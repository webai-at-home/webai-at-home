import * as OnnxRuntimeWeb from 'onnxruntime-web';
import type { ModelIndex } from './model_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OlmoeGenerator — the whole of OLMoE-1B-7B-0924, assembled from graphs and streamed experts
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The model loop of milestone 5 of https://github.com/webai-at-home/webai-at-home/issues/169.
 *
 * It knows nothing about where experts live. It asks for one by layer and number and is handed nine WebGPU buffers,
 * and whether those buffers were already full or were read off a disk a moment ago is the caller's business. That
 * seam is the entire point of this milestone: the two runs it is asked to do differ only on the other side of it.
 *
 * One token at a time throughout, including the prompt. Feeding a prompt in one pass would be faster and would need
 * a causal mask; decoding one token at a time needs no mask at all, since that token may attend to the whole history.
 * This is the milestone about correctness, so it takes the shape with fewer ways to be wrong. The graph still takes
 * the mask as an input, and `gate_olmoe_non_expert_graph.py` tests it with one.
 *
 * The same sequence of graphs was run outside the browser by `tools/gate_olmoe_whole_model.py`, which produced
 * `The capital of France is Paris.` from the same files. That is the control this loop is read against.
 */

/** The three projections one expert is made of, in the order a block holds them. */
const PROJECTION_NAMES = ['gate_proj', 'up_proj', 'down_proj'] as const;
/** How many parts one projection contributes to a block. */
const PARTS_FOR_EACH_PROJECTION = 3;
/** How many weights share one scale. This is what the conversion pipeline chose and what the expert graph declares. */
const QUANTIZATION_BLOCK_SIZE = 32;

/** One expert, wherever it happens to live. */
export type ResidentExpert = {
	/** The nine buffers, in the order the block holds its parts. */
	buffers: GPUBuffer[];
	/** Whether the expert was already in graphics memory rather than being read in for this lookup. */
	wasResident: boolean;
};

/** Whoever decides which experts are in graphics memory. */
export type ExpertResidency = {
	/**
	 * Makes one expert resident and hands back its buffers.
	 *
	 * @param layerIndex Which layer wants it.
	 * @param expertNumber Which expert of that layer.
	 * @returns The expert's nine buffers, and whether it was already there.
	 */
	acquire(layerIndex: number, expertNumber: number): Promise<ResidentExpert>;
};

/** How much of one expert's dimensions the graph needs stated for it. */
type ProjectionShape = {
	/** The length of the entering activation, which `MatMulNBits` calls K. */
	inputSize: number;
	/** The length of the leaving activation, which `MatMulNBits` calls N. */
	outputSize: number;
	/** How many quantized blocks one row is divided into. */
	blocksForEachRow: number;
	/** How many bytes one quantized block occupies. */
	blobSize: number;
};

/** Every graph of one OLMoE, and the loop that drives them. */
export class OlmoeGenerator {
	/** What was built, and what shape the model is. */
	private readonly _index: ModelIndex;
	/** One session for each decoder layer's non-expert half. */
	private readonly _layerSessions: OnnxRuntimeWeb.InferenceSession[];
	/** The final normalization and the language model head. */
	private readonly _headSession: OnnxRuntimeWeb.InferenceSession;
	/** One expert, with all nine of its weight tensors as runtime inputs. */
	private readonly _expertSession: OnnxRuntimeWeb.InferenceSession;
	/** The token embedding table, looked up rather than multiplied. */
	private readonly _embedding: Float32Array;
	/** The rotary frequencies, which depend only on the position and are the same for every layer. */
	private readonly _inverseFrequencies: Float32Array;
	/** The dimensions of each of the three projections, worked out once rather than for every expert run. */
	private readonly _projectionShapes: ProjectionShape[];

	/**
	 * Holds every already-created graph and the embedding table.
	 *
	 * @param index What `graphs.json` says.
	 * @param layerSessions One session for each decoder layer.
	 * @param headSession The final normalization and the language model head.
	 * @param expertSession One expert, with its weights as runtime inputs.
	 * @param embedding The token embedding table, of `vocabularySize * hiddenSize` values.
	 */
	constructor(
		index: ModelIndex,
		layerSessions: OnnxRuntimeWeb.InferenceSession[],
		headSession: OnnxRuntimeWeb.InferenceSession,
		expertSession: OnnxRuntimeWeb.InferenceSession,
		embedding: Float32Array,
	) {
		this._index = index;
		this._layerSessions = layerSessions;
		this._headSession = headSession;
		this._expertSession = expertSession;
		this._embedding = embedding;

		const half = index.headDimension / 2;
		this._inverseFrequencies = new Float32Array(half);
		for (let position = 0; position < half; position++) {
			this._inverseFrequencies[position] = 1 / Math.pow(index.rotaryTheta, (position * 2) / index.headDimension);
		}

		this._projectionShapes = PROJECTION_NAMES.map((name) => {
			const inputSize = name === 'down_proj' ? index.expertWidth : index.hiddenSize;
			const outputSize = name === 'down_proj' ? index.hiddenSize : index.expertWidth;
			return {
				inputSize: inputSize,
				outputSize: outputSize,
				blocksForEachRow: Math.ceil(inputSize / QUANTIZATION_BLOCK_SIZE),
				blobSize: (QUANTIZATION_BLOCK_SIZE * 4) / 8,
			};
		});
	}

	/**
	 * Generates greedily from a prompt, one token at a time.
	 *
	 * Greedy on purpose. This milestone requires two runs to produce identical tokens, and any sampling with a random
	 * number in it would make that a statement about the random number generator instead.
	 *
	 * @param promptTokenIds The prompt.
	 * @param newTokenCount How many tokens to generate after it.
	 * @param residency Who decides which experts are in graphics memory.
	 * @param report Called with each newly generated token id, so a run shows its working as it goes.
	 * @returns The prompt followed by what was generated, and what the run cost.
	 */
	async generate(
		promptTokenIds: number[],
		newTokenCount: number,
		residency: ExpertResidency,
		report: (tokenId: number) => void,
	): Promise<{ tokenIds: number[]; lookupCount: number; hitCount: number }> {
		const index = this._index;
		const emptyCache = (): OnnxRuntimeWeb.Tensor => {
			return new OnnxRuntimeWeb.Tensor('float32', new Float32Array(0), [
				1,
				index.headCount,
				0,
				index.headDimension,
			]);
		};
		const pastKeys: OnnxRuntimeWeb.Tensor[] = this._layerSessions.map(emptyCache);
		const pastValues: OnnxRuntimeWeb.Tensor[] = this._layerSessions.map(emptyCache);

		const produced = [...promptTokenIds];
		let lookupCount = 0;
		let hitCount = 0;

		for (let step = 0; step < promptTokenIds.length + newTokenCount - 1; step++) {
			let hidden = this._embed(produced[step]);
			const { cosine, sine } = this._rotary(step);
			// Every token may attend to the whole history, so the bias is zero everywhere. It is still fed, because
			// the graph declares it and because a graph whose mask is built in is a graph nobody can test.
			const bias = new OnnxRuntimeWeb.Tensor('float32', new Float32Array(step + 1), [1, 1, 1, step + 1]);

			for (let layerIndex = 0; layerIndex < this._layerSessions.length; layerIndex++) {
				const outputs = await this._layerSessions[layerIndex].run({
					hidden_state: new OnnxRuntimeWeb.Tensor('float32', hidden, [1, 1, index.hiddenSize]),
					past_key: pastKeys[layerIndex],
					past_value: pastValues[layerIndex],
					cos: cosine,
					sin: sine,
					attention_bias: bias,
				});
				pastKeys[layerIndex] = outputs.present_key;
				pastValues[layerIndex] = outputs.present_value;

				const residual = outputs.residual.data as Float32Array;
				const expertInput = outputs.expert_input.data as Float32Array;
				const chosen = this._route(outputs.router_logits.data as Float32Array);

				const total = new Float32Array(index.hiddenSize);
				for (const choice of chosen) {
					lookupCount++;
					const expert = await residency.acquire(layerIndex, choice.expertNumber);
					if (expert.wasResident === true) {
						hitCount++;
					}
					const contribution = await this._runExpert(expertInput, expert.buffers);
					for (let channel = 0; channel < total.length; channel++) {
						total[channel] += contribution[channel] * choice.weight;
					}
				}

				hidden = new Float32Array(index.hiddenSize);
				for (let channel = 0; channel < hidden.length; channel++) {
					hidden[channel] = residual[channel] + total[channel];
				}
			}

			if (step + 1 < promptTokenIds.length) {
				continue;
			}

			const logits = (await this._headSession.run({
				hidden_state: new OnnxRuntimeWeb.Tensor('float32', hidden, [1, 1, index.hiddenSize]),
			})).logits.data as Float32Array;
			const nextTokenId = this._argmax(logits);
			produced.push(nextTokenId);
			report(nextTokenId);
		}

		return {
			tokenIds: produced,
			lookupCount: lookupCount,
			hitCount: hitCount,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The pieces of one step
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Looks one token's row out of the embedding table.
	 *
	 * @param tokenId Which token.
	 * @returns A copy of its row, which the loop then owns and overwrites.
	 */
	private _embed(tokenId: number): Float32Array {
		const width = this._index.hiddenSize;
		return this._embedding.slice(tokenId * width, (tokenId + 1) * width);
	}

	/**
	 * Builds the cosine and sine tables for one position.
	 *
	 * @param position Which position in the sequence.
	 * @returns The two tables, each shaped for one token of one batch.
	 */
	private _rotary(position: number): { cosine: OnnxRuntimeWeb.Tensor; sine: OnnxRuntimeWeb.Tensor } {
		const width = this._index.headDimension;
		const cosine = new Float32Array(width);
		const sine = new Float32Array(width);
		for (let index = 0; index < this._inverseFrequencies.length; index++) {
			const angle = position * this._inverseFrequencies[index];
			cosine[index] = Math.cos(angle);
			sine[index] = Math.sin(angle);
			cosine[index + this._inverseFrequencies.length] = cosine[index];
			sine[index + this._inverseFrequencies.length] = sine[index];
		}
		return {
			cosine: new OnnxRuntimeWeb.Tensor('float32', cosine, [1, 1, 1, width]),
			sine: new OnnxRuntimeWeb.Tensor('float32', sine, [1, 1, 1, width]),
		};
	}

	/**
	 * Turns one token's router logits into the experts it chose and what weight each one carries.
	 *
	 * The softmax is over all 64 experts and is taken before the top-k, not after. The eight weights are then left
	 * exactly as they are: OLMoE sets `norm_topk_prob` to false, so they are raw probabilities that do not add up to
	 * one, and dividing them by their own sum — which many implementations do — multiplies every expert's
	 * contribution by about 2.64 while leaving the output looking entirely reasonable.
	 *
	 * The order is fixed by probability and then by expert number, so that the eight contributions are added in the
	 * same order every time. Two runs that added the same eight numbers in a different order would disagree in the
	 * last bit, and this milestone asks for identical tokens.
	 *
	 * @param logits One value for each expert of this layer.
	 * @returns The chosen experts, most probable first.
	 */
	private _route(logits: Float32Array): { expertNumber: number; weight: number }[] {
		let largest = Number.NEGATIVE_INFINITY;
		for (const value of logits) {
			largest = Math.max(largest, value);
		}
		let total = 0;
		const probabilities = new Float32Array(logits.length);
		for (let index = 0; index < logits.length; index++) {
			probabilities[index] = Math.exp(logits[index] - largest);
			total += probabilities[index];
		}

		const ordered: { expertNumber: number; weight: number }[] = [];
		for (let index = 0; index < probabilities.length; index++) {
			ordered.push({
				expertNumber: index,
				weight: probabilities[index] / total,
			});
		}
		ordered.sort((left, right) => {
			if (left.weight !== right.weight) {
				return right.weight - left.weight;
			}
			return left.expertNumber - right.expertNumber;
		});
		if (this._index.normalizeTopExpertWeights === true) {
			throw new Error('this checkpoint renormalises its routing weights, which this loop deliberately does not');
		}
		return ordered.slice(0, this._index.expertsForEachToken);
	}

	/**
	 * Runs one expert from nine buffers this page owns.
	 *
	 * @param expertInput What the layer graph produced for the experts to consume.
	 * @param buffers The expert's nine buffers, in the order the block holds its parts.
	 * @returns The expert's output, one value for each hidden channel.
	 */
	private async _runExpert(expertInput: Float32Array, buffers: GPUBuffer[]): Promise<Float32Array> {
		const feeds: Record<string, OnnxRuntimeWeb.Tensor> = {
			expert_input: new OnnxRuntimeWeb.Tensor('float32', expertInput, [1, 1, this._index.hiddenSize]),
		};
		for (let index = 0; index < PROJECTION_NAMES.length; index++) {
			const name = PROJECTION_NAMES[index];
			const shape = this._projectionShapes[index];
			const zeroPointsPart = this._index.expertBlocks.parts[index * PARTS_FOR_EACH_PROJECTION + 2];

			feeds[`${name}_quantized`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers[index * PARTS_FOR_EACH_PROJECTION],
				{
					dataType: 'uint8',
					dims: [shape.outputSize, shape.blocksForEachRow, shape.blobSize],
				},
			);
			feeds[`${name}_scales`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers[index * PARTS_FOR_EACH_PROJECTION + 1],
				{
					dataType: 'float16',
					dims: [shape.outputSize * shape.blocksForEachRow],
				},
			);
			feeds[`${name}_zero_points`] = OnnxRuntimeWeb.Tensor.fromGpuBuffer(
				buffers[index * PARTS_FOR_EACH_PROJECTION + 2],
				{
					dataType: 'uint8',
					dims: [zeroPointsPart.byteLength],
				},
			);
		}
		return (await this._expertSession.run(feeds)).expert_output.data as Float32Array;
	}

	/**
	 * Finds the highest logit, taking the lowest token id when two are exactly equal.
	 *
	 * @param logits One value for each token the model knows.
	 * @returns The chosen token id.
	 */
	private _argmax(logits: Float32Array): number {
		let bestIndex = 0;
		let bestValue = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < logits.length; index++) {
			if (logits[index] > bestValue) {
				bestValue = logits[index];
				bestIndex = index;
			}
		}
		return bestIndex;
	}
}
