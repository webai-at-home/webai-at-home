///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	QuantizedWeights — builds, quantizes, and independently recomputes expert weight blocks
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Produces the synthetic expert weight matrices this gate runs, quantizes them into the block layout `MatMulNBits`
 * expects, and recomputes the expected product in plain TypeScript.
 *
 * The independent recomputation is the point. Without it, a phase that runs without throwing proves only that ONNX
 * Runtime Web accepted the tensors, not that it read the right bytes out of the buffer this project owns. Milestone
 * zero of https://github.com/webai-at-home/webai-at-home/issues/169 turns on that difference: a session that silently
 * kept a prepacked copy of the first weights would run without error and return a stale answer.
 */

/** One weight matrix in the block-quantized layout that `MatMulNBits` reads. */
export type QuantizedMatrix = {
	/** The packed 4-bit weight values, two per byte with the even value in the low half. */
	quantized: Uint8Array;
	/** One scale factor per block, indexed as `row * blocksPerRow + block`. */
	scales: Float32Array;
	/** The number of rows in the weight matrix, which `MatMulNBits` calls `N`. */
	rowCount: number;
	/** The number of columns in the weight matrix, which `MatMulNBits` calls `K`. */
	columnCount: number;
	/** The number of weight values sharing one scale factor. */
	blockSize: number;
	/** The number of blocks along one row, which is `ceil(columnCount / blockSize)`. */
	blocksPerRow: number;
	/**
	 * One packed zero point per block, or undefined when the matrix was quantized against a fixed zero point. Every
	 * row starts on a whole byte, because that is how `MatMulNBits` reads the tensor, so a row holding an odd number
	 * of blocks wastes the top half of its last byte.
	 */
	zeroPoints?: Uint8Array;
};

/**
 * Builds and quantizes synthetic expert weights, and recomputes their product without ONNX Runtime Web.
 */
export class QuantizedWeights {
	/**
	 * Produces a deterministic pseudo-random floating point sequence in the range -1 to 1.
	 *
	 * Determinism matters twice over: a failing phase can be re-run and re-read, and each simulated expert is
	 * identified by its seed alone rather than by megabytes of stored weights.
	 *
	 * @param seed - The seed identifying this sequence. Distinct seeds stand for distinct simulated experts.
	 * @param count - How many values to produce.
	 * @returns The generated values.
	 */
	static makeValues(seed: number, count: number): Float32Array {
		const values = new Float32Array(count);
		let state = (seed * 2654435761) >>> 0;
		for (let index = 0; index < count; index++) {
			state = (state + 0x6d2b79f5) >>> 0;
			let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
			mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
			values[index] = (((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296) * 2 - 1;
		}
		return values;
	}

	/**
	 * Quantizes a weight matrix into the block layout `MatMulNBits` reads.
	 *
	 * The quantization is symmetric around the zero point: a stored value of `zeroPoint` means zero, and one step of
	 * the stored value is one scale factor. The scale of a block is chosen so the largest magnitude in that block
	 * reaches the edge of the representable range.
	 *
	 * @param weights - The weight matrix, row-major, with `rowCount * columnCount` values.
	 * @param rowCount - The number of rows, which `MatMulNBits` calls `N`.
	 * @param columnCount - The number of columns, which `MatMulNBits` calls `K`.
	 * @param blockSize - The number of weight values sharing one scale factor.
	 * @param zeroPoint - The stored value that stands for zero. `MatMulNBits` uses 8 at 4 bits when no zero point tensor
	 *   is supplied, but this gate measures that rather than assuming it.
	 * @returns The quantized matrix.
	 */
	static quantize(
		weights: Float32Array,
		rowCount: number,
		columnCount: number,
		blockSize: number,
		zeroPoint: number,
	): QuantizedMatrix {
		const blocksPerRow = Math.ceil(columnCount / blockSize);
		const blobSize = (blockSize * 4) / 8;
		const quantized = new Uint8Array(rowCount * blocksPerRow * blobSize);
		const scales = new Float32Array(rowCount * blocksPerRow);
		const largestStep = Math.max(zeroPoint, 15 - zeroPoint);

		for (let row = 0; row < rowCount; row++) {
			for (let block = 0; block < blocksPerRow; block++) {
				const firstColumn = block * blockSize;
				const lastColumn = Math.min(firstColumn + blockSize, columnCount);

				let largestMagnitude = 0;
				for (let column = firstColumn; column < lastColumn; column++) {
					largestMagnitude = Math.max(largestMagnitude, Math.abs(weights[row * columnCount + column]));
				}

				const scale = largestMagnitude === 0 ? 0 : largestMagnitude / largestStep;
				scales[row * blocksPerRow + block] = scale;

				for (let column = firstColumn; column < lastColumn; column++) {
					const weight = weights[row * columnCount + column];
					const stored = scale === 0 ? zeroPoint : Math.min(15, Math.max(0, Math.round(weight / scale) + zeroPoint));
					const positionInBlock = column - firstColumn;
					const byteIndex = (row * blocksPerRow + block) * blobSize + Math.floor(positionInBlock / 2);
					if (positionInBlock % 2 === 0) {
						quantized[byteIndex] = (quantized[byteIndex] & 0xf0) | (stored & 0x0f);
					} else {
						quantized[byteIndex] = (quantized[byteIndex] & 0x0f) | ((stored & 0x0f) << 4);
					}
				}
			}
		}

		return {
			quantized: quantized,
			scales: scales,
			rowCount: rowCount,
			columnCount: columnCount,
			blockSize: blockSize,
			blocksPerRow: blocksPerRow,
		};
	}

	/**
	 * Quantizes a weight matrix by fitting each block's own range, and writes a zero point for every block.
	 *
	 * This is the scheme milestone 3 chose after measuring it against real Qwen3-30B-A3B weights and against a
	 * published 4-bit quantization of the same model. Against a fixed zero point of 8, the whole representable range
	 * is spent symmetrically whether or not the block is symmetric; fitting the range recovers about a sixth of the
	 * loss for 4 more bits per block. It needs the fourth input to exist on the node, which is what the phase using
	 * this method is there to prove.
	 *
	 * @param weights - The weight matrix, row-major, with `rowCount * columnCount` values.
	 * @param rowCount - The number of rows, which `MatMulNBits` calls `N`.
	 * @param columnCount - The number of columns, which `MatMulNBits` calls `K`.
	 * @param blockSize - The number of weight values sharing one scale factor.
	 * @returns The quantized matrix, carrying its zero points.
	 */
	static quantizeAsymmetric(
		weights: Float32Array,
		rowCount: number,
		columnCount: number,
		blockSize: number,
	): QuantizedMatrix {
		const blocksPerRow = Math.ceil(columnCount / blockSize);
		const blobSize = (blockSize * 4) / 8;
		const zeroPointBytesPerRow = Math.ceil(blocksPerRow / 2);
		const quantized = new Uint8Array(rowCount * blocksPerRow * blobSize);
		const scales = new Float32Array(rowCount * blocksPerRow);
		const zeroPoints = new Uint8Array(rowCount * zeroPointBytesPerRow);

		for (let row = 0; row < rowCount; row++) {
			for (let block = 0; block < blocksPerRow; block++) {
				const firstColumn = block * blockSize;
				const lastColumn = Math.min(firstColumn + blockSize, columnCount);

				let smallest = Number.POSITIVE_INFINITY;
				let largest = Number.NEGATIVE_INFINITY;
				for (let column = firstColumn; column < lastColumn; column++) {
					const weight = weights[row * columnCount + column];
					smallest = Math.min(smallest, weight);
					largest = Math.max(largest, weight);
				}

				const scale = largest === smallest ? 0 : (largest - smallest) / 15;
				const zeroPoint = scale === 0 ? 8 : Math.min(15, Math.max(0, Math.round(-smallest / scale)));
				scales[row * blocksPerRow + block] = scale;
				QuantizedWeights._packNibble(zeroPoints, row * zeroPointBytesPerRow * 2 + block, zeroPoint);

				for (let column = firstColumn; column < lastColumn; column++) {
					const weight = weights[row * columnCount + column];
					const stored = scale === 0 ? zeroPoint : Math.min(15, Math.max(0, Math.round(weight / scale) + zeroPoint));
					const positionInBlock = column - firstColumn;
					const byteIndex = (row * blocksPerRow + block) * blobSize + Math.floor(positionInBlock / 2);
					if (positionInBlock % 2 === 0) {
						quantized[byteIndex] = (quantized[byteIndex] & 0xf0) | (stored & 0x0f);
					} else {
						quantized[byteIndex] = (quantized[byteIndex] & 0x0f) | ((stored & 0x0f) << 4);
					}
				}
			}
		}

		return {
			quantized: quantized,
			scales: scales,
			rowCount: rowCount,
			columnCount: columnCount,
			blockSize: blockSize,
			blocksPerRow: blocksPerRow,
			zeroPoints: zeroPoints,
		};
	}

	/**
	 * Recomputes the product `hiddenState` times the transpose of the quantized matrix, without ONNX Runtime Web.
	 *
	 * @param hiddenState - The activation vector entering the projection, with `columnCount` values.
	 * @param matrix - The quantized weight matrix.
	 * @param zeroPoint - The stored value that stands for zero, used for every block when the matrix carries no zero
	 *   points of its own. It is ignored when the matrix does carry them.
	 * @returns The expected output vector, with `rowCount` values.
	 */
	static referenceProduct(hiddenState: Float32Array, matrix: QuantizedMatrix, zeroPoint: number): Float32Array {
		const blobSize = (matrix.blockSize * 4) / 8;
		const zeroPointBytesPerRow = Math.ceil(matrix.blocksPerRow / 2);
		const projected = new Float32Array(matrix.rowCount);

		for (let row = 0; row < matrix.rowCount; row++) {
			let total = 0;
			for (let column = 0; column < matrix.columnCount; column++) {
				const block = Math.floor(column / matrix.blockSize);
				const positionInBlock = column - block * matrix.blockSize;
				const byteIndex = (row * matrix.blocksPerRow + block) * blobSize + Math.floor(positionInBlock / 2);
				const packed = matrix.quantized[byteIndex];
				const stored = positionInBlock % 2 === 0 ? packed & 0x0f : (packed >> 4) & 0x0f;
				const blockZeroPoint = matrix.zeroPoints === undefined
					? zeroPoint
					: QuantizedWeights._readNibble(matrix.zeroPoints, row * zeroPointBytesPerRow * 2 + block);
				const weight = (stored - blockZeroPoint) * matrix.scales[row * matrix.blocksPerRow + block];
				total += hiddenState[column] * weight;
			}
			projected[row] = total;
		}

		return projected;
	}

	/**
	 * Writes one 4-bit value into a packed array, with the even value in the low half of its byte.
	 *
	 * @param packed - The array to write into.
	 * @param index - The index of the value, counted in 4-bit values rather than bytes.
	 * @param value - The value to write, from 0 to 15.
	 * @returns Nothing.
	 */
	static _packNibble(packed: Uint8Array, index: number, value: number): void {
		const byteIndex = index >> 1;
		if ((index & 1) === 0) {
			packed[byteIndex] = (packed[byteIndex] & 0xf0) | (value & 0x0f);
		} else {
			packed[byteIndex] = (packed[byteIndex] & 0x0f) | ((value & 0x0f) << 4);
		}
	}

	/**
	 * Reads one 4-bit value out of a packed array.
	 *
	 * @param packed - The array to read from.
	 * @param index - The index of the value, counted in 4-bit values rather than bytes.
	 * @returns The value, from 0 to 15.
	 */
	static _readNibble(packed: Uint8Array, index: number): number {
		const stored = packed[index >> 1];
		return (index & 1) === 0 ? stored & 0x0f : (stored >> 4) & 0x0f;
	}

	/**
	 * Reports the largest absolute difference between two vectors of the same length.
	 *
	 * A single number is enough to decide a phase, and it stays readable in the page's output where a full vector of
	 * 768 values would not.
	 *
	 * @param left - The first vector.
	 * @param right - The second vector.
	 * @returns The largest absolute difference, or `Number.POSITIVE_INFINITY` when the lengths differ.
	 */
	static largestDifference(left: ArrayLike<number>, right: ArrayLike<number>): number {
		if (left.length !== right.length) {
			return Number.POSITIVE_INFINITY;
		}
		let largest = 0;
		for (let index = 0; index < left.length; index++) {
			largest = Math.max(largest, Math.abs(left[index] - right[index]));
		}
		return largest;
	}

	/**
	 * Reports the largest absolute value in a vector, which sets the scale that a difference should be judged against.
	 *
	 * @param values - The vector to measure.
	 * @returns The largest absolute value.
	 */
	static largestMagnitude(values: ArrayLike<number>): number {
		let largest = 0;
		for (let index = 0; index < values.length; index++) {
			largest = Math.max(largest, Math.abs(values[index]));
		}
		return largest;
	}
}
