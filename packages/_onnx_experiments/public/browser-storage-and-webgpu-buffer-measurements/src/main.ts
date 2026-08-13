import type { DetailedStorageEstimate } from './browser_storage_types';
import type { StorageWorkerRequest, StorageWorkerResponse } from './storage_worker_messages';
import { WebgpuProbes, type AllocationCeilingMeasurement } from './webgpu_probes';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — runs the milestone two storage and WebGPU measurements of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Milestone two of https://github.com/webai-at-home/webai-at-home/issues/169 asks for measurements rather than for a
 * verdict. Milestone zero already proved that ONNX Runtime Web will multiply against a WebGPU buffer this project
 * owns and will reread that buffer after it is overwritten. What is still unknown is everything underneath it:
 *
 * - how many bytes this origin is allowed to keep on disk, and whether the browser promises not to delete them,
 * - how fast an expert-sized block comes off disk through the Origin Private File System and into a WebGPU buffer,
 * - whether that write overlaps the multiplication or waits behind it on the single queue,
 * - and how much WebGPU buffer memory one Chrome page can hold at once before allocation fails.
 *
 * No model is downloaded and ONNX Runtime Web is never loaded. This page owns its own WebGPU device outright, so the
 * device-borrowing finding of milestone zero does not apply here.
 */

/**
 * One Qwen3-30B-A3B expert at 4 bits, in bytes, as measured by `tools/weight_conversion/measure_qwen3_moe_residency.mjs` in milestone
 * one. Three projections of 768 by 2048, at 4.5 bits for every weight once the block scales are counted. It is also
 * exactly 648 pages of 4096 bytes, so every block in the test file starts on a page boundary without any padding.
 */
const EXPERT_BLOCK_BYTE_LENGTH = 2_654_208;
/** How many experts Qwen3-30B-A3B holds across its 48 layers, at 128 experts for each layer. */
const QWEN3_EXPERT_COUNT = 6144;
/** How many parameters Qwen3-30B-A3B holds outside its experts, and therefore must keep resident. */
const QWEN3_RESIDENT_PARAMETER_COUNT = 1_541_093_376;
/** Every weight costs 4 bits, plus one half-precision scale for every 32 weights, so 4.5 bits in total. */
const BITS_FOR_EACH_WEIGHT = 4.5;
/** The largest test file this page writes, in blocks. At the block length above this is about 1.27 gigabytes. */
const LARGEST_FILE_BLOCK_COUNT = 512;
/** The smallest test file worth measuring, in blocks. Below this the timings are noise. */
const SMALLEST_FILE_BLOCK_COUNT = 64;
/** How much of the free quota the test file is allowed to take, so the run never fills the user's disk. */
const QUOTA_SHARE_FOR_THE_TEST_FILE = 0.5;
/** How many blocks the read measurement touches, out of the blocks in the file. */
const READ_BLOCK_COUNT = 128;
/** How many blocks travel the whole path from disk into a WebGPU buffer. */
const UPLOAD_BLOCK_COUNT = 32;
/** The name of the test file inside the Origin Private File System. */
const TEST_FILE_NAME = 'issue-169-milestone-two-expert-blocks.bin';
/** The length of every buffer the allocation ceiling probe takes, in bytes. */
const CEILING_CHUNK_BYTE_LENGTH = 256 * 1024 * 1024;
/**
 * The quota an ordinary Chrome profile reports is a large share of the free space on the disk. A quota far below this
 * is the mark of a private window, a restricted profile, or an embedded browser, and a number measured there says
 * nothing about what a user's own Chrome would allow.
 */
const SMALLEST_ORDINARY_PROFILE_QUOTA = 10 * 1024 * 1024 * 1024;

/** What one phase reports back to the runner. */
type PhaseOutcome = {
	/** Whether the phase produced the numbers it exists to produce. */
	completed: boolean;
	/** The one-line result written into the page's summary. */
	summary: string;
};

/** One row of the table of measurements this page exists to produce. */
type Measurement = {
	/** What was measured, in words. */
	name: string;
	/** What was measured, as a value. */
	value: string;
};

/** Runs the measurements and prints every raw number they produce. */
class Main {
	/** The element every phase writes its output into. */
	static outputElement: HTMLPreElement | undefined;
	/** The worker that holds every synchronous access handle, because those exist nowhere else. */
	static storageWorker: Worker | undefined;
	/** The adapter this page requested, once the run has started. */
	static adapter: GPUAdapter | undefined;
	/** The device this page owns. Nothing else uses it, so it can be exhausted without breaking anything. */
	static device: GPUDevice | undefined;
	/** Every row of the table of measurements, gathered as the phases run. */
	static measurements: Measurement[] = [];
	/** How many blocks the test file actually holds, which phase three fits to the quota this origin was given. */
	static fileBlockCount = LARGEST_FILE_BLOCK_COUNT;

	/**
	 * Builds the page and connects the two buttons.
	 *
	 * @returns A promise that resolves once the page is ready to run.
	 */
	static async main(): Promise<void> {
		Main.outputElement = document.querySelector<HTMLPreElement>('#output') ?? undefined;
		Main._registerServiceWorker();
		Main._connectButton('#run-button', 'Run the measurements', 'Measuring…', Main.runMeasurements);
		Main._connectButton(
			'#run-ceiling-button',
			'Run the allocation ceiling probe',
			'Allocating until it fails…',
			Main.runAllocationCeiling,
		);
	}

	/**
	 * Runs the six measurement phases in order, then removes the test file it wrote.
	 *
	 * @returns A promise that resolves once every phase that could run has run.
	 */
	static async runMeasurements(): Promise<void> {
		if (Main.outputElement !== undefined) {
			Main.outputElement.textContent = '';
		}
		Main.measurements = [];

		const phases: { title: string; run: () => Promise<PhaseOutcome> }[] = [
			{
				title: '1 · how many bytes this origin is allowed to keep',
				run: Main.phaseQuota,
			},
			{
				title: '2 · whether the browser promises not to delete them',
				run: Main.phasePersistence,
			},
			{
				title: '3 · writing expert-sized blocks into the Origin Private File System',
				run: Main.phaseWriteBlocks,
			},
			{
				title: '4 · reading them back through a synchronous access handle in a worker',
				run: Main.phaseReadBlocks,
			},
			{
				title: '5 · the whole path, from disk into a WebGPU buffer',
				run: Main.phaseDiskIntoGpuBuffer,
			},
			{
				title: '6 · whether a buffer write overlaps a compute pass or waits behind it',
				run: Main.phaseOverlap,
			},
		];

		for (const phase of phases) {
			Main._write(`\n── phase ${phase.title}`, 'phase');
			let outcome: PhaseOutcome;
			try {
				outcome = await phase.run();
			} catch (error) {
				outcome = {
					completed: false,
					summary: `threw — ${error instanceof Error ? error.message : String(error)}`,
				};
				Main._write(`  threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, 'fail');
			}
			Main._write(`  ${outcome.completed ? 'MEASURED' : 'NOT MEASURED'} — ${outcome.summary}`, outcome.completed ? 'pass' : 'fail');
			if (outcome.completed === false) {
				Main._write('\n  Later phases depend on this one, so the run stops here.', 'fail');
				break;
			}
		}

		await Main._removeTestFile();
		Main._writeMeasurementTable();
	}

	/**
	 * Runs the allocation ceiling probe on its own, because it deliberately exhausts a device and may take the tab
	 * down with it. It is behind its own button so that the six measurements above can be trusted to finish.
	 *
	 * @returns A promise that resolves once the probe has finished and everything it allocated has been released.
	 */
	static async runAllocationCeiling(): Promise<void> {
		Main._write('\n── phase 7 · how much WebGPU buffer memory one Chrome page can hold at once', 'phase');

		Main._write('\n  first, asking for buffers and only touching their first and last 4096 bytes:');
		const askedFor = await Main._runOneCeilingProbe(false);
		Main._write('\n  now the same loop again, writing every byte of every buffer, so the memory really is committed:');
		const kept = await Main._runOneCeilingProbe(true);

		Main._record('WebGPU buffer memory one page may ask for', Main._bytes(askedFor.totalByteLength));
		Main._record('WebGPU buffer memory one page may keep', Main._bytes(kept.totalByteLength));

		const neitherWasRefused = askedFor.stoppedBy === 'the safety limit of this page' &&
			kept.stoppedBy === 'the safety limit of this page';
		if (neitherWasRefused) {
			Main._write(
				`\n  Neither loop was refused. This page asked for ${Main._bytes(kept.totalByteLength)}, wrote every byte of\n` +
					'  it, and the device never reported an out-of-memory error. That is the answer, and it is not the one\n' +
					'  the question expected: on this platform WebGPU does not refuse. The operating system pages the\n' +
					'  memory out instead, so a residency layer that takes too much is never told so. It only gets slower,\n' +
					'  and it gets slower in the way that is hardest to attribute. The budget has to be given to it,\n' +
					'  because it cannot find one by asking.',
				'warning',
			);
			Main._record('did the device ever refuse an allocation', 'no');
		} else if (askedFor.totalByteLength > kept.totalByteLength) {
			Main._write(
				`\n  The two disagree, and that is the finding. A page may ask for ${Main._bytes(askedFor.totalByteLength)} and\n` +
					`  only keep ${Main._bytes(kept.totalByteLength)}, because createBuffer hands back address space and the\n` +
					'  memory is committed later. A residency layer therefore cannot discover its own budget by allocating\n' +
					'  until allocation fails: allocation will not fail. It finds out when it writes, which is during\n' +
					'  generation, and it must be given a budget rather than left to find one.',
				'warning',
			);
		}
		Main._writeMeasurementTable();
	}

	/**
	 * Runs the allocation ceiling probe once and prints everything it reports.
	 *
	 * @param fillEveryBuffer - Whether to write every byte of every buffer rather than only its first and last bytes.
	 * @returns A promise that resolves to the measurement.
	 */
	static async _runOneCeilingProbe(fillEveryBuffer: boolean): Promise<AllocationCeilingMeasurement> {
		let lastReported = 0;
		const measurement = await WebgpuProbes.measureAllocationCeiling(
			CEILING_CHUNK_BYTE_LENGTH,
			fillEveryBuffer,
			(bufferCount, totalByteLength) => {
				if (totalByteLength - lastReported < 1024 * 1024 * 1024) {
					return;
				}
				lastReported = totalByteLength;
				Main._write(`    ${bufferCount} buffers, ${Main._bytes(totalByteLength)} held`);
			},
		);

		Main._write(`  stopped by ${measurement.stoppedBy}`);
		if (measurement.stopMessage !== '') {
			Main._write(`  the message it carried: ${measurement.stopMessage}`);
		}
		Main._write(
			`  held ${measurement.bufferCount} buffers, ${Main._bytes(measurement.totalByteLength)} in total, ` +
				`in ${measurement.milliseconds.toFixed(0)} milliseconds`,
			'pass',
		);
		if (measurement.stoppedBy === 'the safety limit of this page') {
			Main._write('  This loop reached the limit this page sets for itself rather than a limit of the machine, so ' +
				'the real ceiling is higher than the number above.', 'warning');
		}
		return measurement;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Phase one. Reports what the browser says this origin may store, and measures that against what Qwen3-30B-A3B
	 * would need to put on disk.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phaseQuota(): Promise<PhaseOutcome> {
		const estimate: DetailedStorageEstimate = await navigator.storage.estimate();
		const quota = estimate.quota ?? 0;
		const usage = estimate.usage ?? 0;
		Main._write(`  quota: ${Main._bytes(quota)}`);
		Main._write(`  usage: ${Main._bytes(usage)}`);
		if (estimate.usageDetails !== undefined) {
			for (const [systemName, systemUsage] of Object.entries(estimate.usageDetails)) {
				Main._write(`    ${systemName}: ${Main._bytes(systemUsage)}`);
			}
		} else {
			Main._write('    no per-storage-system breakdown reported');
		}
		Main._record('storage quota', Main._bytes(quota));
		Main._record('storage usage before this run', Main._bytes(usage));

		const expertBytes = QWEN3_EXPERT_COUNT * EXPERT_BLOCK_BYTE_LENGTH;
		const residentBytes = (QWEN3_RESIDENT_PARAMETER_COUNT * BITS_FOR_EACH_WEIGHT) / 8;
		Main._write(`\n  Qwen3-30B-A3B expert weights at 4 bits: ${Main._bytes(expertBytes)}`);
		Main._write(`  Qwen3-30B-A3B whole model at 4 bits:    ${Main._bytes(expertBytes + residentBytes)}`);
		Main._write(`  gpt-oss-120b, published at 4 bits:      about 60 gigabytes`);
		const roomForQwen3 = quota >= expertBytes + residentBytes;
		Main._record('room for Qwen3-30B-A3B at 4 bits', roomForQwen3 ? 'yes' : 'no');

		if (quota < SMALLEST_ORDINARY_PROFILE_QUOTA) {
			Main._write(
				`\n  A quota of ${Main._bytes(quota)} is far below what an ordinary Chrome profile reports, which is a\n` +
					'  large share of the free space on the disk. This is the mark of a private window, a restricted\n' +
					'  profile, or an embedded browser. Every number this page reports is still true of this browser, but\n' +
					'  it says nothing about what a user\'s own Chrome would allow. Run the page again in an ordinary\n' +
					'  Chrome window before quoting the quota anywhere.',
				'warning',
			);
		}

		return {
			completed: true,
			summary: `${Main._bytes(quota)} of quota, ${Main._bytes(usage)} used, ` +
				`${roomForQwen3 ? 'enough' : 'not enough'} for Qwen3-30B-A3B at 4 bits`,
		};
	}

	/**
	 * Phase two. Asks whether the bytes on disk survive, which is the difference between a model downloaded once and a
	 * model downloaded again every time the browser decides it needs the room.
	 *
	 * The answer is expected to differ between an ordinary tab and the same page installed as a Progressive Web
	 * Application, so the phase reports which of the two it is running in and the page has to be run twice.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phasePersistence(): Promise<PhaseOutcome> {
		const isInstalled = window.matchMedia('(display-mode: standalone)').matches ||
			window.matchMedia('(display-mode: window-controls-overlay)').matches;
		const howItIsRunning = isInstalled ? 'installed as a Progressive Web Application' : 'an ordinary browser tab';
		Main._write(`  running as: ${howItIsRunning}`);

		const wasPersistedBefore = await navigator.storage.persisted();
		Main._write(`  already persistent before asking: ${wasPersistedBefore}`);

		let permissionState = 'not reported';
		try {
			const status = await navigator.permissions.query({
				name: 'persistent-storage' as PermissionName,
			});
			permissionState = status.state;
		} catch (error) {
			permissionState = `the query threw — ${error instanceof Error ? error.message : String(error)}`;
		}
		Main._write(`  the persistent-storage permission reports: ${permissionState}`);

		const granted = await navigator.storage.persist();
		Main._write(`  navigator.storage.persist() returned: ${granted}`, granted ? 'pass' : 'fail');

		const estimate: DetailedStorageEstimate = await navigator.storage.estimate();
		Main._write(`  quota after asking: ${Main._bytes(estimate.quota ?? 0)}`);

		Main._record(`persistence granted, ${howItIsRunning}`, granted ? 'yes' : 'no');
		Main._record(`quota, ${howItIsRunning}`, Main._bytes(estimate.quota ?? 0));

		if (granted === false) {
			Main._write(
				'\n  A refusal here is not a failure of this page. Chrome grants persistence on site engagement, on a\n' +
					'  bookmark, or on installation as a Progressive Web Application. Install this page and run it again to\n' +
					'  fill in the second half of this measurement.',
			);
		}

		return {
			completed: true,
			summary: `${howItIsRunning}: persistence ${granted ? 'granted' : 'refused'}, permission ${permissionState}`,
		};
	}

	/**
	 * Phase three. Writes the test file, one expert-sized block at a time, through a synchronous access handle inside
	 * the worker. This is also the shape of the first download of issue #169, so its throughput is worth having.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phaseWriteBlocks(): Promise<PhaseOutcome> {
		const before: DetailedStorageEstimate = await navigator.storage.estimate();
		const freeQuota = (before.quota ?? 0) - (before.usage ?? 0);
		const affordableBlockCount = Math.floor(
			(freeQuota * QUOTA_SHARE_FOR_THE_TEST_FILE) / EXPERT_BLOCK_BYTE_LENGTH,
		);
		Main.fileBlockCount = Math.min(LARGEST_FILE_BLOCK_COUNT, affordableBlockCount);
		if (Main.fileBlockCount < SMALLEST_FILE_BLOCK_COUNT) {
			return {
				completed: false,
				summary: `${Main._bytes(freeQuota)} of free quota only affords ${Main.fileBlockCount} expert blocks, ` +
					`and fewer than ${SMALLEST_FILE_BLOCK_COUNT} would make every timing below it noise`,
			};
		}
		if (Main.fileBlockCount < LARGEST_FILE_BLOCK_COUNT) {
			Main._write(
				`  the quota only affords ${Main.fileBlockCount} of the ${LARGEST_FILE_BLOCK_COUNT} blocks this page ` +
					'would rather write, so the file is smaller and more likely to sit entirely in the memory the\n' +
					'  operating system keeps for files. Phase four says whether it did.',
				'warning',
			);
		}

		const fileByteLength = Main.fileBlockCount * EXPERT_BLOCK_BYTE_LENGTH;
		Main._write(`  writing ${Main.fileBlockCount} blocks of ${Main._bytes(EXPERT_BLOCK_BYTE_LENGTH)}, ` +
			`so ${Main._bytes(fileByteLength)} in total…`);
		const response = await Main._askStorageWorker({
			kind: 'write-file',
			fileName: TEST_FILE_NAME,
			blockByteLength: EXPERT_BLOCK_BYTE_LENGTH,
			blockCount: Main.fileBlockCount,
		});
		if (response.kind !== 'write-file') {
			return {
				completed: false,
				summary: response.kind === 'failed' ? response.message : 'the worker answered the wrong request',
			};
		}

		const bytesEachSecond = (response.byteLength / response.milliseconds) * 1000;
		Main._write(`  took ${response.milliseconds.toFixed(0)} milliseconds, ` +
			`of which ${response.flushMilliseconds.toFixed(0)} was the final flush`);
		Main._write(`  write throughput: ${Main._bytesEachSecond(bytesEachSecond)}`, 'pass');

		const after: DetailedStorageEstimate = await navigator.storage.estimate();
		Main._write(`  usage grew from ${Main._bytes(before.usage ?? 0)} to ${Main._bytes(after.usage ?? 0)}`);
		Main._record('write throughput into the Origin Private File System', Main._bytesEachSecond(bytesEachSecond));

		return {
			completed: true,
			summary: `${Main._bytes(fileByteLength)} written at ${Main._bytesEachSecond(bytesEachSecond)}`,
		};
	}

	/**
	 * Phase four. Reads expert-sized blocks back at shuffled offsets, which is how the residency layer will read them,
	 * and then reads exactly the same blocks a second time.
	 *
	 * The second pass is the honest part. If the two passes are the same speed, the whole file was already in the
	 * memory the operating system keeps for files, and the number is an upper bound on the disk rather than a
	 * measurement of it. Saying that out loud is cheaper than believing a number that was never a disk number.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phaseReadBlocks(): Promise<PhaseOutcome> {
		const readBlockCount = Math.min(READ_BLOCK_COUNT, Main.fileBlockCount);
		const blockIndexes = Main._shuffledBlockIndexes(readBlockCount, Main.fileBlockCount, 0x169a);
		const firstPass = await Main._readBlocks(blockIndexes);
		const secondPass = await Main._readBlocks(blockIndexes);
		if (firstPass.kind !== 'read-blocks' || secondPass.kind !== 'read-blocks') {
			const failed = firstPass.kind === 'failed' ? firstPass : secondPass;
			return {
				completed: false,
				summary: failed.kind === 'failed' ? failed.message : 'the worker answered the wrong request',
			};
		}
		if (firstPass.wrongBlockCount > 0 || secondPass.wrongBlockCount > 0) {
			return {
				completed: false,
				summary: `${firstPass.wrongBlockCount + secondPass.wrongBlockCount} blocks came back carrying the wrong ` +
					'block index, so the reads returned the wrong bytes',
			};
		}

		const firstBytesEachSecond = (firstPass.byteLength / firstPass.milliseconds) * 1000;
		const secondBytesEachSecond = (secondPass.byteLength / secondPass.milliseconds) * 1000;
		Main._write(`  ${readBlockCount} blocks at shuffled offsets, ${Main._bytes(firstPass.byteLength)} in total`);
		Main._write(`  first pass:  ${firstPass.milliseconds.toFixed(1)} milliseconds, ` +
			`${Main._bytesEachSecond(firstBytesEachSecond)}, ` +
			`one block ${firstPass.fastestBlockMilliseconds.toFixed(2)} to ` +
			`${firstPass.slowestBlockMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  second pass: ${secondPass.milliseconds.toFixed(1)} milliseconds, ` +
			`${Main._bytesEachSecond(secondBytesEachSecond)}, ` +
			`one block ${secondPass.fastestBlockMilliseconds.toFixed(2)} to ` +
			`${secondPass.slowestBlockMilliseconds.toFixed(2)} milliseconds`, 'pass');

		const ratio = firstPass.milliseconds / secondPass.milliseconds;
		Main._write(`  the first pass took ${ratio.toFixed(2)} times as long as the second`);
		if (ratio < 1.2) {
			Main._write(
				'  The first pass was not slower than the second, so it never reached the disk: the file was already\n' +
					'  held in the memory the operating system keeps for files. Both numbers are an upper bound on what\n' +
					'  this path can do, and neither is a measurement of the disk. A real model of 16 gigabytes will not\n' +
					'  fit in that memory, so the residency layer will meet slower reads than these.',
				'warning',
			);
		} else {
			Main._write('  The first pass is clearly slower, so it reached the disk and the second pass did not.');
		}

		Main._record('read throughput, first pass at shuffled offsets', Main._bytesEachSecond(firstBytesEachSecond));
		Main._record('read throughput, same blocks a second time', Main._bytesEachSecond(secondBytesEachSecond));
		Main._record('one expert block, fastest read', `${secondPass.fastestBlockMilliseconds.toFixed(2)} milliseconds`);

		return {
			completed: true,
			summary: `${Main._bytesEachSecond(firstBytesEachSecond)} on the first pass, ` +
				`${Main._bytesEachSecond(secondBytesEachSecond)} on the second`,
		};
	}

	/**
	 * Phase five. Measures the path the residency layer actually needs, end to end, twice over.
	 *
	 * The first way is the one milestone two names: a synchronous access handle inside the worker, with the block's
	 * buffer handed to the page rather than copied. It costs a fresh allocation for every block, because a buffer can
	 * only be given away once.
	 *
	 * The second way skips the worker entirely and reads the same range through an ordinary asynchronous file read on
	 * the page's own thread. It is the simpler thing to build, so it is worth knowing what the worker buys.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phaseDiskIntoGpuBuffer(): Promise<PhaseOutcome> {
		const device = await Main._requireDevice();
		const uploadBlockCount = Math.min(UPLOAD_BLOCK_COUNT, Main.fileBlockCount);
		const blockIndexes = Main._shuffledBlockIndexes(uploadBlockCount, Main.fileBlockCount, 0x2b1e);
		const destination = device.createBuffer({
			size: EXPERT_BLOCK_BYTE_LENGTH,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
			label: 'expert block destination',
		});

		try {
			let workerReadMilliseconds = 0;
			let fastestWorkerBlockMilliseconds = Number.POSITIVE_INFINITY;
			const workerStartedAt = performance.now();
			for (const blockIndex of blockIndexes) {
				const blockStartedAt = performance.now();
				const response = await Main._askStorageWorker({
					kind: 'read-one-block',
					fileName: TEST_FILE_NAME,
					blockByteLength: EXPERT_BLOCK_BYTE_LENGTH,
					blockIndex: blockIndex,
				});
				if (response.kind !== 'read-one-block') {
					return {
						completed: false,
						summary: response.kind === 'failed' ? response.message : 'the worker answered the wrong request',
					};
				}
				if (response.isCorrectBlock === false) {
					return {
						completed: false,
						summary: `block ${blockIndex} came back carrying the wrong block index`,
					};
				}
				workerReadMilliseconds += response.milliseconds;
				device.queue.writeBuffer(destination, 0, response.bytes);
				await device.queue.onSubmittedWorkDone();
				fastestWorkerBlockMilliseconds = Math.min(
					fastestWorkerBlockMilliseconds,
					performance.now() - blockStartedAt,
				);
			}
			const workerMilliseconds = performance.now() - workerStartedAt;

			await Main._askStorageWorker({
				kind: 'close-file',
			});
			const directory = await navigator.storage.getDirectory();
			const fileHandle = await directory.getFileHandle(TEST_FILE_NAME);
			const file = await fileHandle.getFile();
			const pageStartedAt = performance.now();
			for (const blockIndex of blockIndexes) {
				const offset = blockIndex * EXPERT_BLOCK_BYTE_LENGTH;
				const bytes = await file.slice(offset, offset + EXPERT_BLOCK_BYTE_LENGTH).arrayBuffer();
				device.queue.writeBuffer(destination, 0, bytes);
				await device.queue.onSubmittedWorkDone();
			}
			const pageMilliseconds = performance.now() - pageStartedAt;

			const movedByteLength = uploadBlockCount * EXPERT_BLOCK_BYTE_LENGTH;
			const workerBytesEachSecond = (movedByteLength / workerMilliseconds) * 1000;
			const pageBytesEachSecond = (movedByteLength / pageMilliseconds) * 1000;
			Main._write(`  ${uploadBlockCount} blocks, ${Main._bytes(movedByteLength)} in total, into one WebGPU buffer`);
			Main._write(`  through the worker: ${workerMilliseconds.toFixed(1)} milliseconds, ` +
				`${Main._bytesEachSecond(workerBytesEachSecond)}, ` +
				`${(workerMilliseconds / uploadBlockCount).toFixed(2)} milliseconds for each expert on average, ` +
				`${fastestWorkerBlockMilliseconds.toFixed(2)} for the fastest one`, 'pass');
			Main._write(`    of which the disk reads themselves: ${workerReadMilliseconds.toFixed(1)} milliseconds, ` +
				`so ${(100 * (1 - workerReadMilliseconds / workerMilliseconds)).toFixed(0)} per cent of the time went on ` +
				'crossing threads and writing the buffer');
			Main._write(`  on the page's own thread: ${pageMilliseconds.toFixed(1)} milliseconds, ` +
				`${Main._bytesEachSecond(pageBytesEachSecond)}, ` +
				`${(pageMilliseconds / uploadBlockCount).toFixed(2)} milliseconds for each expert`);

			Main._record('disk into a WebGPU buffer, through the worker', Main._bytesEachSecond(workerBytesEachSecond));
			Main._record('disk into a WebGPU buffer, on the page thread', Main._bytesEachSecond(pageBytesEachSecond));
			Main._record(
				'one expert, disk to WebGPU buffer',
				`${(workerMilliseconds / uploadBlockCount).toFixed(2)} milliseconds on average, ` +
					`${fastestWorkerBlockMilliseconds.toFixed(2)} at best`,
			);

			const expertsForEachToken = 8 * 48 * 3;
			Main._write(`\n  For scale: an uncached Qwen3-30B-A3B token needs ${expertsForEachToken} expert projections, ` +
				`so ${((workerMilliseconds / uploadBlockCount) * expertsForEachToken / 1000).toFixed(1)} seconds of\n` +
				`  loading at the average rate here, or ${(fastestWorkerBlockMilliseconds * expertsForEachToken / 1000).toFixed(1)} ` +
				'seconds at the fastest rate seen, before any cache\n  hit and before any arithmetic.');

			return {
				completed: true,
				summary: `${Main._bytesEachSecond(workerBytesEachSecond)} through the worker, ` +
					`${Main._bytesEachSecond(pageBytesEachSecond)} on the page thread`,
			};
		} finally {
			destination.destroy();
		}
	}

	/**
	 * Phase six. Submits a compute pass alone, a large buffer write alone, and then both together, and reports how
	 * much of the shorter one disappeared inside the longer one.
	 *
	 * @returns A promise that resolves to the outcome.
	 */
	static async phaseOverlap(): Promise<PhaseOutcome> {
		const device = await Main._requireDevice();
		const measurement = await WebgpuProbes.measureOverlap(device);
		Main._write(`  the compute pass was stretched to ${measurement.dispatchCount} dispatches`);
		Main._write(`  compute pass alone:                ${measurement.computeOnlyMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  writing ${Main._bytes(measurement.writeByteLength)} alone:          ` +
			`${measurement.writeOnlyMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  the two submitted together:        ${measurement.togetherMilliseconds.toFixed(2)} milliseconds`,
			'pass');
		Main._write(`  overlap: ${(measurement.overlapFraction * 100).toFixed(0)} per cent of the shorter one was ` +
			'hidden inside the longer one', 'pass');
		Main._record('writeBuffer and compute pass overlap', `${(measurement.overlapFraction * 100).toFixed(0)} per cent`);

		Main._write('\n  The same bytes again, but placed in a buffer the page maps and fills itself, and then moved with');
		Main._write('  copyBufferToBuffer, so that every byte of the move is work for the queue rather than a copy on');
		Main._write('  the page\'s own thread:');
		Main._write(`  mapping and filling the staging buffer: ${measurement.mapAndFillMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  the copy alone:                    ${measurement.copyOnlyMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  the copy and the pass together:    ${measurement.copyTogetherMilliseconds.toFixed(2)} milliseconds`);
		Main._write(`  overlap: ${(measurement.copyOverlapFraction * 100).toFixed(0)} per cent of the shorter one was ` +
			'hidden inside the longer one', 'pass');
		Main._record(
			'copyBufferToBuffer and compute pass overlap',
			`${(measurement.copyOverlapFraction * 100).toFixed(0)} per cent`,
		);

		const stagedTotalMilliseconds = measurement.mapAndFillMilliseconds + measurement.copyOnlyMilliseconds;
		Main._write(`\n  the same ${Main._bytes(measurement.writeByteLength)} cost ` +
			`${measurement.writeOnlyMilliseconds.toFixed(2)} milliseconds through writeBuffer and ` +
			`${stagedTotalMilliseconds.toFixed(2)} milliseconds staged,`);
		Main._write(`  so the staged path is ${(measurement.writeOnlyMilliseconds / stagedTotalMilliseconds).toFixed(1)} ` +
			`times cheaper in total, and ` +
			`${(measurement.writeOnlyMilliseconds / measurement.copyOnlyMilliseconds).toFixed(0)} times cheaper in the ` +
			'part the queue has to run', 'pass');
		Main._record(
			'writeBuffer against a staged copy, for the same bytes',
			`${(measurement.writeOnlyMilliseconds / stagedTotalMilliseconds).toFixed(1)} times cheaper staged`,
		);

		Main._write(`\n  ${Main._describeOverlap(measurement.overlapFraction, 'writeBuffer')}`);
		Main._write(`  ${Main._describeOverlap(measurement.copyOverlapFraction, 'the staged copy')}`);
		if (measurement.copyOverlapFraction - measurement.overlapFraction > 0.25) {
			Main._write(
				'\n  The two answers differ, and the difference is the point. Most of what writeBuffer costs is a copy on\n' +
					'  the page\'s own thread, before the queue ever sees the bytes, and no queue can hide that. Milestone\n' +
					'  four should read each expert straight into a mapped staging buffer and move it with\n' +
					'  copyBufferToBuffer, rather than calling writeBuffer as milestone zero did.',
				'warning',
			);
		}

		return {
			completed: true,
			summary: `${(measurement.overlapFraction * 100).toFixed(0)} per cent hidden through writeBuffer, ` +
				`${(measurement.copyOverlapFraction * 100).toFixed(0)} per cent through a staged copy`,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Says in words what one overlap fraction means for a residency layer that loads the next expert while the
	 * current one is being multiplied.
	 *
	 * @param overlapFraction - The share of the shorter piece of work that was hidden inside the longer one.
	 * @param pathName - The name of the path that was measured, so the two readings can be told apart.
	 * @returns The sentence to print.
	 */
	static _describeOverlap(overlapFraction: number, pathName: string): string {
		if (overlapFraction > 0.75) {
			return `Through ${pathName} the load is close to free while the graphics processing unit is busy, so ` +
				'loading the next expert during the current multiplication pays almost nothing.';
		}
		if (overlapFraction < 0.25) {
			return `Through ${pathName} the two take turns, so loading the next expert costs its full time on top of ` +
				'the multiplication and prefetching cannot hide it.';
		}
		return `Through ${pathName} the two partly share the queue, so prefetching helps but does not come for free.`;
	}

	/**
	 * Sends one request to the storage worker and waits for its reply. Only one request is ever outstanding, because a
	 * synchronous access handle is exclusive and a second one cannot be opened while the first is still open.
	 *
	 * @param request - The request to send.
	 * @returns A promise that resolves to the reply.
	 */
	static _askStorageWorker(request: StorageWorkerRequest): Promise<StorageWorkerResponse> {
		if (Main.storageWorker === undefined) {
			Main.storageWorker = new Worker(new URL('./storage_worker.ts', import.meta.url), {
				type: 'module',
			});
		}
		const worker = Main.storageWorker;
		return new Promise<StorageWorkerResponse>((resolve, reject) => {
			worker.addEventListener('message', (event: MessageEvent<StorageWorkerResponse>) => {
				resolve(event.data);
			}, {
				once: true,
			});
			worker.addEventListener('error', (event: ErrorEvent) => {
				reject(new Error(`the storage worker failed: ${event.message}`));
			}, {
				once: true,
			});
			worker.postMessage(request);
		});
	}

	/**
	 * Asks the worker to read the given blocks and time them.
	 *
	 * @param blockIndexes - The blocks to read, in the order they are to be read.
	 * @returns A promise that resolves to the reply.
	 */
	static _readBlocks(blockIndexes: number[]): Promise<StorageWorkerResponse> {
		return Main._askStorageWorker({
			kind: 'read-blocks',
			fileName: TEST_FILE_NAME,
			blockByteLength: EXPERT_BLOCK_BYTE_LENGTH,
			blockIndexes: blockIndexes,
		});
	}

	/**
	 * Removes the test file, so the bytes this page wrote go back to the quota of the origin rather than sitting on
	 * the user's disk until the browser decides otherwise.
	 *
	 * @returns A promise that resolves once the file is gone or the removal has been reported as failed.
	 */
	static async _removeTestFile(): Promise<void> {
		if (Main.storageWorker === undefined) {
			return;
		}
		try {
			await Main._askStorageWorker({
				kind: 'delete-file',
				fileName: TEST_FILE_NAME,
			});
			const estimate: DetailedStorageEstimate = await navigator.storage.estimate();
			Main._write(`\n  the test file was removed, usage is back to ${Main._bytes(estimate.usage ?? 0)}`);
		} catch (error) {
			Main._write(`\n  the test file could not be removed: ${error instanceof Error ? error.message : String(error)}`,
				'fail');
		}
	}

	/**
	 * Chooses block indexes in a shuffled order, so the reads land where the residency layer's reads would land rather
	 * than walking the file from one end to the other. The order is the same on every run, because a measurement that
	 * changes its own workload between runs cannot be compared with itself.
	 *
	 * @param count - How many block indexes to return.
	 * @param total - How many blocks the file holds.
	 * @param seed - The seed of the generator, which fixes the order.
	 * @returns The chosen block indexes.
	 */
	static _shuffledBlockIndexes(count: number, total: number, seed: number): number[] {
		const indexes: number[] = [];
		for (let index = 0; index < total; index++) {
			indexes.push(index);
		}
		let state = seed >>> 0;
		for (let index = total - 1; index > 0; index--) {
			state = (state + 0x6d2b79f5) >>> 0;
			let scrambled = Math.imul(state ^ (state >>> 15), 1 | state);
			scrambled = (scrambled + Math.imul(scrambled ^ (scrambled >>> 7), 61 | scrambled)) ^ scrambled;
			const chosen = ((scrambled ^ (scrambled >>> 14)) >>> 0) % (index + 1);
			const held = indexes[index];
			indexes[index] = indexes[chosen];
			indexes[chosen] = held;
		}
		return indexes.slice(0, count);
	}

	/**
	 * Requests the WebGPU adapter once and keeps it.
	 *
	 * @returns A promise that resolves to the adapter.
	 */
	static async _requireAdapter(): Promise<GPUAdapter> {
		if (Main.adapter !== undefined) {
			return Main.adapter;
		}
		if (navigator.gpu === undefined) {
			throw new Error('this browser does not expose WebGPU, so nothing on this page can be measured');
		}
		const adapter = await navigator.gpu.requestAdapter();
		if (adapter === null) {
			throw new Error('no WebGPU adapter was granted');
		}
		Main.adapter = adapter;
		return adapter;
	}

	/**
	 * Requests the WebGPU device once and keeps it, reporting the limits that decide how large a resident set can be.
	 *
	 * @returns A promise that resolves to the device.
	 */
	static async _requireDevice(): Promise<GPUDevice> {
		if (Main.device !== undefined) {
			return Main.device;
		}
		const adapter = await Main._requireAdapter();
		const device = await adapter.requestDevice({
			requiredLimits: {
				maxBufferSize: adapter.limits.maxBufferSize,
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			},
		});
		Main.device = device;
		Main._write(`  the adapter reports maxBufferSize ${Main._bytes(device.limits.maxBufferSize)} and ` +
			`maxStorageBufferBindingSize ${Main._bytes(device.limits.maxStorageBufferBindingSize)}`);
		Main._record('largest single WebGPU buffer', Main._bytes(device.limits.maxBufferSize));
		Main._record('largest storage buffer binding', Main._bytes(device.limits.maxStorageBufferBindingSize));
		return device;
	}

	/**
	 * Registers the service worker, which exists only so that Chrome offers to install this page as a Progressive Web
	 * Application. Phase two cannot answer its second half in an ordinary tab.
	 *
	 * @returns Nothing.
	 */
	static _registerServiceWorker(): void {
		if (navigator.serviceWorker === undefined) {
			return;
		}
		navigator.serviceWorker.register('./service_worker.js', {
			scope: './',
		}).catch((error: unknown) => {
			console.warn('the service worker did not register, so this page cannot be installed', error);
		});
	}

	/**
	 * Connects one button to one long-running action, and keeps it disabled while that action runs.
	 *
	 * @param selector - The selector of the button.
	 * @param idleLabel - What the button says when it is ready.
	 * @param busyLabel - What the button says while its action runs.
	 * @param action - The action to run when the button is pressed.
	 * @returns Nothing.
	 */
	static _connectButton(
		selector: string,
		idleLabel: string,
		busyLabel: string,
		action: () => Promise<void>,
	): void {
		const button = document.querySelector<HTMLButtonElement>(selector);
		if (button === null) {
			return;
		}
		button.disabled = false;
		button.textContent = idleLabel;
		button.addEventListener('click', async () => {
			button.disabled = true;
			button.textContent = busyLabel;
			try {
				await action();
			} catch (error) {
				Main._write(`\n  the run failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
					'fail');
			}
			button.disabled = false;
			button.textContent = idleLabel;
		});
	}

	/**
	 * Adds one row to the table of measurements this page exists to produce.
	 *
	 * @param name - What was measured, in words.
	 * @param value - What was measured, as a value.
	 * @returns Nothing.
	 */
	static _record(name: string, value: string): void {
		Main.measurements.push({
			name: name,
			value: value,
		});
	}

	/**
	 * Prints every measurement gathered so far as one table, which is the deliverable of milestone two.
	 *
	 * @returns Nothing.
	 */
	static _writeMeasurementTable(): void {
		if (Main.measurements.length === 0) {
			return;
		}
		Main._write('\n══ the table of measurements', 'phase');
		let widest = 0;
		for (const measurement of Main.measurements) {
			widest = Math.max(widest, measurement.name.length);
		}
		for (const measurement of Main.measurements) {
			Main._write(`  ${measurement.name.padEnd(widest)}  ${measurement.value}`);
		}
	}

	/**
	 * Formats a byte count, in the same units of 1024 that `tools/weight_conversion/measure_qwen3_moe_residency.mjs` reports.
	 *
	 * @param bytes - The byte count.
	 * @returns The formatted text.
	 */
	static _bytes(bytes: number): string {
		if (bytes >= 1024 * 1024 * 1024) {
			return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} gigabytes`;
		}
		if (bytes >= 1024 * 1024) {
			return `${(bytes / 1024 / 1024).toFixed(2)} megabytes`;
		}
		return `${(bytes / 1024).toFixed(2)} kilobytes`;
	}

	/**
	 * Formats a rate.
	 *
	 * @param bytesEachSecond - The rate, in bytes for each second.
	 * @returns The formatted text.
	 */
	static _bytesEachSecond(bytesEachSecond: number): string {
		return `${Main._bytes(bytesEachSecond)} each second`;
	}

	/**
	 * Appends one line to the page's output.
	 *
	 * @param text - The line to append.
	 * @param className - An optional class name that colours the line.
	 * @returns Nothing.
	 */
	static _write(text: string, className?: string): void {
		if (Main.outputElement === undefined) {
			return;
		}
		const line = document.createElement('span');
		if (className !== undefined) {
			line.className = className;
		}
		line.textContent = `${text}\n`;
		Main.outputElement.append(line);
	}
}

Main.main().catch((error: unknown) => {
	console.error('the measurement page failed to start', error);
});
