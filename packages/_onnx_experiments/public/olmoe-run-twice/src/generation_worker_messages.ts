import type { ModelIndex, RunOutcome } from './model_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Generation worker messages — everything the page and the worker say to each other
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The page owns the tokenizer and the printing; the worker owns the file handle, the WebGPU device, every graph, and
 * the model loop. So the page sends text-free requests holding token ids, and the worker answers with token ids and
 * counters. Nothing crosses this boundary during a step, which matters because milestone 2 measured that moving an
 * expert costs a copy on whichever thread does the moving.
 */

/** What the page asks the worker to do. */
export type GenerationRequest =
	| {
		/** Open the block store and say how much of it is already on disk. */
		kind: 'open-store';
		/** Where `graphs.json` lives. */
		graphsUrl: string;
	}
	| {
		/** Download whatever blocks are missing. */
		kind: 'fill-store';
		/** Where the expert block file lives. */
		blocksUrl: string;
	}
	| {
		/** Create the WebGPU device and every graph. */
		kind: 'load-graphs';
	}
	| {
		/** Generate once, with a cache of the given size. */
		kind: 'run';
		/** What to call this run when reporting it. */
		label: string;
		/** How many experts the cache may hold at once. */
		slotCount: number;
		/** Whether to read every expert of the model into the cache before generating. */
		preloadEveryExpert: boolean;
		/** The prompt, already tokenized by the page. */
		promptTokenIds: number[];
		/** How many tokens to generate after the prompt. */
		newTokenCount: number;
	};

/** What the worker says back. */
export type GenerationResponse =
	| {
		/** The store is open. */
		kind: 'store-opened';
		/** What `graphs.json` said. */
		index: ModelIndex;
		/** How many blocks are already on disk. */
		presentBlockCount: number;
		/** How many blocks the model has in total. */
		wantedBlockCount: number;
	}
	| {
		/** Some more of the store has been filled. */
		kind: 'fill-progress';
		/** How many blocks are on disk now. */
		presentBlockCount: number;
		/** How many are wanted. */
		wantedBlockCount: number;
		/** How fast the download is going. */
		bytesEachSecond: number;
	}
	| {
		/** Every wanted block is on disk. */
		kind: 'store-filled';
		/** How long it took, in seconds. */
		seconds: number;
		/** How many bytes were downloaded, which is zero when nothing was missing. */
		downloadedByteLength: number;
	}
	| {
		/** Every graph is loaded. */
		kind: 'graphs-loaded';
		/** How long loading took, in seconds. */
		seconds: number;
		/** How many bytes of graph were read. */
		byteLength: number;
		/** The largest buffer the device the runtime chose will allow. */
		maximumBufferByteLength: number;
	}
	| {
		/** One more token has been generated. */
		kind: 'token';
		/** Which run produced it. */
		label: string;
		/** The token id. */
		tokenId: number;
	}
	| {
		/** A run has finished. */
		kind: 'run-finished';
		/** What it produced and cost. */
		outcome: RunOutcome;
	}
	| {
		/** Something threw. */
		kind: 'failed';
		/** Which request was being handled. */
		requestKind: string;
		/** What went wrong. */
		message: string;
	};
