///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MeasureQwen3MoeResidency — milestone 1 of issue #169, measured from the published weights
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

export {};

/**
 * Answers milestone 1 of https://github.com/webai-at-home/webai-at-home/issues/169:
 *
 * > Does the always-resident part of Qwen3-30B-A3B fit in the graphics memory of the target machine?
 *
 * Streaming only helps for the part of a model that is inactive most of the time. Everything else has to stay in
 * graphics memory permanently: attention weights, embeddings, the output head, normalization parameters, and the
 * key-value cache that grows with the context. If that part alone does not fit, the whole approach of
 * https://github.com/webai-at-home/webai-at-home/issues/168 stops, and it stops for one hour of arithmetic rather
 * than for weeks of implementation.
 *
 * This tool does not trust arithmetic done from the configuration file. It reads the real shape of every one of the
 * published tensors out of the safetensors headers, over HTTP range requests, and classifies each one. That is about
 * 20 megabytes of headers rather than the 61 gigabytes of weights, so it runs in under a minute and downloads no
 * model.
 */

/** The Hugging Face repository holding the model this experiment targets. */
const MODEL_REPOSITORY = 'Qwen/Qwen3-30B-A3B';
/** The revision to read. A branch name is acceptable here because nothing is cached and the run is repeatable. */
const MODEL_REVISION = 'main';
/** The number of weight values that share one scale factor, matching the block size the milestone 0 gate confirmed. */
const BLOCK_SIZE = 32;
/** The byte size of one scale factor, when scales are stored at half precision. */
const SCALE_BYTES = 2;
/** The graphics memory sizes to judge the always-resident part against, in gigabytes. */
const GRAPHICS_MEMORY_TARGETS = [8, 12, 16, 24];
/** The context lengths to report a key-value cache size for. */
const REPORTED_CONTEXT_LENGTHS = [4096, 8192, 16384, 40960];

/** The parts of the published `config.json` this tool reads. */
type Configuration = {
	/** How many decoder layers the model has. */
	num_hidden_layers: number;
	/** The width of one token's activation. */
	hidden_size: number;
	/** How many experts one layer holds. */
	num_experts: number;
	/** How many experts each token selects in each layer. */
	num_experts_per_tok: number;
	/** The width of one expert's inner projection. */
	moe_intermediate_size: number;
	/** How many attention heads each layer has. */
	num_attention_heads: number;
	/** How many key and value heads each layer has. */
	num_key_value_heads: number;
	/** How wide one attention head is. */
	head_dim: number;
	/** How many tokens the model knows. */
	vocab_size: number;
	/** Whether the output head shares its weights with the token embedding. */
	tie_word_embeddings: boolean;
	/** How often a layer is a mixture-of-experts layer, where 1 means every layer is. */
	decoder_sparse_step: number;
	/** Which layers, if any, are dense rather than mixture-of-experts. */
	mlp_only_layers: number[];
};

/** The parsed `model.safetensors.index.json` of a published model. */
type SafetensorsIndex = {
	/** Which shard file holds each tensor, keyed by tensor name. */
	weight_map: Record<string, string>;
	/** Whole-model metadata the index carries alongside the weight map. */
	metadata: {
		/** The total byte size of every shard, at the element type the model was published in. */
		total_size: number;
	};
};

/** One entry of a parsed safetensors header. */
type SafetensorsHeaderEntry = {
	/** The stored element type, such as `BF16`. */
	dtype: string;
	/** The tensor's dimensions. */
	shape: number[];
};

/** One tensor as the published safetensors headers describe it. */
type PublishedTensor = {
	/** The tensor's name in the model. */
	name: string;
	/** The stored element type, such as `BF16`. */
	dataType: string;
	/** The tensor's dimensions. */
	shape: number[];
	/** The number of values the tensor holds. */
	parameterCount: number;
};

/** Reads the published Qwen3-30B-A3B tensor headers and reports how much of the model must stay resident. */
class MeasureQwen3MoeResidency {
	/**
	 * Runs the measurement and prints the report.
	 *
	 * @returns Resolves once the report has been printed.
	 */
	static async main(): Promise<void> {
		const configuration = await MeasureQwen3MoeResidency._fetchJson<Configuration>('config.json');
		const index = await MeasureQwen3MoeResidency._fetchJson<SafetensorsIndex>('model.safetensors.index.json');
		const shardNames = [...new Set(Object.values(index.weight_map))].sort();

		console.log(`model: ${MODEL_REPOSITORY} at revision ${MODEL_REVISION}`);
		console.log(`  ${configuration.num_hidden_layers} layers, hidden size ${configuration.hidden_size}`);
		console.log(
			`  ${configuration.num_experts} experts per layer, ${configuration.num_experts_per_tok} selected per token, ` +
				`expert width ${configuration.moe_intermediate_size}`,
		);
		console.log(
			`  ${configuration.num_attention_heads} attention heads, ${configuration.num_key_value_heads} key-value heads, ` +
				`head dimension ${configuration.head_dim}`,
		);
		console.log(
			`  vocabulary ${configuration.vocab_size}, output head tied to the embedding: ${configuration.tie_word_embeddings}`,
		);
		console.log(
			`  every layer is a mixture-of-experts layer: ` +
				`${configuration.decoder_sparse_step === 1 && configuration.mlp_only_layers.length === 0}`,
		);
		console.log(`  reading ${shardNames.length} safetensors headers over range requests…`);

		const tensors: PublishedTensor[] = [];
		for (const shardName of shardNames) {
			tensors.push(...(await MeasureQwen3MoeResidency._readShardHeader(shardName)));
		}

		const expertTensors = tensors.filter((tensor) => /\.mlp\.experts\.\d+\./.test(tensor.name));
		const residentTensors = tensors.filter((tensor) => /\.mlp\.experts\.\d+\./.test(tensor.name) === false);

		const totalParameters = MeasureQwen3MoeResidency._sumParameters(tensors);
		const expertParameters = MeasureQwen3MoeResidency._sumParameters(expertTensors);
		const residentParameters = MeasureQwen3MoeResidency._sumParameters(residentTensors);

		console.log(`\n  read ${tensors.length} tensors, ${MeasureQwen3MoeResidency._billions(totalParameters)} in total`);
		console.log(
			`  published total_size at ${tensors[0].dataType}: ${MeasureQwen3MoeResidency._gigabytes(index.metadata.total_size)}`,
		);

		console.log('\n── what must stay resident, and what may be streamed');
		MeasureQwen3MoeResidency._printGroup('expert weights (streamed)', expertTensors, expertParameters, totalParameters);
		MeasureQwen3MoeResidency._printGroup(
			'everything else (resident)',
			residentTensors,
			residentParameters,
			totalParameters,
		);

		console.log('\n  the resident part, tensor by tensor:');
		const residentByKind = MeasureQwen3MoeResidency._groupByKind(residentTensors);
		for (const [kind, group] of residentByKind) {
			const parameters = MeasureQwen3MoeResidency._sumParameters(group);
			console.log(
				`    ${kind.padEnd(34)} ${String(group.length).padStart(5)} tensors  ` +
					`${MeasureQwen3MoeResidency._billions(parameters).padStart(12)}  ` +
					`${MeasureQwen3MoeResidency._gigabytes(MeasureQwen3MoeResidency._quantizedBytes(parameters)).padStart(12)} at 4 bits`,
			);
		}

		console.log('\n── one expert, which is the unit the residency layer moves');
		const perExpert = expertParameters / (configuration.num_hidden_layers * configuration.num_experts);
		console.log(`  ${MeasureQwen3MoeResidency._millions(perExpert)} parameters`);
		console.log(
			`  ${MeasureQwen3MoeResidency._megabytes(MeasureQwen3MoeResidency._quantizedBytes(perExpert))} at 4 bits with ` +
				`${BLOCK_SIZE}-value blocks and half-precision scales`,
		);
		console.log(`  ${configuration.num_hidden_layers * configuration.num_experts} experts in the whole model`);
		const activeExpertParameters =
			perExpert * configuration.num_experts_per_tok * configuration.num_hidden_layers;
		console.log(
			`  a token activates ${configuration.num_experts_per_tok} of ${configuration.num_experts} per layer, so ` +
				`${MeasureQwen3MoeResidency._billions(activeExpertParameters)} of expert weights, ` +
				`${MeasureQwen3MoeResidency._megabytes(MeasureQwen3MoeResidency._quantizedBytes(activeExpertParameters))} at 4 bits`,
		);
		console.log(
			`  active parameters per token including the resident part: ` +
				`${MeasureQwen3MoeResidency._billions(activeExpertParameters + residentParameters)}`,
		);
		console.log(
			`  sparsity ratio: ${(totalParameters / (activeExpertParameters + residentParameters)).toFixed(1)} to 1`,
		);

		console.log('\n── the key-value cache, which is resident and grows with the context');
		const cacheBytesPerToken =
			configuration.num_hidden_layers * 2 * configuration.num_key_value_heads * configuration.head_dim * 2;
		console.log(`  ${MeasureQwen3MoeResidency._kilobytes(cacheBytesPerToken)} per token at half precision`);
		for (const contextLength of REPORTED_CONTEXT_LENGTHS) {
			console.log(
				`    ${String(contextLength).padStart(6)} tokens → ` +
					`${MeasureQwen3MoeResidency._gigabytes(cacheBytesPerToken * contextLength)}`,
			);
		}

		console.log('\n── the verdict, which is what milestone 1 exists to produce');
		const residentQuantizedBytes = MeasureQwen3MoeResidency._quantizedBytes(residentParameters);
		const expertQuantizedBytes = MeasureQwen3MoeResidency._quantizedBytes(expertParameters);
		const residentHalfPrecisionBytes = residentParameters * 2;
		console.log(
			`  resident weights at 4 bits:          ${MeasureQwen3MoeResidency._gigabytes(residentQuantizedBytes)}`,
		);
		console.log(
			`  resident weights at half precision:  ${MeasureQwen3MoeResidency._gigabytes(residentHalfPrecisionBytes)}`,
		);
		for (const contextLength of [4096, 40960]) {
			const cacheBytes = cacheBytesPerToken * contextLength;
			const totalResident = residentQuantizedBytes + cacheBytes;
			console.log(
				`\n  at a context of ${contextLength} tokens, the resident set is ` +
					`${MeasureQwen3MoeResidency._gigabytes(totalResident)} ` +
					`(${MeasureQwen3MoeResidency._gigabytes(residentQuantizedBytes)} of weights plus ` +
					`${MeasureQwen3MoeResidency._gigabytes(cacheBytes)} of cache)`,
			);
			for (const target of GRAPHICS_MEMORY_TARGETS) {
				const targetBytes = target * 1024 * 1024 * 1024;
				const headroom = targetBytes - totalResident;
				const verdict = headroom > 0 ? 'FITS' : 'DOES NOT FIT';
				console.log(
					`    ${String(target).padStart(2)} gigabytes of graphics memory: ${verdict.padEnd(12)} ` +
						`${headroom > 0 ? `${MeasureQwen3MoeResidency._gigabytes(headroom)} left for the expert cache` : `short by ${MeasureQwen3MoeResidency._gigabytes(-headroom)}`}`,
				);
			}

			console.log(
				`    what that headroom buys, against ${MeasureQwen3MoeResidency._gigabytes(expertQuantizedBytes)} of expert weights:`,
			);
			for (const target of GRAPHICS_MEMORY_TARGETS) {
				const headroom = target * 1024 * 1024 * 1024 - totalResident;
				if (headroom <= 0) {
					continue;
				}
				const residentShare = Math.min(1, headroom / expertQuantizedBytes);
				const streamedBytes = MeasureQwen3MoeResidency._quantizedBytes(activeExpertParameters) * (1 - residentShare);
				console.log(
					`      ${String(target).padStart(2)} gigabytes: ${(residentShare * 100).toFixed(1).padStart(5)}% of all experts held resident, ` +
						`so ${MeasureQwen3MoeResidency._megabytes(streamedBytes).padStart(17)} read from disk per token at uniform routing`,
				);
			}
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reading the published weights
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the download URL for one file in the model repository.
	 *
	 * @param fileName The file to address.
	 * @returns The URL.
	 */
	private static _fileUrl(fileName: string): string {
		return `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${fileName}`;
	}

	/**
	 * Downloads and parses one JSON file from the model repository.
	 *
	 * @param fileName The file to read.
	 * @returns The parsed contents.
	 */
	private static async _fetchJson<T>(fileName: string): Promise<T> {
		const response = await fetch(MeasureQwen3MoeResidency._fileUrl(fileName));
		if (response.ok === false) {
			throw new Error(`${fileName} could not be read: ${response.status} ${response.statusText}`);
		}
		return await response.json() as T;
	}

	/**
	 * Reads one safetensors file's header and returns every tensor it describes.
	 *
	 * A safetensors file starts with an unsigned 64-bit little-endian header length, followed by that many bytes of
	 * JSON. Only those bytes are fetched, so a 4-gigabyte shard costs a request of a few megabytes.
	 *
	 * @param shardName The shard file to read.
	 * @returns Every tensor described by that shard's header.
	 */
	private static async _readShardHeader(shardName: string): Promise<PublishedTensor[]> {
		const url = MeasureQwen3MoeResidency._fileUrl(shardName);
		const lengthResponse = await fetch(url, { headers: { Range: 'bytes=0-7' } });
		if (lengthResponse.ok === false) {
			throw new Error(`${shardName} header length could not be read: ${lengthResponse.status}`);
		}
		const lengthBytes = new DataView(await lengthResponse.arrayBuffer());
		const headerLength = Number(lengthBytes.getBigUint64(0, true));

		const headerResponse = await fetch(url, { headers: { Range: `bytes=8-${7 + headerLength}` } });
		if (headerResponse.ok === false) {
			throw new Error(`${shardName} header could not be read: ${headerResponse.status}`);
		}
		const header = JSON.parse(await headerResponse.text()) as Record<string, SafetensorsHeaderEntry>;

		const tensors: PublishedTensor[] = [];
		for (const [name, description] of Object.entries(header)) {
			if (name === '__metadata__') {
				continue;
			}
			tensors.push({
				name: name,
				dataType: description.dtype,
				shape: description.shape,
				parameterCount: description.shape.reduce((product, dimension) => product * dimension, 1),
			});
		}
		return tensors;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reporting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Adds up the parameter counts of a group of tensors.
	 *
	 * @param tensors The tensors to add up.
	 * @returns The total parameter count.
	 */
	private static _sumParameters(tensors: PublishedTensor[]): number {
		return tensors.reduce((total, tensor) => total + tensor.parameterCount, 0);
	}

	/**
	 * Groups resident tensors by the role their name states, so the report names each part rather than one total.
	 *
	 * @param tensors The tensors to group.
	 * @returns Each role and the tensors filling it.
	 */
	private static _groupByKind(tensors: PublishedTensor[]): Map<string, PublishedTensor[]> {
		const groups = new Map<string, PublishedTensor[]>();
		for (const tensor of tensors) {
			const kind = tensor.name
				.replace(/^model\.layers\.\d+\./, 'per layer · ')
				.replace(/\.weight$/, '')
				.replace(/^model\./, '');
			const existing = groups.get(kind);
			if (existing === undefined) {
				groups.set(kind, [tensor]);
			} else {
				existing.push(tensor);
			}
		}
		return groups;
	}

	/**
	 * Prints one line describing a group of tensors and its share of the model.
	 *
	 * @param title The group's name.
	 * @param tensors The tensors in the group.
	 * @param parameters The group's parameter count.
	 * @param totalParameters The whole model's parameter count.
	 * @returns Nothing.
	 */
	private static _printGroup(
		title: string,
		tensors: PublishedTensor[],
		parameters: number,
		totalParameters: number,
	): void {
		console.log(
			`  ${title.padEnd(28)} ${String(tensors.length).padStart(6)} tensors  ` +
				`${MeasureQwen3MoeResidency._billions(parameters).padStart(12)}  ` +
				`${((parameters / totalParameters) * 100).toFixed(1).padStart(5)}%  ` +
				`${MeasureQwen3MoeResidency._gigabytes(MeasureQwen3MoeResidency._quantizedBytes(parameters)).padStart(12)} at 4 bits`,
		);
	}

	/**
	 * Reports how many bytes a parameter count occupies at 4 bits, including the block scale factors.
	 *
	 * Block quantization is not free: at a block size of 32 with half-precision scales, 32 weights cost 16 bytes of
	 * packed values plus 2 bytes of scale, which is 4.5 bits per weight rather than 4.
	 *
	 * @param parameters The parameter count.
	 * @returns The byte size.
	 */
	private static _quantizedBytes(parameters: number): number {
		return parameters / 2 + (parameters / BLOCK_SIZE) * SCALE_BYTES;
	}

	/**
	 * Formats a parameter count in billions.
	 *
	 * @param count The parameter count.
	 * @returns The formatted text.
	 */
	private static _billions(count: number): string {
		return `${(count / 1e9).toFixed(2)} billion`;
	}

	/**
	 * Formats a parameter count in millions.
	 *
	 * @param count The parameter count.
	 * @returns The formatted text.
	 */
	private static _millions(count: number): string {
		return `${(count / 1e6).toFixed(2)} million`;
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
	 * Formats a byte count in kilobytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	private static _kilobytes(bytes: number): string {
		return `${(bytes / 1024).toFixed(2)} kilobytes`;
	}
}

await MeasureQwen3MoeResidency.main();
