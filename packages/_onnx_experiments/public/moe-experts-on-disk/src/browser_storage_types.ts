///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	browser_storage_types — the browser interfaces this experiment uses that the TypeScript DOM library omits
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The TypeScript DOM library shipped with the compiler in this repository declares `FileSystemFileHandle` and
 * `StorageManager`, but not `createSyncAccessHandle`, not `FileSystemSyncAccessHandle`, and not the `usageDetails`
 * field of a storage estimate. Chrome has all three, and milestone two of issue #169 exists to measure exactly them,
 * so the missing declarations are written out here rather than reached through a cast at every call site.
 */

/**
 * The options accepted by a read from, or a write to, a `FileSystemSyncAccessHandle`.
 */
export type FileSystemReadWriteOptions = {
	/** The byte offset in the file at which the read or the write starts. */
	at: number;
};

/**
 * A synchronous read and write handle on one file in the Origin Private File System. It exists only inside a worker,
 * every one of its methods blocks the worker thread, and it is the fastest path a browser offers to a file on disk.
 */
export type FileSystemSyncAccessHandle = {
	/**
	 * Reads bytes from the file into the given buffer.
	 *
	 * @param buffer - The destination the bytes are read into.
	 * @param options - Where in the file the read starts.
	 * @returns The number of bytes read.
	 */
	read(buffer: ArrayBufferView, options?: FileSystemReadWriteOptions): number;
	/**
	 * Writes bytes from the given buffer into the file.
	 *
	 * @param buffer - The source the bytes are written from.
	 * @param options - Where in the file the write starts.
	 * @returns The number of bytes written.
	 */
	write(buffer: ArrayBufferView, options?: FileSystemReadWriteOptions): number;
	/**
	 * Resizes the file.
	 *
	 * @param newSize - The new length of the file, in bytes.
	 * @returns Nothing.
	 */
	truncate(newSize: number): void;
	/**
	 * Reads the current length of the file.
	 *
	 * @returns The length of the file, in bytes.
	 */
	getSize(): number;
	/**
	 * Forces every buffered write out to the file.
	 *
	 * @returns Nothing.
	 */
	flush(): void;
	/**
	 * Releases the handle. Another handle on the same file cannot be opened until this one is closed.
	 *
	 * @returns Nothing.
	 */
	close(): void;
};

/**
 * A `FileSystemFileHandle` widened with the synchronous access handle that only exists inside a worker.
 */
export type SyncCapableFileHandle = FileSystemFileHandle & {
	/**
	 * Opens a synchronous read and write handle on the file.
	 *
	 * @returns A promise that resolves to the handle.
	 */
	createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
};

/**
 * A storage estimate widened with the per-storage-system breakdown Chrome reports and the specification does not
 * require. The breakdown is what tells the residency layer whether the bytes it thinks it wrote to the Origin Private
 * File System are the bytes the browser is counting against the quota.
 */
export type DetailedStorageEstimate = StorageEstimate & {
	/** How the reported usage divides across the storage systems of the origin, keyed by storage system name. */
	usageDetails?: Record<string, number>;
};
