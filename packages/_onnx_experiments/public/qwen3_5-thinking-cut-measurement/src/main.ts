import { env, pipeline, TextStreamer, InterruptableStoppingCriteria, type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Thinking cut measurement for issue #226, Qwen3.5-0.8B in a worker browser tab
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts,
// so this measurement reads the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const MODEL_REVISION = 'c0d619322dad7c4441a8841a53fc59772ddddcc0';
const MODEL_DTYPE = 'q4f16';

// The marker this model's own chat template closes a thinking block with. The template opens the block itself,
// in the generation prompt, so the model writes only the closing marker.
const THINKING_CLOSE_MARKER = '</think>';

// The exact history packages/_openai_conformance_test_TOREMOVE/src/tests/chat/multi_turn.ts sends, which is the
// history issue #226 recorded running away to its cap without ever closing its thinking.
const MULTI_TURN_HISTORY = [
	{
		role: 'user',
		content: 'Remember the number 42.',
	},
	{
		role: 'assistant',
		content: 'Okay.',
	},
	{
		role: 'user',
		content: 'Repeat the number I just gave you, and nothing else.',
	},
];

// A settled question with nothing to work out, asked because issue #226 recorded only the runaway above. A model
// that closes its thinking on any question closes it on this one, and a cut can only be read against a run that
// closed.
const SETTLED_QUESTION_HISTORY = [
	{
		role: 'user',
		content: 'What is the capital of France?',
	},
];

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/qwen3_5-thinking-control-gate/src/main.ts, same database
// name, so a browser that already ran that page does not re-download the model for this one.
function createIndexedDbCache(): IndexedDbCache | null {
	if (typeof indexedDB === 'undefined' || typeof Response === 'undefined') { return null; }
	const databaseName = 'webai-onnx-experiments';
	const storeName = 'model-files';
	let databasePromise: Promise<IDBDatabase> | undefined;
	function openDatabase() {
		if (databasePromise === undefined) {
			databasePromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(databaseName, 1);
				request.onupgradeneeded = () => request.result.createObjectStore(storeName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}
		return databasePromise;
	}
	async function read(key: string): Promise<CacheEntry | undefined> {
		const database = await openDatabase();
		return new Promise((resolve, reject) => {
			const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}
	async function write(key: string, value: CacheEntry): Promise<void> {
		const database = await openDatabase();
		return new Promise((resolve, reject) => {
			const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
	return {
		async match(key) {
			try {
				const entry = await read(key);
				if (entry === undefined) { return undefined; }
				return new Response(entry.body, { status: entry.status, headers: entry.headers });
			} catch (error) {
				console.warn('Unable to read the IndexedDB model cache:', error);
				return undefined;
			}
		},
		async put(key, response, progressCallback) {
			try {
				const body = await response.arrayBuffer();
				const headers: Record<string, string> = {};
				response.headers.forEach((value, headerName) => { headers[headerName] = value; });
				await write(key, { body, headers, status: response.status });
				progressCallback?.({ loaded: body.byteLength, total: body.byteLength, progress: 100 });
			} catch (error) {
				console.warn('Unable to write the IndexedDB model cache:', error);
			}
		},
	};
}
const indexedDbCache = createIndexedDbCache();
if (indexedDbCache !== null) {
	env.useBrowserCache = false;
	env.useCustomCache = true;
	env.customCache = indexedDbCache;
} else {
	env.useBrowserCache = true;
}

const buttonElement = document.querySelector<HTMLButtonElement>('#run-button');
const outputElement = document.querySelector<HTMLElement>('#output');
if (buttonElement === null || outputElement === null) { throw new Error('The page must contain #run-button and #output.'); }
// Re-bound to a definitely-non-null type: log() and loadedGenerator() below are closures declared later in this
// module, and TypeScript does not carry the null-check above through a closure boundary on its own.
const button: HTMLButtonElement = buttonElement;
const output: HTMLElement = outputElement;

function log(message: string, className?: string): void {
	const line = document.createElement('div');
	if (className !== undefined) { line.className = className; }
	line.textContent = message;
	output.appendChild(line);
	console.log(message);
}

let generatorPromise: Promise<TextGenerationPipeline> | undefined;
function loadedGenerator(): Promise<TextGenerationPipeline> {
	if (generatorPromise !== undefined) { return generatorPromise; }
	generatorPromise = pipeline('text-generation', MODEL_ID, {
		revision: MODEL_REVISION,
		device: 'webgpu',
		dtype: MODEL_DTYPE,
		progress_callback: (progress: { status: string; file?: string; progress?: number }) => {
			if (progress.status === 'progress' && progress.file !== undefined) {
				const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress ?? 0)}%` : '';
				button.textContent = `Downloading ${progress.file}${percent}…`;
			}
		},
	});
	return generatorPromise;
}

/**
 * The cut this measurement is here to read: the answer is everything the model wrote after its closing marker.
 *
 * Written the way this model's own chat template separates a past assistant message's reasoning from its content,
 * `content.split('</think>')[-1].lstrip('\n')`, rather than guessed at. A run that never wrote the marker never
 * left its thinking, so it holds no answer at all.
 *
 * @param text The text the model wrote, decoded the way the stage helper decodes it.
 * @returns The answer alone, empty when the model never closed its thinking.
 */
function afterTheThinking(text: string): string {
	const markerIndex = text.lastIndexOf(THINKING_CLOSE_MARKER);
	if (markerIndex === -1) { return ''; }
	return text.slice(markerIndex + THINKING_CLOSE_MARKER.length).replace(/^\n+/, '');
}

/**
 * One generation run, decoded exactly the way the real stage helper decodes what it serves a consumer.
 *
 * `skip_special_tokens: true` is the difference from the issue #192 page, and it is the whole point here: the
 * stage helper serves what that setting leaves behind, so the marker a cut looks for has to survive it.
 *
 * @param generator The loaded pipeline.
 * @param history The messages to answer.
 * @param isThinkingEnabled What to pass as `enable_thinking`.
 * @param maxNewTokens The cap this run is allowed.
 * @returns The answer text, the tokens generated, how long the run took, and how the text arrived in pieces.
 */
async function runGeneration(
	generator: TextGenerationPipeline,
	history: { role: string; content: string }[],
	isThinkingEnabled: boolean,
	maxNewTokens: number,
): Promise<{ text: string; tokenCount: number; wallMs: number; markerChunk: string | undefined }> {
	let text = '';
	let tokenCount = 0;
	// The piece the closing marker arrived in, kept because a cut made on streamed text has to know whether the
	// marker arrives whole or split across two pieces.
	let markerChunk: string | undefined = undefined;
	const criteria = new InterruptableStoppingCriteria();
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
		callback_function: (chunk: string) => {
			if (markerChunk === undefined && chunk.includes(THINKING_CLOSE_MARKER) === true) {
				markerChunk = chunk;
			}
			text += chunk;
		},
		token_callback_function: (newTokens: bigint[]) => {
			tokenCount += newTokens.length;
		},
	});
	const startedAt = performance.now();
	await generator(history, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		tokenizer_encode_kwargs: { enable_thinking: isThinkingEnabled },
		stopping_criteria: criteria,
		streamer,
	});
	const wallMs = performance.now() - startedAt;
	return { text, tokenCount, wallMs, markerChunk };
}

/**
 * Runs one phase and writes down everything the fix needs from it.
 *
 * @param generator The loaded pipeline.
 * @param history The messages to answer.
 * @param isThinkingEnabled What to pass as `enable_thinking`.
 * @param maxNewTokens The cap this run is allowed.
 * @returns Nothing.
 */
async function measure(
	generator: TextGenerationPipeline,
	history: { role: string; content: string }[],
	isThinkingEnabled: boolean,
	maxNewTokens: number,
): Promise<void> {
	const run = await runGeneration(generator, history, isThinkingEnabled, maxNewTokens);
	log(`  generated ${run.tokenCount} tokens in ${run.wallMs.toFixed(0)} ms`);
	log(`  reached the ${maxNewTokens} cap = ${run.tokenCount >= maxNewTokens}`);
	log(`  text holds an opening <think> marker  = ${run.text.includes('<think>')}`);
	log(`  text holds a closing </think> marker  = ${run.text.includes(THINKING_CLOSE_MARKER)}`);
	log(`  the piece the closing marker arrived in = ${JSON.stringify(run.markerChunk)}`);
	log(`  text as decoded: ${JSON.stringify(run.text)}`);
	log(`  the cut leaves: ${JSON.stringify(afterTheThinking(run.text))}`);
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	try {
		log('Loading model…', 'phase');
		const generator = await loadedGenerator();
		log('Model loaded.');

		// Phase 1 — thinking on, a settled question. If the model closes its thinking anywhere, it closes it here,
		// and this is the run a cut can be read against.
		log('', undefined);
		log('Phase 1 — enable_thinking: true, "What is the capital of France?", cap = 2048', 'phase');
		await measure(generator, SETTLED_QUESTION_HISTORY, true, 2048);

		// Phase 2 — thinking on, the history issue #226 recorded reaching its cap still thinking. Rerun under
		// skip_special_tokens: true, because that is the decoding the stage helper serves and the earlier run was
		// recorded under the other one.
		log('', undefined);
		log('Phase 2 — enable_thinking: true, the issue #192 multi-turn history, cap = 2048', 'phase');
		await measure(generator, MULTI_TURN_HISTORY, true, 2048);

		// Phase 3 — thinking off, the control. The template closes the thinking block in the prompt itself, so the
		// model writes no marker at all, and a cut must never be applied to a run like this one.
		log('', undefined);
		log('Phase 3 — enable_thinking: false, "What is the capital of France?", cap = 512', 'phase');
		await measure(generator, SETTLED_QUESTION_HISTORY, false, 512);

		log('', undefined);
		log('Measurement complete. Copy the three phases above verbatim into issue #226.', 'phase');
	} catch (error: unknown) {
		log(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`, 'fail');
	} finally {
		button.disabled = false;
		button.textContent = 'Run again';
	}
});

button.textContent = 'Loading model…';
void loadedGenerator().then(() => {
	button.disabled = false;
	button.textContent = 'Run measurement';
}).catch((error: unknown) => {
	log(`Model failed to load: ${error instanceof Error ? error.message : String(error)}`, 'fail');
});
