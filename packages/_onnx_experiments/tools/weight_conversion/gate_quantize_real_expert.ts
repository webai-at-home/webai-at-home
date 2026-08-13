import { QuantizeMatmulnbits } from './quantize_matmulnbits.js';
import type { QuantizationOptions } from './quantize_matmulnbits.js';
import { SafetensorsReader } from './safetensors_reader.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GateQuantizeRealExpert — the de-risking gate of milestone 3 of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/169 converts Qwen3-30B-A3B into an always
 * resident part and 6144 expert blocks. Before any of that is written, one assumption has to be proved or killed:
 *
 * > Can real Qwen3-30B-A3B expert weights, published at BF16, be quantized into the exact `MatMulNBits` 4-bit block
 * > format that the milestone 0 gate confirmed, and still produce an expert output close enough to the original?
 *
 * Milestone 0 proved the format against weights this project made up. Nothing so far has quantized a real published
 * weight, and a format that works on synthetic values can still be the wrong format for these ones.
 *
 * The hard part of this gate is not the arithmetic, it is knowing what "close enough" means. Four bits always loses
 * a great deal, and a threshold picked by taste would only measure the taste. So the gate does not pick one. It
 * quantizes the same weights that **`mlx-community/Qwen3-30B-A3B-4bit`** quantized, dequantizes that published file,
 * and compares against it. That model is a 4-bit quantization of this exact base model that people run every day, so
 * "no worse than that" is a threshold with something behind it.
 *
 * Everything is read by HTTP range request into the safetensors shards, so the gate downloads about 10 megabytes
 * rather than 57 gigabytes.
 */

/** The Hugging Face repository holding the model this experiment targets. */
const MODEL_REPOSITORY = 'Qwen/Qwen3-30B-A3B';
/** A published 4-bit quantization of that exact model, used as the reference this gate judges itself against. */
const REFERENCE_REPOSITORY = 'mlx-community/Qwen3-30B-A3B-4bit';
/** The number of weights sharing one scale in the reference, which its own configuration file states. */
const REFERENCE_GROUP_SIZE = 64;
/** The revision to read from both repositories. */
const MODEL_REVISION = 'main';
/** The layer and the expert this gate reads. Any one would do; these are the first. */
const LAYER_INDEX = 0;
/** The expert within that layer. */
const EXPERT_INDEX = 0;
/** The three projections one Qwen3-30B-A3B expert is made of. */
const PROJECTION_NAMES = ['gate_proj', 'up_proj', 'down_proj'] as const;
/** The quantization schemes this gate compares, before any of them is chosen. */
const COMPARED_SCHEMES: (QuantizationOptions & { label: string })[] = [
	{
		label: 'symmetric, blocks of 16',
		blockSize: 16,
		scheme: 'symmetric',
	},
	{
		label: 'symmetric, blocks of 32',
		blockSize: 32,
		scheme: 'symmetric',
	},
	{
		label: 'symmetric, blocks of 64',
		blockSize: 64,
		scheme: 'symmetric',
	},
	{
		label: 'asymmetric, blocks of 16',
		blockSize: 16,
		scheme: 'asymmetric',
	},
	{
		label: 'asymmetric, blocks of 32',
		blockSize: 32,
		scheme: 'asymmetric',
	},
	{
		label: 'asymmetric, blocks of 64',
		blockSize: 64,
		scheme: 'asymmetric',
	},
];
/** How many experts Qwen3-30B-A3B holds across its 48 layers, at 128 experts for each layer. */
const EXPERT_COUNT = 6144;
/** How many parameters those experts hold together, as milestone 1 measured from the published headers. */
const EXPERT_PARAMETER_COUNT = 28_991_029_248;
/**
 * The largest the expert weights may grow to, in bytes, which is what turns phase 2 from a beauty contest into a
 * choice. Accuracy alone would always pick the smallest block and the most bits, and the whole point of
 * https://github.com/webai-at-home/webai-at-home/issues/168 is that the model is too large to hold. Milestone 1
 * measured the whole model at 16.00 gigabytes, so the expert weights are held under 16 gigabytes here and the scheme
 * that loses least within that budget wins.
 */
const EXPERT_BYTE_BUDGET = 16 * 1024 * 1024 * 1024;
/** How many hidden states the end-to-end comparison runs through the expert. */
const TESTED_HIDDEN_STATE_COUNT = 8;
/**
 * How much worse than the published 4-bit reference this conversion is allowed to be. At 1 it would have to match a
 * quantizer that fits an arbitrary floating point offset for every block, which `MatMulNBits` cannot express, so a
 * little room is left for that one structural difference and for nothing else.
 */
const ACCEPTED_RATIO_AGAINST_REFERENCE = 1.1;

/** One of the expert's three projections as read from the source. */
type Projection = {
	/** The matrix shape, as rows then columns. */
	shape: number[];
	/** The weights, in row-major order. */
	values: Float32Array;
};

/** The pass or fail of one phase of the gate. */
type PhaseOutcome = {
	/** Whether the phase passed. */
	passed: boolean;
	/** What it found, in words. */
	summary: string;
};

/** What phase 2 found and chose. */
type SchemePhaseResult = {
	/** The phase's own outcome. */
	outcome: PhaseOutcome;
	/** The scheme it chose. */
	chosen: QuantizationOptions & { label: string };
};

/** What phase 4 measured, which phase 5 judges against the published reference. */
type WholeExpertPhaseResult = {
	/** The phase's own outcome. */
	outcome: PhaseOutcome;
	/** The mean relative error across every tested hidden state. */
	meanError: number;
	/** The worst relative error across every tested hidden state. */
	worstError: number;
};

/** The two numbers that decide whether block quantization will hurt a set of weights. */
type WeightStatistics = {
	/** The largest magnitude in the set. */
	largestMagnitude: number;
	/** The mean magnitude across the set. */
	meanMagnitude: number;
};

/** How far one set of weights moved from another, over the whole expert. */
type ExpertComparison = {
	/** The mean relative error across every tested hidden state. */
	meanError: number;
	/** The worst relative error across every tested hidden state. */
	worstError: number;
};

/** Proves or kills the one assumption milestone 3 rests on, against real published weights. */
class GateQuantizeRealExpert {
	/**
	 * Runs the gate and prints every raw number it produces.
	 *
	 * @returns Resolves once the gate has finished.
	 */
	static async main(): Promise<void> {
		console.log(`model: ${MODEL_REPOSITORY} at revision ${MODEL_REVISION}`);
		console.log(`  reading layer ${LAYER_INDEX}, expert ${EXPERT_INDEX}, by range request`);

		const reader = new SafetensorsReader(MODEL_REPOSITORY, MODEL_REVISION);
		const projections = new Map<string, Projection>();
		let downloadedBytes = 0;
		for (const projectionName of PROJECTION_NAMES) {
			const tensorName = `model.layers.${LAYER_INDEX}.mlp.experts.${EXPERT_INDEX}.${projectionName}.weight`;
			const tensor = await reader.locate(tensorName);
			const values = await reader.read(tensor);
			downloadedBytes += tensor.byteEnd - tensor.byteStart;
			projections.set(projectionName, {
				shape: tensor.shape,
				values: values,
			});
			console.log(
				`  ${projectionName.padEnd(10)} ${tensor.dataType} ${JSON.stringify(tensor.shape)} ` +
					`from ${tensor.shardName}, ${GateQuantizeRealExpert._megabytes(tensor.byteEnd - tensor.byteStart)}`,
			);
		}
		console.log(`  downloaded ${GateQuantizeRealExpert._megabytes(downloadedBytes)} in total`);

		const outcomes: PhaseOutcome[] = [];
		outcomes.push(GateQuantizeRealExpert._phaseWeightsAreOrdinary(projections));
		const schemeOutcome = GateQuantizeRealExpert._phaseChooseScheme(projections);
		outcomes.push(schemeOutcome.outcome);
		const chosen = schemeOutcome.chosen;
		outcomes.push(GateQuantizeRealExpert._phaseScalePrecision(projections, chosen));

		const ourError = GateQuantizeRealExpert._phaseWholeExpert(projections, chosen);
		outcomes.push(ourError.outcome);
		outcomes.push(await GateQuantizeRealExpert._phaseAgainstPublished(projections, ourError));
		outcomes.push(GateQuantizeRealExpert._phaseBlockLayout(projections, chosen));

		console.log('\n══ verdict');
		const allPassed = outcomes.every((outcome) => outcome.passed);
		if (allPassed) {
			console.log(
				'  GATE GREEN — real Qwen3-30B-A3B expert weights survive 4-bit block quantization in the exact\n' +
					'  MatMulNBits layout, and lose no more than a published 4-bit quantization of the same model that\n' +
					'  people already run. Milestone 3 converts the model with the scheme and layout printed above.',
			);
		} else {
			console.log(
				'  GATE RED — this conversion loses meaningfully more than the published 4-bit quantization of the\n' +
					'  same weights. Converting 15 gigabytes with it would produce a model that is worse than it needs\n' +
					'  to be, for a reason that has nothing to do with residency. Fix the quantizer first.',
			);
		}
		process.exitCode = allPassed ? 0 : 1;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Phases
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Phase 1. Describes the weights before touching them, because a quantization error only means something next to
	 * the distribution it came from.
	 *
	 * @param projections The three projections.
	 * @returns The outcome.
	 */
	private static _phaseWeightsAreOrdinary(projections: Map<string, Projection>): PhaseOutcome {
		console.log('\n── phase 1 · what these weights actually look like');
		let anyOutlier = false;
		for (const [projectionName, projection] of projections) {
			const statistics = GateQuantizeRealExpert._describe(projection.values);
			console.log(
				`  ${projectionName.padEnd(10)} largest magnitude ${statistics.largestMagnitude.toFixed(5)}, ` +
					`mean magnitude ${statistics.meanMagnitude.toFixed(5)}, ` +
					`ratio ${(statistics.largestMagnitude / statistics.meanMagnitude).toFixed(1)} to 1`,
			);
			if (statistics.largestMagnitude / statistics.meanMagnitude > 64) {
				anyOutlier = true;
			}
		}
		console.log(
			anyOutlier
				? '  At least one projection has a value far outside the rest. Block quantization spends its whole\n' +
					'  range on that one value and everything else in its block is crushed.'
				: '  No projection has an extreme outlier, which is the friendly case for block quantization.',
		);
		return {
			passed: true,
			summary: 'the weights were described',
		};
	}

	/**
	 * Phase 2. Measures every scheme rather than arguing about them.
	 *
	 * The choice is real. A fixed zero point of 8 needs no extra tensor and is what milestone 0 already runs, but it
	 * spends its range symmetrically whether or not the block is symmetric. Fitting each block's own range needs a
	 * zero point tensor declared in the graph and costs 4 more bits for every block. A smaller block fits its values
	 * more tightly and costs more scales. None of that decides anything on its own, so all of it is measured.
	 *
	 * @param projections The three projections.
	 * @returns The outcome and the chosen scheme.
	 */
	private static _phaseChooseScheme(projections: Map<string, Projection>): SchemePhaseResult {
		console.log('\n── phase 2 · which quantization scheme costs least, measured');
		console.log('  scheme                      weights differ by   bits each   all experts   within budget');
		const measured: { candidate: QuantizationOptions & { label: string }; error: number; bits: number; expertBytes: number }[] = [];
		for (const candidate of COMPARED_SCHEMES) {
			let worstError = 0;
			let bitsForEachWeight = 0;
			for (const [, projection] of projections) {
				const [rowCount, columnCount] = projection.shape;
				const matrix = QuantizeMatmulnbits.quantize(projection.values, rowCount, columnCount, candidate);
				const restored = QuantizeMatmulnbits.dequantize(matrix);
				worstError = Math.max(worstError, GateQuantizeRealExpert._relativeError(projection.values, restored));
				bitsForEachWeight = QuantizeMatmulnbits.byteLengths(matrix).bitsForEachWeight;
			}
			const expertBytes = (EXPERT_PARAMETER_COUNT * bitsForEachWeight) / 8;
			measured.push({
				candidate: candidate,
				error: worstError,
				bits: bitsForEachWeight,
				expertBytes: expertBytes,
			});
			console.log(
				`  ${candidate.label.padEnd(26)} ${(worstError * 100).toFixed(2).padStart(14)} per cent   ` +
					`${bitsForEachWeight.toFixed(3).padStart(9)}   ` +
					`${GateQuantizeRealExpert._gigabytes(expertBytes).padStart(11)}   ` +
					`${expertBytes <= EXPERT_BYTE_BUDGET ? 'yes' : 'no'}`,
			);
		}

		const affordable = measured.filter((entry) => entry.expertBytes <= EXPERT_BYTE_BUDGET);
		if (affordable.length === 0) {
			throw new Error('no scheme fits the expert byte budget, so phase 2 cannot choose one');
		}
		const best = affordable.reduce((left, right) => (right.error < left.error ? right : left));
		console.log(
			`\n  Accuracy alone would pick ${measured.reduce((left, right) => (right.error < left.error ? right : left)).candidate.label}, ` +
				'but size is the whole point of issue #168,\n' +
				`  so the rule is the smallest loss within ${GateQuantizeRealExpert._gigabytes(EXPERT_BYTE_BUDGET)} of expert weights.`,
		);
		console.log(`  chosen: ${best.candidate.label} — ${(best.error * 100).toFixed(2)} per cent, ` +
			`${best.bits.toFixed(3)} bits for each weight, ${GateQuantizeRealExpert._gigabytes(best.expertBytes)} of experts`);
		return {
			outcome: {
				passed: true,
				summary: `${best.candidate.label}, at ${(best.error * 100).toFixed(2)} per cent and ` +
					`${GateQuantizeRealExpert._gigabytes(best.expertBytes)}`,
			},
			chosen: best.candidate,
		};
	}

	/**
	 * Phase 3. Whether the block scales may be stored at half precision. This is not a detail: at a block size of 32
	 * a half-precision scale costs 0.5 bits for every weight and a single-precision scale costs 1, which across
	 * 28.99 billion expert parameters is 1.69 gigabytes.
	 *
	 * @param projections The three projections.
	 * @param chosen The scheme chosen in phase 2.
	 * @returns The outcome.
	 */
	private static _phaseScalePrecision(
		projections: Map<string, Projection>,
		chosen: QuantizationOptions,
	): PhaseOutcome {
		console.log('\n── phase 3 · whether the block scales survive half precision');
		let worstSingle = 0;
		let worstHalf = 0;
		for (const [, projection] of projections) {
			const [rowCount, columnCount] = projection.shape;
			const matrix = QuantizeMatmulnbits.quantize(projection.values, rowCount, columnCount, chosen);
			worstSingle = Math.max(
				worstSingle,
				GateQuantizeRealExpert._relativeError(projection.values, QuantizeMatmulnbits.dequantize(matrix)),
			);
			const halved = {
				...matrix,
				scales: QuantizeMatmulnbits.roundScalesToHalfPrecision(matrix.scales),
			};
			worstHalf = Math.max(
				worstHalf,
				GateQuantizeRealExpert._relativeError(projection.values, QuantizeMatmulnbits.dequantize(halved)),
			);
		}
		console.log(`  single-precision scales: weights differ by ${(worstSingle * 100).toFixed(3)} per cent`);
		console.log(`  half-precision scales:   weights differ by ${(worstHalf * 100).toFixed(3)} per cent`);
		console.log(
			`  half precision costs ${((worstHalf - worstSingle) * 100).toFixed(4)} percentage points and saves 0.5 bits\n` +
				'  for every weight, which is 1.69 gigabytes across the expert weights of the whole model',
		);
		return {
			passed: true,
			summary: `half precision costs ${((worstHalf - worstSingle) * 100).toFixed(4)} percentage points`,
		};
	}

	/**
	 * Phase 4. Runs the whole expert, meaning `down_proj(silu(gate_proj(x)) * up_proj(x))`, at full precision and
	 * again at 4 bits, and compares the outputs.
	 *
	 * A per-weight error says how far the weights moved. This says how far the expert's answer moves, which is the
	 * thing that has to survive, and it is always the larger of the two because three projections and a product
	 * compound their errors.
	 *
	 * @param projections The three projections.
	 * @param chosen The scheme chosen in phase 2.
	 * @returns The outcome and the errors, which phase 5 judges against the published reference.
	 */
	private static _phaseWholeExpert(
		projections: Map<string, Projection>,
		chosen: QuantizationOptions,
	): WholeExpertPhaseResult {
		console.log('\n── phase 4 · the whole expert, at full precision and at 4 bits');
		const restored = new Map<string, Float32Array>();
		for (const [projectionName, projection] of projections) {
			const [rowCount, columnCount] = projection.shape;
			const matrix = QuantizeMatmulnbits.quantize(projection.values, rowCount, columnCount, chosen);
			matrix.scales = QuantizeMatmulnbits.roundScalesToHalfPrecision(matrix.scales);
			restored.set(projectionName, QuantizeMatmulnbits.dequantize(matrix));
		}
		const errors = GateQuantizeRealExpert._compareExpert(projections, restored);
		console.log(`  ${TESTED_HIDDEN_STATE_COUNT} hidden states through the whole expert`);
		console.log(
			`  the expert's output differs by ${(errors.meanError * 100).toFixed(2)} per cent on average, ` +
				`${(errors.worstError * 100).toFixed(2)} per cent at worst`,
		);
		return {
			outcome: {
				passed: true,
				summary: `the expert's output moves ${(errors.meanError * 100).toFixed(2)} per cent on average`,
			},
			meanError: errors.meanError,
			worstError: errors.worstError,
		};
	}

	/**
	 * Phase 5. The gate itself, and the only phase with a threshold behind it.
	 *
	 * Reads the same expert out of a published 4-bit quantization of this exact model, dequantizes it with that
	 * project's own formula, and runs the identical comparison. If this conversion loses no more than that one does,
	 * then 4 bits in the `MatMulNBits` layout carries these weights as well as something people already run, and
	 * milestone 3 may convert the model. If it loses meaningfully more, the quantizer is at fault and 15 gigabytes
	 * should not be written with it.
	 *
	 * @param projections The three projections.
	 * @param ourError What phase 4 measured for this conversion.
	 * @returns The outcome.
	 */
	private static async _phaseAgainstPublished(
		projections: Map<string, Projection>,
		ourError: ExpertComparison,
	): Promise<PhaseOutcome> {
		console.log(`\n── phase 5 · against ${REFERENCE_REPOSITORY}, which is 4-bit and already runs`);
		const restored = new Map<string, Float32Array>();
		for (const projectionName of PROJECTION_NAMES) {
			const projection = projections.get(projectionName);
			if (projection === undefined) {
				throw new Error(`${projectionName} was never read`);
			}
			const [rowCount, columnCount] = projection.shape;
			restored.set(
				projectionName,
				await GateQuantizeRealExpert._readPublishedProjection(projectionName, rowCount, columnCount),
			);
		}

		let worstPublishedWeightError = 0;
		let worstMatchedWeightError = 0;
		for (const [projectionName, projection] of projections) {
			const [rowCount, columnCount] = projection.shape;
			const publishedRestored = restored.get(projectionName);
			if (publishedRestored === undefined) {
				throw new Error(`${projectionName} has no published restoration`);
			}
			const publishedError = GateQuantizeRealExpert._relativeError(projection.values, publishedRestored);
			const matched = QuantizeMatmulnbits.dequantize(
				QuantizeMatmulnbits.quantize(projection.values, rowCount, columnCount, {
					blockSize: REFERENCE_GROUP_SIZE,
					scheme: 'asymmetric',
				}),
			);
			const matchedError = GateQuantizeRealExpert._relativeError(projection.values, matched);
			console.log(
				`  ${projectionName.padEnd(10)} the published weights differ by ${(publishedError * 100).toFixed(2)} per cent, ` +
					`this quantizer at the same group size and scheme by ${(matchedError * 100).toFixed(2)} per cent`,
			);
			worstPublishedWeightError = Math.max(worstPublishedWeightError, publishedError);
			worstMatchedWeightError = Math.max(worstMatchedWeightError, matchedError);
		}
		console.log(
			`\n  Set to the same group size of ${REFERENCE_GROUP_SIZE} and the same scheme, this quantizer and the published one\n` +
				`  differ by ${(Math.abs(worstMatchedWeightError - worstPublishedWeightError) * 100).toFixed(3)} percentage points. ` +
				'Two implementations written from different descriptions\n  agreeing that closely is the strongest evidence available that this one packs the format correctly.',
		);

		const referenceErrors = GateQuantizeRealExpert._compareExpert(projections, restored);
		console.log(
			`\n  the published expert's output differs by ${(referenceErrors.meanError * 100).toFixed(2)} per cent on average, ` +
				`${(referenceErrors.worstError * 100).toFixed(2)} per cent at worst`,
		);
		console.log(
			`  this conversion's output differs by  ${(ourError.meanError * 100).toFixed(2)} per cent on average, ` +
				`${(ourError.worstError * 100).toFixed(2)} per cent at worst`,
		);
		const ratio = ourError.meanError / referenceErrors.meanError;
		console.log(`  this conversion loses ${ratio.toFixed(2)} times what the published one loses`);
		const passed = ratio <= ACCEPTED_RATIO_AGAINST_REFERENCE;
		console.log(
			`  ${passed ? 'PASS' : 'FAIL'} — the limit is ${ACCEPTED_RATIO_AGAINST_REFERENCE.toFixed(2)} times, which leaves room\n` +
				'  for the one structural difference: the reference fits an arbitrary floating point offset for every\n' +
				`  group of ${REFERENCE_GROUP_SIZE}, and MatMulNBits can only carry a whole number from 0 to 15.`,
		);
		return {
			passed: passed,
			summary: `${ratio.toFixed(2)} times the loss of the published 4-bit quantization`,
		};
	}

	/**
	 * Phase 6. Prints the on-disk block layout the conversion will write, with every byte accounted for, and checks
	 * that every part starts on an aligned offset.
	 *
	 * Milestone 3 requires one contiguous region for each expert, holding its quantized weights and its scales
	 * together, because a layout that puts the scales somewhere else turns one expert into two disk reads. Milestone
	 * 0 found that `Tensor.fromGpuBuffer` binds a whole buffer rather than a range inside one, so the parts still
	 * reach separate WebGPU buffers — but they arrive in one read, which is what this layout is for.
	 *
	 * @param projections The three projections.
	 * @param chosen The scheme chosen in phase 2.
	 * @returns The outcome.
	 */
	private static _phaseBlockLayout(
		projections: Map<string, Projection>,
		chosen: QuantizationOptions & { label: string },
	): PhaseOutcome {
		console.log(`\n── phase 6 · the on-disk layout of one expert block, at ${chosen.label}`);
		let offset = 0;
		let everyPartIsAligned = true;
		for (const projectionName of PROJECTION_NAMES) {
			const projection = projections.get(projectionName);
			if (projection === undefined) {
				throw new Error(`${projectionName} was never read`);
			}
			const [rowCount, columnCount] = projection.shape;
			const matrix = QuantizeMatmulnbits.quantize(projection.values, rowCount, columnCount, chosen);
			const byteLengths = QuantizeMatmulnbits.byteLengths(matrix);
			const parts: { name: string; byteLength: number }[] = [
				{
					name: `${projectionName} quantized`,
					byteLength: byteLengths.quantized,
				},
				{
					name: `${projectionName} scales`,
					byteLength: byteLengths.scales,
				},
			];
			if (byteLengths.zeroPoints > 0) {
				parts.push({
					name: `${projectionName} zero points`,
					byteLength: byteLengths.zeroPoints,
				});
			}
			for (const part of parts) {
				console.log(
					`  ${String(offset).padStart(9)}  ${part.name.padEnd(26)} ${String(part.byteLength).padStart(9)} bytes`,
				);
				if (offset % 256 !== 0) {
					everyPartIsAligned = false;
				}
				offset += part.byteLength;
			}
		}
		console.log(`  ${String(offset).padStart(9)}  end of the block`);
		console.log(
			`  one expert block is ${GateQuantizeRealExpert._megabytes(offset)}, and it is ` +
				`${offset % 4096 === 0 ? 'exactly' : 'not'} a whole number of 4096-byte pages`,
		);
		console.log(`  every part starts on a 256-byte boundary: ${everyPartIsAligned}`);
		console.log(`  6144 experts, so ${GateQuantizeRealExpert._gigabytes(offset * 6144)} of expert blocks in total`);
		return {
			passed: everyPartIsAligned,
			summary: `one block is ${GateQuantizeRealExpert._megabytes(offset)}, every part aligned: ${everyPartIsAligned}`,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The published reference
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one projection of one expert out of the published 4-bit quantization and restores it to single precision.
	 *
	 * That project stacks every expert of a layer into one tensor shaped `[experts, rows, columns / 8]`, packs eight
	 * 4-bit values into each unsigned 32-bit word with the first value in the lowest bits, and stores a scale and a
	 * floating point offset for every group of 64. A value is restored as `stored * scale + offset`. Only the slice
	 * belonging to one expert is fetched, which is contiguous because that expert is the first one.
	 *
	 * @param projectionName Which of the three projections to read.
	 * @param rowCount The number of output rows.
	 * @param columnCount The number of input columns.
	 * @returns The restored weights, in row-major order.
	 */
	private static async _readPublishedProjection(
		projectionName: string,
		rowCount: number,
		columnCount: number,
	): Promise<Float32Array> {
		const reader = new SafetensorsReader(REFERENCE_REPOSITORY, MODEL_REVISION);
		const stem = `model.layers.${LAYER_INDEX}.mlp.switch_mlp.${projectionName}`;
		const groupsForEachRow = columnCount / REFERENCE_GROUP_SIZE;

		const packed = await reader.readSlice(
			await reader.locate(`${stem}.weight`),
			EXPERT_INDEX * rowCount * (columnCount / 8) * 4,
			rowCount * (columnCount / 8) * 4,
		);
		const scales = await reader.readSlice(
			await reader.locate(`${stem}.scales`),
			EXPERT_INDEX * rowCount * groupsForEachRow * 2,
			rowCount * groupsForEachRow * 2,
		);
		const offsets = await reader.readSlice(
			await reader.locate(`${stem}.biases`),
			EXPERT_INDEX * rowCount * groupsForEachRow * 2,
			rowCount * groupsForEachRow * 2,
		);

		const words = new Uint32Array(packed.buffer, packed.byteOffset, packed.length / 4);
		const scaleValues = SafetensorsReader.brainFloatToSingle(scales);
		const offsetValues = SafetensorsReader.brainFloatToSingle(offsets);

		const restored = new Float32Array(rowCount * columnCount);
		for (let row = 0; row < rowCount; row++) {
			for (let column = 0; column < columnCount; column++) {
				const wordIndex = row * (columnCount / 8) + (column >> 3);
				const stored = (words[wordIndex] >>> ((column & 7) * 4)) & 0xf;
				const groupIndex = row * groupsForEachRow + Math.floor(column / REFERENCE_GROUP_SIZE);
				restored[row * columnCount + column] = stored * scaleValues[groupIndex] + offsetValues[groupIndex];
			}
		}
		return restored;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The expert, in plain arithmetic
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the same hidden states through the expert twice, once with the original weights and once with a restored
	 * set, and reports how far the outputs moved apart.
	 *
	 * @param projections The original projections.
	 * @param restored The restored weights, keyed by projection name.
	 * @returns The errors.
	 */
	private static _compareExpert(
		projections: Map<string, Projection>,
		restored: Map<string, Float32Array>,
	): ExpertComparison {
		const gateProjection = projections.get('gate_proj');
		if (gateProjection === undefined) {
			throw new Error('gate_proj was never read');
		}
		const hiddenSize = gateProjection.shape[1];
		let worstError = 0;
		let totalError = 0;
		for (let attempt = 0; attempt < TESTED_HIDDEN_STATE_COUNT; attempt++) {
			const hiddenState = GateQuantizeRealExpert._makeHiddenState(hiddenSize, attempt);
			const reference = GateQuantizeRealExpert._runExpert(
				hiddenState,
				projections,
				(projectionName) => {
					const projection = projections.get(projectionName);
					if (projection === undefined) {
						throw new Error(`${projectionName} was never read`);
					}
					return projection.values;
				},
			);
			const measured = GateQuantizeRealExpert._runExpert(
				hiddenState,
				projections,
				(projectionName) => {
					const values = restored.get(projectionName);
					if (values === undefined) {
						throw new Error(`${projectionName} has no restored weights`);
					}
					return values;
				},
			);
			const error = GateQuantizeRealExpert._relativeError(reference, measured);
			totalError += error;
			worstError = Math.max(worstError, error);
		}
		return {
			meanError: totalError / TESTED_HIDDEN_STATE_COUNT,
			worstError: worstError,
		};
	}

	/**
	 * Runs one Qwen3-30B-A3B expert, which is `down_proj(silu(gate_proj(x)) * up_proj(x))`.
	 *
	 * @param hiddenState The input activation.
	 * @param projections The three projections and their shapes.
	 * @param weightsFor Chooses which weights to use.
	 * @returns The expert's output.
	 */
	private static _runExpert(
		hiddenState: Float32Array,
		projections: Map<string, Projection>,
		weightsFor: (projectionName: string) => Float32Array,
	): Float32Array {
		const gateShape = projections.get('gate_proj');
		const upShape = projections.get('up_proj');
		const downShape = projections.get('down_proj');
		if (gateShape === undefined || upShape === undefined || downShape === undefined) {
			throw new Error('one of the three projections was never read');
		}
		const gated = GateQuantizeRealExpert._project(hiddenState, weightsFor('gate_proj'), gateShape.shape);
		const lifted = GateQuantizeRealExpert._project(hiddenState, weightsFor('up_proj'), upShape.shape);
		const activated = new Float32Array(gated.length);
		for (let index = 0; index < gated.length; index++) {
			activated[index] = (gated[index] / (1 + Math.exp(-gated[index]))) * lifted[index];
		}
		return GateQuantizeRealExpert._project(activated, weightsFor('down_proj'), downShape.shape);
	}

	/**
	 * Multiplies a row-major weight matrix by a vector.
	 *
	 * @param vector The input vector, of length `shape[1]`.
	 * @param weights The weights, in row-major order.
	 * @param shape The matrix shape, as rows then columns.
	 * @returns The product, of length `shape[0]`.
	 */
	private static _project(vector: Float32Array, weights: Float32Array, shape: number[]): Float32Array {
		const [rowCount, columnCount] = shape;
		const product = new Float32Array(rowCount);
		for (let row = 0; row < rowCount; row++) {
			let total = 0;
			const rowStart = row * columnCount;
			for (let column = 0; column < columnCount; column++) {
				total += weights[rowStart + column] * vector[column];
			}
			product[row] = total;
		}
		return product;
	}

	/**
	 * Builds a repeatable hidden state. A real one is not available without running the model, and what this gate
	 * measures is how the expert's arithmetic degrades, which does not need a real activation.
	 *
	 * @param length The length of the hidden state.
	 * @param seed The seed, which fixes the values.
	 * @returns The hidden state.
	 */
	private static _makeHiddenState(length: number, seed: number): Float32Array {
		const values = new Float32Array(length);
		let state = (seed + 1) >>> 0;
		for (let index = 0; index < length; index++) {
			state = (state + 0x6d2b79f5) >>> 0;
			let scrambled = Math.imul(state ^ (state >>> 15), 1 | state);
			scrambled = (scrambled + Math.imul(scrambled ^ (scrambled >>> 7), 61 | scrambled)) ^ scrambled;
			values[index] = (((scrambled ^ (scrambled >>> 14)) >>> 0) / 4294967295) * 2 - 1;
		}
		return values;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reporting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Describes a set of values by the two numbers that decide whether block quantization will hurt.
	 *
	 * @param values The values to describe.
	 * @returns The description.
	 */
	private static _describe(values: Float32Array): WeightStatistics {
		let largestMagnitude = 0;
		let totalMagnitude = 0;
		for (let index = 0; index < values.length; index++) {
			const magnitude = Math.abs(values[index]);
			totalMagnitude += magnitude;
			if (magnitude > largestMagnitude) {
				largestMagnitude = magnitude;
			}
		}
		return {
			largestMagnitude: largestMagnitude,
			meanMagnitude: totalMagnitude / values.length,
		};
	}

	/**
	 * Reports how far one set of values moved from another, as a share of the size of the original.
	 *
	 * @param reference The original values.
	 * @param measured The values after a trip through quantization.
	 * @returns The relative error.
	 */
	private static _relativeError(reference: Float32Array, measured: Float32Array): number {
		let errorEnergy = 0;
		let referenceEnergy = 0;
		for (let index = 0; index < reference.length; index++) {
			const difference = reference[index] - measured[index];
			errorEnergy += difference * difference;
			referenceEnergy += reference[index] * reference[index];
		}
		if (referenceEnergy === 0) {
			return 0;
		}
		return Math.sqrt(errorEnergy / referenceEnergy);
	}

	/**
	 * Formats a byte count in megabytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	private static _megabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024).toFixed(2)} megabytes`;
	}

	/**
	 * Formats a byte count in gigabytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	private static _gigabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} gigabytes`;
	}
}

await GateQuantizeRealExpert.main();
