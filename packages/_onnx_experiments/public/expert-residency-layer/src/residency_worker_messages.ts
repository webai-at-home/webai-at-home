import type { BlockManifest, ResidencyConfiguration, SelectionKind, StepMeasurement } from './residency_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Residency worker messages — what the page and the residency worker say to each other
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The residency layer runs entirely inside one dedicated worker, and this is its whole surface.
 *
 * It runs there rather than on the page thread for a reason measured in milestone 2: `createSyncAccessHandle()` only
 * exists in a worker, and the cost of moving an expert is dominated by a copy on whichever thread does it. Putting the
 * file handle, the WebGPU device, the staging buffers, and the cache all in the same worker means an expert goes from
 * disk into a mapped buffer and then into graphics memory without ever crossing a thread boundary.
 */

/** What the page asks the residency worker to do. */
export type ResidencyRequest =
	| {
		/** Opens the block file, reads how much of it is already present, and reports back. */
		kind: 'open-store';
		/** The published manifest describing the block layout. */
		manifest: BlockManifest;
	}
	| {
		/**
		 * Downloads missing expert blocks into the Origin Private File System and writes them at their exact offsets.
		 * Blocks already present are not downloaded again, so closing the page loses only the block in flight.
		 */
		kind: 'fill-store';
		/** Where the published `expert_blocks.bin` lives, at its pinned revision. */
		blocksUrl: string;
		/** How many blocks to make sure are present, counted from block zero. */
		wantedBlockCount: number;
	}
	| {
		/** Creates the WebGPU device, the staging ring, and the expert cache. */
		kind: 'start-residency';
		/** How the layer is set up. */
		configuration: ResidencyConfiguration;
	}
	| {
		/** Runs the measurement loop and reports one measurement for each step. */
		kind: 'run-steps';
		/** How many steps, meaning generated tokens, to simulate. */
		stepCount: number;
		/** Which synthetic expert-selection sequence to drive it with. */
		selection: SelectionKind;
		/** How many experts each layer selects for each token. */
		selectedForEachLayer: number;
	}
	| {
		/** Releases the staging ring, the cache, and the device, leaving the block file alone. */
		kind: 'stop-residency';
	};

/** What the residency worker says back. */
export type ResidencyResponse =
	| {
		/** The block file is open. */
		kind: 'store-opened';
		/** How many bytes the file holds. */
		byteLength: number;
		/** How many whole blocks that is. */
		presentBlockCount: number;
		/** How many blocks the published file holds in total. */
		publishedBlockCount: number;
	}
	| {
		/** Progress while filling the store, sent often enough to be watchable and rarely enough to be cheap. */
		kind: 'fill-progress';
		/** How many blocks are present now. */
		presentBlockCount: number;
		/** How many blocks are wanted. */
		wantedBlockCount: number;
		/** How many bytes each second the download is achieving. */
		bytesEachSecond: number;
	}
	| {
		/** The store holds every block that was asked for. */
		kind: 'store-filled';
		/** How many blocks are present. */
		presentBlockCount: number;
		/** How long the fill took, in seconds. */
		seconds: number;
		/** How many bytes were downloaded, which is zero when everything was already present. */
		downloadedByteLength: number;
	}
	| {
		/** The residency layer is ready to run steps. */
		kind: 'residency-started';
		/** How many experts the cache can hold at once. */
		slotCount: number;
		/** How many bytes the cache actually allocated. */
		cacheByteLength: number;
		/** How many staging buffers the ring holds. */
		stagingBufferCount: number;
		/** What the device reports as its largest single buffer. */
		maximumBufferByteLength: number;
	}
	| {
		/** One step finished. */
		kind: 'step-measured';
		/** What the step cost. */
		measurement: StepMeasurement;
	}
	| {
		/** Every step finished. */
		kind: 'steps-finished';
		/** How many experts the cache held. */
		slotCount: number;
		/** How many layers were simulated, which is limited by how much of the store is filled. */
		layerCount: number;
		/** How many experts those layers hold in total, which is what the cache is competing against. */
		expertCount: number;
		/** How long the staging ring spent waiting for buffers to be mapped again, in milliseconds. */
		stagingWaitedMilliseconds: number;
	}
	| {
		/** The residency layer is released. */
		kind: 'residency-stopped';
	}
	| {
		/** Something threw. The page shows this rather than a silent stall. */
		kind: 'failed';
		/** Which request failed. */
		requestKind: string;
		/** What went wrong. */
		message: string;
	};
