///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SafetensorsReader — reads single tensors out of published safetensors shards by range request
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Reads one tensor, or one slice of one tensor, out of a model published on Hugging Face, without downloading the
 * shard that holds it.
 *
 * A safetensors file starts with an unsigned 64-bit little-endian header length, then that many bytes of JSON naming
 * every tensor with its element type, its shape, and the byte range it occupies. Both are reachable by HTTP range
 * request, and so is the tensor itself, so reading one 3-megabyte expert projection out of a 4-gigabyte shard costs
 * 3 megabytes.
 *
 * This is what makes milestone 3 of https://github.com/webai-at-home/webai-at-home/issues/169 possible to de-risk at
 * all. Proving that a quantizer carries real Qwen3-30B-A3B weights would otherwise begin with a download of 57
 * gigabytes, and the whole point of a de-risking gate is that it costs less than the thing it guards.
 */

/**
 * One tensor as a published safetensors header describes it, including where its bytes live in its shard.
 *
 * @typedef {object} LocatedTensor
 * @property {string} name The tensor's name in the model.
 * @property {string} shardName The shard file holding it.
 * @property {string} dataType The stored element type, such as `BF16`.
 * @property {number[]} shape The tensor's dimensions.
 * @property {number} byteStart The first byte of the tensor, counted from the start of the shard.
 * @property {number} byteEnd The byte after the last byte of the tensor, counted from the start of the shard.
 */

/** Reads tensors out of one published model repository. */
export class SafetensorsReader {
	/**
	 * @param {string} repository The Hugging Face repository, such as `Qwen/Qwen3-30B-A3B`.
	 * @param {string} revision The revision to read.
	 */
	constructor(repository, revision) {
		/** The Hugging Face repository being read. */
		this.repository = repository;
		/** The revision being read. */
		this.revision = revision;
		/** The parsed weight index, once it has been read. */
		this.index = undefined;
		/** Headers already read, keyed by shard name, so each shard's header is fetched once. */
		this.headers = new Map();
	}

	/**
	 * Finds where one named tensor's bytes live, reading only the index and the header of the shard that holds it.
	 *
	 * @param {string} tensorName The tensor to locate.
	 * @returns {Promise<LocatedTensor>} Where the tensor's bytes are.
	 */
	async locate(tensorName) {
		if (this.index === undefined) {
			this.index = await this._fetchJson('model.safetensors.index.json');
		}
		const shardName = this.index.weight_map[tensorName];
		if (shardName === undefined) {
			throw new Error(`${tensorName} is not in the published index of ${this.repository}`);
		}
		let cached = this.headers.get(shardName);
		if (cached === undefined) {
			cached = await this._readShardHeader(shardName);
			this.headers.set(shardName, cached);
		}
		const description = cached.header[tensorName];
		if (description === undefined) {
			throw new Error(`${tensorName} is not in the header of ${shardName}`);
		}
		return {
			name: tensorName,
			shardName: shardName,
			dataType: description.dtype,
			shape: description.shape,
			byteStart: 8 + cached.headerLength + description.data_offsets[0],
			byteEnd: 8 + cached.headerLength + description.data_offsets[1],
		};
	}

	/**
	 * Downloads one whole tensor and converts it to single precision.
	 *
	 * @param {LocatedTensor} tensor The tensor to read.
	 * @returns {Promise<Float32Array>} The tensor's values, in row-major order.
	 */
	async read(tensor) {
		const bytes = await this.readSlice(tensor, 0, tensor.byteEnd - tensor.byteStart);
		if (tensor.dataType === 'BF16') {
			return SafetensorsReader.brainFloatToSingle(bytes);
		}
		if (tensor.dataType === 'F16') {
			return Float32Array.from(new Float16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));
		}
		if (tensor.dataType === 'F32') {
			return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
		}
		throw new Error(`${tensor.name} is stored as ${tensor.dataType}, which this reader does not convert`);
	}

	/**
	 * Downloads a range of raw bytes from inside one tensor, leaving them exactly as they are stored.
	 *
	 * This is what reads one expert out of a tensor that stacks all 128 experts of a layer together, and what reads
	 * packed 4-bit weights that no floating point conversion applies to.
	 *
	 * @param {LocatedTensor} tensor The tensor to read from.
	 * @param {number} offset The first byte to read, counted from the start of the tensor.
	 * @param {number} byteLength How many bytes to read.
	 * @returns {Promise<Uint8Array>} The stored bytes.
	 */
	async readSlice(tensor, offset, byteLength) {
		const start = tensor.byteStart + offset;
		const end = start + byteLength - 1;
		if (end >= tensor.byteEnd) {
			throw new Error(`the requested slice runs past the end of ${tensor.name}`);
		}
		const response = await fetch(this._fileUrl(tensor.shardName), {
			headers: {
				Range: `bytes=${start}-${end}`,
			},
		});
		if (response.ok === false) {
			throw new Error(`${tensor.name} could not be read: ${response.status} ${response.statusText}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length !== byteLength) {
			throw new Error(
				`${tensor.name} returned ${bytes.length} bytes where ${byteLength} were asked for, so the range request ` +
					'was not honoured and every number read from it would be wrong',
			);
		}
		return bytes;
	}

	/**
	 * Converts brain floating point values to single precision. A brain floating point value is the top 16 bits of a
	 * single-precision value, so the conversion is exact and costs one shift.
	 *
	 * @param {Uint8Array} bytes The stored bytes, little-endian.
	 * @returns {Float32Array} The values at single precision.
	 */
	static brainFloatToSingle(bytes) {
		const count = bytes.length / 2;
		const values = new Float32Array(count);
		const asSingle = new Uint32Array(values.buffer);
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
		for (let index = 0; index < count; index++) {
			asSingle[index] = view.getUint16(index * 2, true) << 16;
		}
		return values;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the download URL for one file in the model repository.
	 *
	 * @param {string} fileName The file to address.
	 * @returns {string} The URL.
	 */
	_fileUrl(fileName) {
		return `https://huggingface.co/${this.repository}/resolve/${this.revision}/${fileName}`;
	}

	/**
	 * Downloads and parses one JSON file from the model repository.
	 *
	 * @param {string} fileName The file to read.
	 * @returns {Promise<any>} The parsed contents.
	 */
	async _fetchJson(fileName) {
		const response = await fetch(this._fileUrl(fileName), {
			redirect: 'follow',
		});
		if (response.ok === false) {
			throw new Error(`${fileName} could not be read: ${response.status} ${response.statusText}`);
		}
		return await response.json();
	}

	/**
	 * Reads one safetensors file's header.
	 *
	 * @param {string} shardName The shard file to read.
	 * @returns {Promise<{header: any, headerLength: number}>} The parsed header and its byte length.
	 */
	async _readShardHeader(shardName) {
		const url = this._fileUrl(shardName);
		const lengthResponse = await fetch(url, {
			headers: {
				Range: 'bytes=0-7',
			},
		});
		if (lengthResponse.ok === false) {
			throw new Error(`${shardName} header length could not be read: ${lengthResponse.status}`);
		}
		const headerLength = Number(new DataView(await lengthResponse.arrayBuffer()).getBigUint64(0, true));

		const headerResponse = await fetch(url, {
			headers: {
				Range: `bytes=8-${7 + headerLength}`,
			},
		});
		if (headerResponse.ok === false) {
			throw new Error(`${shardName} header could not be read: ${headerResponse.status}`);
		}
		return {
			header: JSON.parse(await headerResponse.text()),
			headerLength: headerLength,
		};
	}
}
