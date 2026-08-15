// local imports
import type { CompletionTarget } from '@webai/openai-api-tool/completion_types';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RawHttpClient — the one place in this package a request body is written by hand
//
//	`@webai/openai-api-tool` forbids exactly this: its own rule is that the `openai` npm package
//	is its single transport, so that its six subcommands stay comparable to each other. This
//	package exists for the opposite reason — an HTTP status, a response header, a server-sent
//	event's raw text, and an error body's exact shape are the things a conformance test must
//	read, and the official `openai` Node.js package hides every one of them. `OpenaiPackageClient`
//	is the client for the tests that ask the opposite question: does the official package itself
//	keep working against this endpoint.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** One parsed JSON response, still carrying the HTTP status it arrived with. */
export type RawJsonResponse = {
	/** The HTTP status the endpoint answered with. */
	readonly status: number;
	/** The parsed response body, `undefined` when it was empty or was not valid JSON. */
	readonly json: unknown;
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

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

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
