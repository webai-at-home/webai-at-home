import { InterruptableStoppingCriteria, pipeline, type TextGenerationPipeline } from '@huggingface/transformers';
import constraintBundleSource from './vendor/transformers_response_constraint/index.js?raw';
import { ResponseConstraint, type ResponseFormat } from './vendor/transformers_response_constraint/index.js';
import { ConstrainedGeneration, type GenerationRecord } from './constrained_generation';
import { IndexedDbModelCache } from './indexed_db_model_cache';
import { SampledTokenForwarder } from './sampled_token_forwarder';
import { SchemaCases, type SchemaCase } from './schema_cases';
import { WebgpuRequirement } from './webgpu_requirement';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Response constraint measurement for issue #221, milestone 0, Gemma 4 E2B
//
//	Issue #221 replaces the approach of issue #219, whose hand-written JSON reader and hand-written
//	JSON Schema compiler were reverted from `main` on 20 August 2026. The reason is that a library
//	already exists for that part: `@huggingface/transformers-response-constraint`, written by a
//	Transformers.js collaborator against the same seam this project was already using, and proposed
//	upstream in pull request #1733. Nico Martin pointed at it.
//
//	The one assumption that would make issue #221 impossible is that the package can be depended on
//	by someone who is not its author, and that it constrains this model in this browser tab at a cost
//	a browser tab can pay. This page measures both halves, and the first half is the one that decides
//	the issue. The package is version `0.0.0`, answers HTTP 404 on npm, and lives on a branch whose
//	pull request has been open since 31 July 2026.
//
//	Nothing here is taken from that pull request's own benchmarks, and nothing is taken from what
//	issue #219 measured. Every phase prints its raw input and its raw output.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// Same pinned identifiers as packages/worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts,
// so this measurement is of the model configuration the real stage runs, not of a stand-in.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_REVISION = '9f4bef82ea6e296bc69f8a2f5939f73af81b07a6';
const MODEL_DTYPE = 'q4f16';

/**
 * The token limit every generation on this page runs under.
 *
 * `stage_helper_llm_gemma_4_e2b_full.ts` uses 1024. This page uses less, because one of its phases asks an
 * unconstrained model a question whose answer has no natural end, and 1024 tokens of that would be minutes of wall
 * time bought for nothing. Every answer a constraint is expected to produce here is far shorter than 256 tokens, so
 * an answer that reaches the limit is itself a finding rather than a limit chosen too low.
 */
const MAX_NEW_TOKENS = 256;

const buttonElement = document.querySelector<HTMLButtonElement>('#run-button');
const outputElement = document.querySelector<HTMLElement>('#output');
if (buttonElement === null || outputElement === null) {
	throw new Error('The page must contain #run-button and #output.');
}
// Re-bound to a definitely-non-null type, for the same reason the tool calls measurement does it: the closures
// below are declared later in this module and TypeScript does not carry the null check into them.
const button: HTMLButtonElement = buttonElement;
const output: HTMLElement = outputElement;

const isIndexedDbCacheInstalled = IndexedDbModelCache.install();

/** Every line written to the page, kept so the whole record of a run can be read back out in one piece. */
const loggedLines: string[] = [];
(globalThis as unknown as { measurementLoggedLines: string[] }).measurementLoggedLines = loggedLines;

/**
 * The whole measurement, phase by phase.
 *
 * Each phase writes what it did and what came back, and then says what that means. The order matters: the phase
 * that asks whether the released `@huggingface/transformers` is enough runs before every phase that depends on the
 * answer, because a page that constrained nothing and reported a satisfied schema would be the false green this
 * whole measurement exists to make impossible.
 */
export class ResponseConstraintMeasurement {
	/** The loaded pipeline, once something has asked for it. */
	private static generatorPromise: Promise<TextGenerationPipeline> | undefined = undefined;

	/**
	 * Runs every phase, in order.
	 *
	 * @returns Nothing. Everything the run found is written to the page.
	 */
	static async run(): Promise<void> {
		const generator = await ResponseConstraintMeasurement.phase1RunsOnWebgpu();
		const releaseRecords = await ResponseConstraintMeasurement.phase2IsTheReleasedRuntimeEnough(generator);
		await ResponseConstraintMeasurement.phase3DownloadCost();
		ResponseConstraintMeasurement.phase4GenerationShapes(releaseRecords);
		await ResponseConstraintMeasurement.phase5JsonObject(generator);
		await ResponseConstraintMeasurement.phase6JsonSchema(generator);
		await ResponseConstraintMeasurement.phase7WithoutFlexibleWhitespace(generator);
		await ResponseConstraintMeasurement.phase8TheRealCallShape(generator);
		await ResponseConstraintMeasurement.phase9CostPerToken(generator);
		await ResponseConstraintMeasurement.phase10AnUnenforceableSchema(generator);
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Every phase has run. Read the raw text above before believing any verdict.', 'phase');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Phase 1 — WebGPU or nothing.
	 *
	 * Read before the model is asked for, and confirmed again after it has loaded, because ONNX Runtime Web can
	 * accept `webgpu`, fail to start it, and carry on from WebAssembly with only a console warning.
	 *
	 * @returns The loaded pipeline.
	 */
	private static async phase1RunsOnWebgpu(): Promise<TextGenerationPipeline> {
		ResponseConstraintMeasurement.log('Phase 1 — is this really running on WebGPU?', 'phase');
		WebgpuRequirement.watchForADroppedProvider();
		const adapterReport = await WebgpuRequirement.demandWebgpu();
		ResponseConstraintMeasurement.log(
			`  adapter: vendor=${JSON.stringify(adapterReport.vendor)}, `
			+ `architecture=${JSON.stringify(adapterReport.architecture)}, `
			+ `description=${JSON.stringify(adapterReport.description)}`,
		);
		ResponseConstraintMeasurement.log(
			`  adapter supports shader-f16 = ${adapterReport.isRequiredFeatureSupported}`,
			adapterReport.isRequiredFeatureSupported ? 'pass' : 'fail',
		);
		ResponseConstraintMeasurement.log(`  IndexedDB model cache installed = ${isIndexedDbCacheInstalled}`);
		ResponseConstraintMeasurement.log('  loading the model…');
		const generator = await ResponseConstraintMeasurement.loadedGenerator();
		ResponseConstraintMeasurement.log(`  model loaded. tokenizer = ${generator.tokenizer.constructor.name}`);
		const backendVerdict = await WebgpuRequirement.verdictAfterLoading();
		ResponseConstraintMeasurement.log(`  ${backendVerdict.explanation}`, backendVerdict.isWebgpu ? 'pass' : 'fail');
		for (const warning of backendVerdict.droppedProviderWarnings) {
			ResponseConstraintMeasurement.log(`  dropped provider warning: ${warning}`, 'fail');
		}
		return generator;
	}

	/**
	 * Phase 2 — is the released `@huggingface/transformers` 4.2.0 enough, or is the branch build needed?
	 *
	 * The package's peer dependency says `^4.2.0`, which npm would install and which this project already pins. That
	 * is not the same as the package working against it. `ConstraintLogitsProcessor` masks the logits in `_call` and
	 * advances its grammar in `onTokensSampled`, and the second half is a method pull request #1733 adds to
	 * `LogitsProcessorList` in the same change. So the question is read off the loaded class, and then answered
	 * again by generating twice: once with the package used exactly as its own README says, and once with the
	 * missing calls restored from `input_ids` by {@link SampledTokenForwarder}.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns The two records, so the phase that reads generation shapes does not have to generate again.
	 */
	private static async phase2IsTheReleasedRuntimeEnough(
		generator: TextGenerationPipeline,
	): Promise<GenerationRecord[]> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log(
			'Phase 2 — is the released @huggingface/transformers 4.2.0 enough, or is the branch build needed?',
			'phase',
		);
		const isHookCalled = SampledTokenForwarder.isHookCalledByTheRuntime();
		ResponseConstraintMeasurement.log(
			`  LogitsProcessorList.prototype.onTokensSampled exists = ${isHookCalled}`,
			isHookCalled ? 'pass' : 'fail',
		);
		ResponseConstraintMeasurement.log(
			'  The package advances its grammar in that method. A runtime that never calls it masks every step from '
			+ 'the grammar\'s opening state.',
		);

		const warmupMs = ConstrainedGeneration.warmup(generator);
		ResponseConstraintMeasurement.log(`  ResponseConstraint.warmup on this tokenizer took ${warmupMs.toFixed(0)} ms`);

		const schemaCase = SchemaCases.all()[0];
		ResponseConstraintMeasurement.log(`  schema: ${JSON.stringify(schemaCase.schema)}`);
		ResponseConstraintMeasurement.log(`  prompt: ${JSON.stringify(schemaCase.prompt)}`);

		ResponseConstraintMeasurement.log('  run A — the package used exactly as its own README says:');
		const withoutForwarder = await ConstrainedGeneration.run(generator, {
			prompt: schemaCase.prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: { type: 'json_schema', json_schema: schemaCase.schema },
			isForwarderUsed: false,
			isStreamerUsed: false,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.reportRecord(withoutForwarder, schemaCase);

		ResponseConstraintMeasurement.log('  run B — the same, with the missing onTokensSampled calls restored:');
		const withForwarder = await ConstrainedGeneration.run(generator, {
			prompt: schemaCase.prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: { type: 'json_schema', json_schema: schemaCase.schema },
			isForwarderUsed: true,
			isStreamerUsed: false,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.reportRecord(withForwarder, schemaCase);

		return [withoutForwarder, withForwarder];
	}

	/**
	 * Phase 3 — what a worker browser tab has to download for this package.
	 *
	 * A worker browser tab downloads about 3111 megabytes of model already. Whatever this package costs is small
	 * beside that, and it is measured rather than assumed, because a constrained-generation engine could reasonably
	 * have carried a WebAssembly module of several megabytes.
	 *
	 * @returns Nothing.
	 */
	private static async phase3DownloadCost(): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Phase 3 — what does the package cost to download?', 'phase');
		const bytes = new TextEncoder().encode(constraintBundleSource);
		ResponseConstraintMeasurement.log(`  the built bundle is ${bytes.byteLength} bytes of JavaScript`);
		const gzippedByteLength = await ResponseConstraintMeasurement.gzippedByteLength(bytes);
		if (gzippedByteLength === undefined) {
			ResponseConstraintMeasurement.log('  this browser has no CompressionStream, so the transfer size was not measured');
		} else {
			ResponseConstraintMeasurement.log(`  gzipped, which is how a server sends it, that is ${gzippedByteLength} bytes`);
		}
		ResponseConstraintMeasurement.log('  the package carries no WebAssembly module and no runtime dependency');
	}

	/**
	 * Phase 4 — the logical batch size and the logits shape the pipeline call really uses.
	 *
	 * The package states that generation throws when the logical batch size is not 1. This is read off the two runs
	 * phase 2 already made, rather than generating again, because the shapes are a property of the call and not of
	 * the constraint.
	 *
	 * @param records The records phase 2 produced.
	 * @returns Nothing.
	 */
	private static phase4GenerationShapes(records: GenerationRecord[]): void {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Phase 4 — what logical batch size and logits shape does this call use?', 'phase');
		const batchSizes = [...new Set(records.flatMap((record) => record.batchSizes))];
		const logitsDims = [...new Set(records.flatMap((record) => record.logitsDims))];
		ResponseConstraintMeasurement.log(`  logical batch sizes seen: ${JSON.stringify(batchSizes)}`);
		ResponseConstraintMeasurement.log(`  logits shapes seen: ${JSON.stringify(logitsDims)}`);
		const isBatchSizeOne = batchSizes.length === 1 && batchSizes[0] === 1;
		ResponseConstraintMeasurement.log(
			`  every step ran at the batch size of 1 the package requires = ${isBatchSizeOne}`,
			isBatchSizeOne ? 'pass' : 'fail',
		);
	}

	/**
	 * Phase 5 — `json_object`, the shape that says "an object, and nothing about what is in it".
	 *
	 * The reverted work of issue #219 found this model writing about 400 characters of spaces and line breaks and
	 * never opening the object. Whether that still happens is the package's problem now, and this phase is where it
	 * would show. It is asked twice: once as `json_object`, which is all an OpenAI consumer can send, and once as the
	 * `json_schema` of `{"type":"object"}` this project would have to build in its place to be able to carry the
	 * whitespace control the package offers.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase5JsonObject(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Phase 5 — json_object', 'phase');
		const prompt = 'Describe the current weather in Paris.';
		ResponseConstraintMeasurement.log(`  prompt: ${JSON.stringify(prompt)}`);

		ResponseConstraintMeasurement.log('  asked as json_object, which is what an OpenAI consumer sends:');
		const asJsonObject = await ConstrainedGeneration.run(generator, {
			prompt: prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: { type: 'json_object' },
			isForwarderUsed: true,
			isStreamerUsed: false,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.reportRecord(asJsonObject, undefined);
		ResponseConstraintMeasurement.log(
			`    leading whitespace characters: ${ResponseConstraintMeasurement.leadingWhitespaceCount(asJsonObject.rawText)}`,
		);

		const objectSchema = SchemaCases.withoutFlexibleWhitespace({ type: 'object' });
		ResponseConstraintMeasurement.log(`  asked as the json_schema ${JSON.stringify(objectSchema)}:`);
		const asJsonSchema = await ConstrainedGeneration.run(generator, {
			prompt: prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: { type: 'json_schema', json_schema: objectSchema },
			isForwarderUsed: true,
			isStreamerUsed: false,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.reportRecord(asJsonSchema, undefined);
		ResponseConstraintMeasurement.log(
			`    leading whitespace characters: ${ResponseConstraintMeasurement.leadingWhitespaceCount(asJsonSchema.rawText)}`,
		);
	}

	/**
	 * Phase 6 — `json_schema`, one shape at a time, exactly as a consumer would send it.
	 *
	 * Nothing is added to the schema here. This is the arrangement milestone 3 would ship if it did no more than
	 * hand the consumer's schema to the package, so it is the arrangement that has to be measured first.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase6JsonSchema(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log(
			'Phase 6 — json_schema, seven shapes, exactly as a consumer would send them',
			'phase',
		);
		for (const schemaCase of SchemaCases.all()) {
			ResponseConstraintMeasurement.log(`  case: ${schemaCase.name}`);
			ResponseConstraintMeasurement.log(`    why: ${schemaCase.why}`);
			ResponseConstraintMeasurement.log(`    schema: ${JSON.stringify(schemaCase.schema)}`);
			ResponseConstraintMeasurement.log(`    prompt: ${JSON.stringify(schemaCase.prompt)}`);
			const record = await ConstrainedGeneration.run(generator, {
				prompt: schemaCase.prompt,
				maxNewTokens: MAX_NEW_TOKENS,
				responseFormat: { type: 'json_schema', json_schema: schemaCase.schema },
				isForwarderUsed: true,
				isStreamerUsed: false,
				stageStoppingCriteria: undefined,
			});
			ResponseConstraintMeasurement.reportRecord(record, schemaCase);
		}
	}

	/**
	 * Phase 7 — the same seven shapes with the package's flexible whitespace turned off.
	 *
	 * The grammar returns the same state for every whitespace byte wherever JSON allows whitespace, so greedy
	 * decoding has a fixed point there. `x-guidance: { whitespace_flexible: false }` closes that self-loop, and this
	 * phase is what says whether closing it is enough, and what it costs in the text the model writes.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase7WithoutFlexibleWhitespace(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log(
			'Phase 7 — the same seven shapes with x-guidance whitespace_flexible: false',
			'phase',
		);
		for (const schemaCase of SchemaCases.all()) {
			ResponseConstraintMeasurement.log(`  case: ${schemaCase.name}`);
			const record = await ConstrainedGeneration.run(generator, {
				prompt: schemaCase.prompt,
				maxNewTokens: MAX_NEW_TOKENS,
				responseFormat: {
					type: 'json_schema',
					json_schema: SchemaCases.withoutFlexibleWhitespace(schemaCase.schema),
				},
				isForwarderUsed: true,
				isStreamerUsed: false,
				stageStoppingCriteria: undefined,
			});
			ResponseConstraintMeasurement.reportRecord(record, schemaCase);
		}
	}

	/**
	 * Phase 8 — the same seven shapes on the call shape `stage_helper_llm_gemma_4_e2b_full.ts` really uses.
	 *
	 * A constraint that only works on a bare call is no use to this project. The stage passes `do_sample: false`, a
	 * `TextStreamer`, and an `InterruptableStoppingCriteria` of its own, and `stopping_criteria` is a single option
	 * that the response constraint wants as well. The whitespace control of phase 7 is kept on, so that the only
	 * difference from phase 7 is the call shape.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase8TheRealCallShape(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log(
			'Phase 8 — the same seven shapes, with a streamer and the stage\'s own stopping criterion',
			'phase',
		);
		for (const schemaCase of SchemaCases.all()) {
			ResponseConstraintMeasurement.log(`  case: ${schemaCase.name}`);
			const record = await ConstrainedGeneration.run(generator, {
				prompt: schemaCase.prompt,
				maxNewTokens: MAX_NEW_TOKENS,
				responseFormat: {
					type: 'json_schema',
					json_schema: SchemaCases.withoutFlexibleWhitespace(schemaCase.schema),
				},
				isForwarderUsed: true,
				isStreamerUsed: true,
				stageStoppingCriteria: new InterruptableStoppingCriteria(),
			});
			ResponseConstraintMeasurement.reportRecord(record, schemaCase);
			ResponseConstraintMeasurement.log(`    the streamer forwarded: ${JSON.stringify(record.streamedText)}`);
		}
	}

	/**
	 * Phase 9 — what the constraint costs per token, on the same prompt, with it and without it.
	 *
	 * The author reports in pull request #1733 that the constraints add very little overhead. That is the author's
	 * word and this project's price is its own number, measured on this model, at this quantization, on WebGPU.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase9CostPerToken(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Phase 9 — what does the constraint cost per token?', 'phase');
		const schemaCase = SchemaCases.all()[5];
		const schema = SchemaCases.withoutFlexibleWhitespace(schemaCase.schema);
		ResponseConstraintMeasurement.log(`  prompt: ${JSON.stringify(schemaCase.prompt)}`);
		ResponseConstraintMeasurement.log(`  schema: ${JSON.stringify(schema)}`);

		const unconstrained = await ConstrainedGeneration.run(generator, {
			prompt: schemaCase.prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: undefined,
			isForwarderUsed: false,
			isStreamerUsed: true,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.log(
			`  without the constraint: ${unconstrained.generatedTokenCount} tokens in ${unconstrained.wallMs.toFixed(0)} ms `
			+ `= ${ResponseConstraintMeasurement.msPerToken(unconstrained)} ms per token`,
		);

		const constrained = await ConstrainedGeneration.run(generator, {
			prompt: schemaCase.prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: { type: 'json_schema', json_schema: schema },
			isForwarderUsed: true,
			isStreamerUsed: true,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.log(
			`  with the constraint: ${constrained.generatedTokenCount} tokens in ${constrained.wallMs.toFixed(0)} ms `
			+ `= ${ResponseConstraintMeasurement.msPerToken(constrained)} ms per token`,
		);
		ResponseConstraintMeasurement.log(
			`  building the constraint took ${constrained.constraintBuildMs?.toFixed(0) ?? 'no'} ms, `
			+ 'paid once per request and not per token',
		);
	}

	/**
	 * Phase 10 — a schema the package states it does not enforce.
	 *
	 * Milestone 5 of issue #221 has to refuse such a request at submission, by asking the package rather than by
	 * keeping a list of its own. Whether the package can be asked at all is what this phase records.
	 *
	 * @param generator The loaded text-generation pipeline.
	 * @returns Nothing.
	 */
	private static async phase10AnUnenforceableSchema(generator: TextGenerationPipeline): Promise<void> {
		ResponseConstraintMeasurement.log('');
		ResponseConstraintMeasurement.log('Phase 10 — a schema the package states it does not enforce', 'phase');
		const schemaCase = SchemaCases.externalReference();
		ResponseConstraintMeasurement.log(`  schema: ${JSON.stringify(schemaCase.schema)}`);
		const responseFormat: ResponseFormat = { type: 'json_schema', json_schema: schemaCase.schema };

		let buildError: string | undefined = undefined;
		try {
			ResponseConstraint.fromResponseFormat(generator.tokenizer as unknown as object, responseFormat);
		} catch (thrown: unknown) {
			buildError = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
		}
		if (buildError === undefined) {
			ResponseConstraintMeasurement.log(
				'  building the constraint threw nothing, so a consumer cannot learn from the build alone that the '
				+ 'schema is unenforceable',
				'fail',
			);
		} else {
			ResponseConstraintMeasurement.log(`  building the constraint threw: ${buildError}`, 'pass');
			return;
		}

		const record = await ConstrainedGeneration.run(generator, {
			prompt: schemaCase.prompt,
			maxNewTokens: MAX_NEW_TOKENS,
			responseFormat: responseFormat,
			isForwarderUsed: true,
			isStreamerUsed: false,
			stageStoppingCriteria: undefined,
		});
		ResponseConstraintMeasurement.reportRecord(record, undefined);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Loads the model, on WebGPU and never on anything else.
	 *
	 * @returns The loaded pipeline.
	 */
	private static loadedGenerator(): Promise<TextGenerationPipeline> {
		if (ResponseConstraintMeasurement.generatorPromise !== undefined) {
			return ResponseConstraintMeasurement.generatorPromise;
		}
		// `device: 'webgpu'` unconditionally, never a fallback. A WebAssembly answer would look like a working
		// measurement and would prove nothing about the path a worker browser tab takes, which is what issue #211
		// settled for this model.
		ResponseConstraintMeasurement.generatorPromise = pipeline('text-generation', MODEL_ID, {
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
		// Kept on the global object so a person reading this page can ask the loaded tokenizer questions from the
		// browser console without loading about 3111 megabytes a second time.
		void ResponseConstraintMeasurement.generatorPromise.then((generator) => {
			(globalThis as unknown as { measurementGenerator: TextGenerationPipeline }).measurementGenerator = generator;
		});
		return ResponseConstraintMeasurement.generatorPromise;
	}

	/**
	 * Prints everything one generation produced, and whether it satisfies the schema it was asked for.
	 *
	 * @param record The record of the run.
	 * @param schemaCase The case the run was asked for, or `undefined` when there is no schema to check against.
	 * @returns Nothing.
	 */
	private static reportRecord(record: GenerationRecord, schemaCase: SchemaCase | undefined): void {
		if (record.error !== undefined) {
			ResponseConstraintMeasurement.log(`    the run threw: ${record.error}`, 'fail');
			return;
		}
		ResponseConstraintMeasurement.log(
			`    ${record.generatedTokenCount} tokens in ${record.wallMs.toFixed(0)} ms`
			+ (record.constraintBuildMs === undefined ? '' : `, constraint built in ${record.constraintBuildMs.toFixed(0)} ms`),
		);
		ResponseConstraintMeasurement.log(`    raw generated text: ${JSON.stringify(record.rawText)}`);
		if (record.strippedText !== record.rawText) {
			ResponseConstraintMeasurement.log(`    same tokens, skip_special_tokens: true: ${JSON.stringify(record.strippedText)}`);
		}
		if (record.isCutOffByTheTokenLimit === true) {
			ResponseConstraintMeasurement.log(`    the answer reached the ${MAX_NEW_TOKENS} token limit rather than ending on its own`, 'fail');
		}
		if (schemaCase === undefined) {
			return;
		}
		const parsed = ResponseConstraintMeasurement.parsed(record.strippedText);
		if (typeof parsed === 'string') {
			ResponseConstraintMeasurement.log(`    the answer is not JSON: ${parsed}`, 'fail');
			return;
		}
		const unsatisfied = schemaCase.whyUnsatisfied(parsed.value);
		ResponseConstraintMeasurement.log(
			`    satisfies its schema = ${unsatisfied === undefined}${unsatisfied === undefined ? '' : ` — ${unsatisfied}`}`,
			unsatisfied === undefined ? 'pass' : 'fail',
		);
	}

	/**
	 * One generated answer parsed as JSON.
	 *
	 * @param text The answer.
	 * @returns The parsed value, or one sentence saying why it could not be parsed.
	 */
	private static parsed(text: string): { value: unknown } | string {
		try {
			return { value: JSON.parse(text) };
		} catch (thrown: unknown) {
			return thrown instanceof Error ? thrown.message : String(thrown);
		}
	}

	/**
	 * How many whitespace characters an answer opens with.
	 *
	 * @param text The answer.
	 * @returns The count.
	 */
	private static leadingWhitespaceCount(text: string): number {
		return text.length - text.trimStart().length;
	}

	/**
	 * The wall-clock cost of one generated token, as a string with one decimal place.
	 *
	 * @param record The record of the run.
	 * @returns The cost, or `an unknown` when the run generated nothing.
	 */
	private static msPerToken(record: GenerationRecord): string {
		if (record.generatedTokenCount === 0) {
			return 'an unknown';
		}
		return (record.wallMs / record.generatedTokenCount).toFixed(1);
	}

	/**
	 * How many bytes a body takes once gzipped, which is how a server sends it.
	 *
	 * @param bytes The body.
	 * @returns The gzipped length, or `undefined` when this browser has no `CompressionStream`.
	 */
	private static async gzippedByteLength(bytes: Uint8Array): Promise<number | undefined> {
		if (typeof CompressionStream === 'undefined') {
			return undefined;
		}
		const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
		const gzipped = await new Response(stream).arrayBuffer();
		return gzipped.byteLength;
	}

	/**
	 * Writes one line to the page, to the browser console, and to the record kept for copying out.
	 *
	 * @param message The line.
	 * @param className `phase`, `pass`, or `fail`, or nothing for an ordinary line.
	 * @returns Nothing.
	 */
	private static log(message: string, className?: string): void {
		loggedLines.push(message);
		const line = document.createElement('div');
		if (className !== undefined) {
			line.className = className;
		}
		line.textContent = message;
		output.appendChild(line);
		console.log(message);
	}
}

button.addEventListener('click', () => {
	button.disabled = true;
	output.textContent = '';
	loggedLines.length = 0;
	ResponseConstraintMeasurement.run()
		.catch((error: unknown) => {
			const line = document.createElement('div');
			line.className = 'fail';
			line.textContent = `The measurement stopped: ${error instanceof Error ? error.message : String(error)}`;
			output.appendChild(line);
			console.error(error);
		})
		.finally(() => {
			button.disabled = false;
			button.textContent = 'Run the measurement again';
		});
});
button.disabled = false;
button.textContent = 'Run the measurement';
