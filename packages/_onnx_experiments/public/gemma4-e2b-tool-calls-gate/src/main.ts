import { env, pipeline, TextStreamer, type TextGenerationPipeline } from '@huggingface/transformers';
import { WebgpuRequirement } from './webgpu_requirement';
import { CorrectnessCheck } from './correctness_check';
import { Gemma4E2bToolCallReader, type ToolCallReading } from './gemma_4_e2b_tool_call_reader';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tool calls de-risk gate for issue #216, milestone 0, Gemma 4 E2B
//
//	`task_type_llm_gemma_4_e2b_full` refuses every request that declares a tool. Issue #216 is the
//	plan to make it accept one, and this page is its milestone 0: the de-risk gate that runs before
//	any implementation code is written.
//
//	The same model at the same size does tool calls correctly when LM Studio serves it, and when
//	Ollama serves it with its context length raised, which `packages/_codex_experiments` measured
//	three runs out of three. That says nothing about this path. `llm_gemma_4_e2b_full` is a
//	different arrangement of the same model: `@huggingface/transformers` in a worker browser tab,
//	running the `q4f16` ONNX export on WebGPU, with this project applying the chat template and
//	reading the tool calls back out of the generated text by hand.
//
//	The one assumption that would make issue #216 impossible is that the tool call format belongs to
//	the model, and this project has never measured Gemma 4 E2B's. `ToolCallReader` of
//	`packages/worker_webpage` reads Qwen3.5's format and no other, and the gate of issue #115 already
//	paid once for assuming a format from what a model family is known to do. So nothing here is
//	assumed: every phase prints its raw input and its raw output.
//
//	The quieter half of the same assumption is decoding. Qwen3.5's `<tool_call>` and `</tool_call>`
//	survive `skip_special_tokens: true` only because they are added tokens with `special: false` in
//	that tokenizer. Whatever markers Gemma 4 E2B uses are checked the same way here, against the
//	pinned revision's own tokenizer, because a marker the decoder strips is a tool call no reader
//	will ever see.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const MODEL_DTYPE = 'q4f16';

/**
 * The two tool call markers this gate looks for, named `stc_token` and `etc_token` in the pinned
 * revision's own `tokenizer_config.json`.
 */
const TOOL_CALL_MARKERS = ['<|tool_call>', '<tool_call|>'];
/** The marker Gemma 4 writes around every string value, named `escape_token` in that same file. */
const STRING_VALUE_MARKER = '<|"|>';

/** The tools declared to the model, in the shape `apply_chat_template` takes them. */
const TOOLS = [
	{
		type: 'function',
		function: {
			name: 'get_current_weather',
			description: 'Reports the current weather in one city. Call this whenever the current weather somewhere is asked about.',
			parameters: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
						description: 'The name of the city to report the current weather in, such as Paris.',
					},
				},
				required: ['city'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_current_time',
			description: 'Reports the current time of day in one city. Call this whenever the current time somewhere is asked about.',
			parameters: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
						description: 'The name of the city to report the current time in, such as Paris.',
					},
				},
				required: ['city'],
			},
		},
	},
];

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/gemma4-e2b-it/src/main.ts, same database
// name, so a browser that already ran that experiment does not download 3111 megabytes again for this
// gate. Copied rather than shared, because this package keeps every experiment standalone.
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
// Re-bound to a definitely-non-null type, for the same reason the Qwen3.5 tool calls gate does it: the
// closures below are declared later in this module and TypeScript does not carry the null check into them.
const button: HTMLButtonElement = buttonElement;
const output: HTMLElement = outputElement;

/** Every line written to the page, kept so the whole record of a run can be read back out in one piece. */
const loggedLines: string[] = [];
(globalThis as unknown as { gateLoggedLines: string[] }).gateLoggedLines = loggedLines;

function log(message: string, className?: string): void {
	loggedLines.push(message);
	const line = document.createElement('div');
	if (className !== undefined) { line.className = className; }
	line.textContent = message;
	output.appendChild(line);
	console.log(message);
}

let generatorPromise: Promise<TextGenerationPipeline> | undefined;
function loadedGenerator(): Promise<TextGenerationPipeline> {
	if (generatorPromise !== undefined) { return generatorPromise; }
	// `device: 'webgpu'` unconditionally, never a fallback. A WebAssembly answer would look like a
	// working gate and would prove nothing about the path a worker browser tab takes, which is what
	// issue #211 settled for this model.
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
	// Kept on the global object so a person reading this page can ask the loaded tokenizer questions
	// from the browser console without loading about 3111 megabytes a second time.
	void generatorPromise.then((generator) => {
		(globalThis as unknown as { gateGenerator: TextGenerationPipeline }).gateGenerator = generator;
	});
	return generatorPromise;
}

/** One added token of the tokenizer, as much of it as this gate reads. */
type AddedTokenReading = {
	/** The text of the token. */
	content: string;
	/** The identifier the tokenizer gives it. */
	id: number;
	/** Whether the token is special, which is what decides if `skip_special_tokens: true` strips it. */
	special: boolean;
};

/**
 * Every added token of the loaded tokenizer.
 *
 * `@huggingface/transformers` 4.2.0 keeps its added tokens in the `@huggingface/tokenizers` tokenizer
 * it wraps, reachable through `get_added_tokens_decoder()`, and keeps the parsed `tokenizer.json`
 * beside it. Both are read, the second as a fallback, because this gate must not report a marker as
 * missing when it is really the property name that moved.
 *
 * @param generator The loaded text-generation pipeline.
 * @returns One entry per added token, empty when neither place could be read.
 */
function addedTokensOf(generator: TextGenerationPipeline): AddedTokenReading[] {
	const tokenizer = generator.tokenizer as unknown as {
		_tokenizer?: { get_added_tokens_decoder?: () => Map<number, { content: string; special: boolean }> };
		_tokenizerJSON?: { added_tokens?: { content: string; id: number; special: boolean }[] };
	};
	const decoder = tokenizer._tokenizer?.get_added_tokens_decoder?.();
	if (decoder !== undefined) {
		const readings: AddedTokenReading[] = [];
		for (const [id, addedToken] of decoder.entries()) {
			readings.push({
				content: addedToken.content,
				id: id,
				special: addedToken.special,
			});
		}
		return readings;
	}
	return tokenizer._tokenizerJSON?.added_tokens ?? [];
}

/** The chat template, rendered as text rather than tokenized, so a person can read what the model was given. */
function renderPrompt(generator: TextGenerationPipeline, messages: unknown[], tools: unknown[] | undefined): string {
	const applyChatTemplate = (
		generator.tokenizer as unknown as {
			apply_chat_template: (messages: unknown[], options: Record<string, unknown>) => string;
		}
	).apply_chat_template;
	const options: Record<string, unknown> = {
		tokenize: false,
		add_generation_prompt: true,
		enable_thinking: false,
	};
	if (tools !== undefined) {
		options.tools = tools;
	}
	return applyChatTemplate.call(generator.tokenizer, messages, options);
}

/** What one generation produced, decoded both ways from the same token identifiers. */
type GenerationRecord = {
	/** The answer decoded with `skip_special_tokens: false`, which is the text as the model wrote it. */
	rawText: string;
	/** The same token identifiers decoded with `skip_special_tokens: true`, which is what the real stage would see. */
	strippedText: string;
	/** Every token identifier the model generated, in order. */
	tokenIds: number[];
	/** How long the generation took, in milliseconds. */
	wallMs: number;
};

/**
 * Generates from an already-rendered prompt string, and decodes the answer twice.
 *
 * The prompt is rendered separately and passed as a string on purpose: the text-generation pipeline
 * applies the chat template itself when it is handed a message list, and it exposes no `tools`
 * option to pass through when it does. So the real stage would have to render the prompt itself
 * too, and this gate generates the same way the real stage would have to.
 *
 * The same token identifiers are decoded with `skip_special_tokens: false` and then with `true`,
 * because the difference between the two answers is the whole of the decoding question this gate
 * exists to settle, and it can only be settled on real generated text.
 *
 * @param generator The loaded text-generation pipeline.
 * @param prompt The prompt, already rendered through the chat template.
 * @param maxNewTokens The largest number of tokens this answer may hold.
 * @returns The answer decoded both ways, its token identifiers, and how long it took.
 */
async function runGeneration(generator: TextGenerationPipeline, prompt: string, maxNewTokens: number): Promise<GenerationRecord> {
	const tokenIds: number[] = [];
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		// Special tokens are kept, because the tool call markers this gate is looking for may be
		// special tokens: skipping them is exactly how a real tool call could be made invisible.
		skip_special_tokens: false,
		token_callback_function: (newTokens: bigint[]) => {
			for (const tokenId of newTokens) {
				tokenIds.push(Number(tokenId));
			}
		},
	});
	const startedAt = performance.now();
	await generator(prompt, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		streamer,
	});
	const wallMs = performance.now() - startedAt;
	const decode = (generator.tokenizer as unknown as {
		decode: (tokenIds: number[], options: Record<string, unknown>) => string;
	}).decode;
	return {
		rawText: decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: false }),
		strippedText: decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: true }),
		tokenIds: tokenIds,
		wallMs: wallMs,
	};
}

/** Prints what one generated answer contained, and returns the tool calls read out of it. */
function reportAnswer(label: string, generated: GenerationRecord): ToolCallReading[] {
	log(`  ${label} generated ${generated.tokenIds.length} tokens in ${generated.wallMs.toFixed(0)} ms`);
	log(`  raw generated text, skip_special_tokens: false — ${JSON.stringify(generated.rawText)}`);
	log(`  same tokens, skip_special_tokens: true — ${JSON.stringify(generated.strippedText)}`);
	const toolCalls = Gemma4E2bToolCallReader.read(generated.rawText);
	log(`  tool calls found in the raw text: ${toolCalls.length}`);
	for (const [index, toolCall] of toolCalls.entries()) {
		log(`    [${index}] raw: ${JSON.stringify(toolCall.raw)}`);
		log(`    [${index}] closing marker found = ${toolCall.isClosed}`);
		if (toolCall.readingError !== undefined) {
			log(`    [${index}] could not be read: ${toolCall.readingError}`, 'fail');
			continue;
		}
		log(`    [${index}] name = ${JSON.stringify(toolCall.name)}, arguments = ${JSON.stringify(toolCall.arguments)}`, 'pass');
	}
	return toolCalls;
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	loggedLines.length = 0;
	try {
		// Phase 1 — WebGPU or nothing. Read before the model is asked for, and confirmed again after it
		// has loaded, because ONNX Runtime Web can accept `webgpu`, fail to start it, and carry on from
		// WebAssembly with only a console warning.
		log('Phase 1 — is this really running on WebGPU?', 'phase');
		WebgpuRequirement.watchForADroppedProvider();
		const adapterReport = await WebgpuRequirement.demandWebgpu();
		log(`  adapter: vendor=${JSON.stringify(adapterReport.vendor)}, architecture=${JSON.stringify(adapterReport.architecture)}, description=${JSON.stringify(adapterReport.description)}`);
		log(`  adapter supports shader-f16 = ${adapterReport.isRequiredFeatureSupported}`, adapterReport.isRequiredFeatureSupported ? 'pass' : 'fail');
		log('  loading the model…');
		const generator = await loadedGenerator();
		log(`  model loaded. tokenizer = ${generator.tokenizer.constructor.name}`);
		const backendVerdict = await WebgpuRequirement.verdictAfterLoading();
		log(`  ${backendVerdict.explanation}`, backendVerdict.isWebgpu ? 'pass' : 'fail');
		for (const warning of backendVerdict.droppedProviderWarnings) {
			log(`  dropped provider warning: ${warning}`, 'fail');
		}

		// Phase 2 — questions whose answers are known, before any tool call is believed. WebGPU returns
		// wrong numbers without reporting an error, which is what killed issue #172, so a model that
		// writes a fluent tool call may still be a model whose output is wrong.
		log('');
		log('Phase 2 — does this run answer questions whose answers are known?', 'phase');
		const correctnessResults = await CorrectnessCheck.run(generator, (question) => {
			log(`  asking: ${JSON.stringify(question.prompt)}`);
		});
		for (const result of correctnessResults) {
			log(`  answered ${JSON.stringify(result.answer)}, contains ${JSON.stringify(result.question.requiredText)} = ${result.isPassed}`, result.isPassed ? 'pass' : 'fail');
		}
		log(`  every known answer is right = ${CorrectnessCheck.isEveryCheckPassed(correctnessResults)}`, CorrectnessCheck.isEveryCheckPassed(correctnessResults) ? 'pass' : 'fail');

		// Phase 3 — the cheapest possible kill. If the bundled chat template has no tools slot, nothing
		// below can work, and the answer is known without generating a single token.
		log('');
		log('Phase 3 — does the bundled chat template have a slot for tool declarations?', 'phase');
		const chatTemplate = (generator.tokenizer as unknown as { chat_template?: unknown }).chat_template;
		const chatTemplateText = typeof chatTemplate === 'string' ? chatTemplate : JSON.stringify(chatTemplate);
		log(`  chat_template is a ${typeof chatTemplate}, ${chatTemplateText === undefined ? 0 : chatTemplateText.length} characters`);
		const mentionsTools = chatTemplateText !== undefined && chatTemplateText.includes('tools');
		log(`  chat_template mentions "tools" = ${mentionsTools}`, mentionsTools ? 'pass' : 'fail');
		const mentionsToolCall = chatTemplateText !== undefined && chatTemplateText.includes('tool_call');
		log(`  chat_template mentions "tool_call" = ${mentionsToolCall}`, mentionsToolCall ? 'pass' : 'fail');

		// Phase 4 — the declarations must actually reach the rendered prompt, and the rendered prompt is
		// where the format the model is told to write is written down. It is printed whole, because
		// reading it is the one thing that stops this gate assuming a format.
		log('');
		log('Phase 4 — do the tool declarations reach the rendered prompt, and what is the model told to write?', 'phase');
		const weatherQuestion = 'What is the current weather in Paris?';
		const promptWithTools = renderPrompt(generator, [{ role: 'user', content: weatherQuestion }], TOOLS);
		log(`  rendered prompt with tools (${promptWithTools.length} characters):`);
		log(promptWithTools);
		const carriesToolName = promptWithTools.includes('get_current_weather');
		log(`  rendered prompt contains "get_current_weather" = ${carriesToolName}`, carriesToolName ? 'pass' : 'fail');
		const promptWithoutTools = renderPrompt(generator, [{ role: 'user', content: weatherQuestion }], undefined);
		log(`  rendered prompt without tools (${promptWithoutTools.length} characters):`);
		log(promptWithoutTools);
		log(`  declaring two tools added ${promptWithTools.length - promptWithoutTools.length} characters`);

		// Phase 5 — the quieter half of the assumption, and it is settled without generating anything.
		// Qwen3.5's markers survive `skip_special_tokens: true` only because they are added tokens with
		// `special: false`. A marker that is stripped is a tool call no reader will ever see.
		log('');
		log('Phase 5 — do the tool call markers survive skip_special_tokens: true?', 'phase');
		const addedTokens = addedTokensOf(generator);
		log(`  the tokenizer carries ${addedTokens.length} added tokens`);
		for (const markerText of [...TOOL_CALL_MARKERS, STRING_VALUE_MARKER]) {
			const addedToken = addedTokens.find((candidate) => candidate.content === markerText);
			if (addedToken === undefined) {
				log(`  ${markerText} is not an added token of this tokenizer at all`, 'fail');
				continue;
			}
			log(`  ${markerText} is token ${addedToken.id}, special = ${addedToken.special}`, addedToken.special === false ? 'pass' : 'fail');
		}
		const writtenCall = `${TOOL_CALL_MARKERS[0]}call:get_current_weather{city:${STRING_VALUE_MARKER}Paris${STRING_VALUE_MARKER}}${TOOL_CALL_MARKERS[1]}`;
		const encode = (generator.tokenizer as unknown as { encode: (text: string, options?: Record<string, unknown>) => number[] }).encode;
		const decode = (generator.tokenizer as unknown as { decode: (tokenIds: number[], options: Record<string, unknown>) => string }).decode;
		const writtenCallTokenIds = encode.call(generator.tokenizer, writtenCall, { add_special_tokens: false });
		const decodedKeepingSpecials = decode.call(generator.tokenizer, writtenCallTokenIds, { skip_special_tokens: false });
		const decodedSkippingSpecials = decode.call(generator.tokenizer, writtenCallTokenIds, { skip_special_tokens: true });
		log(`  a tool call written by hand: ${JSON.stringify(writtenCall)}`);
		log(`  encoded to ${writtenCallTokenIds.length} tokens: ${JSON.stringify(writtenCallTokenIds)}`);
		log(`  decoded with skip_special_tokens: false — ${JSON.stringify(decodedKeepingSpecials)}`);
		log(`  decoded with skip_special_tokens: true  — ${JSON.stringify(decodedSkippingSpecials)}`);
		const survivesStripping = TOOL_CALL_MARKERS.every((markerText) => decodedSkippingSpecials.includes(markerText));
		log(`  both markers survive skip_special_tokens: true = ${survivesStripping}`, survivesStripping ? 'pass' : 'fail');

		// Phase 6 — the one that cannot be answered by reading anything: does this export, at this
		// quantization, on this backend, actually write a tool call?
		log('');
		log('Phase 6 — does the model generate a tool call?', 'phase');
		log(`  question: ${JSON.stringify(weatherQuestion)}`);
		const weatherAnswer = await runGeneration(generator, promptWithTools, 256);
		const weatherCalls = reportAnswer('weather question,', weatherAnswer);
		const generatesACall = weatherCalls.length > 0;
		log(`  generates a tool call = ${generatesACall}`, generatesACall ? 'pass' : 'fail');
		const nameIsRight = weatherCalls[0]?.name === 'get_current_weather';
		log(`  call names get_current_weather = ${nameIsRight}`, nameIsRight ? 'pass' : 'fail');
		const filledInCity = weatherCalls[0]?.arguments.city;
		const cityIsRight = typeof filledInCity === 'string' && filledInCity.toLowerCase().includes('paris');
		log(`  arguments name the city the question asked about = ${cityIsRight}`, cityIsRight ? 'pass' : 'fail');

		// Phase 7 — with two tools declared, is the right one chosen?
		log('');
		log('Phase 7 — does it choose the right tool out of two?', 'phase');
		const timeQuestion = 'What is the current time in Paris?';
		log(`  question: ${JSON.stringify(timeQuestion)}`);
		const timeAnswer = await runGeneration(generator, renderPrompt(generator, [{ role: 'user', content: timeQuestion }], TOOLS), 256);
		const timeCalls = reportAnswer('time question,', timeAnswer);
		const choseTheTimeTool = timeCalls[0]?.name === 'get_current_time';
		log(`  chose get_current_time = ${choseTheTimeTool}`, choseTheTimeTool ? 'pass' : 'fail');

		// Phase 8 — the negative control. Without it, a model that writes a tool call every time would
		// pass every phase above and still be useless.
		log('');
		log('Phase 8 — does it answer in words when no tool is needed?', 'phase');
		const plainQuestion = 'Reply with exactly the word hello, and nothing else.';
		log(`  question: ${JSON.stringify(plainQuestion)}`);
		const plainAnswer = await runGeneration(generator, renderPrompt(generator, [{ role: 'user', content: plainQuestion }], TOOLS), 256);
		const plainCalls = reportAnswer('no-tool question,', plainAnswer);
		const abstained = plainCalls.length === 0;
		log(`  answered without asking for a tool = ${abstained}`, abstained ? 'pass' : 'fail');

		// Phase 9 — the other half of a round trip: a history that already carries a tool result.
		log('');
		log('Phase 9 — does a tool result render, and does the model answer from it?', 'phase');
		const historyWithAResult = [
			{ role: 'user', content: weatherQuestion },
			{
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						id: 'call_1',
						type: 'function',
						function: {
							name: 'get_current_weather',
							arguments: { city: 'Paris' },
						},
					},
				],
			},
			{
				role: 'tool',
				tool_call_id: 'call_1',
				name: 'get_current_weather',
				content: JSON.stringify({ city: 'Paris', celsius: 31, sky: 'clear' }),
			},
		];
		let resultPrompt = '';
		try {
			resultPrompt = renderPrompt(generator, historyWithAResult, TOOLS);
			log(`  rendered prompt carrying a tool result (${resultPrompt.length} characters):`);
			log(resultPrompt);
			const carriesTheResult = resultPrompt.includes('31');
			log(`  rendered prompt contains the tool result value 31 = ${carriesTheResult}`, carriesTheResult ? 'pass' : 'fail');
		} catch (error) {
			log(`  the chat template refused a history carrying a tool result: ${error instanceof Error ? error.message : String(error)}`, 'fail');
		}
		if (resultPrompt !== '') {
			const resultAnswer = await runGeneration(generator, resultPrompt, 256);
			reportAnswer('tool result question,', resultAnswer);
			const answersFromTheResult = resultAnswer.strippedText.includes('31');
			log(`  answer states the 31 only the tool result could have told it = ${answersFromTheResult}`, answersFromTheResult ? 'pass' : 'fail');
		}

		log('');
		log('Gate finished. Read the raw text above rather than the pass/fail lines alone.', 'phase');
	} catch (error) {
		log(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`, 'fail');
	} finally {
		button.disabled = false;
		button.textContent = 'Run the gate again';
	}
});

button.disabled = false;
button.textContent = 'Run the tool calls gate';
