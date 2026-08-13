import { Tokenizer } from '@huggingface/tokenizers';
import type { GenerationRequest, GenerationResponse } from './generation_worker_messages.js';
import type { ExpertStorage, ModelIndex, RunOutcome } from './model_types.js';
import { ResidencyCurve } from './residency_curve.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — the page side of milestone 6 of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Milestone 6 asks for two things: Qwen3-30B-A3B generating on a machine whose graphics memory cannot hold it, and
 * the curve of issue #168 — model size against tokens each second, with a line for each of the three places weights
 * can live.
 *
 * The three lines are three runs of the same model through the same graphs with the same arithmetic. What separates
 * them is only what has to happen before an expert can be multiplied by anything. A line that stops is a storage
 * class that cannot hold the model, and that is the finding rather than a failure of the run.
 */

/** Where the development server serves each model's artifacts from. */
const ARTIFACTS_URL = '/moe-artifacts';
/** How many tokens each run generates. */
const NEW_TOKEN_COUNT = 16;
/** How many tokens are generated and thrown away first, so that no run is timed while it compiles shaders. */
const WARM_UP_TOKEN_COUNT = 2;
/**
 * How many experts the cache holds when the experts are not all in graphics memory.
 *
 * One and a half times what a single token wants, so that experts survive from one token to the next and the
 * least-recently-used policy has something to be right about. Milestone 5 measured that a cache below one token's
 * working set hits exactly zero times, which measures the store's bandwidth rather than the design.
 */
const CACHE_MULTIPLE_OF_WORKING_SET = 1.5;

/**
 * The three storage classes, in the order they are run and drawn.
 *
 * They are run smallest demand first, and that order is deliberate. A storage class that cannot hold the model fails
 * by asking for memory it cannot have, and an allocation that large can lose the WebGPU device rather than merely
 * refusing. A lost device would take every run after it down as well, so the run that always works is done first and
 * the run most likely to fail is done last, where the only thing it can cost is itself.
 */
const STORAGE_CLASSES: { storage: ExpertStorage; title: string }[] = [
	{
		storage: 'disk',
		title: 'every expert on disk, in the Origin Private File System',
	},
	{
		storage: 'main-memory',
		title: 'every expert in main memory',
	},
	{
		storage: 'graphics-memory',
		title: 'every expert in graphics memory',
	},
];

/** Everything the page keeps between phases. */
class Main {
	/** The worker holding the model. */
	static worker: Worker | undefined;
	/** Which model is loaded in that worker, so a change of model gets a new one. */
	static loadedModelName: string | undefined;
	/** What `graphs.json` said. */
	static index: ModelIndex | undefined;
	/** The tokenizer. */
	static tokenizer: Tokenizer | undefined;
	/** Where the page prints. */
	static output: HTMLPreElement | undefined;
	/** What each run has produced so far. */
	static readonly generated = new Map<string, number[]>();
	/** Every line printed so far. */
	static readonly lines: string[] = [];
	/** Every run of every model this page has completed, which is what the curve is drawn from. */
	static readonly measured: { modelName: string; expertByteLength: number; outcome: RunOutcome }[] = [];

	/**
	 * Wires the button up.
	 *
	 * @returns Nothing.
	 */
	static start(): void {
		Main.output = document.getElementById('output') as HTMLPreElement;
		const button = document.getElementById('run-button') as HTMLButtonElement;
		button.disabled = false;
		button.textContent = 'Run it';
		button.addEventListener('click', () => {
			button.disabled = true;
			button.textContent = 'Running…';
			Main.run().catch((error: unknown) => {
				Main._print(`<span class="fail">${error instanceof Error ? error.message : String(error)}</span>`);
			}).finally(() => {
				button.disabled = false;
				button.textContent = 'Run it again';
			});
		});
	}

	/**
	 * Runs every phase in order and draws the curve.
	 *
	 * @returns Resolves once everything has been printed and drawn.
	 */
	static async run(): Promise<void> {
		const modelName = (document.getElementById('model-select') as HTMLSelectElement).value;
		Main.lines.length = 0;
		Main.generated.clear();
		Main._print(`${modelName}, generated once for each of the three places its experts can live.\n`);

		// A worker for each model. The graphs of one model are a gigabyte or more of graphics memory, and keeping two
		// sets alive to save a page reload would measure the swap file.
		if (Main.worker !== undefined && Main.loadedModelName !== modelName) {
			Main.worker.terminate();
			Main.worker = undefined;
		}
		if (Main.worker === undefined) {
			Main.worker = new Worker(new URL('./generation_worker.ts', import.meta.url), {
				type: 'module',
			});
			Main.loadedModelName = modelName;
		}

		Main._print('<span class="phase">1 · the block store</span>');
		const opened = await Main._ask({
			kind: 'open-store',
			graphsUrl: `${ARTIFACTS_URL}/${modelName}/graphs`,
			modelName: modelName,
		}, 'store-opened');
		const index = opened.index;
		Main.index = index;
		const expertCount = index.layerCount * index.expertsForEachLayer;
		const expertByteLength = expertCount * index.expertBlocks.blockByteLength;
		Main._print(`  ${index.sourceRepository} at ${index.sourceRevision.slice(0, 12)}`);
		Main._print(`  ${index.layerCount} layers, ${index.expertsForEachLayer} experts each, ` +
			`${index.expertsForEachToken} chosen for each token of each layer`);
		Main._print(`  ${index.headCount} query heads and ${index.keyValueHeadCount} key and value heads of ` +
			`${index.headDimension}, hidden size ${index.hiddenSize}, vocabulary ${index.vocabularySize}`);
		Main._print(`  ${expertCount} expert blocks, ${Main._gigabytes(expertByteLength)} in total, of which ` +
			`${opened.presentBlockCount} are already on disk`);

		if (opened.presentBlockCount < opened.wantedBlockCount) {
			const filled = await Main._ask({
				kind: 'fill-store',
				blocksUrl: `${ARTIFACTS_URL}/${modelName}/blocks/expert_blocks.bin`,
			}, 'store-filled', (message) => {
				if (message.kind === 'fill-progress') {
					Main._replaceLastLine(
						`  filling: ${message.presentBlockCount} of ${message.wantedBlockCount} blocks, ` +
							`${(message.bytesEachSecond / 1024 / 1024).toFixed(0)} megabytes each second`,
					);
				}
			});
			Main._print(`  filled in ${filled.seconds.toFixed(1)} seconds, ` +
				`${Main._gigabytes(filled.downloadedByteLength)} copied`);
		}

		Main._print('\n<span class="phase">2 · the tokenizer and the prompt</span>');
		Main.tokenizer = await Main._loadTokenizer(index);
		const prompt = (document.getElementById('prompt-input') as HTMLInputElement).value;
		const promptTokenIds = Main.tokenizer.encode(prompt).ids;
		Main._print(`  ${JSON.stringify(prompt)} is ${promptTokenIds.length} tokens: ${promptTokenIds.join(', ')}`);

		Main._print(`\n<span class="phase">3 · ${index.layerCount + 2} graphs, and the device the runtime ` +
			'chose</span>');
		const loaded = await Main._ask({
			kind: 'load-graphs',
		}, 'graphs-loaded');
		Main._print(`  loaded in ${loaded.seconds.toFixed(1)} seconds, ` +
			`${Main._gigabytes(loaded.byteLength)} of graphs and embedding`);
		Main._print(`  the largest buffer the runtime's device allows is ` +
			`${Main._gigabytes(loaded.maximumBufferByteLength)}`);

		const workingSet = index.layerCount * index.expertsForEachToken;
		const slotCount = Math.round(workingSet * CACHE_MULTIPLE_OF_WORKING_SET);
		Main._print('\n<span class="phase">4 · a warm-up, thrown away, so that no run is timed while it ' +
			'compiles shaders</span>');
		await Main._runOnce('warm-up', 'disk', slotCount, promptTokenIds, WARM_UP_TOKEN_COUNT, expertByteLength);

		let phase = 5;
		for (const storageClass of STORAGE_CLASSES) {
			Main._print(`\n<span class="phase">${phase} · ${storageClass.title}</span>`);
			try {
				await Main._runOnce(
					storageClass.storage,
					storageClass.storage,
					slotCount,
					promptTokenIds,
					NEW_TOKEN_COUNT,
					expertByteLength,
				);
			} catch (error) {
				Main._print(`  <span class="fail">this storage class cannot hold this model on this machine: ` +
					`${error instanceof Error ? error.message : String(error)}</span>`);
				Main._print('  That is the finding rather than a failure. The line for it stops before this size.');
			}
			phase++;
		}

		Main._print(`\n<span class="phase">${phase} · the curve</span>`);
		Main._drawCurve();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Running
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the model once and prints what it produced as it arrives.
	 *
	 * @param label What to call this run.
	 * @param storage Where the expert weights are kept.
	 * @param slotCount How many experts the cache may hold, when they are not all in graphics memory.
	 * @param promptTokenIds The prompt.
	 * @param newTokenCount How many tokens to generate.
	 * @param expertByteLength How many bytes every expert of this model comes to, for the curve.
	 * @returns What the run produced and cost.
	 */
	static async _runOnce(
		label: string,
		storage: ExpertStorage,
		slotCount: number,
		promptTokenIds: number[],
		newTokenCount: number,
		expertByteLength: number,
	): Promise<RunOutcome> {
		Main.generated.set(label, []);
		Main._print('  ');
		const finished = await Main._ask({
			kind: 'run',
			label: label,
			storage: storage,
			slotCount: slotCount,
			promptTokenIds: promptTokenIds,
			newTokenCount: newTokenCount,
		}, 'run-finished', (message) => {
			if (message.kind === 'run-preparing') {
				Main._replaceLastLine(`  ${message.message}…`);
			} else if (message.kind === 'token') {
				const produced = Main.generated.get(message.label)!;
				produced.push(message.tokenId);
				Main._replaceLastLine(`  <span class="text">${Main._escape(Main._decode(produced))}</span>`);
			}
		});

		const outcome = finished.outcome;
		if (outcome.preloadMilliseconds > 0) {
			Main._print(`  read every expert in first, in ${(outcome.preloadMilliseconds / 1000).toFixed(1)} seconds`);
		}
		Main._print(`  ${outcome.lookupCount} expert lookups, ${outcome.hitCount} already in graphics memory ` +
			`(${((outcome.hitCount / outcome.lookupCount) * 100).toFixed(1)} per cent), ` +
			`${Main._gigabytes(outcome.readByteLength)} moved while generating`);
		Main._print(`  ${(outcome.generateMilliseconds / 1000).toFixed(1)} seconds for ${newTokenCount} tokens, ` +
			`${Main._tokensEachSecond(outcome).toFixed(3)} tokens each second, ` +
			`${(outcome.stalledMilliseconds / outcome.generateMilliseconds * 100).toFixed(0)} per cent of it stalled ` +
			'making experts available');

		if (label !== 'warm-up') {
			Main.measured.push({
				modelName: Main.loadedModelName!,
				expertByteLength: expertByteLength,
				outcome: outcome,
			});
		}
		return outcome;
	}

	/**
	 * Draws every run this page has done as the curve issue #168 asks for.
	 *
	 * @returns Nothing.
	 */
	static _drawCurve(): void {
		const grouped = new Map<ExpertStorage, { size: number; rate: number; label: string }[]>();
		for (const entry of Main.measured) {
			const points = grouped.get(entry.outcome.storage) ?? [];
			points.push({
				size: entry.expertByteLength,
				rate: Main._tokensEachSecond(entry.outcome),
				label: entry.modelName,
			});
			grouped.set(entry.outcome.storage, points);
		}

		ResidencyCurve.draw(document.getElementById('curve') as unknown as SVGSVGElement, grouped);

		Main._print(`  ${'storage'.padEnd(18)}${'model'.padEnd(20)}${'experts'.padStart(10)}` +
			`${'tokens each second'.padStart(20)}`);
		for (const entry of Main.measured) {
			Main._print(`  ${entry.outcome.storage.padEnd(18)}${entry.modelName.padEnd(20)}` +
				`${Main._gigabytes(entry.expertByteLength).padStart(10)}` +
				`${Main._tokensEachSecond(entry.outcome).toFixed(3).padStart(20)}`);
		}
		Main._print('');
		Main._print('  Run the other model as well to give every line a second point. Everything measured so far is');
		Main._print('  kept, so the curve fills in as the runs are done.');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Works out how many tokens a second one run managed.
	 *
	 * The preloading is deliberately left out. It is paid once for a whole conversation rather than for each token,
	 * and folding it in would make the graphics memory line look worse the shorter the run was.
	 *
	 * @param outcome The run.
	 * @returns Tokens each second.
	 */
	static _tokensEachSecond(outcome: RunOutcome): number {
		return outcome.newTokenCount / (outcome.generateMilliseconds / 1000);
	}

	/**
	 * Sends one request and waits for the answer it names, passing every message before it to a listener.
	 *
	 * @param request What to ask for.
	 * @param awaitedKind Which answer ends the wait.
	 * @param onProgress Called with every message that arrives before it.
	 * @returns The awaited answer.
	 */
	static _ask<Kind extends GenerationResponse['kind']>(
		request: GenerationRequest,
		awaitedKind: Kind,
		onProgress?: (message: GenerationResponse) => void,
	): Promise<Extract<GenerationResponse, { kind: Kind }>> {
		return new Promise((resolve, reject) => {
			const worker = Main.worker!;
			const listener = (event: MessageEvent<GenerationResponse>): void => {
				const message = event.data;
				if (message.kind === 'failed') {
					worker.removeEventListener('message', listener);
					reject(new Error(message.message));
					return;
				}
				if (message.kind === awaitedKind) {
					worker.removeEventListener('message', listener);
					resolve(message as Extract<GenerationResponse, { kind: Kind }>);
					return;
				}
				onProgress?.(message);
			};
			worker.addEventListener('message', listener);
			worker.postMessage(request);
		});
	}

	/**
	 * Builds the tokenizer from the published files, at the revision the conversion pinned.
	 *
	 * @param index What `graphs.json` said.
	 * @returns The tokenizer.
	 */
	static async _loadTokenizer(index: ModelIndex): Promise<Tokenizer> {
		const base = `https://huggingface.co/${index.sourceRepository}/resolve/${index.sourceRevision}`;
		const [definition, configuration] = await Promise.all([
			fetch(`${base}/tokenizer.json`).then((response) => response.json()),
			fetch(`${base}/tokenizer_config.json`).then((response) => response.json()),
		]);
		return new Tokenizer(definition, configuration);
	}

	/**
	 * Turns token ids back into words.
	 *
	 * @param tokenIds The ids.
	 * @returns The text.
	 */
	static _decode(tokenIds: number[]): string {
		return Main.tokenizer!.decode(tokenIds, {
			skip_special_tokens: true,
		});
	}

	/**
	 * Formats a byte count in gigabytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	static _gigabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	/**
	 * Escapes text that came out of the model, so that a model producing something that looks like markup does not
	 * have it treated as markup.
	 *
	 * @param text The text.
	 * @returns The escaped text.
	 */
	static _escape(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	/**
	 * Prints one line.
	 *
	 * @param line The line, which may hold the small set of span tags this page styles.
	 * @returns Nothing.
	 */
	static _print(line: string): void {
		Main.lines.push(line);
		Main._draw();
	}

	/**
	 * Replaces the last printed line, so that progress and generated text grow in place.
	 *
	 * @param line The replacement.
	 * @returns Nothing.
	 */
	static _replaceLastLine(line: string): void {
		Main.lines[Math.max(0, Main.lines.length - 1)] = line;
		Main._draw();
	}

	/**
	 * Writes every line into the page.
	 *
	 * @returns Nothing.
	 */
	static _draw(): void {
		Main.output!.innerHTML = `${Main.lines.join('\n')}\n`;
	}
}

Main.start();
