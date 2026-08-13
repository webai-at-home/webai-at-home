import { Tokenizer } from '@huggingface/tokenizers';
import type { GenerationRequest, GenerationResponse } from './generation_worker_messages.js';
import type { ModelIndex, RunOutcome } from './model_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Main — the page side of milestone 5 of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The page owns the tokenizer, the printing, and the comparison. Everything else — the file handle, the WebGPU
 * device, all eighteen graphs, the cache, and the model loop — lives in the worker, because the synchronous access
 * handle of the Origin Private File System exists only there and because moving an expert costs a copy on whichever
 * thread does the moving.
 */

/** Where the development server serves the built graphs from. */
const GRAPHS_URL = '/olmoe-artifacts/graphs';
/** Where it serves the expert block file from, with the byte range support Hugging Face gives. */
const BLOCKS_URL = '/olmoe-artifacts/blocks/expert_blocks.bin';
/** How many tokens each run generates. Short, because the question is answered by a sentence. */
const NEW_TOKEN_COUNT = 24;
/**
 * How many experts one token wants, across the whole model: every layer chooses eight, and no two layers share an
 * expert. This is the number every cache size below is chosen against, and it is what makes a cache of 64 unable to
 * hit even once.
 */
const WORKING_SET = 128;
/**
 * How many experts the two streamed runs may hold at once, out of 1024.
 *
 * Two sizes, one either side of the working set, because one size cannot show both things this page has to show.
 *
 * A cache of 192 holds half as much again as one token wants, so experts survive from one token to the next and the
 * least-recently-used policy has something to be right about. A cache of 64 holds less than one token wants, so every
 * expert is evicted before the next token asks for it again and the hit rate is exactly zero by arithmetic rather
 * than by any fault of the cache. That second one is the harder test of this milestone: every single expert is read
 * off the disk, and the tokens still have to come out identical.
 */
const STREAMED_SLOT_COUNTS = [192, 64];
/**
 * How many tokens are generated and thrown away before anything is timed.
 *
 * The first run of a graph compiles its shaders, and there are eighteen graphs. Without this the first run measured
 * would carry all of that and the later runs would not, and comparing them would be comparing compilation against
 * arithmetic.
 */
const WARM_UP_TOKEN_COUNT = 2;

/** Everything the page keeps between phases. */
class Main {
	/** The worker holding the model. */
	static worker: Worker | undefined;
	/** What `graphs.json` said. */
	static index: ModelIndex | undefined;
	/** The tokenizer, for turning the prompt into ids and the ids back into words. */
	static tokenizer: Tokenizer | undefined;
	/** Where the page prints. */
	static output: HTMLPreElement | undefined;
	/** What each run has produced so far, so the page can print the text as it arrives. */
	static readonly generated = new Map<string, number[]>();
	/** Every line printed so far, kept so that the last one can be replaced without searching the page's markup. */
	static readonly lines: string[] = [];

	/**
	 * Wires the button up.
	 *
	 * @returns Nothing.
	 */
	static start(): void {
		Main.output = document.getElementById('output') as HTMLPreElement;
		const button = document.getElementById('run-button') as HTMLButtonElement;
		button.disabled = false;
		button.textContent = 'Run it twice';
		button.addEventListener('click', () => {
			button.disabled = true;
			button.textContent = 'Running…';
			Main.run().catch((error: unknown) => {
				Main._print(`<span class="fail">${error instanceof Error ? error.message : String(error)}</span>`);
			}).finally(() => {
				button.disabled = false;
				button.textContent = 'Run it twice again';
			});
		});
	}

	/**
	 * Runs every phase in order and prints a verdict.
	 *
	 * @returns Resolves once the verdict has been printed.
	 */
	static async run(): Promise<void> {
		Main.lines.length = 0;
		Main.generated.clear();
		Main._print('OLMoE-1B-7B-0924, generated twice: once with every expert resident, once streamed from disk.\n');

		if (Main.worker === undefined) {
			Main.worker = new Worker(new URL('./generation_worker.ts', import.meta.url), {
				type: 'module',
			});
		}

		Main._print('<span class="phase">1 · the block store</span>');
		const opened = await Main._ask({
			kind: 'open-store',
			graphsUrl: GRAPHS_URL,
		}, 'store-opened');
		Main.index = opened.index;
		Main._print(`  ${opened.index.sourceRepository} at ${opened.index.sourceRevision.slice(0, 12)}`);
		Main._print(`  ${opened.index.layerCount} layers, ${opened.index.expertsForEachLayer} experts each, ` +
			`${opened.index.expertsForEachToken} chosen for each token, hidden size ${opened.index.hiddenSize}`);
		Main._print(`  ${opened.presentBlockCount} of ${opened.wantedBlockCount} expert blocks are already on disk`);

		if (opened.presentBlockCount < opened.wantedBlockCount) {
			const filled = await Main._ask({
				kind: 'fill-store',
				blocksUrl: BLOCKS_URL,
			}, 'store-filled', (message) => {
				if (message.kind === 'fill-progress') {
					Main._replaceLastLine(
						`  filling: ${message.presentBlockCount} of ${message.wantedBlockCount} blocks, ` +
							`${(message.bytesEachSecond / 1024 / 1024).toFixed(0)} megabytes each second`,
					);
				}
			});
			Main._print(`  filled in ${filled.seconds.toFixed(1)} seconds, ` +
				`${(filled.downloadedByteLength / 1024 / 1024 / 1024).toFixed(2)} gigabytes copied`);
		}

		Main._print('\n<span class="phase">2 · the tokenizer and the prompt</span>');
		Main.tokenizer = await Main._loadTokenizer(opened.index);
		const prompt = (document.getElementById('prompt-input') as HTMLInputElement).value;
		const promptTokenIds = Main.tokenizer.encode(prompt).ids;
		Main._print(`  ${JSON.stringify(prompt)} is ${promptTokenIds.length} tokens: ${promptTokenIds.join(', ')}`);

		Main._print('\n<span class="phase">3 · eighteen graphs, and the device the runtime chose</span>');
		const loaded = await Main._ask({
			kind: 'load-graphs',
		}, 'graphs-loaded');
		Main._print(`  loaded in ${loaded.seconds.toFixed(1)} seconds, ` +
			`${(loaded.byteLength / 1024 / 1024 / 1024).toFixed(2)} gigabytes of graphs and embedding`);
		Main._print(`  the largest buffer the runtime's device allows is ` +
			`${(loaded.maximumBufferByteLength / 1024 / 1024 / 1024).toFixed(2)} gigabytes`);

		const expertCount = opened.index.layerCount * opened.index.expertsForEachLayer;
		Main._print('\n<span class="phase">4 · a warm-up, thrown away, so that no run is timed while it ' +
			'compiles shaders</span>');
		await Main._runOnce('warm-up', WORKING_SET, false, promptTokenIds, WARM_UP_TOKEN_COUNT);

		Main._print(`\n<span class="phase">5 · every expert resident: a cache of all ${expertCount}</span>`);
		const resident = await Main._runOnce('resident', expertCount, true, promptTokenIds, NEW_TOKEN_COUNT);

		const streamed: RunOutcome[] = [];
		let phase = 6;
		for (const slotCount of STREAMED_SLOT_COUNTS) {
			Main._print(`\n<span class="phase">${phase} · through the residency layer: a cache of ${slotCount}, ` +
				`which is ${((slotCount / expertCount) * 100).toFixed(1)} per cent of the model and ` +
				`${(slotCount / WORKING_SET).toFixed(2)} times what one token wants</span>`);
			streamed.push(await Main._runOnce(`streamed-${slotCount}`, slotCount, false, promptTokenIds, NEW_TOKEN_COUNT));
			phase++;
		}

		Main._print(`\n<span class="phase">${phase} · the comparison</span>`);
		Main._compare(resident, streamed);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Running and comparing
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the model once and prints what it produced as it arrives.
	 *
	 * @param label What to call this run.
	 * @param slotCount How many experts the cache may hold.
	 * @param preloadEveryExpert Whether to read every expert in before generating.
	 * @param promptTokenIds The prompt.
	 * @param newTokenCount How many tokens to generate.
	 * @returns What the run produced and cost.
	 */
	static async _runOnce(
		label: string,
		slotCount: number,
		preloadEveryExpert: boolean,
		promptTokenIds: number[],
		newTokenCount: number,
	): Promise<RunOutcome> {
		Main.generated.set(label, []);
		Main._print('  ');
		const finished = await Main._ask({
			kind: 'run',
			label: label,
			slotCount: slotCount,
			preloadEveryExpert: preloadEveryExpert,
			promptTokenIds: promptTokenIds,
			newTokenCount: newTokenCount,
		}, 'run-finished', (message) => {
			if (message.kind === 'token') {
				const produced = Main.generated.get(message.label)!;
				produced.push(message.tokenId);
				Main._replaceLastLine(`  <span class="text">${Main._escape(Main._decode(produced))}</span>`);
			}
		});

		const outcome = finished.outcome;
		const missCount = outcome.lookupCount - outcome.hitCount;
		if (outcome.preloadMilliseconds > 0) {
			Main._print(`  read all ${slotCount} experts in first, in ` +
				`${(outcome.preloadMilliseconds / 1000).toFixed(1)} seconds`);
		}
		Main._print(`  ${outcome.lookupCount} expert lookups, ${outcome.hitCount} already resident ` +
			`(${((outcome.hitCount / outcome.lookupCount) * 100).toFixed(1)} per cent), ` +
			`${missCount} read from disk`);
		Main._print(`  ${(outcome.readByteLength / 1024 / 1024).toFixed(0)} megabytes read while generating, ` +
			`${(outcome.generateMilliseconds / 1000).toFixed(1)} seconds, ` +
			`${(newTokenCount / (outcome.generateMilliseconds / 1000)).toFixed(2)} tokens each second`);
		return outcome;
	}

	/**
	 * Compares every streamed run against the resident one, token by token, and prints the verdict.
	 *
	 * @param resident What the run with every expert resident produced.
	 * @param streamed What the runs through the residency layer produced.
	 * @returns Nothing.
	 */
	static _compare(resident: RunOutcome, streamed: RunOutcome[]): void {
		Main._print(`  ${'run'.padEnd(16)}${'slots'.padStart(7)}${'hit rate'.padStart(11)}` +
			`${'read'.padStart(13)}${'tokens each second'.padStart(20)}`);
		for (const outcome of [resident, ...streamed]) {
			Main._print(`  ${outcome.label.padEnd(16)}${String(outcome.slotCount).padStart(7)}` +
				`${`${((outcome.hitCount / outcome.lookupCount) * 100).toFixed(1)} %`.padStart(11)}` +
				`${`${(outcome.readByteLength / 1024 / 1024).toFixed(0)} MB`.padStart(13)}` +
				`${(NEW_TOKEN_COUNT / (outcome.generateMilliseconds / 1000)).toFixed(2).padStart(20)}`);
		}

		Main._print('');
		const differing = streamed.filter((outcome) => {
			return Main._firstDifference(resident.tokenIds, outcome.tokenIds) !== -1;
		});
		if (differing.length === 0) {
			Main._print(`<span class="pass">MILESTONE 5 GREEN — every run produced the same ` +
				`${resident.tokenIds.length} token identifiers, in the same order.</span>`);
			Main._print('  The residency layer changes where the weights are and nothing else.');
			Main._print(`  <span class="text">${Main._escape(Main._decode(resident.tokenIds))}</span>`);
			return;
		}

		Main._print(`<span class="fail">MILESTONE 5 RED — ${differing.length} of ${streamed.length} streamed runs ` +
			'parted company with the resident one.</span>');
		for (const outcome of differing) {
			const at = Main._firstDifference(resident.tokenIds, outcome.tokenIds);
			Main._print(`  ${outcome.label} differs from token ${at}: resident chose ${resident.tokenIds[at]} ` +
				`(${JSON.stringify(Main._decode([resident.tokenIds[at]]))}), it chose ${outcome.tokenIds[at]} ` +
				`(${JSON.stringify(Main._decode([outcome.tokenIds[at]]))})`);
			Main._print(`  <span class="text">${Main._escape(Main._decode(outcome.tokenIds))}</span>`);
		}
		Main._print(`  resident: <span class="text">${Main._escape(Main._decode(resident.tokenIds))}</span>`);
	}

	/**
	 * Finds the first place two token sequences differ.
	 *
	 * @param first One sequence.
	 * @param second The other.
	 * @returns The index of the first difference, or -1 when they are equal.
	 */
	static _firstDifference(first: number[], second: number[]): number {
		const shortest = Math.min(first.length, second.length);
		for (let index = 0; index < shortest; index++) {
			if (first[index] !== second[index]) {
				return index;
			}
		}
		return first.length === second.length ? -1 : shortest;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
					reject(new Error(`${message.requestKind} failed: ${message.message}`));
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
	 * @param index What `graphs.json` said, for the repository and the revision.
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
	 * Escapes text that came out of the model, so that a model which produces something looking like markup does not
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
	 * Replaces the last printed line, so that progress and generated text grow in place rather than scrolling away.
	 *
	 * The lines are kept in an array rather than found again inside the page's own markup. Looking for the last line
	 * break in the markup worked until the model generated a line break of its own, at which point every further
	 * token replaced part of the model's output instead of the whole line.
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
