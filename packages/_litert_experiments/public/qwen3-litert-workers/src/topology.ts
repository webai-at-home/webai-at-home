///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Topology — which browser page holds which graphs, and who it sends to next
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One browser page in the pipeline.
 */
export type WorkerDescription = {
	/** The name this page registers with the relay under, and the name others address it by. */
	name: string;
	/** The graphs this page loads and runs, in the order it runs them. */
	graphs: string[];
	/** The name this page sends its result on to. */
	next: string;
};

/**
 * Where the shards, the embedding table, and the references live.
 *
 * They are the generated artifacts of `qwen3-litert-shards`, read by path and not by import, so no code is
 * shared between the two experiments.
 */
export const MODELS_PREFIX = '/qwen3-litert-shards/models';

/**
 * The name the page that drives the generation registers under.
 */
export const CONDUCTOR_NAME = 'conductor';

/**
 * The four worker pages, in pipeline order.
 *
 * Ten graphs across four pages rather than ten pages across ten, for one reason only: `loadAndCompile()`
 * needs one contiguous WebAssembly allocation the size of the whole file, and a page holding more than about
 * three decoder shards cannot find one. Grouping is a limit of this one machine, not the architecture. Each
 * graph still keeps its own key/value cache and still reads its input back as an ordinary `Float32Array`, so
 * a grouped page behaves exactly as separate pages would, only without the relay hop between them.
 */
export const WORKER_TOPOLOGY: WorkerDescription[] = [
	{
		name: 'decoder_worker_00-11',
		graphs: ['decoder_00-03', 'decoder_04-07', 'decoder_08-11'],
		next: 'decoder_worker_12-19',
	},
	{
		name: 'decoder_worker_12-19',
		graphs: ['decoder_12-15', 'decoder_16-19'],
		next: 'decoder_worker_20-27',
	},
	{
		name: 'decoder_worker_20-27',
		graphs: ['decoder_20-23', 'decoder_24-27'],
		next: 'head_worker',
	},
	{
		name: 'head_worker',
		graphs: ['head_0', 'head_1', 'head_2'],
		next: CONDUCTOR_NAME,
	},
];

/**
 * What the export wrote, as `index.json` describes it.
 */
export type ShardIndex = {
	/** The model that was split. */
	model: string;
	/** Which attention layout the graphs were exported with. */
	attentionLayout?: string;
	/** How many positions every cache holds. */
	cachePositions: number;
	/** The hidden size. */
	hiddenSize: number;
	/** The head dimension. */
	headDimension: number;
	/** The rotary base. */
	ropeTheta: number;
	/** How many tokens the vocabulary holds. */
	vocabularySize: number;
	/** The raw token embedding table. */
	embeddingFile: string;
	/** The decoder shards, in the order they run. */
	decoderShards: string[];
	/** The language-model head chunks, in vocabulary order. */
	headChunks: string[];
};

/**
 * One graph's own reference file, of which this experiment needs only the shapes.
 */
export type GraphReference = {
	/** `decoder` or `head`. */
	kind: 'decoder' | 'head';
	/** The shape of this graph's key/value cache, for a decoder shard. */
	cacheShape?: number[];
	/** How many elements that cache holds. */
	cacheElementCount?: number;
	/** The first vocabulary token this chunk covers, for a head chunk. */
	firstToken?: number;
	/** The last vocabulary token this chunk covers, for a head chunk. */
	lastToken?: number;
	/** The size of the generated `.tflite` file, in bytes. */
	fileBytes: number;
};

/**
 * One graph execution, which is the measurement record section 24 of issue #178 asks for.
 */
export type ExecutionRecord = {
	/** The page that ran it. */
	workerName: string;
	/** The graph that ran. */
	shardName: string;
	/** Where that graph sits in the whole pipeline, counting decoder shards then head chunks. */
	shardIndex: number;
	/** `decode` throughout; prefill is milestone five. */
	mode: string;
	/** The token position. */
	position: number;
	/** Bytes of tensor going in, not counting the key/value cache, which never moves. */
	inputBytes: number;
	/** Bytes of tensor coming out. */
	outputBytes: number;
	/** Milliseconds inside `model.run()`. */
	inferenceMilliseconds: number;
	/** Milliseconds reading the output back into JavaScript. */
	readbackMilliseconds: number;
};

/**
 * One frame leaving a page, measured by the page that sent it.
 *
 * Sending and receiving are recorded separately, each by the page that did it, because the time it took to
 * encode a frame cannot be written inside that same frame. The conductor joins the two afterwards.
 */
export type SendRecord = {
	/** The page that sent it. */
	fromWorker: string;
	/** The page it was addressed to. */
	toWorker: string;
	/** The token position. */
	position: number;
	/** The whole frame, header and payload together. */
	frameBytes: number;
	/** Milliseconds turning the values into a frame. */
	serializeMilliseconds: number;
};

/**
 * One frame arriving at a page, measured by the page that received it.
 */
export type ReceiveRecord = {
	/** The page that sent it. */
	fromWorker: string;
	/** The page that received it. */
	toWorker: string;
	/** The token position. */
	position: number;
	/** The whole frame, header and payload together. */
	frameBytes: number;
	/** Milliseconds turning the frame back into values. */
	deserializeMilliseconds: number;
	/** Milliseconds from the send to the arrival, across the relay. */
	relayMilliseconds: number;
};

/**
 * Reads the shared description of the split, and one graph's shapes.
 */
export class Topology {
	/**
	 * Finds one worker's description by name.
	 *
	 * @param name The worker's name.
	 * @returns Its description.
	 */
	static describe(name: string): WorkerDescription {
		const description = WORKER_TOPOLOGY.find((worker) => worker.name === name);
		if (description === undefined) {
			throw new Error(`No worker is called ${name}. The names are ${Topology.names().join(', ')}.`);
		}
		return description;
	}

	/**
	 * Names every worker, in pipeline order.
	 *
	 * @returns The names.
	 */
	static names(): string[] {
		return WORKER_TOPOLOGY.map((worker) => worker.name);
	}

	/**
	 * Where one graph sits in the whole pipeline.
	 *
	 * @param shardName The graph's name.
	 * @returns Its index, counting decoder shards first and then head chunks.
	 */
	static shardIndex(shardName: string): number {
		let index = 0;
		for (const worker of WORKER_TOPOLOGY) {
			for (const graph of worker.graphs) {
				if (graph === shardName) {
					return index;
				}
				index += 1;
			}
		}
		return -1;
	}

	/**
	 * Reads `index.json`.
	 *
	 * @returns What the export wrote.
	 */
	static async readIndex(): Promise<ShardIndex> {
		return (await (await fetch(`${MODELS_PREFIX}/index.json`)).json()) as ShardIndex;
	}

	/**
	 * Reads one graph's reference file.
	 *
	 * @param shardName The graph's name.
	 * @returns Its shapes.
	 */
	static async readGraphReference(shardName: string): Promise<GraphReference> {
		return (await (
			await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${shardName}.reference.json`)
		).json()) as GraphReference;
	}
}
