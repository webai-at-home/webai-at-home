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

/** One entry of a parsed safetensors header, before it is located in its shard. */
export type SafetensorsHeaderEntry = {
	/** The stored element type, such as `BF16`. */
	dtype: string;
	/** The tensor's dimensions. */
	shape: number[];
	/** The tensor's byte range inside the shard's data section, as `[start, end)`. */
	data_offsets: [number, number];
};

/** A parsed safetensors file header: one entry for every tensor it holds. */
export type SafetensorsHeader = Record<string, SafetensorsHeaderEntry>;

/** The parsed `model.safetensors.index.json` of a published model. */
export type SafetensorsIndex = {
	/** Which shard file holds each tensor, keyed by tensor name. */
	weight_map: Record<string, string>;
	/** Whole-model metadata the index carries alongside the weight map. */
	metadata: {
		/** The total byte size of every shard, at the element type the model was published in. */
		total_size: number;
	};
};

/** One tensor as a published safetensors header describes it, including where its bytes live in its shard. */
export type LocatedTensor = {
	/** The tensor's name in the model. */
	name: string;
	/** The shard file holding it. */
	shardName: string;
	/** The stored element type, such as `BF16`. */
	dataType: string;
	/** The tensor's dimensions. */
	shape: number[];
	/** The first byte of the tensor, counted from the start of the shard. */
	byteStart: number;
	/** The byte after the last byte of the tensor, counted from the start of the shard. */
	byteEnd: number;
};

/** One shard header, cached after its first read. */
type CachedHeader = {
	/** The parsed header. */
	header: SafetensorsHeader;
	/** How many bytes the header occupies, counted after the 8-byte length prefix. */
	headerLength: number;
};

/** Reads tensors out of one published model repository. */
export class SafetensorsReader {
	/** The Hugging Face repository being read. */
	readonly repository: string;
	/** The revision being read. */
	readonly revision: string;
	/** The parsed weight index, once it has been read. */
	index: SafetensorsIndex | undefined;
	/** Headers already read, keyed by shard name, so each shard's header is fetched once. */
	readonly headers: Map<string, CachedHeader>;

	/**
	 * @param repository The Hugging Face repository, such as `Qwen/Qwen3-30B-A3B`.
	 * @param revision The revision to read.
	 */
	constructor(repository: string, revision: string) {
		this.repository = repository;
		this.revision = revision;
		this.index = undefined;
		this.headers = new Map();
	}

	/**
	 * Finds where one named tensor's bytes live, reading only the index and the header of the shard that holds it.
	 *
	 * @param tensorName The tensor to locate.
	 * @returns Where the tensor's bytes are.
	 */
	async locate(tensorName: string): Promise<LocatedTensor> {
		if (this.index === undefined) {
			this.index = await this._fetchJson<SafetensorsIndex>('model.safetensors.index.json');
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
	 * @param tensor The tensor to read.
	 * @returns The tensor's values, in row-major order.
	 */
	async read(tensor: LocatedTensor): Promise<Float32Array> {
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
	 * @param tensor The tensor to read from.
	 * @param offset The first byte to read, counted from the start of the tensor.
	 * @param byteLength How many bytes to read.
	 * @returns The stored bytes.
	 */
	async readSlice(tensor: LocatedTensor, offset: number, byteLength: number): Promise<Uint8Array> {
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
	 * @param bytes The stored bytes, little-endian.
	 * @returns The values at single precision.
	 */
	static brainFloatToSingle(bytes: Uint8Array): Float32Array {
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
	 * Kept accessible rather than made private: the conversion pipeline builds its own retried range requests directly
	 * against this URL, so that one failed request does not throw away the hours of work already done.
	 *
	 * @param fileName The file to address.
	 * @returns The URL.
	 */
	_fileUrl(fileName: string): string {
		return `https://huggingface.co/${this.repository}/resolve/${this.revision}/${fileName}`;
	}

	/**
	 * Downloads and parses one JSON file from the model repository.
	 *
	 * Kept accessible rather than made private: the conversion pipeline reads `config.json` and the weight index
	 * directly through this reader rather than duplicating the fetch.
	 *
	 * @param fileName The file to read.
	 * @returns The parsed contents.
	 */
	async _fetchJson<T>(fileName: string): Promise<T> {
		const response = await fetch(this._fileUrl(fileName), {
			redirect: 'follow',
		});
		if (response.ok === false) {
			throw new Error(`${fileName} could not be read: ${response.status} ${response.statusText}`);
		}
		return await response.json() as T;
	}

	/**
	 * Reads one safetensors file's header.
	 *
	 * @param shardName The shard file to read.
	 * @returns The parsed header and its byte length.
	 */
	private async _readShardHeader(shardName: string): Promise<CachedHeader> {
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
			header: JSON.parse(await headerResponse.text()) as SafetensorsHeader,
			headerLength: headerLength,
		};
	}
}
