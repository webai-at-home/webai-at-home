import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

// Milestone four runs one shard per browser page and passes hidden states between the pages. The pages need
// something to pass them through, and issue #179 leaves the choice between the cluster's own gateway and a
// small relay inside this package. This is the small relay: it is about forty lines, it adds no coupling to
// the gateway, the protocol package, or any worker package, and it knows nothing about shards or tensors.
//
// It forwards a frame to the name in the frame's header and does nothing else. No routing, no queueing, no
// retries, no reconnection. Every one of those belongs to the cluster, and none of them is what milestone
// four is measuring.
const relayPath = '/relay';

/**
 * Attaches the relay to a server, forwarding each frame to the one connection named in its header.
 *
 * @param {import('node:http').Server} httpServer The server to attach to.
 * @returns {void}
 */
function attachRelay(httpServer) {
	const webSocketServer = new WebSocketServer({
		noServer: true,
	});
	/** @type {Map<string, import('ws').WebSocket>} */
	const connections = new Map();

	httpServer.on('upgrade', (request, socket, head) => {
		const requestUrl = new URL(request.url ?? '', 'http://localhost');
		if (requestUrl.pathname !== relayPath) {
			return;
		}
		const name = requestUrl.searchParams.get('name');
		if (name === null) {
			socket.destroy();
			return;
		}
		webSocketServer.handleUpgrade(request, socket, head, (connection) => {
			connections.set(name, connection);
			console.log(`relay: ${name} connected (${connections.size} connected)`);
			connection.on('message', (frame) => {
				// The header names the recipient. The relay reads that and forwards the frame untouched, so
				// the bytes the sender measured are the bytes the recipient receives.
				const bytes = /** @type {Buffer} */ (frame);
				const headerLength = bytes.readUInt32LE(0);
				const header = JSON.parse(bytes.subarray(4, 4 + headerLength).toString('utf8'));
				const recipient = connections.get(header.to);
				if (recipient === undefined) {
					console.log(`relay: no connection named ${header.to}, dropping a ${bytes.length} byte frame`);
					return;
				}
				recipient.send(bytes, {
					binary: true,
				});
			});
			connection.on('close', () => {
				if (connections.get(name) === connection) {
					connections.delete(name);
				}
				console.log(`relay: ${name} disconnected (${connections.size} connected)`);
			});
		});
	});
}

// The milestone two gate reads one row of the token embedding table with a range request, because decoding one
// token needs 4096 bytes of a 622 megabyte file. Vite serves files under the root whole, so the range request
// is answered here instead.
const embeddingPrefix = '/qwen3-litert-shards/models/qwen3_0_6b_embedding.bin';

/**
 * Serves one byte range of the raw token embedding table.
 *
 * @param {import('node:http').ServerResponse} response Where to write.
 * @param {string} filePath The file to serve.
 * @param {string | undefined} rangeHeader The request's Range header, if it sent one.
 * @returns {void}
 */
function serveEmbeddingRange(response, filePath, rangeHeader) {
	const byteLength = statSync(filePath).size;
	const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? '');
	response.setHeader('Content-Type', 'application/octet-stream');
	response.setHeader('Accept-Ranges', 'bytes');

	if (match === null) {
		response.setHeader('Content-Length', String(byteLength));
		response.end(readFileSync(filePath));
		return;
	}

	const firstByte = Number(match[1]);
	const lastByte = match[2] === '' ? byteLength - 1 : Math.min(Number(match[2]), byteLength - 1);
	const wantedLength = lastByte - firstByte + 1;
	// The file is read at an offset rather than whole. It is 622 megabytes and the page asks for 4096 bytes of
	// it, so reading it whole would be the slowest possible way to answer.
	const bytes = Buffer.alloc(wantedLength);
	const descriptor = openSync(filePath, 'r');
	try {
		readSync(descriptor, bytes, 0, wantedLength, firstByte);
	} finally {
		closeSync(descriptor);
	}
	response.statusCode = 206;
	response.setHeader('Content-Range', `bytes ${firstByte}-${lastByte}/${byteLength}`);
	response.setHeader('Content-Length', String(wantedLength));
	response.end(bytes);
}

/**
 * Serves one whole file out of one directory, and nothing outside it.
 *
 * @param {import('node:http').ServerResponse} response Where to write.
 * @param {string} directory The directory the file must sit in.
 * @param {string} requestedName The file wanted, of which only the base name is used.
 * @returns {void}
 */
function serveFileFromDirectory(response, directory, requestedName) {
	// Only the base name is taken, so nothing outside the directory can be reached.
	const fileName = basename(requestedName);
	const filePath = resolve(directory, fileName);
	try {
		const byteLength = statSync(filePath).size;
		response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
		if (fileName.endsWith('.mjs') === true) {
			response.setHeader('Content-Type', 'text/javascript');
		}
		response.setHeader('Content-Length', String(byteLength));
		response.end(readFileSync(filePath));
	} catch (error) {
		response.statusCode = 404;
		response.end(`${fileName} is not in ${directory}. (${error.message})`);
	}
}

// loadLiteRt() is given a directory and picks the WebAssembly variant the browser can run, so the whole directory
// has to be reachable. It lives inside node_modules and is never copied into public/, exactly as the ONNX Runtime
// Web assets are not copied in packages/_onnx_experiments. The directory is resolved rather than written out,
// because npm hoists @litertjs/core to the repository root in this workspace and would not in a standalone install.
const require = createRequire(import.meta.url);
const liteRtWasmDirectory = resolve(dirname(require.resolve('@litertjs/core/package.json')), 'wasm');
const liteRtWasmPrefix = '/wasm/';

// Milestone six measures ONNX Runtime Web beside LiteRT.js, so this package has to serve the ONNX Runtime Web
// WebAssembly files as well. They live inside node_modules and are never copied into public/, exactly as the
// LiteRT.js ones above are not. ONNX Runtime Web asks for them at the root, which is what `env.wasm.wasmPaths`
// on the page is set to.
const onnxRuntimeWebDirectory = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const onnxRuntimeWebFileNames = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

// The three ONNX shards milestone six compares against are the generated artifacts of
// packages/_onnx_experiments/tools/qwen3_shard_export/, about 902 megabytes in total. They are not copied here
// and no code here imports anything from that package: the development server reads the three files off disk
// and serves them, which is the whole of the connection between the two packages.
const onnxShardPrefix = '/onnxruntime-comparison/shards/';
const onnxShardDirectory =
	process.env.QWEN3_ONNX_SHARD_DIRECTORY ??
	resolve(import.meta.dirname, '../_onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards');

export default defineConfig({
	root: resolve(import.meta.dirname, 'public'),
	publicDir: false,
	plugins: [
		{
			name: 'serve-litert-js-wasm-assets',
			configureServer(server) {
				if (server.httpServer !== null && server.httpServer !== undefined) {
					attachRelay(server.httpServer);
				}
				server.middlewares.use((request, response, next) => {
					const path = request.url?.split('?')[0] ?? '';
					if (path === embeddingPrefix) {
						serveEmbeddingRange(
							response,
							resolve(import.meta.dirname, `public${embeddingPrefix}`),
							request.headers.range,
						);
						return;
					}
					if (path.startsWith(onnxShardPrefix) === true) {
						serveFileFromDirectory(response, onnxShardDirectory, path.slice(onnxShardPrefix.length));
						return;
					}
					if (onnxRuntimeWebFileNames.includes(basename(path)) === true) {
						serveFileFromDirectory(response, onnxRuntimeWebDirectory, basename(path));
						return;
					}
					if (path.startsWith(liteRtWasmPrefix) === false) {
						next();
						return;
					}
					// Only the base name is taken, so nothing outside the WebAssembly directory can be reached.
					const fileName = basename(path.slice(liteRtWasmPrefix.length));
					try {
						const bytes = readFileSync(resolve(liteRtWasmDirectory, fileName));
						response.setHeader(
							'Content-Type',
							fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
						);
						response.end(bytes);
					} catch (error) {
						response.statusCode = 404;
						response.end(`${fileName} is not in ${liteRtWasmDirectory}. (${error.message})`);
					}
				});
			},
			generateBundle() {
				for (const fileName of readdirSync(liteRtWasmDirectory)) {
					this.emitFile({
						type: 'asset',
						fileName: `wasm/${fileName}`,
						source: readFileSync(resolve(liteRtWasmDirectory, fileName)),
					});
				}
			},
		},
	],
	build: {
		rollupOptions: {
			input: {
				home: resolve(import.meta.dirname, 'public/index.html'),
				liteRtJsWebGpuGate: resolve(import.meta.dirname, 'public/litertjs-webgpu-gate/index.html'),
				liteRtJsCacheResidencyGate: resolve(
					import.meta.dirname,
					'public/litertjs-cache-residency-gate/index.html',
				),
				liteRtJsMultipleOutputDiagnosis: resolve(
					import.meta.dirname,
					'public/litertjs-multiple-output-diagnosis/index.html',
				),
				qwen3LiteRtShards: resolve(import.meta.dirname, 'public/qwen3-litert-shards/index.html'),
				qwen3LiteRtResidentDecode: resolve(
					import.meta.dirname,
					'public/qwen3-litert-resident-decode/index.html',
				),
				qwen3LiteRtPrefill: resolve(import.meta.dirname, 'public/qwen3-litert-prefill/index.html'),
				qwen3LiteRtWorkers: resolve(import.meta.dirname, 'public/qwen3-litert-workers/index.html'),
				qwen3LiteRtWorkersWorker: resolve(import.meta.dirname, 'public/qwen3-litert-workers/worker.html'),
				onnxRuntimeWebComparison: resolve(import.meta.dirname, 'public/onnxruntime-comparison/index.html'),
				runtimeComparisonInterleaved: resolve(
					import.meta.dirname,
					'public/runtime-comparison-interleaved/index.html',
				),
			},
		},
	},
});
