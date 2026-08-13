#!/usr/bin/env node

import Fs from 'node:fs';
import Path from 'node:path';
import { QuantizeMatmulnbits } from './quantize_matmulnbits.mjs';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MakeExpertBlockGraphFixture — the fixture the expert block graph gate reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * `public/expert-block-graph-gate/` asks whether ONNX Runtime Web computes an expert correctly from the exact bytes
 * `convert_mixture_of_experts_to_expert_blocks.mjs` wrote. A browser cannot answer that on its own: it needs one real
 * block, and it needs an answer computed somewhere else to compare against.
 *
 * This writes both. The reference is computed by restoring the block's own bytes with
 * `QuantizeMatmulnbits.dequantize` and multiplying in single precision, so it is an answer about the same bytes the
 * browser reads rather than an answer about the original model. That is the question the gate asks: given these
 * bytes, does `MatMulNBits` read them the way this project believes it does?
 *
 * The two files are generated artifacts of several megabytes and are not committed, exactly as the Qwen3 shards are
 * not committed.
 */

/** The three projections one expert is made of, in the order the block holds them. */
const PROJECTION_NAMES = ['gate_proj', 'up_proj', 'down_proj'];
/** How many parts one projection contributes to a block: the quantized matrix, its scales, and its zero points. */
const PARTS_FOR_EACH_PROJECTION = 3;
/** The seed of the input vector, fixed so that regenerating the fixture does not change what the gate measures. */
const INPUT_SEED = 20250814;

/**
 * One projection restored from a block, ready to multiply.
 *
 * @typedef {object} RestoredProjection
 * @property {string} name Which projection this is.
 * @property {number} rowCount The number of output rows, which `MatMulNBits` calls N.
 * @property {number} columnCount The number of input columns, which `MatMulNBits` calls K.
 * @property {Float32Array} weights The restored weights, in row-major order.
 */

/** Writes one real expert block and an independently computed answer for it. */
class MakeExpertBlockGraphFixture {
	/**
	 * Writes the fixture.
	 *
	 * @returns {Promise<void>} Resolves once both files have been written.
	 */
	static async main() {
		const options = MakeExpertBlockGraphFixture._readOptions(process.argv.slice(2));
		const manifest = JSON.parse(Fs.readFileSync(Path.join(options.blocksDirectory, 'manifest.json'), 'utf8'));
		const layout = manifest.experts;
		const expertsForEachLayer = layout.expertsForEachLayer;

		const blocksPath = Path.join(options.blocksDirectory, 'expert_blocks.bin');
		const block = Buffer.alloc(layout.blockByteLength);
		const blocksFile = Fs.openSync(blocksPath, 'r');
		try {
			const read = Fs.readSync(
				blocksFile,
				block,
				0,
				block.length,
				options.blockIndex * layout.blockByteLength,
			);
			if (read !== block.length) {
				throw new Error(
					`block ${options.blockIndex} is ${read} bytes where ${block.length} were expected, so the block ` +
						'file is shorter than its manifest says',
				);
			}
		} finally {
			Fs.closeSync(blocksFile);
		}

		const projections = MakeExpertBlockGraphFixture._restore(block, manifest);
		const input = MakeExpertBlockGraphFixture._makeInput(manifest.hiddenSize);
		const output = MakeExpertBlockGraphFixture._computeExpert(projections, input, false);
		const outputAtHalfPrecision = MakeExpertBlockGraphFixture._computeExpert(projections, input, true);

		Fs.mkdirSync(options.outputDirectory, {
			recursive: true,
		});
		Fs.writeFileSync(Path.join(options.outputDirectory, 'expert_block.bin'), block);

		const reference = {
			producedBy: 'packages/_onnx_experiments/tools/make_expert_block_graph_fixture.mjs',
			issue: 'https://github.com/webai-at-home/webai-at-home/issues/169',
			modelName: manifest.modelName,
			sourceRepository: manifest.sourceRepository,
			sourceRevision: manifest.sourceRevision,
			blockIndex: options.blockIndex,
			layerIndex: Math.floor(options.blockIndex / expertsForEachLayer),
			expertIndex: options.blockIndex % expertsForEachLayer,
			hiddenSize: manifest.hiddenSize,
			expertWidth: manifest.expertWidth,
			quantization: manifest.quantization,
			blockByteLength: layout.blockByteLength,
			parts: layout.parts,
			howTheAnswerWasComputed:
				'the block\'s own bytes restored by QuantizeMatmulnbits.dequantize, then down_proj(silu(gate_proj(x)) ' +
				'* up_proj(x)) on the processor side, once in single precision and once with every intermediate value ' +
				'and every running total rounded to half precision',
			input: Array.from(input),
			output: Array.from(output),
			outputAtHalfPrecision: Array.from(outputAtHalfPrecision),
		};
		Fs.writeFileSync(
			Path.join(options.outputDirectory, 'reference.json'),
			`${JSON.stringify(reference)}\n`,
		);

		let largest = 0;
		let total = 0;
		let apart = 0;
		for (let index = 0; index < output.length; index++) {
			largest = Math.max(largest, Math.abs(output[index]));
			total += Math.abs(output[index]);
			apart = Math.max(apart, Math.abs(output[index] - outputAtHalfPrecision[index]));
		}
		console.log(`wrote the fixture for block ${options.blockIndex} of ${manifest.sourceRepository}`);
		console.log(`  layer ${reference.layerIndex}, expert ${reference.expertIndex}`);
		console.log(`  expert_block.bin, ${layout.blockByteLength} bytes, in ${layout.parts.length} parts`);
		console.log(`  reference.json, an input of ${input.length} values and two answers of ${output.length}`);
		console.log(`  the largest value of the answer is ${largest.toFixed(6)}, the mean magnitude ` +
			`${(total / output.length).toFixed(6)}`);
		console.log(`  half precision throughout moves it by ${(apart / (total / output.length)).toExponential(2)} ` +
			'relative, which is the far edge of the bracket the gate allows');
		console.log(`  written to ${options.outputDirectory}`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The reference answer
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Restores the three projections of one block from the block's own bytes.
	 *
	 * The scales are stored at half precision, so they are read as half precision and widened, which is what
	 * `MatMulNBits` does with them too. Reading them any other way would make this reference an answer about a
	 * different set of numbers.
	 *
	 * @param {Buffer} block The block's bytes.
	 * @param {object} manifest The conversion manifest, for the layout and the scheme.
	 * @returns {RestoredProjection[]} The three projections.
	 */
	static _restore(block, manifest) {
		const parts = manifest.experts.parts;
		const blockSize = manifest.quantization.blockSize;
		/** @type {RestoredProjection[]} */
		const restored = [];

		for (let index = 0; index < PROJECTION_NAMES.length; index++) {
			const name = PROJECTION_NAMES[index];
			const rowCount = name === 'down_proj' ? manifest.hiddenSize : manifest.expertWidth;
			const columnCount = name === 'down_proj' ? manifest.expertWidth : manifest.hiddenSize;
			const blocksForEachRow = Math.ceil(columnCount / blockSize);

			const quantizedPart = parts[index * PARTS_FOR_EACH_PROJECTION];
			const scalesPart = parts[index * PARTS_FOR_EACH_PROJECTION + 1];
			const zeroPointsPart = parts[index * PARTS_FOR_EACH_PROJECTION + 2];

			const scaleBytes = block.subarray(scalesPart.offset, scalesPart.offset + scalesPart.byteLength);
			const halfScales = new Float16Array(
				scaleBytes.buffer.slice(
					scaleBytes.byteOffset,
					scaleBytes.byteOffset + scaleBytes.byteLength,
				),
			);

			restored.push({
				name: name,
				rowCount: rowCount,
				columnCount: columnCount,
				weights: QuantizeMatmulnbits.dequantize({
					quantized: new Uint8Array(
						block.subarray(quantizedPart.offset, quantizedPart.offset + quantizedPart.byteLength),
					),
					scales: Float32Array.from(halfScales),
					zeroPoints: new Uint8Array(
						block.subarray(zeroPointsPart.offset, zeroPointsPart.offset + zeroPointsPart.byteLength),
					),
					rowCount: rowCount,
					columnCount: columnCount,
					blockSize: blockSize,
					blocksForEachRow: blocksForEachRow,
					scheme: manifest.quantization.scheme,
				}),
			});
		}
		return restored;
	}

	/**
	 * Computes one expert on the processor side, either in single precision or entirely in half precision.
	 *
	 * The two together are what makes the gate readable. `MatMulNBits` requires the activation and the scales to have
	 * the same element type, and milestone 3 stored the scales at half precision, so the graph the browser runs is a
	 * half precision graph and cannot reproduce the single precision answer. Without knowing how far half precision
	 * moves the answer, any difference the gate measures is unreadable: a layout mistake and a rounding difference
	 * both look like "not equal". With both answers the gate can require the graph to sit between them.
	 *
	 * The half precision form rounds after every single operation, including after every addition of the running
	 * total. That is the worst a half precision implementation can do, because a graphics processor adds in a tree
	 * rather than one term after another, and a tree is more accurate. So the two answers bracket the graph rather
	 * than predicting it.
	 *
	 * @param {RestoredProjection[]} projections The three restored projections.
	 * @param {Float32Array} input The expert input, one value for each hidden channel.
	 * @param {boolean} atHalfPrecision Whether to round every intermediate value to half precision.
	 * @returns {Float32Array} The expert output, one value for each hidden channel.
	 */
	static _computeExpert(projections, input, atHalfPrecision) {
		const round = MakeExpertBlockGraphFixture._rounder(atHalfPrecision);
		const [gateProjection, upProjection, downProjection] = projections;
		const started = new Float32Array(input.length);
		for (let index = 0; index < input.length; index++) {
			started[index] = round(input[index]);
		}

		const gated = MakeExpertBlockGraphFixture._multiply(gateProjection, started, round);
		const raised = MakeExpertBlockGraphFixture._multiply(upProjection, started, round);

		const activated = new Float32Array(gated.length);
		for (let index = 0; index < gated.length; index++) {
			const sigmoid = round(1 / (1 + Math.exp(-gated[index])));
			activated[index] = round(round(gated[index] * sigmoid) * raised[index]);
		}
		return MakeExpertBlockGraphFixture._multiply(downProjection, activated, round);
	}

	/**
	 * Makes the function that rounds one value to the precision being emulated.
	 *
	 * @param {boolean} atHalfPrecision Whether to round to half precision rather than leaving the value alone.
	 * @returns {(value: number) => number} The rounding function.
	 */
	static _rounder(atHalfPrecision) {
		if (atHalfPrecision === false) {
			return (value) => value;
		}
		const scratch = new Float16Array(1);
		return (value) => {
			scratch[0] = value;
			return scratch[0];
		};
	}

	/**
	 * Multiplies one restored projection by a vector, as a linear layer does: `output[n] = sum over k of W[n][k] * x[k]`.
	 *
	 * @param {RestoredProjection} projection The projection.
	 * @param {Float32Array} input The vector, of length `projection.columnCount`.
	 * @param {(value: number) => number} round What to round every intermediate value with.
	 * @returns {Float32Array} The result, of length `projection.rowCount`.
	 */
	static _multiply(projection, input, round) {
		const output = new Float32Array(projection.rowCount);
		for (let row = 0; row < projection.rowCount; row++) {
			let total = 0;
			const rowStart = row * projection.columnCount;
			for (let column = 0; column < projection.columnCount; column++) {
				total = round(total + round(round(projection.weights[rowStart + column]) * input[column]));
			}
			output[row] = total;
		}
		return output;
	}

	/**
	 * Makes the input vector, from a fixed seed so that regenerating the fixture does not change the measurement.
	 *
	 * The values are scaled to the size a real expert input has after the normalization in front of it, so that the
	 * gate measures the accuracy of a plausible multiplication rather than of an extreme one.
	 *
	 * @param {number} hiddenSize How many values the vector holds.
	 * @returns {Float32Array} The vector.
	 */
	static _makeInput(hiddenSize) {
		const input = new Float32Array(hiddenSize);
		let state = INPUT_SEED;
		for (let index = 0; index < hiddenSize; index++) {
			state = (state * 1664525 + 1013904223) >>> 0;
			const first = state / 4294967296;
			state = (state * 1664525 + 1013904223) >>> 0;
			const second = state / 4294967296;
			input[index] = Math.sqrt(-2 * Math.log(first + 1e-12)) * Math.cos(2 * Math.PI * second);
		}
		return input;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Options
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the command line.
	 *
	 * @param {string[]} argumentList The arguments after the script name.
	 * @returns {{blocksDirectory: string, blockIndex: number, outputDirectory: string}} The options.
	 */
	static _readOptions(argumentList) {
		const options = {
			blocksDirectory: undefined,
			blockIndex: 0,
			outputDirectory: 'packages/_onnx_experiments/public/expert-block-graph-gate/fixture',
		};
		const usage = 'Use --blocks <directory written by convert_mixture_of_experts_to_expert_blocks.mjs> ' +
			'[--block <index>] [--output <directory>]';
		for (let index = 0; index < argumentList.length; index += 2) {
			const name = argumentList[index];
			const value = argumentList[index + 1];
			if (name === '--blocks') {
				options.blocksDirectory = value;
			} else if (name === '--block') {
				options.blockIndex = Number(value);
			} else if (name === '--output') {
				options.outputDirectory = value;
			} else {
				throw new Error(`unknown option ${name}. ${usage}`);
			}
		}
		if (options.blocksDirectory === undefined) {
			throw new Error(`no --blocks was given. ${usage}`);
		}
		return options;
	}
}

await MakeExpertBlockGraphFixture.main();
