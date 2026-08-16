import { env, pipeline, TextStreamer, InterruptableStoppingCriteria, type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Thinking control de-risk gate for issue #192, Qwen3.5-0.8B in a worker browser tab
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const MODEL_REVISION = 'c0d619322dad7c4441a8841a53fc59772ddddcc0';
const MODEL_DTYPE = 'q4f16';

// The exact history packages/openai_conformance_test/src/tests/chat/multi_turn.ts sends. That test is the one
// issue #192 reports as failing, so the gate asks the model the question the test asks it.
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

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/qwen3_5-usage-metadata-gate/src/main.ts, same database
// name, so a browser that already ran that gate does not re-download the model for this one.
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
 * Renders the history through the chat template as text, so that the prompt one setting builds can be read
 * against the prompt the other builds.
 *
 * @param generator The loaded pipeline whose tokenizer holds the model's own chat template.
 * @param isThinkingEnabled What to pass as `enable_thinking`.
 * @returns The rendered prompt.
 */
function renderedPrompt(generator: TextGenerationPipeline, isThinkingEnabled: boolean): string {
	return (
		generator.tokenizer as unknown as {
			apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => string;
		}
	).apply_chat_template(MULTI_TURN_HISTORY, {
		tokenize: false,
		add_generation_prompt: true,
		enable_thinking: isThinkingEnabled,
	});
}

/**
 * Counts the tokens the chat template builds for one setting, the same call the real stage helper counts with.
 *
 * @param generator The loaded pipeline whose tokenizer holds the model's own chat template.
 * @param isThinkingEnabled What to pass as `enable_thinking`.
 * @returns The number of tokens the rendered prompt holds.
 */
function promptTokenCount(generator: TextGenerationPipeline, isThinkingEnabled: boolean): number | undefined {
	const tensor = (
		generator.tokenizer as unknown as {
			apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => { data?: ArrayLike<number> };
		}
	).apply_chat_template(MULTI_TURN_HISTORY, {
		tokenize: true,
		add_generation_prompt: true,
		enable_thinking: isThinkingEnabled,
		return_dict: false,
	});
	return tensor.data?.length;
}

/**
 * One generation run of the multi-turn history, with `enable_thinking` set the way this run is testing.
 *
 * `tokenizer_encode_kwargs` is the option the real stage helper passes `enable_thinking` through, so this run
 * exercises the same seam rather than a different one that happens to reach the same template.
 *
 * @param generator The loaded pipeline.
 * @param isThinkingEnabled What to pass as `enable_thinking`.
 * @param maxNewTokens The cap this run is allowed.
 * @returns The answer text, the tokens generated, and how long the run took.
 */
async function runGeneration(
	generator: TextGenerationPipeline,
	isThinkingEnabled: boolean,
	maxNewTokens: number,
): Promise<{ text: string; tokenCount: number; wallMs: number }> {
	let text = '';
	let tokenCount = 0;
	const criteria = new InterruptableStoppingCriteria();
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		skip_special_tokens: false,
		callback_function: (chunk: string) => {
			text += chunk;
		},
		token_callback_function: (newTokens: bigint[]) => {
			tokenCount += newTokens.length;
		},
	});
	const startedAt = performance.now();
	await generator(MULTI_TURN_HISTORY, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		tokenizer_encode_kwargs: { enable_thinking: isThinkingEnabled },
		stopping_criteria: criteria,
		streamer,
	});
	const wallMs = performance.now() - startedAt;
	return { text, tokenCount, wallMs };
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	try {
		log('Loading model…', 'phase');
		const generator = await loadedGenerator();
		log('Model loaded.');

		// Phase 1 — does the setting change the prompt at all? If both settings render the same text, the
		// control is accepted and dropped, exactly as LM Studio 0.4.20 drops chat_template_kwargs, and
		// nothing further is worth measuring.
		log('', undefined);
		log('Phase 1 — does enable_thinking change the rendered prompt?', 'phase');
		const promptWithThinkingOff = renderedPrompt(generator, false);
		const promptWithThinkingOn = renderedPrompt(generator, true);
		log(`  enable_thinking: false renders: ${JSON.stringify(promptWithThinkingOff)}`);
		log(`  enable_thinking: true  renders: ${JSON.stringify(promptWithThinkingOn)}`);
		log(`  the two rendered prompts differ = ${promptWithThinkingOff !== promptWithThinkingOn}`);
		log(`  prompt token count, thinking off = ${promptTokenCount(generator, false)}`);
		log(`  prompt token count, thinking on  = ${promptTokenCount(generator, true)}`);

		// Phase 2 — thinking off, which is what the stage hardcodes today. This is the behaviour that must
		// stay reachable, so it is measured rather than assumed to be unchanged.
		log('', undefined);
		log('Phase 2 — generate with enable_thinking: false (what the stage hardcodes today), cap = 512', 'phase');
		const thinkingOff = await runGeneration(generator, false, 512);
		log(`  generated ${thinkingOff.tokenCount} tokens in ${thinkingOff.wallMs.toFixed(0)} ms`);
		log(`  reached the 512 cap = ${thinkingOff.tokenCount >= 512}`);
		log(`  answer: ${JSON.stringify(thinkingOff.text)}`);

		// Phase 3 — thinking on, the setting the stage cannot reach today. The cap is deliberately generous,
		// so that a run that stops early stopped because the model finished, and a run that reaches the cap
		// is the same runaway issue #192 measured against LM Studio.
		log('', undefined);
		log('Phase 3 — generate with enable_thinking: true, cap = 2048', 'phase');
		const thinkingOn = await runGeneration(generator, true, 2048);
		log(`  generated ${thinkingOn.tokenCount} tokens in ${thinkingOn.wallMs.toFixed(0)} ms`);
		log(`  reached the 2048 cap = ${thinkingOn.tokenCount >= 2048}`);
		log(`  answer holds an opening <think> marker = ${thinkingOn.text.includes('<think>')}`);
		log(`  answer holds a closing </think> marker = ${thinkingOn.text.includes('</think>')}`);
		log(`  answer: ${JSON.stringify(thinkingOn.text)}`);

		log('', undefined);
		log('Gate complete. Copy the three phases above verbatim into issue #192.', 'phase');
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
	button.textContent = 'Run gate';
}).catch((error: unknown) => {
	log(`Model failed to load: ${error instanceof Error ? error.message : String(error)}`, 'fail');
});
