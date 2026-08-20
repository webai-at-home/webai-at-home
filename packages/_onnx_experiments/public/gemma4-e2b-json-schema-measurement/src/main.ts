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
import { JsonSchemaCompiler, type CompiledSchemaNode } from './json_schema_compiler';
import { JsonSchemaMaskCache } from './json_schema_mask_cache';
import { JsonSchemaLogitsProcessor } from './json_schema_logits_processor';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JSON Schema measurement for issue #219, milestone 6, Gemma 4 E2B
//
//	Milestone 5 of issue #219 entered `json_object` into the `task_type_llm_gemma_4_e2b_full` row of
//	`structured_output_support.ts`, so that task type now answers a request asking for any JSON
//	object. `json_schema` asks for more: an object matching a schema the request carries, with the
//	keys that schema requires, of the types it declares, and nothing else.
//
//	Milestone 0 already measured the thing this rests on — a logits processor handed to the pipeline
//	call decides which token this model writes, and costs 44.7 milliseconds per token on this machine.
//	None of that says a mask can hold the model to a *schema*, and two things could fail:
//
//	- a key is written a token at a time, and this tokenizer merges characters, so holding the model
//	  to the key `capital` means masking down to the entries whose text continues that key from
//	  wherever it has got to. If no entry ever survives, the answer stops dead;
//	- a schema state carries which keys have been written and how far into one the model is, so a run
//	  reaches many more distinct states than the eight milestone 0 measured for `json_object`, and
//	  each new state scans the whole vocabulary once. That is the cost this page has to put a number
//	  on before any of it is built into the worker.
//
//	Nothing here is assumed. Every phase prints its raw input and its raw output, and the run is
//	against the exact pinned export the real stage helper loads, on WebGPU, never on WebAssembly.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts,
// so this gate proves the same model configuration the real stage runs, not a stand-in.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const MODEL_DTYPE = 'q4f16';

/** One schema to hold the model to, and the question asked under it. */
type SchemaCase = {
	/** What the phase is called on the page. */
	title: string;
	/** The question to ask the model. */
	question: string;
	/** The schema the answer has to satisfy, as a request would carry it. */
	schema: Record<string, unknown>;
	/** A check on the parsed answer, naming what is wrong when something is. */
	faultOf: (parsed: unknown) => string | undefined;
};

/**
 * The question asked with no schema at all, which is the baseline every schema case is read against.
 */
const PLAIN_QUESTION = 'Describe Paris as a JSON object with the keys name, country, and population.';

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
function reportMaskingCost(processor: JsonSchemaLogitsProcessor): void {
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
	const namedCounts = readings.map((reading) => reading.namedCount);
	log(`  entries named per mask: fewest ${Math.min(...namedCounts)}, most ${Math.max(...namedCounts)}`);
	for (const reading of readings.slice(0, 12)) {
		const named = reading.namesTheEntriesToKeep === true ? 'kept' : 'removed';
		log(`    step ${reading.stepIndex}: state ${reading.signature} named ${reading.namedCount} entries ${named}, ${reading.milliseconds.toFixed(1)} ms${reading.wasReused === true ? ', reused' : ''}`);
	}
	if (readings.length > 12) {
		log(`    … and ${readings.length - 12} more steps`);
	}
}

/** The schemas this page holds the model to, each asking for one more thing than the one before. */
const SCHEMA_CASES: SchemaCase[] = [
	{
		title: 'required keys, and nothing else',
		question: PLAIN_QUESTION,
		schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				country: { type: 'string' },
				population: { type: 'string' },
			},
			required: ['name', 'country', 'population'],
			additionalProperties: false,
		},
		faultOf: (parsed: unknown) => {
			const keys = Object.keys(parsed as Record<string, unknown>).sort();
			return JSON.stringify(keys) === JSON.stringify(['country', 'name', 'population'])
				? undefined
				: `its keys are ${JSON.stringify(keys)}`;
		},
	},
	{
		title: 'a key the model is not asked for, which the schema forbids',
		// The question asks for four keys and the schema declares two of them. A mask that enforces
		// the schema writes the two; one that does not writes what the question asked for.
		question: 'Describe Paris as a JSON object with the keys name, country, population, and mayor.',
		schema: {
			type: 'object',
			properties: {
				name: { type: 'string' },
				country: { type: 'string' },
			},
			required: ['name', 'country'],
			additionalProperties: false,
		},
		faultOf: (parsed: unknown) => {
			const keys = Object.keys(parsed as Record<string, unknown>).sort();
			return JSON.stringify(keys) === JSON.stringify(['country', 'name'])
				? undefined
				: `its keys are ${JSON.stringify(keys)}`;
		},
	},
	{
		title: 'an integer and a boolean, where the question invites neither',
		question: 'Describe Paris as a JSON object. Write the population in words, and say in words whether it is a capital.',
		schema: {
			type: 'object',
			properties: {
				population: { type: 'integer' },
				isCapital: { type: 'boolean' },
			},
			required: ['population', 'isCapital'],
			additionalProperties: false,
		},
		faultOf: (parsed: unknown) => {
			const answer = parsed as { population?: unknown; isCapital?: unknown };
			if (Number.isInteger(answer.population) === false) {
				return `population is ${JSON.stringify(answer.population)}, which is not an integer`;
			}
			if (typeof answer.isCapital !== 'boolean') {
				return `isCapital is ${JSON.stringify(answer.isCapital)}, which is not a boolean`;
			}
			return undefined;
		},
	},
	{
		title: 'an enumeration, whose values the question never mentions',
		question: 'What is the weather in Paris right now? Answer as a JSON object with the keys sky and temperatureUnit.',
		schema: {
			type: 'object',
			properties: {
				sky: { type: 'string', enum: ['clear', 'cloudy', 'raining'] },
				temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
			},
			required: ['sky', 'temperatureUnit'],
			additionalProperties: false,
		},
		faultOf: (parsed: unknown) => {
			const answer = parsed as { sky?: unknown; temperatureUnit?: unknown };
			if (['clear', 'cloudy', 'raining'].includes(String(answer.sky)) === false) {
				return `sky is ${JSON.stringify(answer.sky)}, which is outside the enumeration`;
			}
			if (['celsius', 'fahrenheit'].includes(String(answer.temperatureUnit)) === false) {
				return `temperatureUnit is ${JSON.stringify(answer.temperatureUnit)}, which is outside the enumeration`;
			}
			return undefined;
		},
	},
	{
		title: 'a nested object and a list',
		question: 'Describe Paris and two of its landmarks as a JSON object.',
		schema: {
			type: 'object',
			properties: {
				city: {
					type: 'object',
					properties: {
						name: { type: 'string' },
						country: { type: 'string' },
					},
					required: ['name', 'country'],
					additionalProperties: false,
				},
				landmarks: { type: 'array', items: { type: 'string' } },
			},
			required: ['city', 'landmarks'],
			additionalProperties: false,
		},
		faultOf: (parsed: unknown) => {
			const answer = parsed as { city?: { name?: unknown; country?: unknown }; landmarks?: unknown };
			if (typeof answer.city !== 'object' || answer.city === null) {
				return `city is ${JSON.stringify(answer.city)}, which is not an object`;
			}
			if (typeof answer.city.name !== 'string' || typeof answer.city.country !== 'string') {
				return `city is ${JSON.stringify(answer.city)}, which is missing a required key`;
			}
			if (Array.isArray(answer.landmarks) === false) {
				return `landmarks is ${JSON.stringify(answer.landmarks)}, which is not a list`;
			}
			if (answer.landmarks.every((item: unknown) => typeof item === 'string') === false) {
				return `landmarks holds something that is not a string: ${JSON.stringify(answer.landmarks)}`;
			}
			return undefined;
		},
	},
];

/**
 * Runs one schema case and prints what came back, what it cost, and whether the schema held.
 *
 * @param generator The loaded text-generation pipeline.
 * @param vocabularyTable The text every entry of the vocabulary writes.
 * @param endOfSequenceTokenIds The identifiers that end a sequence for this model.
 * @param schemaCase The case to run.
 * @returns Whether the answer parsed and satisfied the schema.
 */
async function runSchemaCase(
	generator: TextGenerationPipeline,
	vocabularyTable: VocabularyTable,
	endOfSequenceTokenIds: number[],
	schemaCase: SchemaCase,
): Promise<boolean> {
	log(`  question: ${JSON.stringify(schemaCase.question)}`);
	log(`  schema: ${JSON.stringify(schemaCase.schema)}`);
	let nodes: CompiledSchemaNode[];
	const compileStartedAt = performance.now();
	try {
		nodes = JsonSchemaCompiler.compile(schemaCase.schema);
	} catch (error) {
		log(`  the schema was refused: ${error instanceof Error ? error.message : String(error)}`, 'fail');
		return false;
	}
	log(`  compiled into ${nodes.length} nodes in ${(performance.now() - compileStartedAt).toFixed(2)} ms`);
	// One cache per case, so the numbers below are the cost of a schema met for the first time. A
	// worker sharing one cache across every answer under the same schema would pay less than this.
	const maskCache = new JsonSchemaMaskCache(vocabularyTable, endOfSequenceTokenIds, nodes);
	const processor = new JsonSchemaLogitsProcessor(maskCache, nodes);
	let generated: GenerationRecord;
	try {
		generated = await runGeneration(generator, {
			question: schemaCase.question,
			logitsProcessor: processor,
			usesRealCallShape: true,
		});
	} catch (error) {
		log(`  the generation failed: ${error instanceof Error ? error.message : String(error)}`, 'fail');
		return false;
	}
	reportAnswer('schema-masked run,', generated);
	let isSatisfied = false;
	try {
		const parsed: unknown = JSON.parse(generated.strippedText);
		const fault = schemaCase.faultOf(parsed);
		isSatisfied = fault === undefined;
		log(`  the answer satisfies the schema = ${isSatisfied}${fault === undefined ? '' : ` — ${fault}`}`, isSatisfied ? 'pass' : 'fail');
	} catch (error) {
		log(`  JSON.parse refused it: ${error instanceof Error ? error.message : String(error)}`, 'fail');
	}
	log(`  the value is finished = ${processor.isComplete}`, processor.isComplete ? 'pass' : 'fail');
	log(`  the reader refused none of the tokens the mask let through = ${processor.refusedTokenText === undefined}`, processor.refusedTokenText === undefined ? 'pass' : 'fail');
	if (processor.refusedTokenText !== undefined) {
		log(`  the first token the reader refused was ${JSON.stringify(processor.refusedTokenText)}`, 'fail');
	}
	reportMaskingCost(processor);
	return isSatisfied;
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

		// Phase 3 — the vocabulary every mask is worked out over, decoded once for the whole page.
		log('');
		log('Phase 3 — what does a mask have to cover?', 'phase');
		const vocabularyTable = VocabularyTable.build(generator.tokenizer);
		log(`  ${vocabularyTable.size} entries, decoded in ${vocabularyTable.buildMilliseconds.toFixed(0)} ms`);
		log(`  ${vocabularyTable.countByKind.text} write ordinary text, ${vocabularyTable.countByKind.special} are special, ${vocabularyTable.countByKind.unusable} write nothing a grammar can judge`);
		const endOfSequenceTokenIds = eosTokenIdsOf(generator);
		log(`  end-of-sequence identifiers: ${JSON.stringify(endOfSequenceTokenIds)}`);

		// Phase 4 — the baseline. The same question with nothing in the way, read against the first
		// schema, so what the schema is worth can be read rather than assumed.
		log('');
		log('Phase 4 — what does the model write when nothing constrains it?', 'phase');
		const unconstrainedAnswer = await runGeneration(generator, {
			question: PLAIN_QUESTION,
			usesRealCallShape: true,
		});
		reportAnswer('unconstrained run,', unconstrainedAnswer);
		let unconstrainedFault = 'JSON.parse refused it';
		try {
			unconstrainedFault = SCHEMA_CASES[0].faultOf(JSON.parse(unconstrainedAnswer.strippedText)) ?? 'none';
		} catch {
			unconstrainedFault = 'JSON.parse refused it';
		}
		log(`  read against the first schema below, what is wrong with it: ${unconstrainedFault}`);
		const unconstrainedPerToken = unconstrainedAnswer.tokenIds.length === 0 ? 0 : unconstrainedAnswer.wallMilliseconds / unconstrainedAnswer.tokenIds.length;
		log(`  ${unconstrainedPerToken.toFixed(1)} ms per token with no processor in the way`);

		// Phases 5 and after — one schema each, every one asking for something the question alone
		// would not produce.
		const satisfiedCount: boolean[] = [];
		for (const [caseIndex, schemaCase] of SCHEMA_CASES.entries()) {
			log('');
			log(`Phase ${caseIndex + 5} — ${schemaCase.title}`, 'phase');
			satisfiedCount.push(await runSchemaCase(generator, vocabularyTable, endOfSequenceTokenIds, schemaCase));
		}

		log('');
		const passedCount = satisfiedCount.filter((isSatisfied) => isSatisfied === true).length;
		log(`${passedCount} of ${satisfiedCount.length} schemas were satisfied.`, passedCount === satisfiedCount.length ? 'pass' : 'fail');
		log('Measurement finished. Read the raw text above rather than the pass/fail lines alone.', 'phase');
	} catch (error) {
		log(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`, 'fail');
	} finally {
		button.disabled = false;
		button.textContent = 'Run the measurement again';
	}
});

button.disabled = false;
button.textContent = 'Run the JSON Schema measurement';
