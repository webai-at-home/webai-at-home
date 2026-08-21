import { env } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	IndexedDbModelCache — keeps the 3111 megabytes of Gemma 4 E2B out of a second download
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One cached response, as it is kept in the object store. */
type CacheEntry = {
	/** The response body. */
	body: ArrayBuffer;
	/** Every response header, so the response can be rebuilt as it arrived. */
	headers: Record<string, string>;
	/** The response status. */
	status: number;
};

/** What `@huggingface/transformers` calls while a cached file is written, to report how far it has got. */
type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;

/** The two methods `env.customCache` has to carry. */
type CustomCache = {
	/**
	 * Reads one cached response.
	 *
	 * @param key The cache key, which is the file's URL.
	 * @returns The cached response, or `undefined` when nothing is cached under that key.
	 */
	match: (key: string) => Promise<Response | undefined>;
	/**
	 * Writes one response into the cache.
	 *
	 * @param key The cache key, which is the file's URL.
	 * @param response The response to keep.
	 * @param progressCallback Called once the whole body has been written.
	 * @returns Nothing, and never rejects: a cache that cannot be written must not stop a model from loading.
	 */
	put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void>;
};

/**
 * The same IndexedDB model cache as `packages/_onnx_experiments/public/gemma4-e2b-tool-calls-gate`, under the same
 * database name, so a browser that already ran that measurement does not download about 3111 megabytes again for
 * this one.
 *
 * Copied rather than shared, because `packages/_onnx_experiments/CONTEXT.md` keeps every experiment standalone and
 * prefers a copied helper over a shared library folder.
 */
export class IndexedDbModelCache {
	/** The database every experiment in this package caches model files in. */
	private static readonly databaseName = 'webai-onnx-experiments';

	/** The object store inside that database. */
	private static readonly storeName = 'model-files';

	/** The open database, once something has asked for it. */
	private static databasePromise: Promise<IDBDatabase> | undefined = undefined;

	/**
	 * Points `@huggingface/transformers` at this cache, or at the browser's own cache when IndexedDB is missing.
	 *
	 * @returns `true` when this cache was installed, `false` when the browser cache was used instead.
	 */
	static install(): boolean {
		env.allowLocalModels = false;
		if (typeof indexedDB === 'undefined' || typeof Response === 'undefined') {
			env.useBrowserCache = true;
			return false;
		}
		env.useBrowserCache = false;
		env.useCustomCache = true;
		env.customCache = IndexedDbModelCache.cache();
		return true;
	}

	/**
	 * The cache object `env.customCache` is given.
	 *
	 * @returns The cache.
	 */
	private static cache(): CustomCache {
		return {
			async match(key: string): Promise<Response | undefined> {
				try {
					const entry = await IndexedDbModelCache.read(key);
					if (entry === undefined) { return undefined; }
					return new Response(entry.body, { status: entry.status, headers: entry.headers });
				} catch (error) {
					console.warn('Unable to read the IndexedDB model cache:', error);
					return undefined;
				}
			},
			async put(key: string, response: Response, progressCallback?: ProgressCallback): Promise<void> {
				try {
					const body = await response.arrayBuffer();
					const headers: Record<string, string> = {};
					response.headers.forEach((value, headerName) => { headers[headerName] = value; });
					await IndexedDbModelCache.write(key, { body: body, headers: headers, status: response.status });
					progressCallback?.({ loaded: body.byteLength, total: body.byteLength, progress: 100 });
				} catch (error) {
					console.warn('Unable to write the IndexedDB model cache:', error);
				}
			},
		};
	}

	/**
	 * The open database, opening it on the first call.
	 *
	 * @returns The database.
	 */
	private static openDatabase(): Promise<IDBDatabase> {
		if (IndexedDbModelCache.databasePromise === undefined) {
			IndexedDbModelCache.databasePromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(IndexedDbModelCache.databaseName, 1);
				request.onupgradeneeded = () => request.result.createObjectStore(IndexedDbModelCache.storeName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}
		return IndexedDbModelCache.databasePromise;
	}

	/**
	 * Reads one entry out of the object store.
	 *
	 * @param key The cache key.
	 * @returns The entry, or `undefined` when there is none.
	 */
	private static async read(key: string): Promise<CacheEntry | undefined> {
		const database = await IndexedDbModelCache.openDatabase();
		return new Promise((resolve, reject) => {
			const request = database
				.transaction(IndexedDbModelCache.storeName, 'readonly')
				.objectStore(IndexedDbModelCache.storeName)
				.get(key);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	/**
	 * Writes one entry into the object store.
	 *
	 * @param key The cache key.
	 * @param value The entry to keep.
	 * @returns Nothing, once the write has finished.
	 */
	private static async write(key: string, value: CacheEntry): Promise<void> {
		const database = await IndexedDbModelCache.openDatabase();
		return new Promise((resolve, reject) => {
			const request = database
				.transaction(IndexedDbModelCache.storeName, 'readwrite')
				.objectStore(IndexedDbModelCache.storeName)
				.put(value, key);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}
