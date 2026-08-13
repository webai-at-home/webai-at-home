#!/usr/bin/env node

import Fs from 'node:fs';
import Path from 'node:path';
import { QuantizeMatmulnbits } from './quantize_matmulnbits.mjs';
import { SafetensorsReader } from './safetensors_reader.mjs';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ConvertQwen3MoeToExpertBlocks — the conversion pipeline of milestone 3 of issue #169
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/169 splits Qwen3-30B-A3B into the part that
 * must stay in graphics memory and the 6144 expert blocks that may live on disk, and writes each expert block as one
 * contiguous aligned region holding its quantized weights, its scales, and its zero points together.
 *
 * The one-read requirement is the whole point of the layout. The residency layer of milestone 4 reads an expert when
 * it misses, and a layout that put the scales in some other file would turn every miss into two reads and every
 * measurement in milestone 6 into a measurement of that mistake.
 *
 * The quantization scheme is not chosen here. `gate_quantize_real_expert.mjs` measured six of them against real
 * published weights and against `mlx-community/Qwen3-30B-A3B-4bit`, and this pipeline writes the one that gate
 * chose: 4 bits, blocks of 32, each block fitted to its own range with its own zero point.
 *
 * Nothing is downloaded whole. Every tensor is read out of the published safetensors shards by HTTP range request,
 * in contiguous runs, so the machine never holds more than one run at a time and no copy of the 57-gigabyte model is
 * ever written to disk.
 */

/** The Hugging Face repository holding the model this pipeline converts. */
const MODEL_REPOSITORY = 'Qwen/Qwen3-30B-A3B';
/**
 * The revision to read, pinned rather than left at `main`, so that anything published from this pipeline names the
 * exact bytes it was made from. This is the commit `main` pointed at on 13 August 2026, last changed on
 * 26 July 2025.
 */
const MODEL_REVISION = 'ad44e777bcd18fa416d9da3bd8f70d33ebb85d39';
/** The quantization scheme, as chosen by `gate_quantize_real_expert.mjs` against real weights. */
const SCHEME = {
	blockSize: 32,
	scheme: 'asymmetric',
};
/** The three projections one expert is made of, in the order they are written into a block. */
const PROJECTION_NAMES = ['gate_proj', 'up_proj', 'down_proj'];
/** The alignment every part of an expert block starts on. */
const PART_ALIGNMENT = 256;
/** How many bytes one contiguous range request may cover, which bounds how much memory a run holds. */
const LARGEST_RUN_BYTE_LENGTH = 96 * 1024 * 1024;
/** How many times a range request is retried before the run gives up, since a conversion runs for hours. */
const REQUEST_ATTEMPT_COUNT = 5;

/**
 * One part of one expert block.
 *
 * @typedef {object} BlockPart
 * @property {string} name What the part holds, such as `gate_proj quantized`.
 * @property {number} offset Where the part starts inside the block, in bytes.
 * @property {number} byteLength How long the part is, in bytes.
 */

/** Converts Qwen3-30B-A3B into a resident part and 6144 expert blocks. */
class ConvertQwen3MoeToExpertBlocks {
	/**
	 * Runs the conversion.
	 *
	 * @returns {Promise<void>} Resolves once everything asked for has been written and verified.
	 */
	static async main() {
		const options = ConvertQwen3MoeToExpertBlocks._readOptions(process.argv.slice(2));
		Fs.mkdirSync(options.outputDirectory, {
			recursive: true,
		});

		const reader = new SafetensorsReader(MODEL_REPOSITORY, MODEL_REVISION);
		const configuration = await reader._fetchJson('config.json');
		const layerCount = configuration.num_hidden_layers;
		const expertsForEachLayer = configuration.num_experts;
		const lastLayer = Math.min(options.lastLayer, layerCount - 1);
		const convertedLayerCount = lastLayer - options.firstLayer + 1;

		const layout = ConvertQwen3MoeToExpertBlocks._describeBlockLayout(
			configuration.hidden_size,
			configuration.moe_intermediate_size,
		);

		console.log(`converting ${MODEL_REPOSITORY} at revision ${MODEL_REVISION}`);
		console.log(`  ${layerCount} layers, ${expertsForEachLayer} experts each, ` +
			`hidden size ${configuration.hidden_size}, expert width ${configuration.moe_intermediate_size}`);
		console.log(`  scheme: 4 bits, blocks of ${SCHEME.blockSize}, ${SCHEME.scheme}`);
		console.log(`  one expert block is ${ConvertQwen3MoeToExpertBlocks._megabytes(layout.blockByteLength)}, ` +
			`in ${layout.parts.length} parts, every one aligned to ${PART_ALIGNMENT} bytes`);
		console.log(`  converting layers ${options.firstLayer} to ${lastLayer}, which is ` +
			`${convertedLayerCount * expertsForEachLayer} experts of ${layerCount * expertsForEachLayer}`);
		console.log(`  writing to ${options.outputDirectory}`);

		const blocksPath = Path.join(options.outputDirectory, 'expert_blocks.bin');
		const blocksFile = Fs.openSync(blocksPath, 'w');
		const startedAt = Date.now();
		let writtenExpertCount = 0;
		let readBytes = 0;

		try {
			for (let layerIndex = options.firstLayer; layerIndex <= lastLayer; layerIndex++) {
				const outcome = await ConvertQwen3MoeToExpertBlocks._convertLayer({
					reader: reader,
					blocksFile: blocksFile,
					layerIndex: layerIndex,
					expertsForEachLayer: expertsForEachLayer,
					firstLayerConverted: options.firstLayer,
					layout: layout,
				});
				writtenExpertCount += outcome.expertCount;
				readBytes += outcome.readBytes;

				const elapsedSeconds = (Date.now() - startedAt) / 1000;
				const remaining = (convertedLayerCount * expertsForEachLayer) - writtenExpertCount;
				console.log(
					`  layer ${String(layerIndex).padStart(2)}: ${outcome.expertCount} experts, ` +
						`${ConvertQwen3MoeToExpertBlocks._megabytes(outcome.readBytes)} read, ` +
						`${elapsedSeconds.toFixed(0)} seconds so far, ` +
						`about ${((elapsedSeconds / writtenExpertCount) * remaining / 60).toFixed(0)} minutes left`,
				);
			}
		} finally {
			Fs.closeSync(blocksFile);
		}

		const resident = await ConvertQwen3MoeToExpertBlocks._convertResidentPart(reader, options.outputDirectory);

		const manifest = {
			producedBy: 'packages/_onnx_experiments/tools/convert_qwen3_moe_to_expert_blocks.mjs',
			issue: 'https://github.com/webai-at-home/webai-at-home/issues/169',
			sourceRepository: MODEL_REPOSITORY,
			sourceRevision: MODEL_REVISION,
			quantization: {
				bits: 4,
				blockSize: SCHEME.blockSize,
				scheme: SCHEME.scheme,
				zeroPointIsStored: true,
				scalesAreHalfPrecision: true,
				storedValueMeaning: '(stored - zeroPoint) * scale',
			},
			experts: {
				layerCount: layerCount,
				expertsForEachLayer: expertsForEachLayer,
				blockIndexFormula: 'layerIndex * expertsForEachLayer + expertIndex',
				blockByteLength: layout.blockByteLength,
				parts: layout.parts,
				convertedFirstLayer: options.firstLayer,
				convertedLastLayer: lastLayer,
				convertedExpertCount: writtenExpertCount,
			},
			resident: resident,
			hiddenSize: configuration.hidden_size,
			expertWidth: configuration.moe_intermediate_size,
		};
		Fs.writeFileSync(
			Path.join(options.outputDirectory, 'manifest.json'),
			`${JSON.stringify(manifest, undefined, '\t')}\n`,
		);

		const writtenBytes = Fs.statSync(blocksPath).size;
		console.log(`\n  wrote ${writtenExpertCount} expert blocks, ` +
			`${ConvertQwen3MoeToExpertBlocks._gigabytes(writtenBytes)}, after reading ` +
			`${ConvertQwen3MoeToExpertBlocks._gigabytes(readBytes)}`);
		if (writtenBytes !== writtenExpertCount * layout.blockByteLength) {
			throw new Error(
				`the file is ${writtenBytes} bytes where ${writtenExpertCount * layout.blockByteLength} were expected, ` +
					'so a block was written at the wrong offset',
			);
		}
		console.log('  the file length is exactly the block count times the block length');

		await ConvertQwen3MoeToExpertBlocks._verify(reader, blocksPath, layout, options, expertsForEachLayer);
		console.log(`\n  done in ${((Date.now() - startedAt) / 60000).toFixed(1)} minutes`);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Conversion
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Converts every expert of one layer and appends their blocks to the output file.
	 *
	 * The tensors are located first, then sorted by where they sit in their shard and read in contiguous runs, so
	 * one layer costs a handful of large range requests rather than 384 small ones. That is the difference between a
	 * conversion that finishes and one that spends its whole time in request overhead.
	 *
	 * @param {object} options Everything the layer needs.
	 * @param {SafetensorsReader} options.reader The reader for the source model.
	 * @param {number} options.blocksFile The open file descriptor of the expert block file.
	 * @param {number} options.layerIndex Which layer to convert.
	 * @param {number} options.expertsForEachLayer How many experts one layer holds.
	 * @param {number} options.firstLayerConverted The first layer of this run, which fixes where blocks start.
	 * @param {{blockByteLength: number, parts: BlockPart[]}} options.layout The block layout.
	 * @returns {Promise<{expertCount: number, readBytes: number}>} What the layer cost.
	 */
	static async _convertLayer(options) {
		const located = [];
		for (let expertIndex = 0; expertIndex < options.expertsForEachLayer; expertIndex++) {
			for (const projectionName of PROJECTION_NAMES) {
				const tensorName =
					`model.layers.${options.layerIndex}.mlp.experts.${expertIndex}.${projectionName}.weight`;
				located.push({
					expertIndex: expertIndex,
					projectionName: projectionName,
					tensor: await options.reader.locate(tensorName),
				});
			}
		}

		const values = await ConvertQwen3MoeToExpertBlocks._readInRuns(options.reader, located);
		let readBytes = 0;
		for (const entry of located) {
			readBytes += entry.tensor.byteEnd - entry.tensor.byteStart;
		}

		const block = Buffer.alloc(options.layout.blockByteLength);
		for (let expertIndex = 0; expertIndex < options.expertsForEachLayer; expertIndex++) {
			block.fill(0);
			let partIndex = 0;
			for (const projectionName of PROJECTION_NAMES) {
				const entry = located.find(
					(candidate) => candidate.expertIndex === expertIndex && candidate.projectionName === projectionName,
				);
				const [rowCount, columnCount] = entry.tensor.shape;
				const matrix = QuantizeMatmulnbits.quantize(
					values.get(entry.tensor.name),
					rowCount,
					columnCount,
					SCHEME,
				);
				const halfScales = new Float16Array(matrix.scales.length);
				halfScales.set(matrix.scales);

				for (const stored of [matrix.quantized, new Uint8Array(halfScales.buffer), matrix.zeroPoints]) {
					const part = options.layout.parts[partIndex];
					if (stored.length !== part.byteLength) {
						throw new Error(
							`${part.name} of expert ${expertIndex} is ${stored.length} bytes where the layout says ` +
								`${part.byteLength}, so the manifest and the file would disagree`,
						);
					}
					block.set(stored, part.offset);
					partIndex++;
				}
			}

			const blockNumber = (options.layerIndex - options.firstLayerConverted) * options.expertsForEachLayer
				+ expertIndex;
			Fs.writeSync(options.blocksFile, block, 0, block.length, blockNumber * options.layout.blockByteLength);
		}

		return {
			expertCount: options.expertsForEachLayer,
			readBytes: readBytes,
		};
	}

	/**
	 * Reads a set of located tensors in as few contiguous range requests as their placement allows.
	 *
	 * @param {SafetensorsReader} reader The reader for the source model.
	 * @param {{tensor: object}[]} located The tensors to read.
	 * @returns {Promise<Map<string, Float32Array>>} Each tensor's values, keyed by tensor name.
	 */
	static async _readInRuns(reader, located) {
		const byShard = new Map();
		for (const entry of located) {
			const existing = byShard.get(entry.tensor.shardName);
			if (existing === undefined) {
				byShard.set(entry.tensor.shardName, [entry.tensor]);
			} else {
				existing.push(entry.tensor);
			}
		}

		/** @type {Map<string, Float32Array>} */
		const values = new Map();
		for (const [shardName, tensors] of byShard) {
			tensors.sort((left, right) => left.byteStart - right.byteStart);
			let runStart = 0;
			while (runStart < tensors.length) {
				let runEnd = runStart;
				while (
					runEnd + 1 < tensors.length &&
					tensors[runEnd + 1].byteEnd - tensors[runStart].byteStart <= LARGEST_RUN_BYTE_LENGTH
				) {
					runEnd++;
				}
				const firstByte = tensors[runStart].byteStart;
				const lastByte = tensors[runEnd].byteEnd;
				const bytes = await ConvertQwen3MoeToExpertBlocks._fetchRange(reader, shardName, firstByte, lastByte);
				for (let index = runStart; index <= runEnd; index++) {
					const tensor = tensors[index];
					const slice = bytes.subarray(tensor.byteStart - firstByte, tensor.byteEnd - firstByte);
					values.set(tensor.name, ConvertQwen3MoeToExpertBlocks._toSingle(tensor, slice));
				}
				runStart = runEnd + 1;
			}
		}
		return values;
	}

	/**
	 * Fetches one contiguous byte range, retrying because a conversion runs for hours and one refused request should
	 * not throw away the work already done.
	 *
	 * @param {SafetensorsReader} reader The reader, used only for its URL building.
	 * @param {string} shardName The shard to read from.
	 * @param {number} firstByte The first byte to read.
	 * @param {number} lastByte The byte after the last byte to read.
	 * @returns {Promise<Uint8Array>} The bytes.
	 */
	static async _fetchRange(reader, shardName, firstByte, lastByte) {
		let lastError;
		for (let attempt = 0; attempt < REQUEST_ATTEMPT_COUNT; attempt++) {
			try {
				const response = await fetch(reader._fileUrl(shardName), {
					headers: {
						Range: `bytes=${firstByte}-${lastByte - 1}`,
					},
				});
				if (response.ok === false) {
					throw new Error(`${shardName} returned ${response.status} ${response.statusText}`);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (bytes.length !== lastByte - firstByte) {
					throw new Error(
						`${shardName} returned ${bytes.length} bytes where ${lastByte - firstByte} were asked for`,
					);
				}
				return bytes;
			} catch (error) {
				lastError = error;
				await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
			}
		}
		throw new Error(`${shardName} could not be read after ${REQUEST_ATTEMPT_COUNT} attempts: ${lastError}`);
	}

	/**
	 * Converts one tensor's stored bytes to single precision.
	 *
	 * @param {object} tensor The tensor being converted, for its element type and its name.
	 * @param {Uint8Array} bytes The stored bytes.
	 * @returns {Float32Array} The values.
	 */
	static _toSingle(tensor, bytes) {
		if (tensor.dataType === 'BF16') {
			return SafetensorsReader.brainFloatToSingle(bytes);
		}
		if (tensor.dataType === 'F16') {
			return Float32Array.from(new Float16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));
		}
		if (tensor.dataType === 'F32') {
			return new Float32Array(bytes.slice().buffer);
		}
		throw new Error(`${tensor.name} is stored as ${tensor.dataType}, which this pipeline does not convert`);
	}

	/**
	 * Writes the other half of the split: every tensor that is not an expert, gathered into one safetensors file.
	 *
	 * These bytes are copied exactly as published, at BF16, and are not quantized. That is a deliberate limit of this
	 * milestone rather than an omission. Which resident tensors may be quantized depends on how each is used, and
	 * nothing here knows that yet: an attention projection goes through a matrix multiplication and could be
	 * quantized the same way an expert is, while the token embedding is looked up rather than multiplied and would
	 * need a different path entirely. Deciding that needs the graph that consumes these tensors, and building that
	 * graph is milestone 4. Copying them unchanged keeps every one of those choices open and loses nothing.
	 *
	 * @param {SafetensorsReader} reader The reader for the source model.
	 * @param {string} outputDirectory Where to write the file.
	 * @returns {Promise<object>} What was written, for the manifest.
	 */
	static async _convertResidentPart(reader, outputDirectory) {
		console.log('\n  gathering the resident part, which is every tensor that is not an expert');
		if (reader.index === undefined) {
			await reader.locate(Object.keys((await reader._fetchJson('model.safetensors.index.json')).weight_map)[0]);
		}
		const residentNames = Object.keys(reader.index.weight_map)
			.filter((name) => /\.mlp\.experts\.\d+\./.test(name) === false)
			.sort();

		const located = [];
		for (const name of residentNames) {
			located.push({
				tensor: await reader.locate(name),
			});
		}

		const header = {};
		let dataOffset = 0;
		for (const entry of located) {
			const byteLength = entry.tensor.byteEnd - entry.tensor.byteStart;
			header[entry.tensor.name] = {
				dtype: entry.tensor.dataType,
				shape: entry.tensor.shape,
				data_offsets: [dataOffset, dataOffset + byteLength],
			};
			dataOffset += byteLength;
		}
		const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
		const paddedHeaderLength = Math.ceil(headerBytes.length / 8) * 8;

		const residentPath = Path.join(outputDirectory, 'resident.safetensors');
		const residentFile = Fs.openSync(residentPath, 'w');
		try {
			const lengthPrefix = Buffer.alloc(8);
			lengthPrefix.writeBigUInt64LE(BigInt(paddedHeaderLength), 0);
			Fs.writeSync(residentFile, lengthPrefix);
			const paddedHeader = Buffer.alloc(paddedHeaderLength, 0x20);
			headerBytes.copy(paddedHeader);
			Fs.writeSync(residentFile, paddedHeader);

			let writtenBytes = 0;
			const byShard = new Map();
			for (const entry of located) {
				const existing = byShard.get(entry.tensor.shardName);
				if (existing === undefined) {
					byShard.set(entry.tensor.shardName, [entry.tensor]);
				} else {
					existing.push(entry.tensor);
				}
			}
			for (const [shardName, tensors] of byShard) {
				tensors.sort((left, right) => left.byteStart - right.byteStart);
				let runStart = 0;
				while (runStart < tensors.length) {
					let runEnd = runStart;
					while (
						runEnd + 1 < tensors.length &&
						tensors[runEnd + 1].byteEnd - tensors[runStart].byteStart <= LARGEST_RUN_BYTE_LENGTH
					) {
						runEnd++;
					}
					const firstByte = tensors[runStart].byteStart;
					const bytes = await ConvertQwen3MoeToExpertBlocks._fetchRange(
						reader,
						shardName,
						firstByte,
						tensors[runEnd].byteEnd,
					);
					for (let index = runStart; index <= runEnd; index++) {
						const tensor = tensors[index];
						const slice = bytes.subarray(tensor.byteStart - firstByte, tensor.byteEnd - firstByte);
						const target = header[tensor.name].data_offsets[0];
						Fs.writeSync(residentFile, slice, 0, slice.length, 8 + paddedHeaderLength + target);
						writtenBytes += slice.length;
					}
					runStart = runEnd + 1;
				}
			}

			console.log(`    ${located.length} tensors, ${ConvertQwen3MoeToExpertBlocks._gigabytes(writtenBytes)}, ` +
				'copied unchanged at BF16');
			return {
				fileName: 'resident.safetensors',
				tensorCount: located.length,
				byteLength: 8 + paddedHeaderLength + writtenBytes,
				isQuantized: false,
				elementType: 'BF16',
				note: 'copied exactly as published. Which of these may be quantized depends on the graph that consumes ' +
					'them, which milestone 4 builds.',
			};
		} finally {
			Fs.closeSync(residentFile);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Verification
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads blocks back out of the written file and checks them against the source, because a conversion that writes
	 * 15 gigabytes of plausible-looking bytes at the wrong offsets would pass every other check in this pipeline.
	 *
	 * @param {SafetensorsReader} reader The reader for the source model.
	 * @param {string} blocksPath The written expert block file.
	 * @param {{blockByteLength: number, parts: BlockPart[]}} layout The block layout.
	 * @param {{firstLayer: number, lastLayer: number}} options Which layers were converted.
	 * @param {number} expertsForEachLayer How many experts one layer holds.
	 * @returns {Promise<void>} Resolves once every checked block has matched.
	 */
	static async _verify(reader, blocksPath, layout, options, expertsForEachLayer) {
		console.log('\n  verifying, by reading blocks back out of the file and quantizing the source again');
		const blockCount = Fs.statSync(blocksPath).size / layout.blockByteLength;
		const checked = [...new Set([0, Math.floor(blockCount / 2), blockCount - 1])];
		const blocksFile = Fs.openSync(blocksPath, 'r');

		try {
			for (const blockNumber of checked) {
				const layerIndex = options.firstLayer + Math.floor(blockNumber / expertsForEachLayer);
				const expertIndex = blockNumber % expertsForEachLayer;
				const block = Buffer.alloc(layout.blockByteLength);
				Fs.readSync(blocksFile, block, 0, block.length, blockNumber * layout.blockByteLength);

				let partIndex = 0;
				let worstDifference = 0;
				for (const projectionName of PROJECTION_NAMES) {
					const tensorName = `model.layers.${layerIndex}.mlp.experts.${expertIndex}.${projectionName}.weight`;
					const tensor = await reader.locate(tensorName);
					const [rowCount, columnCount] = tensor.shape;
					const matrix = QuantizeMatmulnbits.quantize(await reader.read(tensor), rowCount, columnCount, SCHEME);
					const halfScales = new Float16Array(matrix.scales.length);
					halfScales.set(matrix.scales);

					for (const stored of [matrix.quantized, new Uint8Array(halfScales.buffer), matrix.zeroPoints]) {
						const part = layout.parts[partIndex];
						const written = block.subarray(part.offset, part.offset + part.byteLength);
						for (let index = 0; index < stored.length; index++) {
							worstDifference = Math.max(worstDifference, Math.abs(stored[index] - written[index]));
						}
						partIndex++;
					}
				}

				console.log(
					`    block ${blockNumber} (layer ${layerIndex}, expert ${expertIndex}): ` +
						`${worstDifference === 0 ? 'every byte matches' : `${worstDifference} is the largest byte difference`}`,
				);
				if (worstDifference !== 0) {
					throw new Error(`block ${blockNumber} does not match the source`);
				}
			}
		} finally {
			Fs.closeSync(blocksFile);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Layout
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Works out where every part of an expert block sits, and refuses a layout whose parts are not aligned.
	 *
	 * @param {number} hiddenSize The model's hidden size.
	 * @param {number} expertWidth The width of one expert's inner projection.
	 * @returns {{blockByteLength: number, parts: BlockPart[]}} The layout.
	 */
	static _describeBlockLayout(hiddenSize, expertWidth) {
		/** @type {BlockPart[]} */
		const parts = [];
		let offset = 0;
		for (const projectionName of PROJECTION_NAMES) {
			const rowCount = projectionName === 'down_proj' ? hiddenSize : expertWidth;
			const columnCount = projectionName === 'down_proj' ? expertWidth : hiddenSize;
			const blocksForEachRow = Math.ceil(columnCount / SCHEME.blockSize);
			for (const part of [
				{
					name: `${projectionName} quantized`,
					byteLength: (rowCount * blocksForEachRow * SCHEME.blockSize) / 2,
				},
				{
					name: `${projectionName} scales`,
					byteLength: rowCount * blocksForEachRow * 2,
				},
				{
					name: `${projectionName} zero points`,
					byteLength: Math.ceil((rowCount * blocksForEachRow) / 2),
				},
			]) {
				if (offset % PART_ALIGNMENT !== 0) {
					throw new Error(
						`${part.name} would start at byte ${offset}, which is not a multiple of ${PART_ALIGNMENT}, so a ` +
							'residency layer could not copy it straight into a WebGPU buffer',
					);
				}
				parts.push({
					name: part.name,
					offset: offset,
					byteLength: part.byteLength,
				});
				offset += part.byteLength;
			}
		}
		return {
			blockByteLength: offset,
			parts: parts,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Options and reporting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the command line.
	 *
	 * @param {string[]} argumentList The arguments after the script name.
	 * @returns {{outputDirectory: string, firstLayer: number, lastLayer: number}} The options.
	 */
	static _readOptions(argumentList) {
		const options = {
			outputDirectory: 'qwen3-30b-a3b-expert-blocks',
			firstLayer: 0,
			lastLayer: Number.MAX_SAFE_INTEGER,
		};
		for (let index = 0; index < argumentList.length; index += 2) {
			const name = argumentList[index];
			const value = argumentList[index + 1];
			if (name === '--output') {
				options.outputDirectory = value;
			} else if (name === '--first-layer') {
				options.firstLayer = Number(value);
			} else if (name === '--last-layer') {
				options.lastLayer = Number(value);
			} else {
				throw new Error(
					`unknown option ${name}. Use --output <directory>, --first-layer <index>, --last-layer <index>`,
				);
			}
		}
		return options;
	}

	/**
	 * Formats a byte count in megabytes.
	 *
	 * @param {number} bytes The byte count.
	 * @returns {string} The formatted text.
	 */
	static _megabytes(bytes) {
		return `${(bytes / 1024 / 1024).toFixed(2)} megabytes`;
	}

	/**
	 * Formats a byte count in gigabytes.
	 *
	 * @param {number} bytes The byte count.
	 * @returns {string} The formatted text.
	 */
	static _gigabytes(bytes) {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} gigabytes`;
	}
}

await ConvertQwen3MoeToExpertBlocks.main();
