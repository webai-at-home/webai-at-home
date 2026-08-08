import Fs from 'node:fs';
import Http from 'node:http';
import Path from 'node:path';
import Url from 'node:url';
import { DiagnosticsBatchSchema } from '@webai/protocol';
import type { ConnectionHub } from './connection_hub.js';
import type { DeviceAnnouncer } from '../device/device_announcer.js';
import type { DiagnosticsRateLimiter } from '../libs/diagnostics_rate_limiter.js';
import type { SessionRegistry } from '../task/session_registry.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HttpRoutes — answers every HTTP request the gateway serves
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The part of a Vite development server the gateway uses.
 *
 * Naming only these three members keeps the gateway's dependency on Vite visible and small:
 * pages are transformed on the way out, unmatched paths fall through to Vite's own
 * middleware, and the server is closed on shutdown.
 */
export type PageDevServer = {
	middlewares: (request: Http.IncomingMessage, response: Http.ServerResponse, next: () => void) => void;
	transformIndexHtml(url: string, html: string): Promise<string>;
	close(): Promise<unknown>;
};

/** Where each page route reads its `index.html` from, relative to the web directory. */
const pageRoutes: Record<string, string> = {
	'/home': 'home/index.html',
	'/monitor': 'monitor/index.html',
	'/ledger': 'ledger/index.html',
	'/debug': 'debug/index.html',
	'/debug_iframe': 'debug_iframe/index.html',
	'/debug_iframe_all_stages': 'debug_iframe_all_stages/index.html',
	'/debug_iframe_dev_formula': 'debug_iframe_dev_formula/index.html',
	'/debug_iframe_llm_qwen3_0_6b_sharded': 'debug_iframe_llm_qwen3_0_6b_sharded/index.html',
	'/debug_iframe_llm_gemma_nano_chrome_full': 'debug_iframe_llm_gemma_nano_chrome_full/index.html',
	'/debug_iframe_llm_qwen3_5_0_8b_full': 'debug_iframe_llm_qwen3_5_0_8b_full/index.html',
	'/debug_iframe_llm_llama3_2_1b_full': 'debug_iframe_llm_llama3_2_1b_full/index.html',
};

/** The content type to serve each built asset with. */
const assetContentTypeByExtension: Record<string, string> = {
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
};

/**
 * The largest diagnostics report the gateway will read, in bytes.
 *
 * A report carries no message bodies, only a message type and a timestamp per entry, so the
 * largest allowed batch fits inside this comfortably. The limit is here to stop the gateway
 * buffering an unbounded request body before it has validated anything.
 */
const maximumDiagnosticsRequestBytes = 64_000;

/** The runtime files onnxruntime-web fetches by URL rather than through an import. */
const ortAssetNames = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

/**
 * Serves the gateway's browser pages, its development-only model files, its health route, and
 * the endpoint worker browsers post their diagnostics to.
 */
export class HttpRoutes {
	private readonly webDirectory: string;
	private readonly buildDirectory: string;

	/**
	 * @param hub The connections, used to reach a worker's own relayed log file.
	 * @param announcer The source of the worker count the health route reports.
	 * @param sessionRegistry The authenticated sessions a diagnostics report is checked against.
	 * @param diagnosticsRateLimiter The cap on how much one device may report.
	 * @param authToken The bearer token a diagnostics report must present.
	 * @param pageDevServer The Vite development server, when the gateway is not in production.
	 * @param commitSha The git commit this build was made from, published on the `/health` route.
	 */
	constructor(
		private readonly hub: ConnectionHub,
		private readonly announcer: DeviceAnnouncer,
		private readonly sessionRegistry: SessionRegistry,
		private readonly diagnosticsRateLimiter: DiagnosticsRateLimiter,
		private readonly authToken: string,
		private readonly pageDevServer: PageDevServer | undefined,
		private readonly commitSha: string,
	) {
		this.webDirectory = Path.join(Path.dirname(Url.fileURLToPath(import.meta.url)), '../../web');
		this.buildDirectory = Path.join(this.webDirectory, 'dist');
	}

	/**
	 * Answers one HTTP request.
	 *
	 * @param request The incoming HTTP request.
	 * @param response The HTTP response to answer with.
	 */
	handleRequest(request: Http.IncomingMessage, response: Http.ServerResponse): void {
		const pathname = HttpRoutes.requestPathnameOf(request);
		if (pathname === undefined) {
			HttpRoutes.sendNotFound(response);
			return;
		}

		// Handled before anything else so the route behaves the same in development and in
		// production. In development every unmatched path falls through to Vite's middleware,
		// which adds permissive cross-origin headers of its own, so an endpoint left to that
		// fallthrough would appear to work in development and then be blocked by the browser in
		// production, where there is no Vite.
		if (pathname === '/diagnostics') {
			if (request.method === 'OPTIONS') {
				HttpRoutes.setDiagnosticsCorsHeaders(response);
				response.statusCode = 204;
				response.end();
				return;
			}
			if (request.method !== 'POST') {
				HttpRoutes.endDiagnosticsResponse(response, 405, { error: 'A diagnostics report must be sent with POST' });
				return;
			}
			this.handleDiagnosticsReport(request, response).catch((error: unknown) => {
				console.error(error);
				HttpRoutes.endDiagnosticsResponse(response, 500, { error: 'The diagnostics report could not be recorded' });
			});
			return;
		}

		if (HttpRoutes.sendOnnxRuntimeAsset(response, pathname)) return;

		// The site root has no page of its own; every visitor is sent on to the home page instead
		// (see https://github.com/webai-at-home/webai-at-home/issues/88).
		if (pathname === '/') {
			response.statusCode = 302;
			response.setHeader('location', '/home/');
			response.end();
			return;
		}

		// A page route is looked up with any trailing slash removed, so "/monitor/" reaches the
		// same page as "/monitor". Every page names its own assets with absolute paths, such as
		// "/monitor/src/monitor_page.ts", so both spellings serve an identical working page.
		const pageRoutePathname = HttpRoutes.pageRoutePathnameOf(pathname);
		const pageSourcePath = pageRoutes[pageRoutePathname];
		if (pageSourcePath !== undefined) {
			this.sendPage(response, pageRoutePathname, pageSourcePath).catch((error: unknown) => console.error(error));
			return;
		}
		if (pathname === '/health') {
			response.setHeader('content-type', 'application/json');
			response.end(JSON.stringify({ ok: true, devices: this.announcer.workerDevices().length, commitSha: this.commitSha }));
			return;
		}
		if (this.pageDevServer !== undefined) {
			this.pageDevServer.middlewares(request, response, () => HttpRoutes.sendNotFound(response));
			return;
		}
		if (this.sendBuiltAsset(response, pathname)) return;
		HttpRoutes.sendNotFound(response);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Pages And Assets
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends a browser page, transpiled through Vite in development or read from the production build.
	 *
	 * @param response The HTTP response to write the page to.
	 * @param pathname The requested path, used to drive Vite's HTML transform in development.
	 * @param sourcePath The page's `index.html` path, relative to the web directory.
	 */
	private async sendPage(response: Http.ServerResponse, pathname: string, sourcePath: string): Promise<void> {
		response.setHeader('content-type', 'text/html; charset=utf-8');
		if (this.pageDevServer !== undefined) {
			const html = Fs.readFileSync(Path.join(this.webDirectory, sourcePath), 'utf-8');
			response.end(await this.pageDevServer.transformIndexHtml(pathname, html));
			return;
		}
		response.end(Fs.readFileSync(Path.join(this.buildDirectory, sourcePath)));
	}

	/**
	 * Serves a content-hashed asset from the production build's shared `assets` directory.
	 *
	 * @param response The HTTP response to write the asset to.
	 * @param pathname The requested path.
	 * @returns Whether a matching built asset was found and sent.
	 */
	private sendBuiltAsset(response: Http.ServerResponse, pathname: string): boolean {
		if (pathname.startsWith('/assets/') === false) return false;
		const assetsDirectory = Path.join(this.buildDirectory, 'assets');
		const assetPath = Path.join(this.buildDirectory, pathname);
		if (assetPath.startsWith(assetsDirectory + Path.sep) === false) return false;
		try {
			response.setHeader(
				'content-type',
				assetContentTypeByExtension[Path.extname(assetPath)] ?? 'application/octet-stream',
			);
			response.end(Fs.readFileSync(assetPath));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Serves one onnxruntime-web runtime file.
	 *
	 * onnxruntime-web fetches its WebAssembly runtime by URL rather than through an import, so
	 * it needs to be served explicitly, same as the existing _onnx_experiments prototype does
	 * for itself (see that package's vite.config.js). The package is resolved through Node's own
	 * module resolution rather than a hardcoded relative path — npm workspaces may hoist
	 * onnxruntime-web to the repo root's node_modules instead of nesting it under this
	 * package, depending on what else is installed.
	 *
	 * @param response The HTTP response to write the file to.
	 * @param pathname The requested path.
	 * @returns Whether the path named one of those runtime files.
	 */
	private static sendOnnxRuntimeAsset(response: Http.ServerResponse, pathname: string): boolean {
		const ortAssetName = pathname.slice(1);
		if (ortAssetNames.includes(ortAssetName) === false) return false;
		const ortDistDirectory = Path.dirname(Url.fileURLToPath(import.meta.resolve('onnxruntime-web')));
		response.setHeader('access-control-allow-origin', '*');
		response.setHeader('content-type', ortAssetName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
		response.end(Fs.readFileSync(Path.join(ortDistDirectory, ortAssetName)));
		return true;
	}

	/**
	 * Answers a request for something this gateway does not serve.
	 *
	 * @param response The HTTP response to answer with.
	 */
	private static sendNotFound(response: Http.ServerResponse): void {
		response.statusCode = 404;
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify({ error: 'Not found' }));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Diagnostics Reporting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Records a batch of diagnostic entries reported by a worker browser page over HTTP.
	 *
	 * Diagnostics travel here rather than over the WebSocket connection that carries
	 * scheduling, so that a worker reporting heavily cannot delay stage assignment or result
	 * collection for anyone (see https://github.com/webai-at-home/webai-at-home/issues/50).
	 *
	 * @param request The incoming HTTP request.
	 * @param response The HTTP response to answer with.
	 */
	private async handleDiagnosticsReport(request: Http.IncomingMessage, response: Http.ServerResponse): Promise<void> {
		const bearerToken = (request.headers.authorization ?? '').replace(/^Bearer /, '');
		if (bearerToken !== this.authToken) {
			HttpRoutes.endDiagnosticsResponse(response, 401, { error: 'Credentials were rejected' });
			return;
		}

		const bodyText = await HttpRoutes.readDiagnosticsBody(request);
		if (bodyText === undefined) {
			// The rest of the oversized body is still arriving. Answer first, then close the
			// connection rather than reading the remainder, so the sender learns why it was
			// refused and the gateway never buffers the whole thing.
			response.setHeader('connection', 'close');
			response.once('finish', () => request.destroy());
			HttpRoutes.endDiagnosticsResponse(response, 413, { error: `A diagnostics report may not exceed ${maximumDiagnosticsRequestBytes} bytes` });
			return;
		}

		let json: unknown;
		try {
			json = JSON.parse(bodyText);
		} catch {
			HttpRoutes.endDiagnosticsResponse(response, 400, { error: 'A diagnostics report must be valid JSON' });
			return;
		}

		// Validated against a schema rather than accepted as unknown, which is what the relay
		// over the scheduling connection used to do.
		const parsed = DiagnosticsBatchSchema.safeParse(json);
		if (parsed.success === false) {
			HttpRoutes.endDiagnosticsResponse(response, 400, { error: 'A diagnostics report did not match the expected shape', details: parsed.error.issues.slice(0, 10) });
			return;
		}

		// A valid token is not enough on its own: the report must name a device that currently
		// holds an authenticated connection, so a leaked token cannot be used to write log files
		// for devices that were never here.
		const batch = parsed.data;
		if (this.sessionRegistry.active(batch.deviceId) === undefined) {
			HttpRoutes.endDiagnosticsResponse(response, 403, { error: 'That device does not hold an authenticated connection' });
			return;
		}

		const limit = this.diagnosticsRateLimiter.accept(batch.deviceId, batch.entries.length);
		if (limit.isAccepted === false) {
			response.setHeader('retry-after', String(Math.ceil(limit.retryAfterMs / 1000)));
			HttpRoutes.endDiagnosticsResponse(response, 429, { error: 'That device has reported too many diagnostic entries', retryAfterMs: limit.retryAfterMs });
			return;
		}

		const logger = this.hub.workerMessageLogger(batch.deviceId);
		for (const entry of batch.entries) {
			// The report carries no message body, because the gateway is the other end of every
			// connection this worker has and so already recorded the body itself. What is written
			// here is the worker's own view of the timing, joined to the gateway's own record
			// through the frame identifier.
			logger.log(
				entry.direction,
				{ role: 'gateway' },
				entry.messageType,
				{ type: entry.messageType },
				entry.timestamp,
				{ id: entry.messageId },
			);
		}
		HttpRoutes.endDiagnosticsResponse(response, 202, { recorded: batch.entries.length, remaining: limit.remaining });
	}

	/**
	 * Allows a worker browser page served from a different origin to post its diagnostics.
	 *
	 * The worker page is normally served by its own development server on another port, so a
	 * report is a cross-origin request. A JSON post also carries a `content-type` the browser
	 * treats as non-simple, so the browser asks permission with an `OPTIONS` request first and
	 * refuses to send the report at all unless that permission is granted here.
	 *
	 * Any origin is allowed because a worker may legitimately run on any host. What actually
	 * guards the endpoint is the bearer token and the requirement that the device already hold
	 * an authenticated connection, not the origin the report came from.
	 *
	 * @param response The HTTP response to set the headers on.
	 */
	private static setDiagnosticsCorsHeaders(response: Http.ServerResponse): void {
		response.setHeader('access-control-allow-origin', '*');
		response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
		response.setHeader('access-control-allow-headers', 'authorization, content-type');
		response.setHeader('access-control-max-age', '86400');
	}

	/**
	 * Answers a diagnostics request with a JSON body and the headers that let a browser read it.
	 *
	 * @param response The HTTP response to write to.
	 * @param statusCode The HTTP status code to answer with.
	 * @param body The object to send as the response body.
	 */
	private static endDiagnosticsResponse(response: Http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
		HttpRoutes.setDiagnosticsCorsHeaders(response);
		response.statusCode = statusCode;
		response.setHeader('content-type', 'application/json');
		response.end(JSON.stringify(body));
	}

	/**
	 * Reads a request body, refusing anything past the diagnostics size limit.
	 *
	 * The limit is enforced while the body arrives rather than after it, so an oversized report
	 * is never fully buffered in memory.
	 *
	 * @param request The incoming HTTP request.
	 * @returns The body as text, or `undefined` when it exceeded the limit.
	 */
	private static readDiagnosticsBody(request: Http.IncomingMessage): Promise<string | undefined> {
		return new Promise((resolve) => {
			const chunks: Buffer[] = [];
			let totalBytes = 0;
			request.on('data', (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > maximumDiagnosticsRequestBytes) {
					// Stop collecting, but leave the connection alone: the caller still has to write
					// the refusal, and destroying the connection here would reach the worker as a
					// connection reset rather than as an answer explaining what was wrong.
					chunks.length = 0;
					resolve(undefined);
					return;
				}
				chunks.push(chunk);
			});
			request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			request.on('error', () => resolve(undefined));
		});
	}

	/**
	 * Reads the path out of a request, refusing any request target this server will not route.
	 *
	 * Only a target naming a path on this server is accepted: one starting with a single slash.
	 * Two leading slashes are refused for two reasons. Such a target cannot be parsed against
	 * this server's own address at all, because a leading `//` names another host rather than a
	 * path, and reaching the parser with one used to end the whole gateway process rather than
	 * the one request. Even parsed successfully it would let the target name a different host
	 * and still be served a page from here.
	 *
	 * @param request The incoming HTTP request.
	 * @returns The requested path, or `undefined` when the request target is not a path on this server.
	 */
	private static requestPathnameOf(request: Http.IncomingMessage): string | undefined {
		const requestTarget = request.url ?? '/';
		if (requestTarget.startsWith('/') === false || requestTarget.startsWith('//')) return undefined;
		try {
			return new URL(requestTarget, `http://${request.headers.host ?? 'localhost'}`).pathname;
		} catch {
			return undefined;
		}
	}

	/**
	 * Reduces a requested path to the spelling the page route table is keyed by, which is the
	 * path without any trailing slash.
	 *
	 * A person typing a page address by hand, and a link written with a trailing slash, both
	 * reach the page rather than a "Not found" answer. The site root is handled separately, as a
	 * redirect, before this is ever reached.
	 *
	 * @param pathname The requested path.
	 * @returns The path to look up in the page route table.
	 */
	private static pageRoutePathnameOf(pathname: string): string {
		const withoutTrailingSlashes = pathname.replace(/\/+$/, '');
		return withoutTrailingSlashes === '' ? '/' : withoutTrailingSlashes;
	}
}
