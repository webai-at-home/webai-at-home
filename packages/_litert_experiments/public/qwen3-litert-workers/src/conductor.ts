import { RelayFrame, type FrameHeader } from './relay_frame.js';
import {
	CONDUCTOR_NAME,
	MODELS_PREFIX,
	Topology,
	WORKER_TOPOLOGY,
	type ExecutionRecord,
	type ReceiveRecord,
	type SendRecord,
} from './topology.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Qwen3LiteRtConductor — drives milestone four's generation across the worker pages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What PyTorch generated, which the pipeline's own tokens are compared against.
 */
type DecodeReference = {
	/** The prompt it was given. */
	prompt: string;
	/** The prompt's tokens. */
	promptTokens: number[];
	/** The tokens the decomposition generated. */
	generatedTokens: number[];
	/** Those tokens as text. */
	generatedText: string;
	/** The tokens the unsplit Hugging Face model generated. */
	unsplitTokens: number[];
	/** The index of the first generated token the two disagree on, or null when they agree throughout. */
	firstDivergence: number | null;
	/** Every step, of which this page uses only the count. */
	steps: { position: number }[];
};

/**
 * What one worker reported when it had loaded its graphs.
 */
type ReadyReport = {
	/** The graphs it holds. */
	graphs: string[];
	/** Whether every one of them compiled fully onto the graphics processor. */
	isFullyAccelerated: boolean;
	/** How many bytes of `.tflite` it loaded. */
	loadedBytes: number;
};

const outputElement = document.querySelector('#output') as HTMLPreElement;
const runButton = document.querySelector('#run') as HTMLButtonElement;

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
 * @returns Milliseconds since the epoch, with sub-millisecond resolution.
 */
function absoluteNow(): number {
	return performance.timeOrigin + performance.now();
}

/**
 * Formats a duration in milliseconds to three decimal places.
 *
 * @param milliseconds The duration.
 * @returns The duration, written out with its unit.
 */
function formatMilliseconds(milliseconds: number): string {
	return `${milliseconds.toFixed(3)} ms`;
}

/**
 * Sums a list of numbers.
 *
 * @param values The numbers.
 * @returns Their total.
 */
function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

/**
 * Fetches one row of the token embedding table with an HTTP range request.
 *
 * @param embeddingFile The raw embedding file's name.
 * @param token The token to look up.
 * @param hiddenSize The hidden size, which is the width of one row.
 * @returns That token's embedding row.
 */
async function fetchEmbeddingRow(
	embeddingFile: string,
	token: number,
	hiddenSize: number,
): Promise<Float32Array> {
	const rowBytes = hiddenSize * Float32Array.BYTES_PER_ELEMENT;
	const firstByte = token * rowBytes;
	const response = await fetch(`${MODELS_PREFIX}/${embeddingFile}`, {
		headers: {
			Range: `bytes=${firstByte}-${firstByte + rowBytes - 1}`,
		},
	});
	if (response.status !== 206) {
		throw new Error(`Expected a 206 Partial Content answer for the embedding row, got ${response.status}.`);
	}
	return new Float32Array(await response.arrayBuffer());
}

const connection = new WebSocket(`ws://${location.host}/relay?name=${CONDUCTOR_NAME}`);
connection.binaryType = 'arraybuffer';

const readyWorkers = new Map<string, ReadyReport>();
const executionRecords: ExecutionRecord[] = [];
const sendRecords: SendRecord[] = [];
const receiveRecords: ReceiveRecord[] = [];
const cacheBufferTypes = new Map<string, string>();

/**
 * The promise waiting on whatever frame the generation loop expects next.
 */
let pendingResolve: ((header: FrameHeader) => void) | undefined;

/**
 * How many workers still owe an answer to a broadcast.
 */
let pendingCount = 0;

/**
 * Encodes and sends one frame.
 *
 * @param header The header.
 * @param payload The values to carry, if any.
 * @returns How large the frame was and how long encoding took.
 */
function send(header: FrameHeader, payload?: Float32Array): { bytes: number; milliseconds: number } {
	const start = performance.now();
	const frame = RelayFrame.encode(
		{
			...header,
			sentAt: absoluteNow(),
		},
		payload,
	);
	const milliseconds = performance.now() - start;
	connection.send(frame);
	return {
		bytes: frame.byteLength,
		milliseconds,
	};
}

/**
 * Waits for the next frame the loop is expecting.
 *
 * @returns That frame's header.
 */
function waitForFrame(): Promise<FrameHeader> {
	return new Promise((resolve) => {
		pendingResolve = resolve;
	});
}

/**
 * Sends one frame to every worker and waits for all of them to answer.
 *
 * @param type What to send.
 * @returns Nothing.
 */
async function broadcastAndWait(type: 'reset' | 'collect'): Promise<void> {
	pendingCount = WORKER_TOPOLOGY.length;
	const finished = new Promise<void>((resolve) => {
		pendingResolve = () => {
			pendingCount -= 1;
			if (pendingCount === 0) {
				resolve();
			}
		};
	});
	for (const worker of WORKER_TOPOLOGY) {
		send({
			to: worker.name,
			from: CONDUCTOR_NAME,
			type,
		});
	}
	await finished;
}

connection.addEventListener('message', (event) => {
	const { header } = RelayFrame.decode(event.data as ArrayBuffer);

	if (header.type === 'ready') {
		readyWorkers.set(header.from, {
			graphs: header.graphs as string[],
			isFullyAccelerated: header.isFullyAccelerated as boolean,
			loadedBytes: header.loadedBytes as number,
		});
		report(
			`${header.from} is ready: ${(header.graphs as string[]).join(', ')}, ` +
				`${((header.loadedBytes as number) / 1e6).toFixed(1)} MB, ` +
				`isFullyAccelerated=${header.isFullyAccelerated}`,
		);
		if (readyWorkers.size === WORKER_TOPOLOGY.length) {
			report(`\nall ${WORKER_TOPOLOGY.length} workers are ready.`);
			runButton.disabled = false;
		}
		return;
	}

	if (header.type === 'records') {
		executionRecords.push(...(header.executionRecords as ExecutionRecord[]));
		sendRecords.push(...(header.sendRecords as SendRecord[]));
		receiveRecords.push(...(header.receiveRecords as ReceiveRecord[]));
		for (const [shardName, bufferType] of Object.entries(
			header.cacheBufferTypes as Record<string, string>,
		)) {
			cacheBufferTypes.set(shardName, bufferType);
		}
	}

	pendingResolve?.(header);
});

connection.addEventListener('open', () => {
	outputElement.textContent = '';
	report(`connected to the relay as ${CONDUCTOR_NAME}`);
	report(`waiting for ${WORKER_TOPOLOGY.length} workers: ${Topology.names().join(', ')}`);
	report('open one page per worker from the links above, then come back here.\n');
	// Any worker already loaded announced itself before this page connected, and the relay forwards rather
	// than queues, so those announcements are gone. Asking again costs nothing and makes the order the pages
	// are opened in stop mattering.
	for (const worker of WORKER_TOPOLOGY) {
		send({
			to: worker.name,
			from: CONDUCTOR_NAME,
			type: 'hello',
		});
	}
});

/**
 * Reports what every graph execution and every relay frame cost.
 *
 * @param positionCount How many positions were decoded.
 * @param generatedCount How many tokens were generated.
 * @returns Nothing.
 */
function reportMeasurements(positionCount: number, generatedCount: number): void {
	report('\n=== measurement records, one per graph execution ===');
	report('  shard  graph            worker                position  in     out     inference   readback');
	const byShard = new Map<number, ExecutionRecord[]>();
	for (const record of executionRecords) {
		byShard.set(record.shardIndex, [...(byShard.get(record.shardIndex) ?? []), record]);
	}
	for (const shardIndex of [...byShard.keys()].sort((first, second) => first - second)) {
		const records = byShard.get(shardIndex) as ExecutionRecord[];
		const first = records[0];
		report(
			`  ${String(shardIndex).padStart(5)}  ${first.shardName.padEnd(16)} ${first.workerName.padEnd(21)} ` +
				`${String(records.length).padStart(8)}  ${String(first.inputBytes).padStart(5)}  ` +
				`${String(first.outputBytes).padStart(6)}  ` +
				`${(sum(records.map((record) => record.inferenceMilliseconds)) / records.length).toFixed(3).padStart(9)}  ` +
				`${(sum(records.map((record) => record.readbackMilliseconds)) / records.length).toFixed(3).padStart(9)}`,
		);
	}
	report('  (position is how many executions that graph ran; inference and readback are the mean of them)');

	const totalInference = sum(executionRecords.map((record) => record.inferenceMilliseconds));
	const totalReadback = sum(executionRecords.map((record) => record.readbackMilliseconds));
	report(
		`\n  every graph, every position: inference ${formatMilliseconds(totalInference)}, ` +
			`readback ${formatMilliseconds(totalReadback)}`,
	);
	report(
		`  per generated token: inference ${formatMilliseconds(totalInference / generatedCount)}, ` +
			`readback ${formatMilliseconds(totalReadback / generatedCount)}`,
	);

	report('\n=== the relay, one row per hop ===');
	report('  from                  to                    frames  bytes each  serialize   deserialize  relay');
	const hops = new Map<string, { sends: SendRecord[]; receives: ReceiveRecord[] }>();
	for (const record of sendRecords) {
		const key = `${record.fromWorker} -> ${record.toWorker}`;
		const hop = hops.get(key) ?? {
			sends: [],
			receives: [],
		};
		hop.sends.push(record);
		hops.set(key, hop);
	}
	for (const record of receiveRecords) {
		const key = `${record.fromWorker} -> ${record.toWorker}`;
		const hop = hops.get(key) ?? {
			sends: [],
			receives: [],
		};
		hop.receives.push(record);
		hops.set(key, hop);
	}
	let totalRelayBytes = 0;
	for (const [key, hop] of hops) {
		const [fromWorker, toWorker] = key.split(' -> ');
		const bytes = hop.sends[0]?.frameBytes ?? hop.receives[0]?.frameBytes ?? 0;
		totalRelayBytes += sum(hop.sends.map((record) => record.frameBytes));
		const serialize =
			hop.sends.length === 0
				? Number.NaN
				: sum(hop.sends.map((record) => record.serializeMilliseconds)) / hop.sends.length;
		const deserialize =
			hop.receives.length === 0
				? Number.NaN
				: sum(hop.receives.map((record) => record.deserializeMilliseconds)) / hop.receives.length;
		const relay =
			hop.receives.length === 0
				? Number.NaN
				: sum(hop.receives.map((record) => record.relayMilliseconds)) / hop.receives.length;
		report(
			`  ${fromWorker.padEnd(21)} ${toWorker.padEnd(21)} ` +
				`${String(Math.max(hop.sends.length, hop.receives.length)).padStart(6)}  ` +
				`${String(bytes).padStart(10)}  ${serialize.toFixed(4).padStart(9)}  ` +
				`${deserialize.toFixed(4).padStart(11)}  ${relay.toFixed(3).padStart(6)}`,
		);
	}
	report(
		`\n  ${totalRelayBytes} bytes crossed the relay over ${positionCount} positions, ` +
			`${(totalRelayBytes / generatedCount).toFixed(0)} bytes per generated token`,
	);
	report('  (the conductor\'s own hop is missing a deserialize and relay time: it is the sender, not a worker)');
}

/**
 * Runs the whole generation.
 *
 * @returns Nothing.
 */
async function main(): Promise<void> {
	runButton.disabled = true;
	outputElement.textContent = '';
	// Each worker empties its own records when it is told to reset. This page has to empty its copies too, or
	// a second generation reports the first one's executions alongside its own.
	executionRecords.length = 0;
	sendRecords.length = 0;
	receiveRecords.length = 0;
	cacheBufferTypes.clear();
	report(`workers: ${[...readyWorkers.keys()].join(', ')}`);

	const index = await Topology.readIndex();
	const reference = (await (
		await fetch(`${MODELS_PREFIX}/decode_reference.json`)
	).json()) as DecodeReference;
	report(`${index.model}, attention layout ${index.attentionLayout ?? 'unknown'}`);
	report(`prompt ${JSON.stringify(reference.prompt)}, ${reference.promptTokens.length} tokens`);
	report(`${reference.steps.length} positions, ${reference.generatedTokens.length} tokens to generate`);

	report('\nzeroing every key/value cache...');
	await broadcastAndWait('reset');
	report('every worker has zeroed its caches.');

	// Real generation: the conductor knows the prompt and nothing else. Every token after the prompt is the
	// token the pipeline itself produced, not one taken from the reference. Feeding the reference's tokens
	// back in would be teacher forcing, and would hide exactly the drift this milestone is looking for.
	const generatedTokens: number[] = [];
	const perTokenMilliseconds: number[] = [];
	const firstWorker = WORKER_TOPOLOGY[0].name;
	let embeddingMilliseconds = 0;
	report(`\ngenerating, one position at a time, starting at ${firstWorker}...`);

	const generationStart = performance.now();
	for (let position = 0; position < reference.steps.length; position += 1) {
		const inputToken =
			position < reference.promptTokens.length
				? reference.promptTokens[position]
				: generatedTokens[position - reference.promptTokens.length];

		const embeddingStart = performance.now();
		const embeddingRow = await fetchEmbeddingRow(index.embeddingFile, inputToken, index.hiddenSize);
		embeddingMilliseconds += performance.now() - embeddingStart;

		const positionStart = performance.now();
		const answer = waitForFrame();
		const sent = send(
			{
				to: firstWorker,
				from: CONDUCTOR_NAME,
				type: 'hidden',
				position,
			},
			embeddingRow,
		);
		sendRecords.push({
			fromWorker: CONDUCTOR_NAME,
			toWorker: firstWorker,
			position,
			frameBytes: sent.bytes,
			serializeMilliseconds: sent.milliseconds,
		});

		const header = await answer;
		if (header.type !== 'token') {
			throw new Error(`Expected a token at position ${position}, got ${header.type}.`);
		}
		perTokenMilliseconds.push(performance.now() - positionStart);

		if (position >= reference.promptTokens.length - 1) {
			generatedTokens.push(header.token as number);
		}
	}
	const generationMilliseconds = performance.now() - generationStart;

	report(`generated ${generatedTokens.length} tokens in ${formatMilliseconds(generationMilliseconds)}`);
	report(
		`  ${formatMilliseconds(generationMilliseconds / generatedTokens.length)} per token, ` +
			`${((generatedTokens.length / generationMilliseconds) * 1000).toFixed(2)} tokens per second`,
	);
	report(`  of which fetching embedding rows: ${formatMilliseconds(embeddingMilliseconds)}`);

	report('\n=== the tokens ===');
	report(`  pipeline:  ${JSON.stringify(generatedTokens)}`);
	report(`  PyTorch:   ${JSON.stringify(reference.generatedTokens)}`);
	let firstDifference = -1;
	for (let index_ = 0; index_ < reference.generatedTokens.length; index_ += 1) {
		if (generatedTokens[index_] !== reference.generatedTokens[index_]) {
			firstDifference = index_;
			break;
		}
	}
	const isIdentical = firstDifference === -1 && generatedTokens.length === reference.generatedTokens.length;
	report(`  PyTorch's text: ${JSON.stringify(reference.generatedText)}`);
	report(
		`  the two agree on every generated token: ${isIdentical}` +
			(firstDifference === -1 ? '' : ` (they first differ at generated token ${firstDifference})`),
	);
	report(
		`  PyTorch's decomposition and the unsplit model also agree with each other: ` +
			`${reference.firstDivergence === null}`,
	);

	report('\ncollecting the measurement records from every worker...');
	await broadcastAndWait('collect');
	reportMeasurements(reference.steps.length, generatedTokens.length);

	report('\n=== where every key/value cache ended up, after the last position ===');
	let everyCacheStayedOnTheGraphicsProcessor = cacheBufferTypes.size > 0;
	for (const [shardName, bufferType] of cacheBufferTypes) {
		report(`  ${shardName.padEnd(16)} ${bufferType}`);
		if (bufferType.startsWith('WEB_GPU') === false) {
			everyCacheStayedOnTheGraphicsProcessor = false;
		}
	}
	report(
		`  every cache is still in a WebGPU buffer, so none of them was read into JavaScript: ` +
			`${everyCacheStayedOnTheGraphicsProcessor}`,
	);

	report(`\n=== verdict ===`);
	report(`  ${WORKER_TOPOLOGY.length} browser pages, each holding its own shards and its own key/value caches`);
	report(`  only the hidden state crossed the relay between them`);
	report(`  the tokens match PyTorch: ${isIdentical}`);
	report(`  every key/value cache stayed on the graphics processor: ${everyCacheStayedOnTheGraphicsProcessor}`);
	report(`  MILESTONE FOUR CORRECT=${isIdentical && everyCacheStayedOnTheGraphicsProcessor}`);
	report('\nDone.');
	runButton.disabled = false;
}

runButton.addEventListener('click', () => {
	main().catch((error) => {
		report(`\nFAILED: ${error?.stack ?? error}`);
		runButton.disabled = false;
	});
});
