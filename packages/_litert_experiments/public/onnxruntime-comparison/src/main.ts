import * as OnnxRuntimeWeb from 'onnxruntime-web';
import type { DecodeReference, PrefillIndex } from './reference_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OnnxRuntimeWebComparison — the milestone six measurement of issue #179
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where the three ONNX shards are served from. The development server reads them out of
 * `packages/_onnx_experiments`, which is the whole of the connection between the two packages.
 */
const SHARD_PREFIX = '/onnxruntime-comparison/shards';

/**
 * Where the PyTorch references milestones four and five were checked against live.
 */
const MODELS_PREFIX = '/qwen3-litert-shards/models';

/**
 * The three shard files, in the order they run.
 */
const SHARD_FILE_NAMES = ['shard-1.onnx', 'shard-2.onnx', 'shard-3.onnx'] as const;

/**
 * Which decoder layers each shard owns. Taken from
 * `packages/_onnx_experiments/tools/qwen3_shard_export/split_qwen3_onnx.py`, and checked against the running
 * sessions before anything is measured.
 */
const SHARD_LAYERS: ReadonlyArray<{ first: number; last: number }> = [
	{
		first: 0,
		last: 8,
	},
	{
		first: 9,
		last: 18,
	},
	{
		first: 19,
		last: 27,
	},
];

/**
 * The two tensors each shard hands to the next one. ONNX Runtime Web cuts the residual stream where the
 * next layer normalizes it, so the boundary carries both the normalized hidden state and the residual one.
 * LiteRT.js carries a single hidden state instead.
 */
const SHARD_BOUNDARIES: ReadonlyArray<{ normalized: string; residual: string } | undefined> = [
	undefined,
	{
		normalized: '/model/layers.9/input_layernorm/output_0',
		residual: '/model/layers.9/input_layernorm/output_3',
	},
	{
		normalized: '/model/layers.19/input_layernorm/output_0',
		residual: '/model/layers.19/input_layernorm/output_3',
	},
];

/**
 * How many tokens are generated in each measured decode run. The same count milestone four generated.
 */
const DECODE_STEPS = 32;

/**
 * How many positions are decoded and thrown away before anything is measured. A warm-up of four positions
 * was not enough: it left the first measured run at 2.63 tokens per second against 7.49 and 7.34 for the two
 * after it. A whole decode is thrown away instead.
 */
const WARMUP_DECODE_STEPS = 32;

/**
 * How many prefill calls of each length are thrown away before that length is measured.
 */
const WARMUP_PREFILL_RUNS = 2;

/**
 * How many times each measurement is repeated, because no timing is reported from a single run. Five rather
 * than three, because decoding keeps getting faster for longer than any warm-up here can cover: with a whole
 * decode thrown away first, the runs after it still went 7.20, 23.25 and 24.98 tokens per second. Every run
 * is printed so that a figure still climbing can be seen to be still climbing.
 */
const MEASURED_RUNS = 5;

/**
 * The prompt lengths milestone five exported one prefill graph apiece for.
 */
const PREFILL_LENGTHS = [32, 128, 512];

const outputElement = document.querySelector('#output') as HTMLPreElement;
const runButton = document.querySelector('#run') as HTMLButtonElement;
const searchParameters = new URLSearchParams(location.search);

/**
 * Whether the page has been out of sight at any moment since it loaded. Chrome slows a hidden tab down, and
 * a run that spent part of its time hidden is not a measurement of anything. The first four runs of this
 * page were all taken hidden, and disagreed with each other by a factor of five.
 */
let wasEverHidden = document.visibilityState === 'hidden';
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		wasEverHidden = true;
	}
});

/**
 * Where each key/value cache lives between calls. `cpu` copies it out to JavaScript and back on every call,
 * which is what the cluster does today; `gpu-buffer` leaves it on the graphics processor, which is what
 * milestone four does with LiteRT.js.
 */
const CACHE_LOCATION = (searchParameters.get('cacheLocation') ?? 'cpu') as 'cpu' | 'gpu-buffer';

/**
 * Which execution provider to run the graphs on.
 */
const EXECUTION_PROVIDER = (searchParameters.get('executionProvider') ?? 'webgpu') as 'webgpu' | 'wasm';

OnnxRuntimeWeb.env.wasm.wasmPaths = '/';
// ONNX Runtime reports operator placement through the browser's error console even when inference continues.
// Those messages are read once by hand, in the section that describes the sessions, and would otherwise bury
// every measurement below them.
OnnxRuntimeWeb.env.logLevel = 'fatal';

/**
 * The named tensors passed to and returned from one shard.
 */
type TensorMap = Record<string, OnnxRuntimeWeb.Tensor>;

/**
 * What one decode run cost.
 */
type DecodeMeasurement = {
	/** How many single-token positions were decoded. */
	steps: number;
	/** How long all of those positions took together. */
	totalMilliseconds: number;
	/** How long each shard spent inside `run()` across all of those positions. */
	shardMilliseconds: number[];
	/** How many bytes crossed each shard boundary at one position. */
	boundaryBytes: number[];
	/** The tokens generated. */
	tokens: number[];
};

/**
 * What one prefill run cost.
 */
type PrefillMeasurement = {
	/** How many tokens were read in one call. */
	length: number;
	/** How long the three shards took together. */
	totalMilliseconds: number;
	/** How long each shard spent inside `run()`. */
	shardMilliseconds: number[];
	/** How many bytes crossed each shard boundary. */
	boundaryBytes: number[];
	/** The token chosen after reading the prompt. */
	argmaxToken: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Reporting
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Writes one line to the page and to the browser console.
 *
 * @param line The line to write.
 * @returns Nothing.
 */
function report(line: string): void {
	outputElement.textContent += `${line}\n`;
	console.log(line);
}

/**
 * Formats a duration in milliseconds to three decimal places.
 *
 * @param milliseconds The duration.
 * @returns The duration, written out with its unit.
 */
function formatMilliseconds(milliseconds: number): string {
	return `${milliseconds.toFixed(3)} ms`;
}

/**
 * Formats a byte count in mebibytes to two decimal places.
 *
 * @param bytes The byte count.
 * @returns The byte count in mebibytes, written out with its unit.
 */
function formatMebibytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Averages a list of numbers.
 *
 * @param values The numbers.
 * @returns Their mean, or zero when the list is empty.
 */
function mean(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((total, value) => total + value, 0) / values.length;
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Loading
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Names the key/value cache outputs of one shard, so that they can be asked to stay on the graphics
 * processor. The names are computed from the layer ranges and then checked against the running session,
 * because a wrong name here would silently leave the cache on the central processor.
 *
 * @param shardIndex Which shard, counting from zero.
 * @returns The output names of that shard's key/value cache.
 */
function cacheOutputNames(shardIndex: number): string[] {
	const layers = SHARD_LAYERS[shardIndex];
	const names: string[] = [];
	for (let layer = layers.first; layer <= layers.last; layer += 1) {
		names.push(`present.${layer}.key`);
		names.push(`present.${layer}.value`);
	}
	return names;
}

/**
 * Downloads one shard and creates its session, timing the two apart.
 *
 * @param shardIndex Which shard, counting from zero.
 * @returns The session, how many bytes it was built from, and what each stage cost.
 */
async function createShardSession(shardIndex: number): Promise<{
	session: OnnxRuntimeWeb.InferenceSession;
	bytes: number;
	fetchMilliseconds: number;
	createMilliseconds: number;
}> {
	const fetchStart = performance.now();
	const response = await fetch(`${SHARD_PREFIX}/${SHARD_FILE_NAMES[shardIndex]}`);
	if (response.ok === false) {
		throw new Error(`${SHARD_FILE_NAMES[shardIndex]} could not be read (${response.status}).`);
	}
	const bytes = await response.arrayBuffer();
	const fetchMilliseconds = performance.now() - fetchStart;

	const wantedCacheNames = cacheOutputNames(shardIndex);
	const preferredOutputLocation: Record<string, OnnxRuntimeWeb.Tensor.DataLocation> = {};
	if (CACHE_LOCATION === 'gpu-buffer') {
		for (const name of wantedCacheNames) {
			preferredOutputLocation[name] = 'gpu-buffer';
		}
	}

	const createStart = performance.now();
	const session = await OnnxRuntimeWeb.InferenceSession.create(bytes, {
		executionProviders: [EXECUTION_PROVIDER],
		graphOptimizationLevel: 'all',
		preferredOutputLocation: preferredOutputLocation,
	});
	const createMilliseconds = performance.now() - createStart;

	const actualCacheNames = session.outputNames.filter((name) => name.startsWith('present.'));
	const missing = wantedCacheNames.filter((name) => actualCacheNames.includes(name) === false);
	if (missing.length > 0 || actualCacheNames.length !== wantedCacheNames.length) {
		throw new Error(
			`Shard ${shardIndex + 1} owns ${actualCacheNames.length} cache outputs, not the ` +
				`${wantedCacheNames.length} expected for layers ${SHARD_LAYERS[shardIndex].first} to ` +
				`${SHARD_LAYERS[shardIndex].last}. Missing: ${missing.join(', ') || 'none'}.`,
		);
	}

	return {
		session: session,
		bytes: bytes.byteLength,
		fetchMilliseconds: fetchMilliseconds,
		createMilliseconds: createMilliseconds,
	};
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Running
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Creates a 64-bit integer tensor for the token, mask, and position inputs.
 *
 * @param values The values.
 * @param dimensions The tensor's dimensions.
 * @returns The tensor.
 */
function int64Tensor(values: number[], dimensions: readonly number[]): OnnxRuntimeWeb.Tensor {
	return new OnnxRuntimeWeb.Tensor('int64', BigInt64Array.from(values, BigInt), dimensions);
}

/**
 * Creates the empty key/value cache the first call of a sequence is given.
 *
 * @returns An empty 16-bit floating point key/value cache tensor.
 */
function emptyCache(): OnnxRuntimeWeb.Tensor {
	return new OnnxRuntimeWeb.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
}

/**
 * Builds every input one shard needs for one call.
 *
 * @param session The shard's session.
 * @param inputTokens The tokens fed in at this call.
 * @param position The position of the first of those tokens.
 * @param cache The key/value cache the previous call of this shard returned, if there was one.
 * @param boundary The two tensors the previous shard handed over, if this is not the first shard.
 * @returns The named input tensors.
 */
function buildInputs(
	session: OnnxRuntimeWeb.InferenceSession,
	inputTokens: number[],
	position: number,
	cache: TensorMap | undefined,
	boundary: TensorMap | undefined,
): TensorMap {
	const inputs: TensorMap = {
		input_ids: int64Tensor(inputTokens, [1, inputTokens.length]),
		attention_mask: int64Tensor(
			Array.from({ length: position + inputTokens.length }, () => 1),
			[1, position + inputTokens.length],
		),
		position_ids: int64Tensor(
			Array.from({ length: inputTokens.length }, (_unused, index) => position + index),
			[1, inputTokens.length],
		),
	};
	if (boundary !== undefined) {
		for (const name of Object.keys(boundary)) {
			inputs[name] = boundary[name];
		}
	}
	for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) {
		inputs[name] = cache?.[name] ?? emptyCache();
	}
	return inputs;
}

/**
 * Takes the key/value cache out of one call's outputs, renaming it to the names the next call reads it by.
 *
 * @param outputs Everything the call returned.
 * @returns The key/value cache, ready to be fed back in.
 */
function takeCache(outputs: TensorMap): TensorMap {
	const cache: TensorMap = {};
	for (const [name, tensor] of Object.entries(outputs)) {
		if (name.startsWith('present.') === true) {
			cache[name.replace('present', 'past_key_values')] = tensor;
		}
	}
	return cache;
}

/**
 * Frees a key/value cache that is about to be replaced. A cache left on the graphics processor is not
 * collected on its own, so a decode of thirty-two positions would otherwise hold thirty-two of them.
 *
 * @param cache The cache to free, if there is one.
 * @returns Nothing.
 */
function releaseCache(cache: TensorMap | undefined): void {
	if (cache === undefined) {
		return;
	}
	for (const tensor of Object.values(cache)) {
		if (tensor.location === 'gpu-buffer') {
			tensor.dispose();
		}
	}
}

/**
 * How many bytes one value of each tensor type takes. Read from the type rather than from the values,
 * because a tensor kept on the graphics processor has no values to read.
 */
const BYTES_PER_VALUE: Record<string, number> = {
	float32: 4,
	float16: 2,
	int64: 8,
	int32: 4,
	uint8: 1,
	int8: 1,
	bool: 1,
};

/**
 * Measures a tensor from its shape and its type.
 *
 * @param tensor The tensor.
 * @returns How many bytes its values take.
 */
function tensorByteLength(tensor: OnnxRuntimeWeb.Tensor): number {
	const valueCount = tensor.dims.reduce((total, dimension) => total * dimension, 1);
	return valueCount * (BYTES_PER_VALUE[tensor.type] ?? 4);
}

/**
 * Turns one 16-bit floating point value into a number.
 *
 * @param bits The sixteen bits.
 * @returns The number they stand for.
 */
function decodeHalf(bits: number): number {
	const sign = (bits & 0x8000) !== 0 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const fraction = bits & 0x3ff;
	if (exponent === 0) {
		return sign * 2 ** -14 * (fraction / 1024);
	}
	if (exponent === 31) {
		return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
	}
	return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/**
 * Chooses the token with the largest logit at the last position. A 16-bit floating point tensor whose values
 * arrive as raw sixteen-bit patterns is decoded first: comparing those patterns as whole numbers would order
 * every negative logit backwards.
 *
 * @param logits The logits tensor the last shard returned.
 * @returns The chosen token.
 */
function chooseToken(logits: OnnxRuntimeWeb.Tensor): number {
	const values = logits.data as ArrayLike<number>;
	const isRawHalf = logits.type === 'float16' && values instanceof Uint16Array;
	const vocabularySize = logits.dims.at(-1) ?? 0;
	const offset = values.length - vocabularySize;
	let bestToken = 0;
	let bestValue = Number.NEGATIVE_INFINITY;
	for (let token = 0; token < vocabularySize; token += 1) {
		const raw = values[offset + token];
		const value = isRawHalf === true ? decodeHalf(raw) : raw;
		if (value > bestValue) {
			bestValue = value;
			bestToken = token;
		}
	}
	return bestToken;
}

/**
 * How the logits came back, recorded the first time they are read so that the report can say what type the
 * ONNX side actually works in rather than what its file says.
 */
let observedLogits: string | undefined;

/**
 * Finds the logits among the last shard's outputs.
 *
 * @param outputs Everything the last shard returned.
 * @returns The logits tensor.
 */
function findLogits(outputs: TensorMap): OnnxRuntimeWeb.Tensor {
	const name = Object.keys(outputs).find((candidate) => candidate === 'logits' || candidate.endsWith('.logits'));
	if (name === undefined) {
		throw new Error(`The last shard returned no logits. It returned: ${Object.keys(outputs).join(', ')}`);
	}
	const logits = outputs[name];
	observedLogits ??= `${name}: type ${logits.type}, shape [${logits.dims.join(', ')}], ` +
		`values arrive as ${(logits.data as object).constructor.name}, kept on ${logits.location}`;
	return logits;
}

/**
 * Pushes one call through all three shards, keeping each shard's key/value cache and handing the boundary
 * tensors from one shard to the next.
 *
 * @param sessions The three shard sessions.
 * @param inputTokens The tokens fed in at this call.
 * @param position The position of the first of those tokens.
 * @param caches Each shard's key/value cache, replaced in place.
 * @returns The token chosen, how long each shard took, and how many bytes crossed each boundary.
 */
async function runOnePosition(
	sessions: OnnxRuntimeWeb.InferenceSession[],
	inputTokens: number[],
	position: number,
	caches: Array<TensorMap | undefined>,
): Promise<{ token: number; shardMilliseconds: number[]; boundaryBytes: number[] }> {
	const shardMilliseconds: number[] = [];
	const boundaryBytes: number[] = [];
	let boundary: TensorMap | undefined;
	let token = 0;

	for (const [index, session] of sessions.entries()) {
		const inputs = buildInputs(session, inputTokens, position, caches[index], boundary);
		const start = performance.now();
		const outputs = (await session.run(inputs)) as TensorMap;
		shardMilliseconds.push(performance.now() - start);

		releaseCache(caches[index]);
		caches[index] = takeCache(outputs);

		if (index < sessions.length - 1) {
			const names = SHARD_BOUNDARIES[index + 1];
			if (names === undefined) {
				throw new Error(`No boundary is defined after shard ${index + 1}.`);
			}
			boundary = {
				[names.normalized]: outputs[names.normalized],
				[names.residual]: outputs[names.residual],
			};
			boundaryBytes.push(
				tensorByteLength(outputs[names.normalized]) + tensorByteLength(outputs[names.residual]),
			);
		} else {
			token = chooseToken(findLogits(outputs));
		}
	}

	return {
		token: token,
		shardMilliseconds: shardMilliseconds,
		boundaryBytes: boundaryBytes,
	};
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Measurements
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads the prompt, then generates tokens one at a time, timing only the single-token positions.
 *
 * @param sessions The three shard sessions.
 * @param promptTokens The prompt.
 * @param steps How many tokens to generate.
 * @returns What the run cost and which tokens it produced.
 */
async function decode(
	sessions: OnnxRuntimeWeb.InferenceSession[],
	promptTokens: number[],
	steps: number,
): Promise<DecodeMeasurement> {
	const caches: Array<TensorMap | undefined> = [undefined, undefined, undefined];
	const tokens: number[] = [];
	const shardTotals = [0, 0, 0];
	let boundaryBytes: number[] = [];
	let position = 0;

	// The whole prompt goes in one call, exactly as the ONNX graph allows and milestone five's LiteRT.js
	// graphs do not. That call is prefill and is not counted in the decode timing below.
	const first = await runOnePosition(sessions, promptTokens, position, caches);
	tokens.push(first.token);
	position += promptTokens.length;

	const decodeStart = performance.now();
	for (let step = 1; step < steps; step += 1) {
		const result = await runOnePosition(sessions, [tokens[tokens.length - 1]], position, caches);
		tokens.push(result.token);
		for (const [index, milliseconds] of result.shardMilliseconds.entries()) {
			shardTotals[index] += milliseconds;
		}
		boundaryBytes = result.boundaryBytes;
		position += 1;
	}
	const totalMilliseconds = performance.now() - decodeStart;

	for (const cache of caches) {
		releaseCache(cache);
	}

	return {
		steps: steps - 1,
		totalMilliseconds: totalMilliseconds,
		shardMilliseconds: shardTotals,
		boundaryBytes: boundaryBytes,
		tokens: tokens,
	};
}

/**
 * Reads one whole prompt in a single call per shard, and times it.
 *
 * @param sessions The three shard sessions.
 * @param promptTokens The prompt.
 * @returns What the call cost and which token it chose.
 */
async function prefill(
	sessions: OnnxRuntimeWeb.InferenceSession[],
	promptTokens: number[],
): Promise<PrefillMeasurement> {
	const caches: Array<TensorMap | undefined> = [undefined, undefined, undefined];
	const start = performance.now();
	const result = await runOnePosition(sessions, promptTokens, 0, caches);
	const totalMilliseconds = performance.now() - start;
	for (const cache of caches) {
		releaseCache(cache);
	}
	return {
		length: promptTokens.length,
		totalMilliseconds: totalMilliseconds,
		shardMilliseconds: result.shardMilliseconds,
		boundaryBytes: result.boundaryBytes,
		argmaxToken: result.token,
	};
}

/**
 * Describes what the three running sessions actually hold, so that every measurement below can be read in
 * the light of it. This is the part of milestone six that answers whether the comparison the plan promises
 * exists at all.
 *
 * @param sessions The three shard sessions.
 * @param shardBytes How large each shard file is.
 * @returns Nothing. Everything is reported.
 */
function describeSessions(sessions: OnnxRuntimeWeb.InferenceSession[], shardBytes: number[]): void {
	report('--- what the ONNX side holds ---');
	for (const [index, session] of sessions.entries()) {
		const layers = SHARD_LAYERS[index];
		const cacheOutputs = session.outputNames.filter((name) => name.startsWith('present.'));
		report(
			`shard ${index + 1}: decoder layers ${layers.first} to ${layers.last}, ` +
				`${formatMebibytes(shardBytes[index])}, ` +
				`${session.inputNames.length} inputs, ${session.outputNames.length} outputs, ` +
				`${cacheOutputs.length} key/value cache outputs`,
		);
		const nonCacheInputs = session.inputNames.filter((name) => name.startsWith('past_key_values.') === false);
		const nonCacheOutputs = session.outputNames.filter((name) => name.startsWith('present.') === false);
		report(`  inputs other than the cache: ${nonCacheInputs.join(', ')}`);
		report(`  outputs other than the cache: ${nonCacheOutputs.join(', ')}`);
	}
	report(`total on disk: ${formatMebibytes(shardBytes.reduce((total, bytes) => total + bytes, 0))}`);
	report('');
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs the whole comparison and writes it to the page.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	outputElement.textContent = '';
	wasEverHidden = document.visibilityState === 'hidden';
	if (wasEverHidden === true) {
		report('THIS PAGE IS HIDDEN. Chrome slows a hidden tab down. Bring it to the front and run it again.');
	}
	report(`user agent: ${navigator.userAgent}`);
	report(`execution provider: ${EXECUTION_PROVIDER}, key/value cache kept on: ${CACHE_LOCATION}`);
	const adapter = await navigator.gpu?.requestAdapter();
	report(`graphics processor: ${adapter?.info?.architecture ?? 'unknown'} (${adapter?.info?.vendor ?? 'unknown'})`);
	report('');

	const [decodeReference, prefillIndex] = await Promise.all([
		fetch(`${MODELS_PREFIX}/decode_reference.json`).then((response) => response.json() as Promise<DecodeReference>),
		fetch(`${MODELS_PREFIX}/prefill_index.json`).then((response) => response.json() as Promise<PrefillIndex>),
	]);
	report(`reference: ${decodeReference.model}, prompt ${JSON.stringify(decodeReference.prompt)}`);
	report(`prompt tokens: ${JSON.stringify(decodeReference.promptTokens)}`);
	report('');

	report('--- initialization ---');
	const sessions: OnnxRuntimeWeb.InferenceSession[] = [];
	const shardBytes: number[] = [];
	const initializationStart = performance.now();
	for (let index = 0; index < SHARD_FILE_NAMES.length; index += 1) {
		const created = await createShardSession(index);
		sessions.push(created.session);
		shardBytes.push(created.bytes);
		report(
			`shard ${index + 1}: read ${formatMebibytes(created.bytes)} in ` +
				`${formatMilliseconds(created.fetchMilliseconds)}, ` +
				`parsed, compiled and uploaded in ${formatMilliseconds(created.createMilliseconds)}`,
		);
	}
	report(`all three ready in ${formatMilliseconds(performance.now() - initializationStart)}`);
	report('');

	describeSessions(sessions, shardBytes);

	report('--- correctness, against the same PyTorch reference milestones four and five used ---');
	const warmup = await decode(sessions, decodeReference.promptTokens, WARMUP_DECODE_STEPS);
	report(`warm-up of ${warmup.steps} positions done, thrown away`);
	report(`logits: ${observedLogits ?? 'not read'}`);

	const runs: DecodeMeasurement[] = [];
	for (let run = 0; run < MEASURED_RUNS; run += 1) {
		runs.push(await decode(sessions, decodeReference.promptTokens, DECODE_STEPS));
	}
	const generated = runs[0].tokens;
	report(`generated:      ${JSON.stringify(generated)}`);
	report(`unsplit PyTorch: ${JSON.stringify(decodeReference.unsplitTokens)}`);
	const divergence = generated.findIndex((token, index) => token !== decodeReference.unsplitTokens[index]);
	if (divergence === -1) {
		report(`the two agree on all ${generated.length} tokens`);
	} else {
		report(
			`the two agree for ${divergence} tokens and then part: ` +
				`${generated[divergence]} against ${decodeReference.unsplitTokens[divergence]}`,
		);
	}
	report('');

	report('--- decode ---');
	for (const [index, run] of runs.entries()) {
		const perToken = run.totalMilliseconds / run.steps;
		report(
			`run ${index + 1}: ${run.steps} positions in ${formatMilliseconds(run.totalMilliseconds)}, ` +
				`${(1000 / perToken).toFixed(2)} tokens per second, ${formatMilliseconds(perToken)} per token`,
		);
		report(
			`  inside run(): shard 1 ${formatMilliseconds(run.shardMilliseconds[0] / run.steps)}, ` +
				`shard 2 ${formatMilliseconds(run.shardMilliseconds[1] / run.steps)}, ` +
				`shard 3 ${formatMilliseconds(run.shardMilliseconds[2] / run.steps)} per position`,
		);
	}
	report(
		`bytes across each boundary at one position: ${runs[0].boundaryBytes.join(' and ')} ` +
			`(two 16-bit floating point tensors of ${decodeReference.hiddenSize} values each)`,
	);
	report(
		`mean over ${MEASURED_RUNS} runs: ` +
			`${(1000 / mean(runs.map((run) => run.totalMilliseconds / run.steps))).toFixed(2)} tokens per second`,
	);
	report('');

	report('--- prefill ---');
	for (const length of PREFILL_LENGTHS) {
		const reference = prefillIndex.prefills.find((candidate) => candidate.length === length);
		if (reference === undefined) {
			report(`${length}: no reference was exported for this length, skipped`);
			continue;
		}
		for (let warmup = 0; warmup < WARMUP_PREFILL_RUNS; warmup += 1) {
			await prefill(sessions, reference.tokens);
		}
		const measurements: PrefillMeasurement[] = [];
		for (let run = 0; run < MEASURED_RUNS; run += 1) {
			measurements.push(await prefill(sessions, reference.tokens));
		}
		const rates = measurements.map((measurement) => (length * 1000) / measurement.totalMilliseconds);
		report(
			`${length} tokens: ${rates.map((rate) => rate.toFixed(1)).join(' / ')} tokens per second, ` +
				`${measurements.map((measurement) => formatMilliseconds(measurement.totalMilliseconds)).join(' / ')}`,
		);
		report(
			`  chose token ${measurements[0].argmaxToken}, unsplit PyTorch chose ${reference.unsplitArgmaxToken}` +
				`${measurements[0].argmaxToken === reference.unsplitArgmaxToken ? '' : ' — they differ'}`,
		);
		report(
			`  bytes across each boundary: ${measurements[0].boundaryBytes.join(' and ')}, ` +
				`against ${reference.activationBytes} for one 32-bit floating point activation`,
		);
	}
	report('');

	const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
	if (memory !== undefined) {
		report(`JavaScript heap in use: ${formatMebibytes(memory.usedJSHeapSize)}`);
	}

	// Without this, every page load leaves its 860 megabytes of graphics-processor buffers behind, and the
	// load after it measures a machine that is already paging. That is what made the first four runs of this
	// page disagree with each other by a factor of five for the same settings.
	for (const session of sessions) {
		await session.release();
	}
	report('the three sessions are released.');
	if (wasEverHidden === true) {
		report('EVERY FIGURE ABOVE IS VOID: the page was out of sight for part of this run.');
	} else {
		report('the page stayed in sight for the whole run.');
	}
	report('done.');
}

runButton.addEventListener('click', () => {
	runButton.disabled = true;
	main()
		.catch((error: unknown) => {
			report(`FAILED: ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
		})
		.finally(() => {
			runButton.disabled = false;
		});
});

// `?autorun=1` starts the run as soon as the page loads. It exists so that the whole run can be left alone:
// reading the page while it works is itself a disturbance, because touching a hidden tab lifts the slowdown
// Chrome puts on it, and that disturbance was large enough to move the figures by a factor of three.
if (searchParameters.get('autorun') === '1') {
	runButton.click();
}
