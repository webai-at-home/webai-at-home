import { LiteRtSide } from './litert_side.js';
import { ONNX_SHARD_LAYER_COUNTS, OnnxSide } from './onnx_side.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RuntimeComparisonInterleaved — both runtimes in one page load, alternating
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Which LiteRT.js decoder shard is run, and how many decoder layers it owns.
 */
const LITERT_SHARD_NAME = 'decoder_00-03';

/**
 * How many decoder layers `LITERT_SHARD_NAME` owns.
 */
const LITERT_LAYER_COUNT = 4;

/**
 * Which ONNX shard's cost is divided by a layer count. Shard 2 is the only one that is nothing but decoder
 * layers: shard 1 also carries the token embedding and shard 3 the final normalization and the
 * language-model head.
 */
const ONNX_MEASURED_SHARD = 1;

/**
 * How many tokens each ONNX block generates.
 */
const ONNX_DECODE_STEPS = 32;

/**
 * How many blocks of each runtime are thrown away before anything is counted.
 */
const WARMUP_BLOCKS = 2;

/**
 * How many blocks of each runtime are counted. They alternate, so anything that drifts over the life of the
 * page drifts through both columns alike.
 */
const MEASURED_BLOCKS = 5;

const outputElement = document.querySelector('#output') as HTMLPreElement;
const runButton = document.querySelector('#run') as HTMLButtonElement;
const searchParameters = new URLSearchParams(location.search);

/**
 * Whether the page has been out of sight at any moment since the run began. Chrome slows a hidden tab down.
 */
let wasEverHidden = document.visibilityState === 'hidden';
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		wasEverHidden = true;
	}
});

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
 * Formats a byte count in mebibytes.
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

/**
 * Runs both runtimes alternately and writes the comparison to the page.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	outputElement.textContent = '';
	wasEverHidden = document.visibilityState === 'hidden';
	report(`user agent: ${navigator.userAgent}`);
	const adapter = await navigator.gpu?.requestAdapter();
	report(`graphics processor: ${adapter?.info?.architecture ?? 'unknown'} (${adapter?.info?.vendor ?? 'unknown'})`);
	report(
		'Both runtimes are loaded into this one page and run in alternating blocks. Everything that made the ' +
			'separate pages disagree with each other — how warm the machine is, what the browser cached, what ' +
			'else was running — now moves both columns together instead of one of them.',
	);
	report('');

	// LiteRT.js is loaded first: it needs one contiguous block of its WebAssembly heap the size of the whole
	// graph, and that is the harder allocation of the two to satisfy.
	report('--- loading ---');
	const liteRtSide = new LiteRtSide(LITERT_SHARD_NAME, LITERT_LAYER_COUNT);
	const liteRtLoad = await liteRtSide.load();
	report(
		`LiteRT.js ${LITERT_SHARD_NAME}: ${formatMebibytes(liteRtLoad.bytes)}, ` +
			`${LITERT_LAYER_COUNT} decoder layers, loaded and compiled in ` +
			`${formatMilliseconds(liteRtLoad.compileMilliseconds)}, fully accelerated=${liteRtSide.isFullyAccelerated()}`,
	);

	const onnxSide = new OnnxSide();
	const onnxLoad = await onnxSide.load();
	report(
		`ONNX Runtime Web, three shards: ${formatMebibytes(onnxLoad.bytes.reduce((total, b) => total + b, 0))}, ` +
			`read in ${formatMilliseconds(onnxLoad.fetchMilliseconds)}, ` +
			`parsed, compiled and uploaded in ${formatMilliseconds(onnxLoad.createMilliseconds)}`,
	);
	report(
		`the shard whose cost is divided by a layer count is ONNX shard ${ONNX_MEASURED_SHARD + 1}, ` +
			`${ONNX_SHARD_LAYER_COUNTS[ONNX_MEASURED_SHARD]} decoder layers and nothing else`,
	);
	report('');

	report(`--- ${WARMUP_BLOCKS} warm-up blocks each, thrown away ---`);
	const promptTokens = [785, 6722, 315, 9625, 374];
	for (let block = 0; block < WARMUP_BLOCKS; block += 1) {
		await liteRtSide.decodeBlock();
		await onnxSide.decodeBlock(promptTokens, ONNX_DECODE_STEPS);
	}
	report('done.');
	report('');

	report(`--- ${MEASURED_BLOCKS} measured blocks each, alternating ---`);
	report('  block  LiteRT.js per layer   ONNX Runtime Web per layer   ratio');
	const liteRtPerLayer: number[] = [];
	const onnxPerLayer: number[] = [];
	let largestLiteRtDifference = 0;
	let onnxTokens: number[] = [];

	for (let block = 0; block < MEASURED_BLOCKS; block += 1) {
		const liteRtBlock = await liteRtSide.decodeBlock();
		const onnxBlock = await onnxSide.decodeBlock(promptTokens, ONNX_DECODE_STEPS);

		const liteRtValue = liteRtBlock.wallClockMilliseconds / liteRtBlock.positions / LITERT_LAYER_COUNT;
		const onnxValue =
			onnxBlock.shardMilliseconds[ONNX_MEASURED_SHARD] /
			onnxBlock.positions /
			ONNX_SHARD_LAYER_COUNTS[ONNX_MEASURED_SHARD];
		liteRtPerLayer.push(liteRtValue);
		onnxPerLayer.push(onnxValue);
		largestLiteRtDifference = Math.max(largestLiteRtDifference, liteRtBlock.largestDifference);
		onnxTokens = onnxBlock.tokens;

		report(
			`  ${String(block + 1).padStart(5)}  ${formatMilliseconds(liteRtValue).padStart(19)}   ` +
				`${formatMilliseconds(onnxValue).padStart(26)}   ${(liteRtValue / onnxValue).toFixed(2)}`,
		);
	}
	report('');

	const liteRtMean = mean(liteRtPerLayer);
	const onnxMean = mean(onnxPerLayer);
	report(
		`LiteRT.js, 32-bit floating point: ${formatMilliseconds(liteRtMean)} per decoder layer per token, ` +
			`over ${MEASURED_BLOCKS} blocks`,
	);
	report(
		`ONNX Runtime Web, four-bit: ${formatMilliseconds(onnxMean)} per decoder layer per token, ` +
			`over ${MEASURED_BLOCKS} blocks`,
	);
	report(`LiteRT.js takes ${(liteRtMean / onnxMean).toFixed(2)} times as long per decoder layer.`);
	report('');
	report('The two hold different weights. Per decoder layer per token, the weights that have to be read are');
	report('  ONNX Runtime Web: about 7.87 megabytes at four bits');
	report('  LiteRT.js:        about 62.9 megabytes at 32 bits');
	report(`so eight times the bytes are read for ${(liteRtMean / onnxMean).toFixed(2)} times the time.`);
	report('');

	report('--- correctness, both against the same PyTorch reference ---');
	report(`LiteRT.js largest relative difference over every position: ${largestLiteRtDifference.toExponential(3)}`);
	report(`ONNX Runtime Web generated: ${JSON.stringify(onnxTokens.slice(0, 12))}...`);
	report('');

	liteRtSide.release();
	await onnxSide.release();
	report('both runtimes are released.');
	if (wasEverHidden === true) {
		report('NOTE: the page was out of sight for part of this run, so both columns were slowed together.');
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

// `?autorun=1` starts the run as soon as the page loads, so that the whole run can be left alone: reading a
// hidden page lifts the slowdown Chrome puts on it.
if (searchParameters.get('autorun') === '1') {
	runButton.click();
}
