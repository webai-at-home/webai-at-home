import type { DetailedStorageEstimate } from './browser_storage_types.js';
import type { BlockManifest, SelectionKind, StepMeasurement } from './residency_types.js';
import type { ResidencyRequest, ResidencyResponse } from './residency_worker_messages.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — the page of issue #169 milestone 4, the residency layer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The published expert blocks. */
const BLOCK_REPOSITORY = 'jerome-etienne/webai-at-home-qwen3-30b-a3b-expert-blocks';
/** The pinned revision of them, so this page always reads the bytes milestone 3 verified. */
const BLOCK_REVISION = 'd8db887997f90a003bea1f67478cfd7cc2a2b84a';
/** Where those files live. */
const BLOCK_BASE_URL = `https://huggingface.co/${BLOCK_REPOSITORY}/resolve/${BLOCK_REVISION}/`;
/** How many staging buffers the ring holds. Eight blocks is 21.82 megabytes, which is nothing next to the cache. */
const STAGING_BUFFER_COUNT = 8;
/** How many steps, meaning generated tokens, one run simulates. */
const STEP_COUNT = 24;
/** How many experts each layer selects for each token, which is what Qwen3-30B-A3B does. */
const SELECTED_FOR_EACH_LAYER = 8;

/** The page: it owns no buffers and reads no files. It sets the residency worker going and shows what comes back. */
class Main {
	/** Where everything is written. */
	private static _output: HTMLPreElement;
	/** The worker holding the whole residency layer. */
	private static _worker: Worker | undefined;
	/** The published layout of the blocks, once it has been read. */
	private static _manifest: BlockManifest | undefined;
	/** How many blocks the store holds, as last reported. */
	private static _presentBlockCount = 0;

	/**
	 * Wires the buttons.
	 *
	 * @returns Nothing.
	 */
	static start(): void {
		Main._output = document.getElementById('output') as HTMLPreElement;
		Main._output.textContent = '';
		Main._registerServiceWorker();

		Main._button('storage-button').addEventListener('click', () => {
			void Main._guard(() => Main.phaseStorage());
		});
		Main._button('fill-button').addEventListener('click', () => {
			void Main._guard(() => Main.phaseFillStore());
		});
		Main._button('measure-button').addEventListener('click', () => {
			void Main._guard(() => Main.phaseMeasure());
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reports what the browser will let this origin keep, and asks for the persistence grant milestone 4 requires.
	 *
	 * @returns Resolves when the report is written.
	 */
	static async phaseStorage(): Promise<void> {
		Main._phase('Phase 1 — storage, and what the quota actually means');

		const before = (await navigator.storage.estimate()) as DetailedStorageEstimate;
		const granted = await navigator.storage.persist();
		const persisted = await navigator.storage.persisted();
		let permission = 'unavailable';
		try {
			permission = (await navigator.permissions.query({
				name: 'persistent-storage' as PermissionName,
			})).state;
		} catch (error) {
			permission = `unavailable: ${String(error)}`;
		}

		Main._line(`  reported quota            ${Main._gigabytes(before.quota ?? 0)}`);
		Main._line(`  reported usage            ${Main._gigabytes(before.usage ?? 0)}`);
		Main._line(`  headroom                  ${Main._gigabytes((before.quota ?? 0) - (before.usage ?? 0))}`);
		Main._line(`  persistence granted       ${granted === true ? 'yes' : 'no'}`);
		Main._line(`  persisted now             ${persisted === true ? 'yes' : 'no'}`);
		Main._line(`  permission                ${permission}`);
		Main._line(`  installed as an app       ${window.matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'}`);

		Main._line('');
		Main._warning('  The reported quota is not a ceiling. It is usage plus a rolling headroom, so it rises as the');
		Main._warning('  store is filled. Measured in Chrome 151: 11.34 GB reported at 0.60 GB used, 16.84 at 6.10, and');
		Main._warning('  32.81 at 22.08 — a headroom of 10.74 GB every time. A 21.47-gigabyte file was written without');
		Main._warning('  one refusal on a browser reporting an 11.34-gigabyte quota. Do not decide what fits by reading');
		Main._warning('  this number; the expert blocks need 15.61 GB and no reported quota will ever say that is fine.');
		Main._line('');
		Main._line('  Persistence changes whether the browser may delete the store under disk pressure, not how much');
		Main._line('  it holds. Chrome grants it on its own heuristics — an installed app is the reliable way to get it.');
	}

	/**
	 * Fills the store from the published blocks, downloading only what is missing.
	 *
	 * @returns Resolves when the store holds every block that was asked for.
	 */
	static async phaseFillStore(): Promise<void> {
		Main._phase('Phase 2 — the block store in the Origin Private File System');

		const manifest = await Main._readManifest();
		const wantedBlockCount = Number((document.getElementById('block-count') as HTMLSelectElement).value);

		const opened = await Main._ask({
			kind: 'open-store',
			manifest: manifest,
		}, 'store-opened');
		if (opened.kind !== 'store-opened') {
			return;
		}
		Main._presentBlockCount = opened.presentBlockCount;
		Main._line(`  source                    ${BLOCK_REPOSITORY}`);
		Main._line(`  pinned revision           ${BLOCK_REVISION}`);
		Main._line(`  published blocks          ${opened.publishedBlockCount}`);
		Main._line(`  one block                 ${manifest.experts.blockByteLength.toLocaleString()} bytes`);
		Main._line(`  already on disk           ${opened.presentBlockCount} blocks, ${Main._gigabytes(opened.byteLength)}`);
		Main._line(`  wanted                    ${wantedBlockCount} blocks, ` +
			`${Main._gigabytes(wantedBlockCount * manifest.experts.blockByteLength)}`);

		if (opened.presentBlockCount >= wantedBlockCount) {
			Main._pass('  the store already holds every block wanted, so nothing is downloaded');
			return;
		}

		Main._line('');
		Main._line('  downloading the missing blocks. Closing the page loses only the block in flight.');
		const filled = await Main._ask({
			kind: 'fill-store',
			blocksUrl: `${BLOCK_BASE_URL}expert_blocks.bin`,
			wantedBlockCount: wantedBlockCount,
		}, 'store-filled');
		if (filled.kind !== 'store-filled') {
			return;
		}
		Main._presentBlockCount = filled.presentBlockCount;
		Main._pass(`  ${filled.presentBlockCount} blocks on disk, ` +
			`${Main._gigabytes(filled.downloadedByteLength)} downloaded in ${filled.seconds.toFixed(1)} seconds, ` +
			`${Main._megabytesEachSecond(filled.downloadedByteLength / filled.seconds)}`);
	}

	/**
	 * Runs the measurement loop twice, once for each synthetic selection sequence.
	 *
	 * @returns Resolves when both runs have been reported.
	 */
	static async phaseMeasure(): Promise<void> {
		Main._phase('Phase 3 — the residency layer, measured');

		const manifest = await Main._readManifest();
		const cacheByteBudget = Number((document.getElementById('cache-budget') as HTMLSelectElement).value);
		const pinnedForEachLayer = Number((document.getElementById('pinned-count') as HTMLSelectElement).value);

		await Main._ask({
			kind: 'open-store',
			manifest: manifest,
		}, 'store-opened');

		const started = await Main._ask({
			kind: 'start-residency',
			configuration: {
				cacheByteBudget: cacheByteBudget,
				stagingBufferCount: STAGING_BUFFER_COUNT,
				pinnedForEachLayer: pinnedForEachLayer,
			},
		}, 'residency-started');
		if (started.kind !== 'residency-started') {
			return;
		}

		Main._line(`  graphics memory budget    ${Main._gigabytes(cacheByteBudget)} — given, not discovered`);
		Main._line(`  cache slots               ${started.slotCount} experts, ` +
			`${Main._gigabytes(started.cacheByteLength)} actually allocated`);
		Main._line(`  buffers in the cache      ${started.slotCount * manifest.experts.parts.length} ` +
			`(${manifest.experts.parts.length} for each expert, because a graph input binds a whole buffer)`);
		Main._line(`  staging ring              ${started.stagingBufferCount} buffers, ` +
			`${Main._megabytes(started.stagingBufferCount * manifest.experts.blockByteLength)}, ` +
			'created once and recycled');
		Main._line(`  largest buffer allowed    ${Main._gigabytes(started.maximumBufferByteLength)}`);
		Main._line(`  pinned for each layer     ${pinnedForEachLayer}`);

		for (const selection of ['uniform', 'skewed'] as SelectionKind[]) {
			await Main._runOne(selection, manifest);
		}

		await Main._ask({
			kind: 'stop-residency',
		}, 'residency-stopped');
		Main._line('');
		Main._line('  the cache, the ring, and the device are released. The block store on disk is kept.');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one selection sequence and writes its table.
	 *
	 * @param selection Which sequence to run.
	 * @param manifest The published layout.
	 * @returns Resolves when the run has been reported.
	 */
	private static async _runOne(selection: SelectionKind, manifest: BlockManifest): Promise<void> {
		Main._line('');
		Main._line(`  ${selection} selection, ${STEP_COUNT} steps of ${SELECTED_FOR_EACH_LAYER} experts for each layer`);

		const steps: StepMeasurement[] = [];
		const finished = await Main._ask({
			kind: 'run-steps',
			stepCount: STEP_COUNT,
			selection: selection,
			selectedForEachLayer: SELECTED_FOR_EACH_LAYER,
		}, 'steps-finished', (response) => {
			if (response.kind === 'step-measured') {
				steps.push(response.measurement);
			}
		});
		if (finished.kind !== 'steps-finished') {
			return;
		}

		const allStalledMilliseconds = steps.reduce((total, step) => total + step.stalledMilliseconds, 0);
		const settled = steps.slice(Math.floor(steps.length / 2));
		const lookupCount = settled.reduce((total, step) => total + step.lookupCount, 0);
		const hitCount = settled.reduce((total, step) => total + step.hitCount, 0);
		const readByteLength = settled.reduce((total, step) => total + step.readByteLength, 0);
		const stalledMilliseconds = settled.reduce((total, step) => total + step.stalledMilliseconds, 0);
		const totalMilliseconds = settled.reduce((total, step) => total + step.totalMilliseconds, 0);

		Main._line(`    layers simulated        ${finished.layerCount} of ${manifest.experts.layerCount}` +
			(finished.layerCount < manifest.experts.layerCount ? ' — the store holds no more' : ''));
		Main._line(`    experts competing       ${finished.expertCount}, of which the cache holds ` +
			`${finished.slotCount} (${((finished.slotCount / finished.expertCount) * 100).toFixed(1)} per cent)`);
		Main._line(`    cache hit rate          ${((hitCount / lookupCount) * 100).toFixed(1)} per cent ` +
			`(${hitCount} of ${lookupCount} lookups)`);
		Main._line(`    read from disk          ${Main._megabytes(readByteLength / settled.length)} for each step`);
		Main._line(`    stalled on weights      ${(stalledMilliseconds / settled.length).toFixed(1)} ms for each step`);
		Main._line(`    whole step              ${(totalMilliseconds / settled.length).toFixed(1)} ms`);
		Main._line(`    stalled fraction        ${((stalledMilliseconds / totalMilliseconds) * 100).toFixed(1)} per cent`);
		Main._line(`    staging ring waited     ${(finished.stagingWaitedMilliseconds / steps.length).toFixed(2)} ms for ` +
			`each step, ${((finished.stagingWaitedMilliseconds / allStalledMilliseconds) * 100).toFixed(1)} per cent of ` +
			'the stall — the ring is large enough when this is small');
		Main._line(`    that is                 ${(1000 / (totalMilliseconds / settled.length)).toFixed(2)} steps ` +
			'each second, counting only the weight movement and none of the arithmetic');
	}

	/**
	 * Sends one request to the residency worker and waits for the response that finishes it.
	 *
	 * @param request What to ask.
	 * @param finishingKind Which response kind ends the wait.
	 * @param onProgress Called with every response that arrives before that one.
	 * @returns The finishing response, or the failure.
	 */
	private static _ask(
		request: ResidencyRequest,
		finishingKind: ResidencyResponse['kind'],
		onProgress?: (response: ResidencyResponse) => void,
	): Promise<ResidencyResponse> {
		const worker = Main._requireWorker();
		return new Promise<ResidencyResponse>((resolve, reject) => {
			const listener = (event: MessageEvent<ResidencyResponse>): void => {
				const response = event.data;
				if (response.kind === 'failed') {
					worker.removeEventListener('message', listener);
					Main._fail(`  ${response.requestKind} failed: ${response.message}`);
					reject(new Error(response.message));
					return;
				}
				if (response.kind === finishingKind) {
					worker.removeEventListener('message', listener);
					resolve(response);
					return;
				}
				if (response.kind === 'fill-progress') {
					Main._replaceLastLine(`    ${response.presentBlockCount} of ${response.wantedBlockCount} blocks, ` +
						`${Main._megabytesEachSecond(response.bytesEachSecond)}`);
				}
				onProgress?.(response);
			};
			worker.addEventListener('message', listener);
			worker.postMessage(request);
		});
	}

	/**
	 * Reads the published manifest once and keeps it.
	 *
	 * @returns The manifest.
	 */
	private static async _readManifest(): Promise<BlockManifest> {
		if (Main._manifest !== undefined) {
			return Main._manifest;
		}
		const response = await fetch(`${BLOCK_BASE_URL}manifest.json`);
		if (response.ok === false) {
			throw new Error(`the manifest could not be read: ${response.status} ${response.statusText}`);
		}
		Main._manifest = (await response.json()) as BlockManifest;
		return Main._manifest;
	}

	/**
	 * Registers the service worker, which exists only so that Chrome offers to install this page as a Progressive Web
	 * Application. Chrome decides whether to grant persistent storage on its own heuristics, and being installed is the
	 * one of them a page can actually do something about. It caches nothing.
	 *
	 * @returns Nothing.
	 */
	private static _registerServiceWorker(): void {
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
	 * @returns The residency worker, created on first use.
	 */
	private static _requireWorker(): Worker {
		if (Main._worker === undefined) {
			Main._worker = new Worker(new URL('./residency_worker.js', import.meta.url), {
				type: 'module',
			});
		}
		return Main._worker;
	}

	/**
	 * Runs a phase and writes whatever it threw rather than failing silently.
	 *
	 * @param phase The phase to run.
	 * @returns Resolves when the phase has finished or its failure has been written.
	 */
	private static async _guard(phase: () => Promise<void>): Promise<void> {
		Main._setButtonsEnabled(false);
		try {
			await phase();
		} catch (error) {
			Main._fail(`  ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
		} finally {
			Main._setButtonsEnabled(true);
		}
	}

	/**
	 * @param enabled Whether the buttons may be pressed.
	 * @returns Nothing.
	 */
	private static _setButtonsEnabled(enabled: boolean): void {
		for (const id of ['storage-button', 'fill-button', 'measure-button']) {
			Main._button(id).disabled = enabled === false;
		}
	}

	/**
	 * @param id The button's identifier.
	 * @returns The button.
	 */
	private static _button(id: string): HTMLButtonElement {
		return document.getElementById(id) as HTMLButtonElement;
	}

	/**
	 * @param text The phase heading.
	 * @returns Nothing.
	 */
	private static _phase(text: string): void {
		Main._write(`\n${text}\n`, 'phase');
	}

	/**
	 * @param text The line.
	 * @returns Nothing.
	 */
	private static _line(text: string): void {
		Main._write(`${text}\n`, undefined);
	}

	/**
	 * @param text The line, shown as a success.
	 * @returns Nothing.
	 */
	private static _pass(text: string): void {
		Main._write(`${text}\n`, 'pass');
	}

	/**
	 * @param text The line, shown as a failure.
	 * @returns Nothing.
	 */
	private static _fail(text: string): void {
		Main._write(`${text}\n`, 'fail');
	}

	/**
	 * @param text The line, shown as a warning.
	 * @returns Nothing.
	 */
	private static _warning(text: string): void {
		Main._write(`${text}\n`, 'warning');
	}

	/**
	 * Replaces the last line, so progress does not fill the page.
	 *
	 * @param text The new last line.
	 * @returns Nothing.
	 */
	private static _replaceLastLine(text: string): void {
		const last = Main._output.lastElementChild;
		if (last !== null && last.getAttribute('data-progress') === 'yes') {
			last.textContent = `${text}\n`;
			return;
		}
		const element = document.createElement('span');
		element.setAttribute('data-progress', 'yes');
		element.textContent = `${text}\n`;
		Main._output.appendChild(element);
	}

	/**
	 * @param text What to write.
	 * @param className Which style to write it in, or undefined for the ordinary one.
	 * @returns Nothing.
	 */
	private static _write(text: string, className: string | undefined): void {
		const element = document.createElement('span');
		if (className !== undefined) {
			element.className = className;
		}
		element.textContent = text;
		Main._output.appendChild(element);
		Main._output.scrollTop = Main._output.scrollHeight;
	}

	/**
	 * @param bytes A byte count.
	 * @returns It in gigabytes, to two places.
	 */
	private static _gigabytes(bytes: number): string {
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
	}

	/**
	 * @param bytes A byte count.
	 * @returns It in megabytes, to two places.
	 */
	private static _megabytes(bytes: number): string {
		return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	}

	/**
	 * @param bytesEachSecond A rate.
	 * @returns It in megabytes each second, to one place.
	 */
	private static _megabytesEachSecond(bytesEachSecond: number): string {
		return `${(bytesEachSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	}
}

Main.start();
