import {
	env,
	pipeline,
	InterruptableStoppingCriteria,
	LogitsProcessorList,
	TextStreamer,
	type LogitsProcessor,
	type TextGenerationPipeline,
} from '@huggingface/transformers';
import { WebgpuRequirement } from './webgpu_requirement';
import { CorrectnessCheck } from './correctness_check';
import { VocabularyTable } from './vocabulary_table';
import { CountingLogitsProcessor } from './counting_logits_processor';
import { ForcedTokenLogitsProcessor } from './forced_token_logits_processor';
import { JsonGrammarLogitsProcessor } from './json_grammar_logits_processor';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JSON grammar de-risk gate for issue #219, milestone 0, Gemma 4 E2B
//
//	`task_type_llm_gemma_4_e2b_full` honours no response format, so `consumer_openai` refuses both
//	`json_object` and `json_schema` for it. Issue #218 is why, and issue #219 is the plan to change
//	it. This page is milestone 0 of that plan: the de-risk gate that runs before any implementation
//	code is written.
//
//	Issue #218 established, by reading the installed `@huggingface/transformers` 4.2.0 rather than
//	its documentation, that the extension point already exists: `generate()` takes a
//	`logits_processor`, `pipeline('text-generation', ...)` spreads its options into that call, and
//	`LogitsProcessor` is exported from the package entry point. No fork and no patch is needed.
//	Reading source proves a processor is REACHED. It cannot prove any of the following, and each of
//	them would sink the plan on its own:
//
//	- that setting a score to negative infinity keeps the sampler away from that entry, for this
//	  model, at this quantization, on WebGPU;
//	- that it still does so with the call shape the real stage helper uses, which carries a
//	  `stopping_criteria` that cancellation already depends on and a `TextStreamer`;
//	- that the cost of deciding, at every step, which of a vocabulary this size may legally come
//	  next is a cost a browser tab can pay.
//
//	So nothing here is assumed. Every phase prints its raw input and its raw output, and the run is
//	against the exact pinned export the real stage helper loads, on WebGPU, never on WebAssembly.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const MODEL_DTYPE = 'q4f16';

/** The question every phase that asks for an object uses, so the phases can be compared against each other. */
const JSON_QUESTION = 'Describe Paris as a JSON object with the keys name, country, and population.';

/** The text forced token by token in the phases that prove a mask decides the output. */
const FORCED_TEXT = 'Wombat wombat wombat.';

/** The largest number of tokens any generation on this page may produce. */
const MAX_NEW_TOKENS = 128;

type CacheEntry = { body: ArrayBuffer; headers: Record<string, string>; status: number };
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;
type IndexedDbCache = { match: (key: string) => Promise<Response | undefined>; put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void> };

env.allowLocalModels = false;

// Same IndexedDB cache as packages/_onnx_experiments/public/gemma4-e2b-tool-calls-gate/src/main.ts,
// same database name, so a browser that already ran that gate does not download 3111 megabytes again
// for this one. Copied rather than shared, because this package keeps every experiment standalone.
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
// Re-bound to a definitely-non-null type, for the same reason the tool calls gate does it: the
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

/**
 * The model's own end-of-sequence token identifiers, normalized to an array.
 *
 * Read from `generation_config` rather than from `config.json`, for the reason
 * `stage_helper_llm_gemma_4_e2b_full.ts` records: this model states them twice, the two statements
 * disagree, and `generation_config` is the one `generate()` itself stops on.
 *
 * @param generator The loaded text-generation pipeline.
 * @returns The end-of-sequence token identifiers this model's `generation_config` declares.
 */
function eosTokenIdsOf(generator: TextGenerationPipeline): number[] {
	const eosTokenId = (generator.model as unknown as { generation_config?: { eos_token_id?: number | number[] } }).generation_config?.eos_token_id;
	if (eosTokenId === undefined) { return []; }
	return Array.isArray(eosTokenId) ? eosTokenId : [eosTokenId];
}

/** What one generation produced. */
type GenerationRecord = {
	/** The answer decoded with `skip_special_tokens: false`, which is the text as the model wrote it. */
	rawText: string;
	/** The same token identifiers decoded with `skip_special_tokens: true`, which is what a consumer would receive. */
	strippedText: string;
	/** Every token identifier the model generated, in order. */
	tokenIds: number[];
	/** How long the generation took, in milliseconds. */
	wallMilliseconds: number;
};

/** How one generation is to be run. */
type GenerationRequest = {
	/** The question to ask. */
	question: string;
	/** The processor to hand to the call, or `undefined` to run with none at all. */
	logitsProcessor?: LogitsProcessor;
	/** Whether to pass the `stopping_criteria` the real stage helper passes and its cancellation needs. */
	usesRealCallShape: boolean;
};

/**
 * Generates one answer and decodes it twice.
 *
 * The question is handed over as a message list rather than as a rendered prompt, because that is
 * what `stage_helper_llm_gemma_4_e2b_full.ts` hands the pipeline for a task that declared no tools,
 * and this gate is about that path.
 *
 * @param generator The loaded text-generation pipeline.
 * @param request What to ask, what to mask with, and which call shape to use.
 * @returns The answer decoded both ways, its token identifiers, and how long it took.
 */
async function runGeneration(generator: TextGenerationPipeline, request: GenerationRequest): Promise<GenerationRecord> {
	const tokenIds: number[] = [];
	const options: Record<string, unknown> = {
		max_new_tokens: MAX_NEW_TOKENS,
		do_sample: false,
		return_full_text: false,
		tokenizer_encode_kwargs: { enable_thinking: false },
	};
	if (request.logitsProcessor !== undefined) {
		// `_get_logits_processor` calls `processors.extend(logits_processor)`, and `extend` spreads
		// what it is given, so this has to be an iterable of processors rather than one processor.
		// `LogitsProcessorList` is the shape `GenerationFunctionParameters` declares for the field, so
		// it is the one used here.
		const processorList = new LogitsProcessorList();
		processorList.push(request.logitsProcessor);
		options.logits_processor = processorList;
	}
	// A `TextStreamer` is present in every run on this page, because its `token_callback_function` is
	// how the token identifiers are collected at all. What the real call shape adds is the
	// `stopping_criteria` the real stage helper passes and that its cancellation depends on.
	options.streamer = new TextStreamer(generator.tokenizer, {
		skip_prompt: true,
		skip_special_tokens: true,
		token_callback_function: (newTokens: bigint[]) => {
			for (const tokenId of newTokens) { tokenIds.push(Number(tokenId)); }
		},
	});
	if (request.usesRealCallShape === true) {
		options.stopping_criteria = new InterruptableStoppingCriteria();
	}
	const startedAt = performance.now();
	await generator([{ role: 'user', content: request.question }], options);
	const wallMilliseconds = performance.now() - startedAt;
	const decode = (generator.tokenizer as unknown as {
		decode: (tokenIds: number[], options: Record<string, unknown>) => string;
	}).decode;
	return {
		rawText: tokenIds.length === 0 ? '' : decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: false }),
		strippedText: tokenIds.length === 0 ? '' : decode.call(generator.tokenizer, tokenIds, { skip_special_tokens: true }),
		tokenIds: tokenIds,
		wallMilliseconds: wallMilliseconds,
	};
}

/** Prints what one generated answer contained. */
function reportAnswer(label: string, generated: GenerationRecord): void {
	const perToken = generated.tokenIds.length === 0 ? 0 : generated.wallMilliseconds / generated.tokenIds.length;
	log(`  ${label} generated ${generated.tokenIds.length} tokens in ${generated.wallMilliseconds.toFixed(0)} ms, ${perToken.toFixed(1)} ms per token`);
	log(`  raw generated text, skip_special_tokens: false — ${JSON.stringify(generated.rawText)}`);
	log(`  same tokens, skip_special_tokens: true — ${JSON.stringify(generated.strippedText)}`);
	log(`  token identifiers: ${JSON.stringify(generated.tokenIds)}`);
}

/** Prints what one grammar-masked run cost, step by step and in total. */
function reportMaskingCost(processor: JsonGrammarLogitsProcessor): void {
	const readings = processor.stepReadings;
	if (readings.length === 0) {
		log('  the processor was never called', 'fail');
		return;
	}
	const totalMilliseconds = readings.reduce((sum, reading) => sum + reading.milliseconds, 0);
	const workedOut = readings.filter((reading) => reading.wasReused === false);
	const reused = readings.filter((reading) => reading.wasReused === true);
	const averageOf = (list: typeof readings) => list.length === 0 ? 0 : list.reduce((sum, reading) => sum + reading.milliseconds, 0) / list.length;
	log(`  the processor ran ${readings.length} times, ${totalMilliseconds.toFixed(0)} ms in total`);
	log(`  ${workedOut.length} steps scanned the whole vocabulary, ${averageOf(workedOut).toFixed(1)} ms each on average`);
	log(`  ${reused.length} steps reused a mask worked out earlier, ${averageOf(reused).toFixed(2)} ms each on average`);
	log(`  ${processor.distinctSignatureCount} distinct grammar states were reached across ${readings.length} steps`);
	const legalCounts = readings.map((reading) => reading.legalCount);
	log(`  entries left legal per step: smallest ${Math.min(...legalCounts)}, largest ${Math.max(...legalCounts)}`);
	for (const reading of readings.slice(0, 12)) {
		log(`    step ${reading.stepIndex}: state ${reading.signature} left ${reading.legalCount} entries legal, ${reading.milliseconds.toFixed(1)} ms${reading.wasReused === true ? ', reused' : ''}`);
	}
	if (readings.length > 12) {
		log(`    … and ${readings.length - 12} more steps`);
	}
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

		// Phase 2 — questions whose answers are known, before any figure from this page is believed.
		// WebGPU returns wrong numbers without reporting an error, which is what killed issue #172.
		log('');
		log('Phase 2 — does this run answer questions whose answers are known?', 'phase');
		const correctnessResults = await CorrectnessCheck.run(generator, (question) => {
			log(`  asking: ${JSON.stringify(question.prompt)}`);
		});
		for (const result of correctnessResults) {
			log(`  answered ${JSON.stringify(result.answer)}, contains ${JSON.stringify(result.question.requiredText)} = ${result.isPassed}`, result.isPassed ? 'pass' : 'fail');
		}
		log(`  every known answer is right = ${CorrectnessCheck.isEveryCheckPassed(correctnessResults)}`, CorrectnessCheck.isEveryCheckPassed(correctnessResults) ? 'pass' : 'fail');

		// Phase 3 — the vocabulary a mask has to cover. Every cost below is a multiple of its size, and
		// the entries a grammar cannot judge are the bytes this approach can never let the model write.
		log('');
		log('Phase 3 — what does this tokenizer look like, and what would a mask have to cover?', 'phase');
		const endOfSequenceTokenIds = eosTokenIdsOf(generator);
		log(`  generation_config end-of-sequence token identifiers: ${JSON.stringify(endOfSequenceTokenIds)}`);
		const vocabularyTable = await VocabularyTable.build(generator, (doneCount, totalCount) => {
			button.textContent = `Decoding the vocabulary, ${doneCount} of ${totalCount}…`;
		});
		button.textContent = 'Running…';
		log(`  the vocabulary holds ${vocabularyTable.size} entries`);
		log(`  decoding all of them took ${vocabularyTable.buildMilliseconds.toFixed(0)} ms, which milestone 1 pays once per loaded model`);
		log(`  ordinary text entries: ${vocabularyTable.countByKind.text}`);
		log(`  special entries, masked out until the value is finished: ${vocabularyTable.countByKind.special}`);
		log(`  entries that write nothing or write an incomplete character, masked out throughout: ${vocabularyTable.countByKind.unusable}`);
		for (const structuralText of ['{', '}', '[', ']', ':', ',', '"']) {
			const exactly = vocabularyTable.identifiersWritingExactly(structuralText);
			const startingWith = vocabularyTable.countStartingWith(structuralText);
			log(`  ${JSON.stringify(structuralText)}: ${exactly.length} entries write it alone (${JSON.stringify(exactly)}), ${startingWith} entries start with it`);
		}

		// Phase 4 — is a processor handed to a pipeline call reached at all, and what is it handed?
		// Reading the source says it should be. This says whether it is.
		log('');
		log('Phase 4 — is a logits processor handed to a pipeline call reached, and what is it handed?', 'phase');
		const countingProcessor = new CountingLogitsProcessor();
		const countedAnswer = await runGeneration(generator, {
			question: 'Reply with exactly the word hello, and nothing else.',
			logitsProcessor: countingProcessor,
			usesRealCallShape: false,
		});
		reportAnswer('counting run,', countedAnswer);
		log(`  the processor was called ${countingProcessor.callCount} times for ${countedAnswer.tokenIds.length} generated tokens`, countingProcessor.callCount > 0 ? 'pass' : 'fail');
		log(`  called once per generated token = ${countingProcessor.callCount === countedAnswer.tokenIds.length}`, countingProcessor.callCount === countedAnswer.tokenIds.length ? 'pass' : 'fail');
		if (countingProcessor.reading !== undefined) {
			const reading = countingProcessor.reading;
			log(`  logits tensor: dims ${JSON.stringify(reading.dimensions)}, type ${reading.elementType}`);
			log(`  the first batch row holds ${reading.batchDataLength} numbers in a ${reading.batchDataConstructorName}`);
			log(`  the row covers the whole vocabulary = ${reading.batchDataLength === vocabularyTable.size}`, reading.batchDataLength === vocabularyTable.size ? 'pass' : 'fail');
			log(`  all_input_ids held ${reading.firstCallInputLength} identifiers on the first call, which is the prompt`);
		}

		// Phase 5 — the half no amount of source reading can settle: does a mask decide the output?
		log('');
		log('Phase 5 — does a mask decide which token the model writes?', 'phase');
		const encode = (generator.tokenizer as unknown as { encode: (text: string, options?: Record<string, unknown>) => number[] }).encode;
		const forcedTokenIds = encode.call(generator.tokenizer, FORCED_TEXT, { add_special_tokens: false });
		log(`  forcing ${JSON.stringify(FORCED_TEXT)}, which is ${forcedTokenIds.length} tokens: ${JSON.stringify(forcedTokenIds)}`);
		const forcingProcessor = new ForcedTokenLogitsProcessor(forcedTokenIds, endOfSequenceTokenIds);
		const forcedAnswer = await runGeneration(generator, {
			question: 'What is the capital city of France? Answer with the name of the city only.',
			logitsProcessor: forcingProcessor,
			usesRealCallShape: false,
		});
		reportAnswer('forced run,', forcedAnswer);
		const wroteTheForcedTokens = forcedTokenIds.every((tokenId, index) => forcedAnswer.tokenIds[index] === tokenId);
		log(`  the model wrote the forced tokens = ${wroteTheForcedTokens}`, wroteTheForcedTokens ? 'pass' : 'fail');
		log(`  it was asked about the capital of France and did not write it = ${forcedAnswer.strippedText.includes('Paris') === false}`, forcedAnswer.strippedText.includes('Paris') === false ? 'pass' : 'fail');
		const stoppedOnEndOfSequence = endOfSequenceTokenIds.includes(forcedAnswer.tokenIds.at(-1) ?? -1);
		log(`  it then stopped on an end-of-sequence token = ${stoppedOnEndOfSequence}`, stoppedOnEndOfSequence ? 'pass' : 'fail');

		// Phase 6 — the same thing with the call shape the real stage helper uses. A processor that only
		// works on a bare call is no use to a worker whose cancellation depends on stopping_criteria.
		log('');
		log('Phase 6 — does the mask still decide the output with the call shape the real stage helper uses?', 'phase');
		log('  the call carries do_sample: false, return_full_text: false, tokenizer_encode_kwargs, a TextStreamer, and the stopping_criteria the real stage helper passes');
		const forcingProcessorAgain = new ForcedTokenLogitsProcessor(forcedTokenIds, endOfSequenceTokenIds);
		const forcedAnswerRealShape = await runGeneration(generator, {
			question: 'What is the capital city of France? Answer with the name of the city only.',
			logitsProcessor: forcingProcessorAgain,
			usesRealCallShape: true,
		});
		reportAnswer('forced run with the real call shape,', forcedAnswerRealShape);
		const wroteTheForcedTokensAgain = forcedTokenIds.every((tokenId, index) => forcedAnswerRealShape.tokenIds[index] === tokenId);
		log(`  the model wrote the forced tokens = ${wroteTheForcedTokensAgain}`, wroteTheForcedTokensAgain ? 'pass' : 'fail');
		log(`  the two runs generated the same tokens = ${JSON.stringify(forcedAnswer.tokenIds) === JSON.stringify(forcedAnswerRealShape.tokenIds)}`);

		// Phase 7 — the baseline. What this model writes when it is asked for an object and nothing
		// constrains it, and what a token costs when no processor is in the way.
		log('');
		log('Phase 7 — what does the model write when it is asked for JSON and nothing constrains it?', 'phase');
		log(`  question: ${JSON.stringify(JSON_QUESTION)}`);
		const unconstrainedAnswer = await runGeneration(generator, {
			question: JSON_QUESTION,
			usesRealCallShape: true,
		});
		reportAnswer('unconstrained run,', unconstrainedAnswer);
		let unconstrainedParses = false;
		try {
			JSON.parse(unconstrainedAnswer.strippedText);
			unconstrainedParses = true;
		} catch {
			unconstrainedParses = false;
		}
		log(`  the answer parses as JSON on its own = ${unconstrainedParses}`);

		// Phase 8 — the whole point. The grammar in place, on the real call shape, against the same
		// question, so the two answers can be read side by side.
		log('');
		log('Phase 8 — what does the model write with the JSON grammar in place?', 'phase');
		const grammarProcessor = new JsonGrammarLogitsProcessor(vocabularyTable, endOfSequenceTokenIds, true);
		const constrainedAnswer = await runGeneration(generator, {
			question: JSON_QUESTION,
			logitsProcessor: grammarProcessor,
			usesRealCallShape: true,
		});
		reportAnswer('grammar-masked run,', constrainedAnswer);
		let constrainedParses = false;
		let parsedKeys: string[] = [];
		try {
			const parsed: unknown = JSON.parse(constrainedAnswer.strippedText);
			constrainedParses = true;
			parsedKeys = typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [];
		} catch (error) {
			log(`  JSON.parse refused it: ${error instanceof Error ? error.message : String(error)}`, 'fail');
		}
		log(`  the answer parses as JSON = ${constrainedParses}`, constrainedParses ? 'pass' : 'fail');
		log(`  its keys: ${JSON.stringify(parsedKeys)}`);
		log(`  the reader refused none of the tokens the mask let through = ${grammarProcessor.refusedTokenText === undefined}`, grammarProcessor.refusedTokenText === undefined ? 'pass' : 'fail');
		if (grammarProcessor.refusedTokenText !== undefined) {
			log(`  the first token the reader refused was ${JSON.stringify(grammarProcessor.refusedTokenText)}`, 'fail');
		}
		reportMaskingCost(grammarProcessor);
		const unconstrainedPerToken = unconstrainedAnswer.tokenIds.length === 0 ? 0 : unconstrainedAnswer.wallMilliseconds / unconstrainedAnswer.tokenIds.length;
		const constrainedPerToken = constrainedAnswer.tokenIds.length === 0 ? 0 : constrainedAnswer.wallMilliseconds / constrainedAnswer.tokenIds.length;
		log(`  ${unconstrainedPerToken.toFixed(1)} ms per token without the processor, ${constrainedPerToken.toFixed(1)} ms per token with it`);
		log(`  masking cost ${(constrainedPerToken - unconstrainedPerToken).toFixed(1)} ms per token on this machine`);

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
button.textContent = 'Run the JSON grammar gate';
