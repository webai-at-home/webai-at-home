import { env, pipeline, TextStreamer, InterruptableStoppingCriteria, type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	De-risk gate for issue #154, milestone 0: Llama 3.2 1B Instruct, complete model, one browser tab
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// The exact repository, revision, and quantization recorded in issue #154 as what a live run must
// confirm, so this gate proves the same model configuration the real stage would run, not a stand-in.
// onnx-community/Llama-3.2-1B-Instruct redirects to this longer identifier; the redirect target is
// pinned here rather than the shorter alias.
const MODEL_ID = 'onnx-community/Llama-3.2-1B-Instruct-ONNX';
const MODEL_REVISION = '14007543b6dc92de88daf96a9aa85d2f95ace6ef';
const MODEL_DTYPE = 'q4f16';

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

/** The minimal shape of the WebGPU adapter this gate reads, the same shape the real stage helper reads. */
type GpuAdapterLike = { features: { has(featureName: string): boolean } };
/** The minimal shape of `navigator.gpu` this gate reads. */
type GpuLike = { requestAdapter(): Promise<GpuAdapterLike | null> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/qwen3_5-usage-metadata-gate/src/main.ts,
// same database name, so a browser that already ran a sibling gate keeps its own separate store entries
// under this model's own cache keys.
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

/** Bytes actually reported downloaded for each file this gate's own model loading pass has seen. */
const downloadedBytesByFile = new Map<string, number>();

async function checkReadiness(): Promise<void> {
	log('Phase 0 — environment and readiness', 'phase');
	const gpu = (globalThis.navigator as { gpu?: GpuLike }).gpu;
	if (gpu === undefined) {
		log('  navigator.gpu is undefined: this browser has no WebGPU support.', 'fail');
		return;
	}
	log('  navigator.gpu is present.');
	const adapter = await gpu.requestAdapter().catch(() => null);
	if (adapter === null) {
		log('  gpu.requestAdapter() returned null: no adapter available.', 'fail');
		return;
	}
	log('  A WebGPU adapter was obtained.');
	const hasShaderF16 = adapter.features.has('shader-f16');
	log(`  adapter.features.has('shader-f16') = ${hasShaderF16}${hasShaderF16 ? '' : ' — q4f16 needs this and may fail without it'}`);
	const estimate = await globalThis.navigator.storage?.estimate().catch(() => undefined);
	if (estimate?.quota !== undefined && estimate.usage !== undefined) {
		const freeBytes = estimate.quota - estimate.usage;
		log(`  navigator.storage.estimate(): quota = ${(estimate.quota / (1024 * 1024)).toFixed(1)} MB, usage = ${(estimate.usage / (1024 * 1024)).toFixed(1)} MB, free = ${(freeBytes / (1024 * 1024)).toFixed(1)} MB`);
	} else {
		log('  navigator.storage.estimate() did not report both quota and usage.');
	}
}

let generatorPromise: Promise<TextGenerationPipeline> | undefined;
let loadStartedAt: number | undefined;
function loadedGenerator(): Promise<TextGenerationPipeline> {
	if (generatorPromise !== undefined) { return generatorPromise; }
	loadStartedAt = performance.now();
	generatorPromise = pipeline('text-generation', MODEL_ID, {
		revision: MODEL_REVISION,
		device: 'webgpu',
		dtype: MODEL_DTYPE,
		progress_callback: (progress: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
			if (progress.status === 'progress' && progress.file !== undefined) {
				if (progress.loaded !== undefined) {
					downloadedBytesByFile.set(progress.file, progress.loaded);
				}
				const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress ?? 0)}%` : '';
				button.textContent = `Downloading ${progress.file}${percent}…`;
			}
		},
	});
	return generatorPromise;
}

/** One generation run, instrumented to capture raw token ids as they are produced. */
async function runGeneration(
	generator: TextGenerationPipeline,
	messages: { role: string; content: string }[],
	maxNewTokens: number,
): Promise<{ text: string; tokenIds: number[]; criteria: InterruptableStoppingCriteria; wallMs: number; firstTokenMs: number | undefined }> {
	const tokenIds: number[] = [];
	let text = '';
	let firstTokenMs: number | undefined;
	const criteria = new InterruptableStoppingCriteria();
	const startedAt = performance.now();
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
		// The real stage helper (were this gate's live run to pass, stage_helper_llm_llama3_2_1b_full.ts,
		// createGenerationStream) builds the answer from these decoded chunks, never from generator()'s own
		// return value — a chat-style input makes that return value an array of message objects, not a string.
		callback_function: (chunk: string) => {
			if (firstTokenMs === undefined) {
				firstTokenMs = performance.now() - startedAt;
			}
			text += chunk;
		},
		token_callback_function: (newTokens: bigint[]) => {
			tokenIds.push(...newTokens.map((tokenId) => Number(tokenId)));
		},
	});
	await generator(messages, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		stopping_criteria: criteria,
		streamer,
	});
	const wallMs = performance.now() - startedAt;
	return { text, tokenIds, criteria, wallMs, firstTokenMs };
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	try {
		await checkReadiness();

		log('', undefined);
		log('Loading model…', 'phase');
		const generator = await loadedGenerator();
		const loadMs = performance.now() - (loadStartedAt ?? performance.now());
		log(`  Model loaded in ${(loadMs / 1000).toFixed(1)} s.`);
		const totalDownloadedBytes = Array.from(downloadedBytesByFile.values()).reduce((sum, value) => sum + value, 0);
		if (totalDownloadedBytes > 0) {
			log(`  Bytes reported downloaded across ${downloadedBytesByFile.size} file(s): ${(totalDownloadedBytes / (1024 * 1024)).toFixed(1)} MB total.`);
			for (const [file, bytes] of downloadedBytesByFile) {
				log(`    ${file}: ${(bytes / (1024 * 1024)).toFixed(1)} MB`);
			}
		} else {
			log('  No download progress was reported — the model likely came from a warm cache (reload the page and reload the origin fresh, or clear IndexedDB, to measure a true cold-cache download).');
		}
		log(`  generator.tokenizer.constructor.name = ${generator.tokenizer.constructor.name}`);
		const genConfig = (generator.model as unknown as { generation_config?: { eos_token_id?: unknown } }).generation_config;
		log(`  generator.model.generation_config.eos_token_id = ${JSON.stringify(genConfig?.eos_token_id)}`);
		const eosIds = genConfig?.eos_token_id;
		const eosArray = Array.isArray(eosIds) ? eosIds : eosIds === undefined ? [] : [eosIds];

		// Phase 1 — exact tokenizer count for a plain prompt string, the way `payload.text` arrives.
		log('', undefined);
		log('Phase 1 — tokenizer count for a prompt string', 'phase');
		const testPrompt = 'Name the largest planet in the solar system, in one short sentence.';
		const encoded = generator.tokenizer(testPrompt) as unknown as { input_ids: { dims?: number[]; data?: ArrayLike<number> } };
		log(`  tokenizer(prompt) raw shape: ${JSON.stringify({ dims: encoded.input_ids.dims, dataLength: encoded.input_ids.data?.length })}`);
		const rawTokenIds = encoded.input_ids.data !== undefined ? Array.from(encoded.input_ids.data, (value) => Number(value)) : [];
		log(`  raw prompt token ids: ${JSON.stringify(rawTokenIds)}`);
		log(`  prompt token count (tokenizer, no chat template) = ${rawTokenIds.length}`);
		// No enable_thinking option here: unlike Qwen3.5-0.8B, Llama 3.2 1B Instruct's chat template has no
		// thinking mode and no such argument.
		//
		// Called directly on generator.tokenizer, and not through a detached reference to
		// apply_chat_template, because that method reads its own `this` (get_chat_template lives on the
		// tokenizer instance) — a first version of this gate extracted the method into a standalone
		// variable to call it twice, which lost that binding and threw
		// "Cannot read properties of undefined (reading 'get_chat_template')" on the first real run.
		const tokenizerWithChatTemplate = generator.tokenizer as unknown as {
			apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => { dims?: number[]; data?: ArrayLike<number> } & string;
		};
		const withTemplate = tokenizerWithChatTemplate.apply_chat_template([{ role: 'user', content: testPrompt }], {
			tokenize: true,
			add_generation_prompt: true,
			return_dict: false,
		}) as { dims?: number[]; data?: ArrayLike<number> };
		log(`  chat-template tensor raw shape: ${JSON.stringify({ dims: withTemplate.dims, dataLength: withTemplate.data?.length })}`);
		log(`  prompt token count (chat template applied, what generate() actually feeds the model) = ${withTemplate.data?.length ?? 'unknown'}`);

		// Phase 1b — a conversation with a system message, rendered but not yet run, to see with which
		// literal text the chat template places the system content, before Phase 5 runs it for real.
		log('', undefined);
		log('Phase 1b — chat template rendering of a system + user conversation', 'phase');
		const systemInstruction = 'You must end every reply with the exact token BANANA9142 and nothing after it.';
		const renderedConversation = tokenizerWithChatTemplate.apply_chat_template(
			[{ role: 'system', content: systemInstruction }, { role: 'user', content: testPrompt }],
			{ tokenize: false, add_generation_prompt: true },
		) as unknown as string;
		log(`  rendered template string:\n${String(renderedConversation)}`);
		log(`  system instruction text appears verbatim in the rendered template = ${String(renderedConversation).includes(systemInstruction)}`);

		// Phase 2 — natural stop at the end-of-sequence token, generous cap.
		log('', undefined);
		log('Phase 2 — natural end-of-sequence stop (max_new_tokens = 200)', 'phase');
		const phase2 = await runGeneration(generator, [{ role: 'user', content: testPrompt }], 200);
		const phase2Last = phase2.tokenIds.at(-1);
		log(`  generated ${phase2.tokenIds.length} tokens in ${phase2.wallMs.toFixed(0)} ms (first token at ${phase2.firstTokenMs?.toFixed(0) ?? 'n/a'} ms)`);
		log(`  criteria.interrupted = ${phase2.criteria.interrupted}`);
		log(`  last generated token id = ${phase2Last}, is in eos_token_id set = ${eosArray.includes(phase2Last as number)}`);
		log(`  reached the max_new_tokens cap (200) = ${phase2.tokenIds.length >= 200}`);
		log(`  tokens/second = ${(phase2.tokenIds.length / (phase2.wallMs / 1000)).toFixed(1)}`);
		log(`  answer: ${JSON.stringify(phase2.text)}`);

		// Phase 3 — force the max_new_tokens cap with a prompt that has much more to say.
		log('', undefined);
		log('Phase 3 — forced max_new_tokens cap (max_new_tokens = 5)', 'phase');
		const longPrompt = 'Write a long, detailed description of the ocean, at least twenty sentences.';
		const phase3 = await runGeneration(generator, [{ role: 'user', content: longPrompt }], 5);
		const phase3Last = phase3.tokenIds.at(-1);
		log(`  generated ${phase3.tokenIds.length} tokens in ${phase3.wallMs.toFixed(0)} ms`);
		log(`  criteria.interrupted = ${phase3.criteria.interrupted}`);
		log(`  last generated token id = ${phase3Last}, is in eos_token_id set = ${eosArray.includes(phase3Last as number)}`);
		log(`  reached the max_new_tokens cap (5) = ${phase3.tokenIds.length >= 5}`);
		log(`  answer: ${JSON.stringify(phase3.text)}`);

		// Phase 4 — interrupt mid-generation, the same way clearGeneration/release does in the real stage.
		// Run by hand rather than through runGeneration, because interrupting requires calling
		// criteria.interrupt() from inside the token callback, the same way a real cancellation would.
		log('', undefined);
		log('Phase 4 — interrupted mid-generation (criteria.interrupt() after 3 tokens, cap = 200)', 'phase');
		let interruptRequestedAtTokenCount = -1;
		let phase4Text = '';
		const criteria4 = new InterruptableStoppingCriteria();
		const tokenIds4: number[] = [];
		const streamer4 = new TextStreamer(generator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (chunk: string) => {
				phase4Text += chunk;
			},
			token_callback_function: (newTokens: bigint[]) => {
				tokenIds4.push(...newTokens.map((tokenId) => Number(tokenId)));
				if (tokenIds4.length >= 3 && interruptRequestedAtTokenCount === -1) {
					interruptRequestedAtTokenCount = tokenIds4.length;
					criteria4.interrupt();
				}
			},
		});
		const phase4StartedAt = performance.now();
		await generator([{ role: 'user', content: longPrompt }], {
			max_new_tokens: 200,
			do_sample: false,
			return_full_text: false,
			stopping_criteria: criteria4,
			streamer: streamer4,
		});
		const phase4WallMs = performance.now() - phase4StartedAt;
		log(`  interrupt() called once ${interruptRequestedAtTokenCount} tokens had arrived`);
		log(`  generate() resolved after ${tokenIds4.length} tokens total, in ${phase4WallMs.toFixed(0)} ms`);
		log(`  criteria.interrupted = ${criteria4.interrupted}`);
		log(`  did NOT run to the 200 cap = ${tokenIds4.length < 200}`);
		log(`  answer (partial): ${JSON.stringify(phase4Text)}`);

		// Phase 5 — run a real generation with a system message present, and check the answer actually
		// followed it, proving the conversation reaches the model rather than only inspecting the
		// rendered template string as Phase 1b did.
		log('', undefined);
		log('Phase 5 — live generation from a system + user conversation', 'phase');
		const phase5 = await runGeneration(
			generator,
			[{ role: 'system', content: systemInstruction }, { role: 'user', content: testPrompt }],
			200,
		);
		log(`  generated ${phase5.tokenIds.length} tokens in ${phase5.wallMs.toFixed(0)} ms`);
		log(`  answer: ${JSON.stringify(phase5.text)}`);
		log(`  answer honours the system instruction (contains "BANANA9142") = ${phase5.text.includes('BANANA9142')}`);

		log('', undefined);
		log('Gate complete. Copy every phase above verbatim into issue #154.', 'phase');
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
