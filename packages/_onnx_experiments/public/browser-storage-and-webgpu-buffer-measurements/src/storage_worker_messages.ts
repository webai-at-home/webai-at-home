///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	storage_worker_messages — the message contract between the page and the Origin Private File System worker
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Every measurement of milestone two of issue #169 that touches disk runs inside a dedicated worker, because
 * `createSyncAccessHandle` exists only inside a worker. This file holds the two message types both sides import, so
 * that a change to one of them cannot leave the page and the worker disagreeing.
 */

/** A request the page sends to the storage worker. */
export type StorageWorkerRequest =
	| {
		/** Fills a file with the given number of blocks, each one carrying a pattern derived from its block index. */
		kind: 'write-file';
		/** The name of the file inside the Origin Private File System. */
		fileName: string;
		/** The length of one block, in bytes. */
		blockByteLength: number;
		/** How many blocks the file holds. */
		blockCount: number;
	}
	| {
		/** Reads the named blocks one after another, timing each read, and returns only the timings. */
		kind: 'read-blocks';
		/** The name of the file inside the Origin Private File System. */
		fileName: string;
		/** The length of one block, in bytes. */
		blockByteLength: number;
		/** The blocks to read, in the order they are to be read. */
		blockIndexes: number[];
	}
	| {
		/** Reads one block and transfers its bytes back to the page, which is the path the residency layer needs. */
		kind: 'read-one-block';
		/** The name of the file inside the Origin Private File System. */
		fileName: string;
		/** The length of one block, in bytes. */
		blockByteLength: number;
		/** The block to read. */
		blockIndex: number;
	}
	| {
		/**
		 * Closes the open synchronous access handle without removing the file. A synchronous access handle holds an
		 * exclusive lock, so nothing else, including an ordinary file read on the page's own thread, can touch the
		 * file until the handle is closed.
		 */
		kind: 'close-file';
	}
	| {
		/** Removes the file and gives its bytes back to the quota. */
		kind: 'delete-file';
		/** The name of the file inside the Origin Private File System. */
		fileName: string;
	};

/** A reply the storage worker sends back to the page. */
export type StorageWorkerResponse =
	| {
		/** The reply to a `write-file` request. */
		kind: 'write-file';
		/** How many bytes were written. */
		byteLength: number;
		/** How long the whole write took, including the final flush, in milliseconds. */
		milliseconds: number;
		/** How long the final flush alone took, in milliseconds. */
		flushMilliseconds: number;
	}
	| {
		/** The reply to a `read-blocks` request. */
		kind: 'read-blocks';
		/** How many bytes were read in total. */
		byteLength: number;
		/** How long every read took together, in milliseconds. */
		milliseconds: number;
		/** The fastest single block read, in milliseconds. */
		fastestBlockMilliseconds: number;
		/** The slowest single block read, in milliseconds. */
		slowestBlockMilliseconds: number;
		/**
		 * How many blocks did not carry the block index that was written into their first four bytes. Any value above
		 * zero means the read returned the wrong bytes, which no timing can make acceptable.
		 */
		wrongBlockCount: number;
	}
	| {
		/** The reply to a `read-one-block` request. */
		kind: 'read-one-block';
		/** The bytes of the block, transferred rather than copied. */
		bytes: ArrayBuffer;
		/** How long the read alone took inside the worker, in milliseconds. */
		milliseconds: number;
		/** Whether the block carried the block index that was written into its first four bytes. */
		isCorrectBlock: boolean;
	}
	| {
		/** The reply to a `close-file` request. */
		kind: 'close-file';
	}
	| {
		/** The reply to a `delete-file` request. */
		kind: 'delete-file';
	}
	| {
		/** The reply sent when a request threw inside the worker. */
		kind: 'failed';
		/** The failure, as text, because an error object does not survive being posted between threads. */
		message: string;
	};
