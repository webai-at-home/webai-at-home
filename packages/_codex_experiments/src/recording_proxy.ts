import Fs from 'node:fs';
import Http from 'node:http';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RecordingProxy — passes every request through to a target model and writes down what went by
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One request the Codex command-line program made, and the answer it received, as written to the
 * recording file. One JSON object per line.
 */
export type RecordedExchange = {
	/** Which request this was within the run, counting from one. */
	exchangeNumber: number;
	/** The request method, such as `POST`. */
	method: string;
	/** The path the request was made to, such as `/v1/responses`. */
	path: string;
	/** The headers of the request, as received. */
	requestHeaders: Record<string, string>;
	/** The whole request body, unchanged. */
	requestBody: string;
	/** The status code the target model answered with. */
	responseStatusCode: number;
	/** The headers of the answer, as received from the target model. */
	responseHeaders: Record<string, string>;
	/** The whole answer body, unchanged, which for a streamed answer is every event of the stream. */
	responseBody: string;
	/** How long the target model took to answer, in milliseconds. */
	milliseconds: number;
};

/**
 * An HTTP server that sits between the Codex command-line program and one target model. It passes
 * every request through unchanged, passes every answer back unchanged, and writes both to a
 * recording file, one JSON object per line. It exists because a measurement of the prompt must be
 * read from the traffic itself and never from what a target model reports about it.
 */
export class RecordingProxy {
	/** The origin of the target model, such as `http://localhost:1234`, without any path. */
	private readonly _upstreamOrigin: string;

	/** The file every exchange is written to, one JSON object per line. */
	private readonly _recordingFilePath: string;

	/** The server passing the traffic through, created when the proxy is started. */
	private _server: Http.Server | null = null;

	/** How many requests have gone through, which numbers each recorded exchange. */
	private _exchangeCount = 0;

	/**
	 * @param upstreamOrigin The origin of the target model, such as `http://localhost:1234`.
	 * @param recordingFilePath The file every exchange is written to, replaced when the proxy starts.
	 */
	constructor(upstreamOrigin: string, recordingFilePath: string) {
		this._upstreamOrigin = upstreamOrigin;
		this._recordingFilePath = recordingFilePath;
	}

	/**
	 * Starts the proxy on a port the operating system chooses, and empties the recording file.
	 *
	 * @returns The port the proxy is listening on.
	 */
	async start(): Promise<number> {
		Fs.writeFileSync(this._recordingFilePath, '');

		this._server = Http.createServer((request, response) => {
			this._passThrough(request, response);
		});
		this._server.timeout = 0;
		this._server.requestTimeout = 0;
		this._server.headersTimeout = 0;

		const server = this._server;
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', () => {
				resolve();
			});
		});

		const address = server.address();
		if (address === null || typeof address === 'string') {
			throw new Error('the recording proxy was given no port by the operating system');
		}
		return address.port;
	}

	/**
	 * Stops the proxy. Every exchange has already been written by the time this returns.
	 *
	 * @returns Nothing.
	 */
	async stop(): Promise<void> {
		if (this._server === null) {
			return;
		}
		const server = this._server;
		this._server = null;
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			server.close(() => {
				resolve();
			});
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one whole request, sends it to the target model unchanged, sends the answer back
	 * unchanged, and writes both to the recording file.
	 *
	 * @param request The request from the Codex command-line program.
	 * @param response The answer being written back to the Codex command-line program.
	 * @returns Nothing.
	 */
	private _passThrough(request: Http.IncomingMessage, response: Http.ServerResponse): void {
		this._exchangeCount = this._exchangeCount + 1;
		const exchangeNumber = this._exchangeCount;
		const requestChunks: Buffer[] = [];

		request.on('data', (chunk: Buffer) => {
			requestChunks.push(chunk);
		});

		request.on('end', () => {
			const requestBody = Buffer.concat(requestChunks).toString('utf8');
			const startedAt = Date.now();
			const upstreamUrl = new URL(request.url ?? '/', this._upstreamOrigin);

			const upstreamRequest = Http.request(
				upstreamUrl,
				{
					method: request.method ?? 'POST',
					headers: {
						...request.headers,
						host: upstreamUrl.host,
					},
				},
				(upstreamResponse) => {
					const responseChunks: Buffer[] = [];
					response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);

					upstreamResponse.on('data', (chunk: Buffer) => {
						responseChunks.push(chunk);
						response.write(chunk);
					});

					upstreamResponse.on('end', () => {
						response.end();
						this._writeExchange({
							exchangeNumber: exchangeNumber,
							method: request.method ?? '',
							path: request.url ?? '',
							requestHeaders: RecordingProxy._flattenHeaders(request.headers),
							requestBody: requestBody,
							responseStatusCode: upstreamResponse.statusCode ?? 0,
							responseHeaders: RecordingProxy._flattenHeaders(upstreamResponse.headers),
							responseBody: Buffer.concat(responseChunks).toString('utf8'),
							milliseconds: Date.now() - startedAt,
						});
					});
				},
			);

			upstreamRequest.on('error', (error: Error) => {
				response.writeHead(502, {
					'content-type': 'text/plain',
				});
				response.end(`the recording proxy could not reach ${this._upstreamOrigin}: ${error.message}`);
				this._writeExchange({
					exchangeNumber: exchangeNumber,
					method: request.method ?? '',
					path: request.url ?? '',
					requestHeaders: RecordingProxy._flattenHeaders(request.headers),
					requestBody: requestBody,
					responseStatusCode: 502,
					responseHeaders: {},
					responseBody: `the recording proxy could not reach ${this._upstreamOrigin}: ${error.message}`,
					milliseconds: Date.now() - startedAt,
				});
			});

			upstreamRequest.setTimeout(0);
			upstreamRequest.end(requestBody);
		});
	}

	/**
	 * Appends one exchange to the recording file.
	 *
	 * @param exchange The request and the answer to write down.
	 * @returns Nothing.
	 */
	private _writeExchange(exchange: RecordedExchange): void {
		Fs.appendFileSync(this._recordingFilePath, `${JSON.stringify(exchange)}\n`);
	}

	/**
	 * Turns the headers of Node.js, whose values may be a list, into plain text values.
	 *
	 * @param headers The headers as Node.js gives them.
	 * @returns The same headers, every value a single piece of text.
	 */
	private static _flattenHeaders(headers: Http.IncomingHttpHeaders): Record<string, string> {
		const flattened: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			if (value === undefined) {
				continue;
			}
			flattened[name] = Array.isArray(value) === true ? value.join(', ') : String(value);
		}
		return flattened;
	}
}
