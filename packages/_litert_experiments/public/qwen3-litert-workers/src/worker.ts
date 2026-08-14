import { Tensor, TensorBufferType, loadAndCompile, loadLiteRt, type CompiledModel } from '@litertjs/core';
import { RelayFrame, type FrameHeader } from './relay_frame.js';
import {
	CONDUCTOR_NAME,
	MODELS_PREFIX,
	Topology,
	type ExecutionRecord,
	type GraphReference,
	type ReceiveRecord,
	type SendRecord,
} from './topology.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Qwen3LiteRtWorker — one browser page holding its own shards and its own caches
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One loaded graph, with everything needed to run it and the cache it owns.
 */
type LoadedGraph = {
	/** The graph's name. */
	name: string;
	/** Where it sits in the whole pipeline. */
	shardIndex: number;
	/** The compiled graph. */
	model: CompiledModel;
	/** Its shapes. */
	reference: GraphReference;
	/**
	 * Its key/value cache, which stays on the graphics processor between positions and is never read into
	 * JavaScript. This is the property milestone four exists to demonstrate. A head chunk owns none.
	 */
	cache: Tensor | undefined;
};

const outputElement = document.querySelector('#output') as HTMLPreElement;
const searchParameters = new URLSearchParams(location.search);
const workerName = searchParameters.get('worker') ?? '';

/**
 * Writes one line to the page and to the browser console.
 *
 * @param line The line to write.
 * @returns Nothing.
 */
function report(line: string): void {
	outputElement.textContent += `${line}\n`;
	console.log(line);
}

/**
 * An absolute high-resolution timestamp, comparable between browser pages on this machine.
 *
 * `performance.now()` counts from each page's own start, so two pages cannot be compared with it. Adding
 * `performance.timeOrigin` gives an absolute time that keeps the sub-millisecond resolution `Date.now()`
 * throws away.
 *
 * @returns Milliseconds since the epoch, with sub-millisecond resolution.
 */
function absoluteNow(): number {
	return performance.timeOrigin + performance.now();
}

/**
 * Builds the rotary cosine and sine table for one position, matching the export script's `rotary_tables`.
 *
 * @param position The token position.
 * @param headDimension The head dimension.
 * @param ropeTheta The rotary base.
 * @returns The cosine and the sine, each with `headDimension` elements.
 */
function rotaryTables(position: number, headDimension: number, ropeTheta: number): [Float32Array, Float32Array] {
	const half = headDimension / 2;
	const cosine = new Float32Array(headDimension);
	const sine = new Float32Array(headDimension);
	for (let index = 0; index < half; index += 1) {
		const angle = position / ropeTheta ** ((2 * index) / headDimension);
		cosine[index] = Math.cos(angle);
		cosine[index + half] = Math.cos(angle);
		sine[index] = Math.sin(angle);
		sine[index + half] = Math.sin(angle);
	}
	return [cosine, sine];
}

/**
 * Builds the cache write mask and the attention mask for one position.
 *
 * @param position The token position being decoded.
 * @param cachePositions How many positions the cache holds.
 * @returns The one-hot write mask, and the attention mask that admits positions up to this one.
 */
function decodeMasks(position: number, cachePositions: number): [Float32Array, Float32Array] {
	const writeMask = new Float32Array(cachePositions);
	writeMask[position] = 1;
	const attentionMask = new Float32Array(cachePositions).fill(-Infinity);
	for (let admitted = 0; admitted <= position; admitted += 1) {
		attentionMask[admitted] = 0;
	}
	return [writeMask, attentionMask];
}

/**
 * Runs the whole page: load the graphs this worker owns, then answer frames until the page is closed.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	const description = Topology.describe(workerName);
	const isLastInPipeline = description.next === CONDUCTOR_NAME;
	document.title = `${workerName} — milestone four of issue #179`;
	(document.querySelector('#name') as HTMLElement).textContent = workerName;
	report(`worker ${workerName}`);
	report(`graphs: ${description.graphs.join(', ')}`);
	report(`sends its result on to: ${description.next}`);

	const adapter = await navigator.gpu?.requestAdapter();
	if (adapter !== undefined && adapter !== null) {
		const { vendor, architecture } = adapter.info;
		report(`WebGPU adapter info: vendor=${vendor} architecture=${architecture}`);
	}

	await loadLiteRt('/wasm/litert_wasm_jspi_internal.js');
	const index = await Topology.readIndex();
	report(`${index.model}, attention layout ${index.attentionLayout ?? 'unknown'}`);

	const graphs: LoadedGraph[] = [];
	let loadedBytes = 0;
	for (const name of description.graphs) {
		const reference = await Topology.readGraphReference(name);
		const modelBytes = new Uint8Array(
			await (await fetch(`${MODELS_PREFIX}/qwen3_0_6b_${name}.tflite`)).arrayBuffer(),
		);
		const compileStart = performance.now();
		const model = await loadAndCompile(modelBytes, {
			accelerator: 'webgpu',
		});
		loadedBytes += modelBytes.byteLength;
		report(
			`  ${name}: loadAndCompile ${(performance.now() - compileStart).toFixed(1)} ms, ` +
				`isFullyAccelerated=${model.isFullyAccelerated}, ${(modelBytes.byteLength / 1e6).toFixed(1)} MB`,
		);
		graphs.push({
			name,
			shardIndex: Topology.shardIndex(name),
			model,
			reference,
			cache: undefined,
		});
	}
	report(`loaded ${graphs.length} graphs, ${(loadedBytes / 1e6).toFixed(1)} MB in total`);

	const executionRecords: ExecutionRecord[] = [];
	const sendRecords: SendRecord[] = [];
	const receiveRecords: ReceiveRecord[] = [];

	const connection = new WebSocket(`ws://${location.host}/relay?name=${encodeURIComponent(workerName)}`);
	connection.binaryType = 'arraybuffer';

	/**
	 * Encodes one frame, records what that cost, and sends it.
	 *
	 * @param header The header.
	 * @param payload The values to carry, if any.
	 * @returns Nothing.
	 */
	function send(header: FrameHeader, payload?: Float32Array): void {
		const start = performance.now();
		const frame = RelayFrame.encode(
			{
				...header,
				sentAt: absoluteNow(),
			},
			payload,
		);
		const serializeMilliseconds = performance.now() - start;
		connection.send(frame);
		if (header.type === 'hidden' || header.type === 'token') {
			sendRecords.push({
				fromWorker: workerName,
				toWorker: header.to,
				position: header.position as number,
				frameBytes: frame.byteLength,
				serializeMilliseconds,
			});
		}
	}

	/**
	 * Runs every graph this worker owns for one position, and passes the result on.
	 *
	 * @param position The token position.
	 * @param incomingHidden The hidden state that arrived.
	 * @returns Nothing.
	 */
	async function decodeOnePosition(position: number, incomingHidden: Float32Array): Promise<void> {
		let hidden = incomingHidden;
		const [cosine, sine] = rotaryTables(position, index.headDimension, index.ropeTheta);
		const [writeMask, attentionMask] = decodeMasks(position, index.cachePositions);
		const logits = isLastInPipeline ? new Float32Array(index.vocabularySize) : undefined;

		for (const graph of graphs) {
			const hiddenTensor = new Tensor(hidden, [1, 1, index.hiddenSize]);
			const extraTensors: Tensor[] = [];
			const inputs: Tensor[] = [hiddenTensor];

			if (graph.reference.kind === 'decoder') {
				const cosineTensor = new Tensor(cosine, [1, 1, 1, index.headDimension]);
				const sineTensor = new Tensor(sine, [1, 1, 1, index.headDimension]);
				const writeMaskTensor = new Tensor(writeMask, [1, index.cachePositions, 1]);
				const attentionMaskTensor = new Tensor(attentionMask, [1, 1, 1, index.cachePositions]);
				extraTensors.push(cosineTensor, sineTensor, writeMaskTensor, attentionMaskTensor);
				inputs.push(
					graph.cache as Tensor,
					cosineTensor,
					sineTensor,
					writeMaskTensor,
					attentionMaskTensor,
				);
			}

			const inputBytes = hidden.byteLength;
			const runStart = performance.now();
			const outputs = (await graph.model.run(inputs)) as Tensor[];
			const readbackStart = performance.now();
			const produced = (await outputs[0].data()) as Float32Array;
			const readbackEnd = performance.now();

			if (graph.reference.kind === 'decoder') {
				// The cache that came out becomes the cache that goes in, and is never read into JavaScript.
				graph.cache?.delete();
				graph.cache = outputs[1];
				hidden = produced;
			} else {
				(logits as Float32Array).set(produced, graph.reference.firstToken as number);
			}
			outputs[0].delete();

			executionRecords.push({
				workerName,
				shardName: graph.name,
				shardIndex: graph.shardIndex,
				mode: 'decode',
				position,
				inputBytes,
				outputBytes: produced.byteLength,
				inferenceMilliseconds: readbackStart - runStart,
				readbackMilliseconds: readbackEnd - readbackStart,
			});

			hiddenTensor.delete();
			for (const tensor of extraTensors) {
				tensor.delete();
			}
		}

		if (isLastInPipeline) {
			// Choosing the token here rather than at the conductor is what keeps 151936 logits — 608 kilobytes
			// per generated token — off the relay entirely.
			const allLogits = logits as Float32Array;
			let argmaxToken = 0;
			let argmaxValue = -Infinity;
			for (let token = 0; token < allLogits.length; token += 1) {
				if (allLogits[token] > argmaxValue) {
					argmaxValue = allLogits[token];
					argmaxToken = token;
				}
			}
			send({
				to: CONDUCTOR_NAME,
				from: workerName,
				type: 'token',
				position,
				token: argmaxToken,
				logitsFirstValues: [...allLogits.subarray(0, 8)],
			});
			return;
		}

		send(
			{
				to: description.next,
				from: workerName,
				type: 'hidden',
				position,
			},
			hidden,
		);
	}

	/**
	 * Tells the conductor this worker is loaded and which graphs it holds.
	 *
	 * @returns Nothing.
	 */
	function announce(): void {
		send({
			to: CONDUCTOR_NAME,
			from: workerName,
			type: 'ready',
			graphs: description.graphs,
			isFullyAccelerated: graphs.every((graph) => graph.model.isFullyAccelerated),
			loadedBytes,
		});
	}

	connection.addEventListener('open', () => {
		report('connected to the relay');
		announce();
	});

	connection.addEventListener('message', async (event) => {
		const arrivedAt = absoluteNow();
		const frame = event.data as ArrayBuffer;
		const deserializeStart = performance.now();
		const { header, payload } = RelayFrame.decode(frame);
		const deserializeMilliseconds = performance.now() - deserializeStart;

		if (header.type === 'hello') {
			announce();
			return;
		}

		if (header.type === 'reset') {
			for (const graph of graphs) {
				graph.cache?.delete();
				graph.cache = undefined;
				if (graph.reference.kind === 'decoder') {
					graph.cache = new Tensor(
						new Float32Array(graph.reference.cacheElementCount as number),
						graph.reference.cacheShape as number[],
					);
				}
			}
			executionRecords.length = 0;
			sendRecords.length = 0;
			receiveRecords.length = 0;
			report('caches zeroed');
			send({
				to: CONDUCTOR_NAME,
				from: workerName,
				type: 'reset-done',
			});
			return;
		}

		if (header.type === 'collect') {
			// Where each key/value cache ended up is the evidence for the claim this milestone makes. A cache
			// still in a `WEB_GPU_BUFFER` never came back to JavaScript across the whole generation.
			const cacheBufferTypes: Record<string, string> = {};
			for (const graph of graphs) {
				if (graph.cache !== undefined) {
					const bufferType = graph.cache.getBufferType();
					cacheBufferTypes[graph.name] =
						Object.entries(TensorBufferType).find(([, value]) => value === bufferType)?.[0] ??
						String(bufferType);
				}
			}
			send({
				to: CONDUCTOR_NAME,
				from: workerName,
				type: 'records',
				executionRecords,
				sendRecords,
				receiveRecords,
				cacheBufferTypes,
			});
			report(`sent ${executionRecords.length} execution records`);
			return;
		}

		if (header.type !== 'hidden') {
			return;
		}

		receiveRecords.push({
			fromWorker: header.from,
			toWorker: workerName,
			position: header.position as number,
			frameBytes: frame.byteLength,
			deserializeMilliseconds,
			relayMilliseconds: arrivedAt - (header.sentAt as number),
		});

		await decodeOnePosition(header.position as number, payload);
	});

	connection.addEventListener('close', () => {
		report('the relay connection closed');
	});
}

main().catch((error) => {
	report(`\nFAILED: ${error?.stack ?? error}`);
});
