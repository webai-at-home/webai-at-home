///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebgpuProbes — the two WebGPU measurements milestone two of issue #169 asks for
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Two questions, both about the queue rather than about arithmetic.
 *
 * The first is whether a write into a WebGPU buffer overlaps a compute pass or waits behind it. WebGPU gives a device
 * one queue, so a residency layer that loads the next expert while the current one is being multiplied is either
 * getting that load for free or paying for it twice. That decides whether prefetching is worth building at all.
 *
 * The second is how much buffer memory one Chrome page is allowed to allocate before allocation fails. That number is
 * neither the memory of the machine nor the limit the adapter advertises, and every residency budget written before
 * it is measured is a guess.
 */

/** The result of asking whether a buffer write and a compute pass share the queue or take turns on it. */
export type OverlapMeasurement = {
	/** How long the compute pass alone took, in milliseconds. */
	computeOnlyMilliseconds: number;
	/** How long the buffer write alone took, in milliseconds. */
	writeOnlyMilliseconds: number;
	/** How long the two took when submitted together, in milliseconds. */
	togetherMilliseconds: number;
	/**
	 * How much of the shorter of the two was hidden inside the longer one, from zero for taking turns to one for
	 * completely overlapped.
	 */
	overlapFraction: number;
	/** How long filling a mapped staging buffer with the same bytes took, in milliseconds. */
	mapAndFillMilliseconds: number;
	/** How long copying those bytes out of the staging buffer alone took, in milliseconds. */
	copyOnlyMilliseconds: number;
	/** How long that copy and the compute pass took when submitted together, in milliseconds. */
	copyTogetherMilliseconds: number;
	/** How much of the shorter of those two was hidden inside the longer one. */
	copyOverlapFraction: number;
	/** How many bytes the buffer write moved. */
	writeByteLength: number;
	/** How many times the compute pass was dispatched, which is how the pass was made long enough to measure. */
	dispatchCount: number;
};

/** The result of allocating WebGPU buffers until the device refuses. */
export type AllocationCeilingMeasurement = {
	/** The length of every buffer that was allocated, in bytes. */
	chunkByteLength: number;
	/** How many buffers were allocated before allocation stopped. */
	bufferCount: number;
	/** How many bytes those buffers hold together. */
	totalByteLength: number;
	/** What stopped the loop. */
	stoppedBy:
		| 'an out-of-memory error from the device'
		| 'the device being lost'
		| 'createBuffer throwing'
		| 'the safety limit of this page';
	/** The message the device or the exception carried, when there was one. */
	stopMessage: string;
	/** How long the whole loop took, in milliseconds. */
	milliseconds: number;
	/** Whether every byte of every buffer was written, rather than only its first and last bytes. */
	wasEveryBufferFilled: boolean;
};

/** Everything the overlap measurement needs to keep alive between its three timed runs. */
type OverlapProbe = {
	/** The pipeline that runs the deliberately slow shader. */
	pipeline: GPUComputePipeline;
	/** The bind group holding the buffer the shader reads and writes. */
	bindGroup: GPUBindGroup;
	/** The buffer the timed write targets. It is bound to nothing, so nothing can serialise on its contents. */
	writeTarget: GPUBuffer;
	/** A buffer the page can map and fill directly, so the copy into the target becomes queue work. */
	stagingBuffer: GPUBuffer;
	/** The bytes the timed write moves. */
	writeSource: Uint8Array;
	/** How many workgroups one dispatch covers. */
	workgroupCount: number;
};

/** How many floating point values the slow shader works over. */
const COMPUTE_ELEMENT_COUNT = 65536;
/** How many values one workgroup of the slow shader covers. */
const COMPUTE_WORKGROUP_SIZE = 64;
/** How long the compute pass is stretched to, in milliseconds, so that a queue stall is visible against it. */
const TARGET_COMPUTE_MILLISECONDS = 40;
/** The largest number of dispatches the calibration will grow to, so a slow adapter cannot make the page hang. */
const MAXIMUM_DISPATCH_COUNT = 4096;
/** How many bytes the timed write moves, chosen to be far larger than one expert so the write is not lost in noise. */
const OVERLAP_WRITE_BYTE_LENGTH = 64 * 1024 * 1024;
/** How many times each of the three timed shapes is run, after a warm-up run, with the fastest one kept. */
const TIMED_ATTEMPT_COUNT = 3;
/**
 * The largest number of buffers the allocation ceiling loop will take, as a backstop against a runaway loop. At the
 * chunk length this page uses that is 64 gigabytes, which is far more than the memory of any machine this experiment
 * runs on, so reaching it is itself a finding rather than a safe stopping point.
 */
const MAXIMUM_CEILING_BUFFER_COUNT = 256;
/** How many bytes are written into each allocated buffer, at its start and at its end, to make the device commit it. */
const CEILING_TOUCH_BYTE_LENGTH = 4096;

/**
 * The deliberately slow compute shader. The loop cannot be removed by the shader compiler, because every step depends
 * on the one before it and the result is written back out.
 */
const SLOW_COMPUTE_SHADER = `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;

@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	var value = data[id.x];
	for (var index = 0u; index < 2048u; index = index + 1u) {
		value = value * 1.0000001 + 0.0000001;
	}
	data[id.x] = value;
}
`;

/** Runs the two WebGPU measurements of milestone two and reports every raw number they produce. */
export class WebgpuProbes {
	/**
	 * Measures whether a write into a WebGPU buffer overlaps a compute pass or waits behind it.
	 *
	 * The buffer written to is bound to nothing and is read by nothing, so it shares no data with the compute pass.
	 * Any waiting seen therefore belongs to the queue itself and not to a dependency between the two pieces of work.
	 *
	 * @param device - The device both pieces of work are submitted to.
	 * @returns A promise that resolves to the measurement.
	 */
	static async measureOverlap(device: GPUDevice): Promise<OverlapMeasurement> {
		const probe = WebgpuProbes._createOverlapProbe(device);
		try {
			const dispatchCount = await WebgpuProbes._calibrateDispatchCount(device, probe);

			const computeOnlyMilliseconds = await WebgpuProbes._timeBest(device, () => {
				WebgpuProbes._submitCompute(device, probe, dispatchCount);
			});
			const writeOnlyMilliseconds = await WebgpuProbes._timeBest(device, () => {
				device.queue.writeBuffer(probe.writeTarget, 0, probe.writeSource);
			});
			const togetherMilliseconds = await WebgpuProbes._timeBest(device, () => {
				device.queue.writeBuffer(probe.writeTarget, 0, probe.writeSource);
				WebgpuProbes._submitCompute(device, probe, dispatchCount);
			});

			const mapAndFillMilliseconds = await WebgpuProbes._fillStagingBuffer(probe);
			const copyOnlyMilliseconds = await WebgpuProbes._timeBest(device, () => {
				WebgpuProbes._submitCopy(device, probe);
			});
			const copyTogetherMilliseconds = await WebgpuProbes._timeBest(device, () => {
				WebgpuProbes._submitCopy(device, probe);
				WebgpuProbes._submitCompute(device, probe, dispatchCount);
			});

			return {
				computeOnlyMilliseconds: computeOnlyMilliseconds,
				writeOnlyMilliseconds: writeOnlyMilliseconds,
				togetherMilliseconds: togetherMilliseconds,
				overlapFraction: WebgpuProbes._overlapFraction(
					computeOnlyMilliseconds,
					writeOnlyMilliseconds,
					togetherMilliseconds,
				),
				mapAndFillMilliseconds: mapAndFillMilliseconds,
				copyOnlyMilliseconds: copyOnlyMilliseconds,
				copyTogetherMilliseconds: copyTogetherMilliseconds,
				copyOverlapFraction: WebgpuProbes._overlapFraction(
					computeOnlyMilliseconds,
					copyOnlyMilliseconds,
					copyTogetherMilliseconds,
				),
				writeByteLength: OVERLAP_WRITE_BYTE_LENGTH,
				dispatchCount: dispatchCount,
			};
		} finally {
			probe.writeTarget.destroy();
			probe.stagingBuffer.destroy();
		}
	}

	/**
	 * Allocates buffers of one size, one after another, until the device refuses, and reports how far it got.
	 *
	 * The `fillEveryBuffer` argument changes what the loop measures, and both readings are worth having.
	 *
	 * With it off, each buffer is written at its first and last 4096 bytes only. A device that hands back address
	 * space and commits memory later will let that loop run far past the memory of the machine, so what it reports is
	 * how much a page may ask for rather than how much it may keep.
	 *
	 * With it on, every byte of every buffer is written, so the memory really is committed and the loop stops where
	 * the machine stops. That is slower, and it is the number a residency budget has to be built on.
	 *
	 * The adapter and the device are both requested here and the device is destroyed here. A fresh adapter is needed
	 * for every run, because an adapter that has already created a device is consumed and refuses to create a second
	 * one. Running this on a device that anything else is using would in any case leave that other thing with no
	 * memory left.
	 *
	 * @param chunkByteLength - The length of every buffer allocated, in bytes.
	 * @param fillEveryBuffer - Whether to write every byte of every buffer rather than only its first and last bytes.
	 * @param onProgress - Called after each successful allocation, so the page can show the loop advancing.
	 * @returns A promise that resolves to the measurement.
	 */
	static async measureAllocationCeiling(
		chunkByteLength: number,
		fillEveryBuffer: boolean,
		onProgress: (bufferCount: number, totalByteLength: number) => void,
	): Promise<AllocationCeilingMeasurement> {
		if (navigator.gpu === undefined) {
			throw new Error('this browser does not expose WebGPU, so no allocation ceiling can be measured');
		}
		const adapter = await navigator.gpu.requestAdapter();
		if (adapter === null) {
			throw new Error('no WebGPU adapter was granted for the allocation ceiling probe');
		}
		const device = await adapter.requestDevice({
			requiredLimits: {
				maxBufferSize: adapter.limits.maxBufferSize,
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
			},
		});
		let lostMessage: string | undefined;
		device.lost.then((lost) => {
			lostMessage = lost.message === '' ? lost.reason : lost.message;
		}).catch(() => {
			lostMessage = 'the device was lost, and the reason could not be read';
		});

		const buffers: GPUBuffer[] = [];
		const touch = new Uint8Array(fillEveryBuffer ? chunkByteLength : CEILING_TOUCH_BYTE_LENGTH);
		let stoppedBy: AllocationCeilingMeasurement['stoppedBy'] = 'the safety limit of this page';
		let stopMessage = '';
		const startedAt = performance.now();

		try {
			while (buffers.length < MAXIMUM_CEILING_BUFFER_COUNT) {
				if (lostMessage !== undefined) {
					stoppedBy = 'the device being lost';
					stopMessage = lostMessage;
					break;
				}

				device.pushErrorScope('out-of-memory');
				let buffer: GPUBuffer;
				try {
					buffer = device.createBuffer({
						size: chunkByteLength,
						usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
						label: `allocation ceiling probe ${buffers.length}`,
					});
				} catch (error) {
					await device.popErrorScope();
					stoppedBy = 'createBuffer throwing';
					stopMessage = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
					break;
				}

				const outOfMemory = await device.popErrorScope();
				if (outOfMemory !== null) {
					stoppedBy = 'an out-of-memory error from the device';
					stopMessage = outOfMemory.message;
					break;
				}

				device.pushErrorScope('out-of-memory');
				if (fillEveryBuffer) {
					device.queue.writeBuffer(buffer, 0, touch);
				} else {
					device.queue.writeBuffer(buffer, 0, touch);
					device.queue.writeBuffer(buffer, chunkByteLength - CEILING_TOUCH_BYTE_LENGTH, touch);
				}
				await device.queue.onSubmittedWorkDone();
				const writeFailed = await device.popErrorScope();
				if (writeFailed !== null) {
					buffer.destroy();
					stoppedBy = 'an out-of-memory error from the device';
					stopMessage = `the allocation was granted, and writing to it failed: ${writeFailed.message}`;
					break;
				}

				buffers.push(buffer);
				onProgress(buffers.length, buffers.length * chunkByteLength);
			}

			return {
				chunkByteLength: chunkByteLength,
				bufferCount: buffers.length,
				totalByteLength: buffers.length * chunkByteLength,
				stoppedBy: stoppedBy,
				stopMessage: stopMessage,
				milliseconds: performance.now() - startedAt,
				wasEveryBufferFilled: fillEveryBuffer,
			};
		} finally {
			for (const buffer of buffers) {
				buffer.destroy();
			}
			device.destroy();
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the pipeline, the bind group, and the two buffers the overlap measurement needs.
	 *
	 * @param device - The device everything is created on.
	 * @returns The probe.
	 */
	static _createOverlapProbe(device: GPUDevice): OverlapProbe {
		const computeBuffer = device.createBuffer({
			size: COMPUTE_ELEMENT_COUNT * 4,
			usage: GPUBufferUsage.STORAGE,
			label: 'overlap probe compute buffer',
		});
		const module = device.createShaderModule({
			code: SLOW_COMPUTE_SHADER,
		});
		const pipeline = device.createComputePipeline({
			layout: 'auto',
			compute: {
				module: module,
				entryPoint: 'main',
			},
		});
		const bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{
					binding: 0,
					resource: {
						buffer: computeBuffer,
					},
				},
			],
		});
		return {
			pipeline: pipeline,
			bindGroup: bindGroup,
			writeTarget: device.createBuffer({
				size: OVERLAP_WRITE_BYTE_LENGTH,
				usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
				label: 'overlap probe write target',
			}),
			stagingBuffer: device.createBuffer({
				size: OVERLAP_WRITE_BYTE_LENGTH,
				usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
				label: 'overlap probe staging buffer',
			}),
			writeSource: new Uint8Array(OVERLAP_WRITE_BYTE_LENGTH),
			workgroupCount: COMPUTE_ELEMENT_COUNT / COMPUTE_WORKGROUP_SIZE,
		};
	}

	/**
	 * Grows the number of dispatches until the compute pass takes long enough that a queue stall would be visible
	 * against it. A pass that finishes in under a millisecond cannot answer the overlap question either way.
	 *
	 * @param device - The device the pass is submitted to.
	 * @param probe - The probe built by `_createOverlapProbe`.
	 * @returns A promise that resolves to the number of dispatches to use for the timed runs.
	 */
	static async _calibrateDispatchCount(device: GPUDevice, probe: OverlapProbe): Promise<number> {
		let dispatchCount = 1;
		while (dispatchCount < MAXIMUM_DISPATCH_COUNT) {
			const milliseconds = await WebgpuProbes._time(device, () => {
				WebgpuProbes._submitCompute(device, probe, dispatchCount);
			});
			if (milliseconds >= TARGET_COMPUTE_MILLISECONDS) {
				return dispatchCount;
			}
			const growth = milliseconds <= 0.5 ? 8 : Math.ceil(TARGET_COMPUTE_MILLISECONDS / milliseconds);
			dispatchCount = Math.min(MAXIMUM_DISPATCH_COUNT, dispatchCount * Math.max(2, growth));
		}
		return dispatchCount;
	}

	/**
	 * Maps the staging buffer, fills it with the same bytes the timed write moves, and unmaps it.
	 *
	 * This is the cost the residency layer pays on its own thread if it takes this path, and it is the fair thing to
	 * compare against the part of `writeBuffer` that is a copy on that same thread. Everything after it is queue work.
	 *
	 * @param probe - The probe built by `_createOverlapProbe`.
	 * @returns A promise that resolves to how long the mapping and the filling took, in milliseconds.
	 */
	static async _fillStagingBuffer(probe: OverlapProbe): Promise<number> {
		const startedAt = performance.now();
		await probe.stagingBuffer.mapAsync(GPUMapMode.WRITE);
		new Uint8Array(probe.stagingBuffer.getMappedRange()).set(probe.writeSource);
		probe.stagingBuffer.unmap();
		return performance.now() - startedAt;
	}

	/**
	 * Encodes and submits one copy from the staging buffer into the write target. Unlike `writeBuffer`, every byte of
	 * this copy is work for the queue, so it is the version that has a chance of overlapping the compute pass.
	 *
	 * @param device - The device the copy is submitted to.
	 * @param probe - The probe built by `_createOverlapProbe`.
	 * @returns Nothing.
	 */
	static _submitCopy(device: GPUDevice, probe: OverlapProbe): void {
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer(probe.stagingBuffer, 0, probe.writeTarget, 0, OVERLAP_WRITE_BYTE_LENGTH);
		device.queue.submit([encoder.finish()]);
	}

	/**
	 * Reports how much of the shorter of two pieces of work disappeared inside the longer one when both were
	 * submitted together.
	 *
	 * @param firstMilliseconds - How long the first piece of work took on its own.
	 * @param secondMilliseconds - How long the second piece of work took on its own.
	 * @param togetherMilliseconds - How long both took when submitted together.
	 * @returns The share hidden, from zero for taking turns to one for completely overlapped.
	 */
	static _overlapFraction(
		firstMilliseconds: number,
		secondMilliseconds: number,
		togetherMilliseconds: number,
	): number {
		const shorter = Math.min(firstMilliseconds, secondMilliseconds);
		if (shorter === 0) {
			return 0;
		}
		const hidden = firstMilliseconds + secondMilliseconds - togetherMilliseconds;
		return Math.min(1, Math.max(0, hidden / shorter));
	}

	/**
	 * Encodes and submits one compute pass holding the given number of dispatches.
	 *
	 * @param device - The device the pass is submitted to.
	 * @param probe - The probe built by `_createOverlapProbe`.
	 * @param dispatchCount - How many dispatches the pass holds.
	 * @returns Nothing.
	 */
	static _submitCompute(device: GPUDevice, probe: OverlapProbe, dispatchCount: number): void {
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(probe.pipeline);
		pass.setBindGroup(0, probe.bindGroup);
		for (let index = 0; index < dispatchCount; index++) {
			pass.dispatchWorkgroups(probe.workgroupCount);
		}
		pass.end();
		device.queue.submit([encoder.finish()]);
	}

	/**
	 * Runs a piece of work once without timing it, then times it several times and keeps the fastest run.
	 *
	 * Both halves matter. The first write of 64 megabytes into a buffer pays for a staging buffer the driver then
	 * keeps, so timing it would charge one measurement for a cost the next one does not pay, and the three numbers
	 * this probe compares would not be comparable at all. Keeping the fastest of the timed runs then answers the
	 * question the probe is actually asking, which is what the queue does when nothing else is in the way.
	 *
	 * @param device - The device whose queue is drained around the work.
	 * @param submit - The work to time.
	 * @returns A promise that resolves to the fastest run, in milliseconds.
	 */
	static async _timeBest(device: GPUDevice, submit: () => void): Promise<number> {
		await WebgpuProbes._time(device, submit);
		let best = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < TIMED_ATTEMPT_COUNT; attempt++) {
			best = Math.min(best, await WebgpuProbes._time(device, submit));
		}
		return best;
	}

	/**
	 * Times a piece of work from an empty queue to an empty queue.
	 *
	 * @param device - The device whose queue is drained before and after the work.
	 * @param submit - The work to time.
	 * @returns A promise that resolves to how long the work took, in milliseconds.
	 */
	static async _time(device: GPUDevice, submit: () => void): Promise<number> {
		await device.queue.onSubmittedWorkDone();
		const startedAt = performance.now();
		submit();
		await device.queue.onSubmittedWorkDone();
		return performance.now() - startedAt;
	}
}
