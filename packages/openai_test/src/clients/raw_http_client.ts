// local imports
import type { CompletionTarget } from '../completion_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RawHttpClient — the one place in this package a request body is written by hand
//
//	Everywhere else in this package the `openai` npm package is the transport, so that the three
//	subcommands stay comparable to each other. This one file is the exception, and it exists
//	because an HTTP status, a response header, a server-sent event's raw text, and an error body's
//	exact shape are the things a conformance test must read, and the official `openai` Node.js
//	package hides every one of them. `OpenaiPackageClient` is the client for the tests that ask the
//	opposite question: does the official package itself keep working against this endpoint.
//	There is no third way to reach an endpoint.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One parsed JSON response, still carrying the HTTP status it arrived with. */
export type RawJsonResponse = {
	/** The HTTP status the endpoint answered with. */
	readonly status: number;
	/** The parsed response body, `undefined` when it was empty or was not valid JSON. */
	readonly json: unknown;
};

/** One server-sent event, exactly as received, still unparsed. */
export type RawStreamEvent = {
	/** This event's raw text, from its first `data:` line up to (not including) the blank line that ends it. */
	readonly rawText: string;
	/** How long after the request was sent this event finished arriving, in milliseconds. */
	readonly arrivedAtMs: number;
};

/** One streamed response, read to its end. */
export type RawStreamResponse = {
	/** The HTTP status the endpoint answered with. */
	readonly status: number;
	/** The response headers, lower-cased, exactly as the endpoint sent them. */
	readonly headers: Record<string, string>;
	/** Every server-sent event received, in arrival order. */
	readonly events: readonly RawStreamEvent[];
};

/** Sends a chat completion request as raw JSON over HTTP, and reads back the raw response. */
export class RawHttpClient {
	/**
	 * @param target The endpoint to send every request to.
	 */
	constructor(private readonly target: CompletionTarget) {}

	/**
	 * Sends `GET /models`.
	 *
	 * @returns The HTTP status, and the parsed response body.
	 */
	async listModels(): Promise<RawJsonResponse> {
		return this._fetchJson(`${this.target.baseUrl}/models`, {
			method: 'GET',
			headers: this._headers(),
		});
	}

	/**
	 * Sends `POST /chat/completions` with `body` serialized exactly as given, so a test that needs
	 * to send a request the OpenAI Chat Completions interface would reject — a missing field, a
	 * wrong type — can do so without this client correcting it first.
	 *
	 * @param body The request body to serialize and send.
	 * @returns The HTTP status, and the parsed response body.
	 */
	async postChatCompletion(body: Record<string, unknown>): Promise<RawJsonResponse> {
		return this._fetchJson(`${this.target.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this._headers(),
			body: JSON.stringify(body),
		});
	}

	/**
	 * Sends `POST /chat/completions` with a request body that is not valid JSON at all, which
	 * `postChatCompletion` cannot do, because it always serializes a well-formed object.
	 *
	 * @param rawBody The literal bytes to send as the request body.
	 * @returns The HTTP status, and the parsed response body.
	 */
	async postMalformedChatCompletion(rawBody: string): Promise<RawJsonResponse> {
		return this._fetchJson(`${this.target.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this._headers(),
			body: rawBody,
		});
	}

	/**
	 * Sends `POST /chat/completions` with `stream: true`, added on top of `body` regardless of
	 * what `body` itself carries, and reads the response as server-sent events to its end.
	 *
	 * @param body The request body to serialize and send, before `stream: true` is added.
	 * @returns The HTTP status, the response headers, and every event received, in arrival order.
	 */
	async postStreamingChatCompletion(body: Record<string, unknown>): Promise<RawStreamResponse> {
		const startedAt = Date.now();
		const abortController = new AbortController();
		const timeoutHandle = setTimeout(() => abortController.abort(), this.target.timeoutMs);
		try {
			const response = await fetch(`${this.target.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: this._headers(),
				body: JSON.stringify({ ...body, stream: true }),
				signal: abortController.signal,
			});
			const headers: Record<string, string> = {};
			response.headers.forEach((value, key) => {
				headers[key] = value;
			});
			if (response.body === null) {
				return { status: response.status, headers, events: [] };
			}
			const events = await this._readServerSentEvents(response.body, startedAt);
			return { status: response.status, headers, events };
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads a response body to its end, splitting it into server-sent events on the blank line
	 * that separates them, and timestamping each event against when the request was sent.
	 *
	 * @param body The response body stream.
	 * @param startedAt When the request was sent, in the same clock `Date.now()` reads.
	 * @returns Every event received, in arrival order.
	 */
	private async _readServerSentEvents(body: ReadableStream<Uint8Array>, startedAt: number): Promise<RawStreamEvent[]> {
		const events: RawStreamEvent[] = [];
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let readResult = await reader.read();
		while (readResult.done === false) {
			buffer += decoder.decode(readResult.value, { stream: true });
			let separatorIndex = buffer.indexOf('\n\n');
			while (separatorIndex !== -1) {
				const rawText = buffer.slice(0, separatorIndex).trim();
				buffer = buffer.slice(separatorIndex + 2);
				if (rawText.length > 0) {
					events.push({ rawText, arrivedAtMs: Date.now() - startedAt });
				}
				separatorIndex = buffer.indexOf('\n\n');
			}
			readResult = await reader.read();
		}
		const trailingText = buffer.trim();
		if (trailingText.length > 0) {
			events.push({ rawText: trailingText, arrivedAtMs: Date.now() - startedAt });
		}
		return events;
	}

	/**
	 * Sends one request and reads back the HTTP status and the parsed body, giving up once
	 * `target.timeoutMs` has passed.
	 *
	 * @param url The full URL to request.
	 * @param init The request method, headers, and body.
	 * @returns The HTTP status, and the parsed response body.
	 */
	private async _fetchJson(url: string, init: RequestInit): Promise<RawJsonResponse> {
		const abortController = new AbortController();
		const timeoutHandle = setTimeout(() => abortController.abort(), this.target.timeoutMs);
		try {
			const response = await fetch(url, { ...init, signal: abortController.signal });
			const text = await response.text();
			let json: unknown = undefined;
			if (text.length > 0) {
				try {
					json = JSON.parse(text);
				} catch {
					json = undefined;
				}
			}
			return { status: response.status, json };
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	/**
	 * Builds the headers every request carries.
	 *
	 * @returns The headers to send.
	 */
	private _headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.target.apiKey}`,
		};
	}
}
