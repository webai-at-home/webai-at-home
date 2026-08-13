///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	QuantizeMatmulnbits — 4-bit block quantization in the layout MatMulNBits reads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The quantizer shared by the milestone 3 de-risking gate and by the conversion pipeline of
 * https://github.com/webai-at-home/webai-at-home/issues/169. It writes exactly the layout the milestone 0 gate
 * confirmed against a live ONNX Runtime Web:
 *
 * - `B` shaped `[N, ceil(K / blockSize), blockSize * 4 / 8]`,
 * - two values to a byte, with the even value in the low half,
 * - one scale for every block,
 * - a value restored as `(stored - zeroPoint) * scale`.
 *
 * Two schemes are offered because they cost different amounts and the difference is measurable rather than a matter
 * of taste. `symmetric` leaves the zero point at the fixed 8 that `MatMulNBits` assumes when it is given no zero
 * point tensor, which is what milestone 0 ran. `asymmetric` fits each block's own range and writes a zero point for
 * every block, which needs that extra tensor declared in the graph and costs 4 more bits for every block.
 */

/** The stored value that stands for zero when `MatMulNBits` is given no zero point tensor. */
export const FIXED_ZERO_POINT = 8;

/** Which of the two quantization schemes a matrix was quantized with. */
export type QuantizationScheme = 'symmetric' | 'asymmetric';

/** How to quantize one weight matrix. */
export type QuantizationOptions = {
	/** The number of weight values that share one scale. */
	blockSize: number;
	/** Which scheme to use. */
	scheme: QuantizationScheme;
	/** Symmetric only: what the largest magnitude in a block is divided by to make its scale. Defaults to 8. */
	divisor?: number;
};

/** One weight matrix quantized to 4 bits in blocks. */
export type QuantizedMatrix = {
	/** The packed values, two to a byte, with the even value in the low half. */
	quantized: Uint8Array;
	/** One scale for every block, in row-major order. Mutable so it can be rounded to half precision in place. */
	scales: Float32Array;
	/**
	 * One packed zero point for every block, or undefined when the scheme is symmetric and the fixed zero point of 8
	 * applies. Every row starts on a whole byte, because that is how `MatMulNBits` reads the tensor, so a row holding
	 * an odd number of blocks wastes the top half of its last byte.
	 */
	zeroPoints: Uint8Array | undefined;
	/** The number of output rows, which `MatMulNBits` calls N. */
	rowCount: number;
	/** The number of input columns, which `MatMulNBits` calls K. */
	columnCount: number;
	/** The number of weights sharing one scale. */
	blockSize: number;
	/** How many blocks one row is divided into. */
	blocksForEachRow: number;
	/** Which scheme produced this matrix. */
	scheme: QuantizationScheme;
};

/** How many bytes one quantized matrix occupies on disk, part by part. */
export type QuantizedByteLengths = {
	/** The byte length of the packed values. */
	quantized: number;
	/** The byte length of the scales. */
	scales: number;
	/** The byte length of the zero points, or 0 when the scheme is symmetric. */
	zeroPoints: number;
	/** The sum of the three. */
	total: number;
	/** What the total costs for every weight, in bits. */
	bitsForEachWeight: number;
};

/** Quantizes weight matrices to 4 bits in the layout `MatMulNBits` reads, and restores them again. */
export class QuantizeMatmulnbits {
	/**
	 * Quantizes one weight matrix.
	 *
	 * @param values The weights, in row-major order, of length `rowCount * columnCount`.
	 * @param rowCount The number of output rows, which `MatMulNBits` calls N.
	 * @param columnCount The number of input columns, which `MatMulNBits` calls K.
	 * @param options How to quantize.
	 * @returns The quantized matrix.
	 */
	static quantize(
		values: Float32Array,
		rowCount: number,
		columnCount: number,
		options: QuantizationOptions,
	): QuantizedMatrix {
		const blockSize = options.blockSize;
		const blocksForEachRow = Math.ceil(columnCount / blockSize);
		const blobSize = (blockSize * 4) / 8;
		const quantized = new Uint8Array(rowCount * blocksForEachRow * blobSize);
		const scales = new Float32Array(rowCount * blocksForEachRow);
		const zeroPointBytesForEachRow = Math.ceil(blocksForEachRow / 2);
		const zeroPoints = options.scheme === 'asymmetric'
			? new Uint8Array(rowCount * zeroPointBytesForEachRow)
			: undefined;

		for (let row = 0; row < rowCount; row++) {
			for (let block = 0; block < blocksForEachRow; block++) {
				const firstColumn = block * blockSize;
				const lastColumn = Math.min(firstColumn + blockSize, columnCount);
				const blockIndex = row * blocksForEachRow + block;

				let scale: number;
				let zeroPoint: number;
				if (options.scheme === 'symmetric') {
					let largestMagnitude = 0;
					for (let column = firstColumn; column < lastColumn; column++) {
						largestMagnitude = Math.max(largestMagnitude, Math.abs(values[row * columnCount + column]));
					}
					scale = largestMagnitude === 0 ? 1 : largestMagnitude / (options.divisor ?? FIXED_ZERO_POINT);
					zeroPoint = FIXED_ZERO_POINT;
				} else {
					let smallest = Number.POSITIVE_INFINITY;
					let largest = Number.NEGATIVE_INFINITY;
					for (let column = firstColumn; column < lastColumn; column++) {
						const value = values[row * columnCount + column];
						smallest = Math.min(smallest, value);
						largest = Math.max(largest, value);
					}
					scale = largest === smallest ? 1 : (largest - smallest) / 15;
					zeroPoint = Math.min(15, Math.max(0, Math.round(-smallest / scale)));
					QuantizeMatmulnbits._packNibble(zeroPoints as Uint8Array, row * zeroPointBytesForEachRow * 2 + block, zeroPoint);
				}
				scales[blockIndex] = scale;

				for (let step = 0; step < blockSize; step++) {
					const column = firstColumn + step;
					const value = column < columnCount ? values[row * columnCount + column] : 0;
					let stored = Math.round(value / scale) + zeroPoint;
					if (stored < 0) {
						stored = 0;
					}
					if (stored > 15) {
						stored = 15;
					}
					QuantizeMatmulnbits._packNibble(quantized, blockIndex * blockSize + step, stored);
				}
			}
		}

		return {
			quantized: quantized,
			scales: scales,
			zeroPoints: zeroPoints,
			rowCount: rowCount,
			columnCount: columnCount,
			blockSize: blockSize,
			blocksForEachRow: blocksForEachRow,
			scheme: options.scheme,
		};
	}

	/**
	 * Restores a quantized matrix to single precision, exactly as `MatMulNBits` restores it before multiplying.
	 *
	 * @param matrix The quantized matrix.
	 * @returns The restored weights, in row-major order.
	 */
	static dequantize(matrix: QuantizedMatrix): Float32Array {
		const restored = new Float32Array(matrix.rowCount * matrix.columnCount);
		const zeroPointBytesForEachRow = Math.ceil(matrix.blocksForEachRow / 2);
		for (let row = 0; row < matrix.rowCount; row++) {
			for (let block = 0; block < matrix.blocksForEachRow; block++) {
				const blockIndex = row * matrix.blocksForEachRow + block;
				const scale = matrix.scales[blockIndex];
				const zeroPoint = matrix.zeroPoints === undefined
					? FIXED_ZERO_POINT
					: QuantizeMatmulnbits._readNibble(matrix.zeroPoints, row * zeroPointBytesForEachRow * 2 + block);
				for (let step = 0; step < matrix.blockSize; step++) {
					const column = block * matrix.blockSize + step;
					if (column >= matrix.columnCount) {
						break;
					}
					const stored = QuantizeMatmulnbits._readNibble(matrix.quantized, blockIndex * matrix.blockSize + step);
					restored[row * matrix.columnCount + column] = (stored - zeroPoint) * scale;
				}
			}
		}
		return restored;
	}

	/**
	 * Reports how many bytes one quantized matrix occupies on disk, part by part.
	 *
	 * @param matrix The quantized matrix.
	 * @returns The byte counts, and what they cost for every weight.
	 */
	static byteLengths(matrix: QuantizedMatrix): QuantizedByteLengths {
		const quantized = matrix.quantized.length;
		const scales = matrix.scales.length * 2;
		const zeroPoints = matrix.zeroPoints === undefined ? 0 : matrix.zeroPoints.length;
		const total = quantized + scales + zeroPoints;
		return {
			quantized: quantized,
			scales: scales,
			zeroPoints: zeroPoints,
			total: total,
			bitsForEachWeight: (total * 8) / (matrix.rowCount * matrix.columnCount),
		};
	}

	/**
	 * Rounds every scale through half precision and back, which is how they are stored on disk.
	 *
	 * @param scales The scales at single precision.
	 * @returns The same scales after a trip through half precision.
	 */
	static roundScalesToHalfPrecision(scales: Float32Array): Float32Array {
		const rounded = new Float32Array(scales.length);
		const halves = new Float16Array(scales.length);
		halves.set(scales);
		rounded.set(halves);
		return rounded;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Writes one 4-bit value into a packed array, with the even value in the low half of its byte.
	 *
	 * @param packed The array to write into.
	 * @param index The index of the value, counted in 4-bit values rather than bytes.
	 * @param value The value to write, from 0 to 15.
	 * @returns Nothing.
	 */
	private static _packNibble(packed: Uint8Array, index: number, value: number): void {
		const byteIndex = index >> 1;
		if ((index & 1) === 0) {
			packed[byteIndex] = (packed[byteIndex] & 0xf0) | value;
		} else {
			packed[byteIndex] = (packed[byteIndex] & 0x0f) | (value << 4);
		}
	}

	/**
	 * Reads one 4-bit value out of a packed array.
	 *
	 * @param packed The array to read from.
	 * @param index The index of the value, counted in 4-bit values rather than bytes.
	 * @returns The value, from 0 to 15.
	 */
	private static _readNibble(packed: Uint8Array, index: number): number {
		const stored = packed[index >> 1];
		return (index & 1) === 0 ? stored & 0x0f : stored >> 4;
	}
}
