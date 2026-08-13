import type { FileSystemSyncAccessHandle, SyncCapableFileHandle } from './browser_storage_types';
import type { StorageWorkerRequest, StorageWorkerResponse } from './storage_worker_messages';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StorageWorker — reads and writes expert-sized blocks in the Origin Private File System
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The disk half of milestone two of issue #169. It runs inside a dedicated worker for one reason: the synchronous
 * access handle, which is the only path the browser offers that reads a block without allocating a `Blob`, without a
 * promise for every read, and without a copy through the structured clone algorithm, exists nowhere else.
 *
 * Every method here blocks this thread on purpose. That is what makes the timings mean something, and it is why none
 * of this may ever move to the thread that draws the page.
 */

/**
 * The part of the dedicated worker global scope this file uses. The TypeScript DOM library types `self` as a window,
 * whose `postMessage` takes a target origin rather than a transfer list, so the shape that is actually there is
 * written out instead of fighting the wrong one.
 */
type DedicatedWorkerScope = {
	/**
	 * Registers the handler that receives requests from the page.
	 *
	 * @param type - Always `message`.
	 * @param listener - The handler.
	 * @returns Nothing.
	 */
	addEventListener(type: 'message', listener: (event: MessageEvent<StorageWorkerRequest>) => void): void;
	/**
	 * Sends a reply back to the page.
	 *
	 * @param message - The reply.
	 * @param transfer - The buffers whose ownership moves to the page rather than being copied.
	 * @returns Nothing.
	 */
	postMessage(message: StorageWorkerResponse, transfer?: Transferable[]): void;
};

/** How many bytes at the start of every block carry the block index, so a read can prove it got the right block. */
const BLOCK_INDEX_BYTE_LENGTH = 4;

/** Answers one request at a time from the page, against one file in the Origin Private File System. */
class StorageWorker {
	/**
	 * The one open synchronous access handle, kept open between requests.
	 *
	 * Opening a handle is not free, and it is not part of what milestone two is measuring. A residency layer opens the
	 * expert file once when the model is loaded and keeps it open for as long as the model is loaded, so a measurement
	 * that reopened it for every expert would be reporting a cost the real thing never pays.
	 */
	static openFile: { fileName: string; handle: FileSystemSyncAccessHandle } | undefined;

	/**
	 * Registers the message handler. Requests are answered one at a time, in the order they arrive, because a
	 * synchronous access handle is exclusive and a second one cannot be opened while the first is still open.
	 *
	 * @param scope - The dedicated worker global scope.
	 * @returns Nothing.
	 */
	static listen(scope: DedicatedWorkerScope): void {
		scope.addEventListener('message', (event) => {
			StorageWorker._answer(scope, event.data).catch((error: unknown) => {
				scope.postMessage({
					kind: 'failed',
					message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
				});
			});
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Requests
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one request and posts its reply.
	 *
	 * @param scope - The dedicated worker global scope, used to post the reply.
	 * @param request - The request from the page.
	 * @returns A promise that resolves once the reply has been posted.
	 */
	static async _answer(scope: DedicatedWorkerScope, request: StorageWorkerRequest): Promise<void> {
		if (request.kind === 'write-file') {
			scope.postMessage(await StorageWorker._writeFile(request.fileName, request.blockByteLength, request.blockCount));
			return;
		}
		if (request.kind === 'read-blocks') {
			scope.postMessage(
				await StorageWorker._readBlocks(request.fileName, request.blockByteLength, request.blockIndexes),
			);
			return;
		}
		if (request.kind === 'read-one-block') {
			const response = await StorageWorker._readOneBlock(
				request.fileName,
				request.blockByteLength,
				request.blockIndex,
			);
			scope.postMessage(response, [response.bytes]);
			return;
		}
		if (request.kind === 'close-file') {
			StorageWorker._closeSyncHandle();
			scope.postMessage({
				kind: 'close-file',
			});
			return;
		}
		await StorageWorker._deleteFile(request.fileName);
		scope.postMessage({
			kind: 'delete-file',
		});
	}

	/**
	 * Fills a file with blocks, each one carrying its own block index in its first four bytes and a pattern derived
	 * from that index in the rest, so that a later read can prove it landed on the block it asked for.
	 *
	 * One block buffer is allocated and refilled for every block, because allocating one buffer for each of hundreds
	 * of blocks would measure the memory allocator rather than the disk.
	 *
	 * @param fileName - The name of the file inside the Origin Private File System.
	 * @param blockByteLength - The length of one block, in bytes.
	 * @param blockCount - How many blocks the file holds.
	 * @returns A promise that resolves to the reply for the page.
	 */
	static async _writeFile(
		fileName: string,
		blockByteLength: number,
		blockCount: number,
	): Promise<StorageWorkerResponse> {
		const handle = await StorageWorker._openSyncHandle(fileName);
		handle.truncate(0);
		const block = new Uint8Array(blockByteLength);
		const blockIndexView = new DataView(block.buffer);
		const startedAt = performance.now();
		for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
			StorageWorker._fillBlock(block, blockIndexView, blockIndex);
			handle.write(block, {
				at: blockIndex * blockByteLength,
			});
		}
		const flushStartedAt = performance.now();
		handle.flush();
		const finishedAt = performance.now();
		return {
			kind: 'write-file',
			byteLength: blockByteLength * blockCount,
			milliseconds: finishedAt - startedAt,
			flushMilliseconds: finishedAt - flushStartedAt,
		};
	}

	/**
	 * Reads the given blocks one after another into one reused buffer, times each read on its own, and returns only
	 * the timings. Nothing is transferred back, so this measures the disk path and nothing else.
	 *
	 * @param fileName - The name of the file inside the Origin Private File System.
	 * @param blockByteLength - The length of one block, in bytes.
	 * @param blockIndexes - The blocks to read, in the order they are to be read.
	 * @returns A promise that resolves to the reply for the page.
	 */
	static async _readBlocks(
		fileName: string,
		blockByteLength: number,
		blockIndexes: number[],
	): Promise<StorageWorkerResponse> {
		const handle = await StorageWorker._openSyncHandle(fileName);
		const block = new Uint8Array(blockByteLength);
		const blockIndexView = new DataView(block.buffer);
		let fastestBlockMilliseconds = Number.POSITIVE_INFINITY;
		let slowestBlockMilliseconds = 0;
		let wrongBlockCount = 0;
		const startedAt = performance.now();
		for (const blockIndex of blockIndexes) {
			const blockStartedAt = performance.now();
			handle.read(block, {
				at: blockIndex * blockByteLength,
			});
			const blockMilliseconds = performance.now() - blockStartedAt;
			if (blockMilliseconds < fastestBlockMilliseconds) {
				fastestBlockMilliseconds = blockMilliseconds;
			}
			if (blockMilliseconds > slowestBlockMilliseconds) {
				slowestBlockMilliseconds = blockMilliseconds;
			}
			if (blockIndexView.getUint32(0, true) !== blockIndex) {
				wrongBlockCount++;
			}
		}
		const milliseconds = performance.now() - startedAt;
		return {
			kind: 'read-blocks',
			byteLength: blockByteLength * blockIndexes.length,
			milliseconds: milliseconds,
			fastestBlockMilliseconds: blockIndexes.length === 0 ? 0 : fastestBlockMilliseconds,
			slowestBlockMilliseconds: slowestBlockMilliseconds,
			wrongBlockCount: wrongBlockCount,
		};
	}

	/**
	 * Reads one block into a buffer allocated for this call alone, and hands that buffer's ownership to the page.
	 *
	 * The fresh allocation is not an oversight. A buffer can only be transferred once, and after the transfer this
	 * side no longer owns it, so the reused buffer of `_readBlocks` cannot be used here. The difference between the
	 * two measurements is exactly the price of moving bytes across the thread boundary.
	 *
	 * @param fileName - The name of the file inside the Origin Private File System.
	 * @param blockByteLength - The length of one block, in bytes.
	 * @param blockIndex - The block to read.
	 * @returns A promise that resolves to the reply for the page, carrying the block's bytes.
	 */
	static async _readOneBlock(
		fileName: string,
		blockByteLength: number,
		blockIndex: number,
	): Promise<{ kind: 'read-one-block'; bytes: ArrayBuffer; milliseconds: number; isCorrectBlock: boolean }> {
		const handle = await StorageWorker._openSyncHandle(fileName);
		const block = new Uint8Array(blockByteLength);
		const startedAt = performance.now();
		handle.read(block, {
			at: blockIndex * blockByteLength,
		});
		const milliseconds = performance.now() - startedAt;
		return {
			kind: 'read-one-block',
			bytes: block.buffer,
			milliseconds: milliseconds,
			isCorrectBlock: new DataView(block.buffer).getUint32(0, true) === blockIndex,
		};
	}

	/**
	 * Removes the file, which gives its bytes back to the quota of the origin.
	 *
	 * @param fileName - The name of the file inside the Origin Private File System.
	 * @returns A promise that resolves once the file is gone.
	 */
	static async _deleteFile(fileName: string): Promise<void> {
		StorageWorker._closeSyncHandle();
		const directory = await navigator.storage.getDirectory();
		await directory.removeEntry(fileName);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Opens the file in the Origin Private File System, creating it when it is not there, and takes a synchronous
	 * access handle on it.
	 *
	 * @param fileName - The name of the file inside the Origin Private File System.
	 * @returns A promise that resolves to the handle.
	 */
	static async _openSyncHandle(fileName: string): Promise<FileSystemSyncAccessHandle> {
		if (StorageWorker.openFile !== undefined && StorageWorker.openFile.fileName === fileName) {
			return StorageWorker.openFile.handle;
		}
		StorageWorker._closeSyncHandle();
		const directory = await navigator.storage.getDirectory();
		const fileHandle = (await directory.getFileHandle(fileName, {
			create: true,
		})) as SyncCapableFileHandle;
		const handle = await fileHandle.createSyncAccessHandle();
		StorageWorker.openFile = {
			fileName: fileName,
			handle: handle,
		};
		return handle;
	}

	/**
	 * Closes the open synchronous access handle, if there is one. A file cannot be removed while a handle on it is
	 * still open, and a second handle on the same file cannot be taken either.
	 *
	 * @returns Nothing.
	 */
	static _closeSyncHandle(): void {
		if (StorageWorker.openFile === undefined) {
			return;
		}
		StorageWorker.openFile.handle.close();
		StorageWorker.openFile = undefined;
	}

	/**
	 * Writes the block index into the first four bytes of a block and a pattern derived from it into the rest.
	 *
	 * The pattern is written in strides rather than byte by byte, because filling 2.5 megabytes one byte at a time for
	 * every one of hundreds of blocks would make the write measurement a measurement of this loop.
	 *
	 * @param block - The block buffer to fill.
	 * @param blockIndexView - A view on the same buffer, used to write the block index.
	 * @param blockIndex - The index of the block being filled.
	 * @returns Nothing.
	 */
	static _fillBlock(block: Uint8Array, blockIndexView: DataView, blockIndex: number): void {
		const stride = 4096;
		for (let offset = BLOCK_INDEX_BYTE_LENGTH; offset < block.length; offset += stride) {
			block[offset] = (blockIndex + offset) & 0xff;
		}
		blockIndexView.setUint32(0, blockIndex, true);
	}
}

StorageWorker.listen(self as unknown as DedicatedWorkerScope);
