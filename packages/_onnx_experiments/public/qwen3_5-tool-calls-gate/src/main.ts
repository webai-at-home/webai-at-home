import { env, pipeline, TextStreamer, type TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tool calls de-risk gate for issue #115, milestone 0, Qwen3.5-0.8B
//
//	`qwen_qwen3.5-0.8b` served by LM Studio passes every one of the six tool call abilities the
//	`tool_calls` subcommand of `@webai/openai-api-tool` probes, in both modes. That measurement is
//	about the model weights, and it was taken through a server that applies the chat template and
//	parses the tool calls itself.
//
//	`llm_qwen3_5_0_8b_full` is a different arrangement of the same model: `@huggingface/transformers`
//	in a volunteer browser tab, running the `q4f16` ONNX export, with this project applying the chat
//	template and reading the tool calls back out of the generated text by hand. Three things could
//	fail there that cannot fail through LM Studio, so none of them is assumed here:
//
//	  1. the chat template bundled with this export may have no slot for tool declarations at all;
//	  2. the `q4f16` export may not generate a tool call where the build LM Studio serves does;
//	  3. whatever the model writes has to be found and parsed back out of the streamed text.
//
//	Every phase prints its raw input and raw output, so the conclusion can be checked against what
//	the model really wrote rather than taken on trust.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/Qwen3.5-0.8B-ONNX';
const MODEL_REVISION = 'c0d619322dad7c4441a8841a53fc59772ddddcc0';
const MODEL_DTYPE = 'q4f16';

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

// Same IndexedDB cache as packages/_onnx_experiments/public/qwen3_5-0.8b-gate/src/main.ts, same database
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
// Re-bound to a definitely-non-null type, for the same reason the usage metadata gate does it: the
// closures below are declared later in this module and TypeScript does not carry the null check into them.
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

/**
 * Generates from an already-rendered prompt string.
 *
 * The prompt is rendered separately and passed as a string on purpose: the text-generation pipeline
 * applies the chat template itself when it is handed a message list, and it exposes no `tools`
 * option to pass through when it does. So the real stage would have to render the prompt itself
 * too, and this gate generates the same way the real stage would have to.
 */
async function runGeneration(generator: TextGenerationPipeline, prompt: string, maxNewTokens: number): Promise<{ text: string; tokenCount: number; wallMs: number }> {
	let text = '';
	let tokenCount = 0;
	const streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		// Special tokens are kept, because the tool call markers this gate is looking for may be
		// special tokens: skipping them is exactly how a real tool call could be made invisible.
		skip_special_tokens: false,
		callback_function: (chunk: string) => {
			text += chunk;
		},
		token_callback_function: (newTokens: bigint[]) => {
			tokenCount += newTokens.length;
		},
	});
	const startedAt = performance.now();
	await generator(prompt, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
		streamer,
	});
	return { text, tokenCount, wallMs: performance.now() - startedAt };
}

/**
 * Everything that looks like a tool call in one generated answer, with whatever could be read out of
 * it.
 *
 * The format is the one this export's own chat template instructs the model to use, read off the
 * rendered prompt in phase 2 rather than assumed:
 *
 * ```text
 * <tool_call>
 * <function=get_current_weather>
 * <parameter=city>
 * Paris
 * </parameter>
 * </function>
 * </tool_call>
 * ```
 *
 * It is not the JSON-inside-`<tool_call>` format that Qwen2.5 and Qwen3 use, which is what this gate
 * was first written to expect and what a reader who knows those models would reach for. Every
 * parameter value arrives as text, because this format carries no types at all, so a caller that
 * wants the JSON arguments the OpenAI interface defines has to convert each value using the type the
 * tool declared for it.
 *
 * A closing marker is optional at every level, so a call the model left unfinished is reported as
 * far as it got rather than silently missed.
 */
function readToolCalls(generatedText: string): { raw: string; name: string | undefined; args: Record<string, string>; parseError: string | undefined }[] {
	const found: { raw: string; name: string | undefined; args: Record<string, string>; parseError: string | undefined }[] = [];
	for (const callMatch of generatedText.matchAll(/<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g)) {
		const raw = (callMatch[1] ?? '').trim();
		const functionMatch = /<function=([^>]*)>([\s\S]*?)(?:<\/function>|$)/.exec(raw);
		if (functionMatch === null) {
			found.push({
				raw,
				name: undefined,
				args: {},
				parseError: 'no <function=…> block inside the <tool_call> block',
			});
			continue;
		}
		const args: Record<string, string> = {};
		for (const parameterMatch of (functionMatch[2] ?? '').matchAll(/<parameter=([^>]*)>([\s\S]*?)(?:<\/parameter>|$)/g)) {
			args[parameterMatch[1] ?? ''] = (parameterMatch[2] ?? '').trim();
		}
		found.push({
			raw,
			name: functionMatch[1],
			args,
			parseError: undefined,
		});
	}
	return found;
}

/** Prints what one generated answer contained, and returns the tool calls read out of it. */
function reportAnswer(label: string, generated: { text: string; tokenCount: number; wallMs: number }) {
	log(`  ${label} generated ${generated.tokenCount} tokens in ${generated.wallMs.toFixed(0)} ms`);
	log(`  raw generated text: ${JSON.stringify(generated.text)}`);
	const toolCalls = readToolCalls(generated.text);
	log(`  <tool_call> blocks found: ${toolCalls.length}`);
	for (const [index, toolCall] of toolCalls.entries()) {
		log(`    [${index}] raw: ${JSON.stringify(toolCall.raw)}`);
		if (toolCall.parseError !== undefined) {
			log(`    [${index}] does not parse as JSON: ${toolCall.parseError}`, 'fail');
			continue;
		}
		log(`    [${index}] name = ${JSON.stringify(toolCall.name)}, arguments = ${JSON.stringify(toolCall.args)}`, 'pass');
	}
	return toolCalls;
}

button.addEventListener('click', async () => {
	button.disabled = true;
	output.textContent = '';
	try {
		log('Loading model…', 'phase');
		const generator = await loadedGenerator();
		log(`Model loaded. tokenizer = ${generator.tokenizer.constructor.name}`);

		// Phase 1 — the cheapest possible kill. If the bundled chat template has no tools slot, nothing
		// below can work, and the answer is known without generating a single token.
		log('');
		log('Phase 1 — does the bundled chat template have a slot for tool declarations?', 'phase');
		const chatTemplate = (generator.tokenizer as unknown as { chat_template?: unknown }).chat_template;
		const chatTemplateText = typeof chatTemplate === 'string' ? chatTemplate : JSON.stringify(chatTemplate);
		log(`  chat_template is a ${typeof chatTemplate}, ${chatTemplateText === undefined ? 0 : chatTemplateText.length} characters`);
		const mentionsTools = chatTemplateText !== undefined && chatTemplateText.includes('tools');
		log(`  chat_template mentions "tools" = ${mentionsTools}`, mentionsTools ? 'pass' : 'fail');
		const mentionsToolCall = chatTemplateText !== undefined && chatTemplateText.includes('tool_call');
		log(`  chat_template mentions "tool_call" = ${mentionsToolCall}`, mentionsToolCall ? 'pass' : 'fail');

		// Phase 2 — the declarations must actually reach the rendered prompt. A template that mentions
		// tools but drops these ones would look identical to a working one until the text is read.
		log('');
		log('Phase 2 — do the tool declarations reach the rendered prompt?', 'phase');
		const weatherQuestion = 'What is the current weather in Paris?';
		const promptWithTools = renderPrompt(generator, [{ role: 'user', content: weatherQuestion }], TOOLS);
		log(`  rendered prompt with tools (${promptWithTools.length} characters):`);
		log(promptWithTools);
		const carriesToolName = promptWithTools.includes('get_current_weather');
		log(`  rendered prompt contains "get_current_weather" = ${carriesToolName}`, carriesToolName ? 'pass' : 'fail');
		const promptWithoutTools = renderPrompt(generator, [{ role: 'user', content: weatherQuestion }], undefined);
		log(`  same prompt rendered without tools is ${promptWithoutTools.length} characters, so declaring tools added ${promptWithTools.length - promptWithoutTools.length}`);

		// Phase 3 — the one that cannot be answered by reading anything: does this export, at this
		// quantization, actually write a tool call?
		log('');
		log('Phase 3 — does the model generate a tool call?', 'phase');
		log(`  question: ${JSON.stringify(weatherQuestion)}`);
		const weatherAnswer = await runGeneration(generator, promptWithTools, 256);
		const weatherCalls = reportAnswer('weather question,', weatherAnswer);
		const generatesACall = weatherCalls.length > 0;
		log(`  generates a tool call = ${generatesACall}`, generatesACall ? 'pass' : 'fail');
		const filledInCity = weatherCalls[0]?.args.city;
		const cityIsRight = filledInCity !== undefined && filledInCity.toLowerCase().includes('paris');
		log(`  arguments name the city the question asked about = ${cityIsRight}`, cityIsRight ? 'pass' : 'fail');
		const nameIsRight = weatherCalls[0]?.name === 'get_current_weather';
		log(`  call names get_current_weather = ${nameIsRight}`, nameIsRight ? 'pass' : 'fail');

		// Phase 4 — with two tools declared, is the right one chosen?
		log('');
		log('Phase 4 — does it choose the right tool out of two?', 'phase');
		const timeQuestion = 'What is the current time in Paris?';
		log(`  question: ${JSON.stringify(timeQuestion)}`);
		const timeAnswer = await runGeneration(generator, renderPrompt(generator, [{ role: 'user', content: timeQuestion }], TOOLS), 256);
		const timeCalls = reportAnswer('time question,', timeAnswer);
		const choseTheTimeTool = timeCalls[0]?.name === 'get_current_time';
		log(`  chose get_current_time = ${choseTheTimeTool}`, choseTheTimeTool ? 'pass' : 'fail');

		// Phase 5 — the negative control. Without it, a model that writes a tool call every time would
		// pass every phase above and still be useless.
		log('');
		log('Phase 5 — does it answer in words when no tool is needed?', 'phase');
		const plainQuestion = 'Reply with exactly the word hello, and nothing else.';
		log(`  question: ${JSON.stringify(plainQuestion)}`);
		const plainAnswer = await runGeneration(generator, renderPrompt(generator, [{ role: 'user', content: plainQuestion }], TOOLS), 256);
		const plainCalls = reportAnswer('no-tool question,', plainAnswer);
		const abstained = plainCalls.length === 0;
		log(`  answered without asking for a tool = ${abstained}`, abstained ? 'pass' : 'fail');

		// Phase 6 — the other half of a round trip: a conversation that already carries a tool result.
		log('');
		log('Phase 6 — does a tool result render, and does the model answer from it?', 'phase');
		const conversationWithAResult = [
			{ role: 'user', content: weatherQuestion },
			{ role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'get_current_weather', arguments: { city: 'Paris' } } }] },
			{ role: 'tool', name: 'get_current_weather', content: JSON.stringify({ city: 'Paris', celsius: 31, sky: 'clear' }) },
		];
		let resultPrompt = '';
		try {
			resultPrompt = renderPrompt(generator, conversationWithAResult, TOOLS);
			log(`  rendered prompt carrying a tool result (${resultPrompt.length} characters):`);
			log(resultPrompt);
			const carriesTheResult = resultPrompt.includes('31');
			log(`  rendered prompt contains the tool result value 31 = ${carriesTheResult}`, carriesTheResult ? 'pass' : 'fail');
		} catch (error) {
			log(`  the chat template refused a conversation carrying a tool result: ${error instanceof Error ? error.message : String(error)}`, 'fail');
		}
		if (resultPrompt !== '') {
			const resultAnswer = await runGeneration(generator, resultPrompt, 256);
			reportAnswer('tool result question,', resultAnswer);
			const answersFromTheResult = resultAnswer.text.includes('31');
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

void loadedGenerator().then(() => {
	button.disabled = false;
	button.textContent = 'Run the tool calls gate';
}).catch((error: unknown) => {
	log(`Could not load the model: ${error instanceof Error ? error.message : String(error)}`, 'fail');
	button.textContent = 'Model failed to load';
});
