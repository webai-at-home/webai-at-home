// node imports
import Fs from 'node:fs';
import Http from 'node:http';
import Path from 'node:path';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CurlStyleTransactionLogger — writes one `curl -v`-style block per HTTP transaction
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Whether, and how, the request's key was checked. */
export type TransactionAuthOutcome = 'not_required' | 'ok' | 'failed';

/** How the transaction ended. */
export type TransactionOutcome = 'completed' | 'failed' | 'cancelled';

/** What kind of body the response carried. */
export type TransactionResponseType = 'chat.completion' | 'chat.completion.chunk' | 'response' | 'response.stream' | 'error' | 'none';

/**
 * Everything this server has learned about one `POST /v1/chat/completions` transaction, by the
 * time its response has closed.
 */
export type HttpTransactionInput = {
	/** The identifier of this transaction. */
	id: string;
	/** When the request was received. */
	receivedAt: Date;
	/** The HTTP method of the request. */
	method: string;
	/** The route the request was sent to. */
	path: string;
	/** The HTTP version the request stated. */
	httpVersion: string;
	/** The request's own headers, exactly as received. */
	requestHeaders: Http.IncomingHttpHeaders;
	/** The request body, exactly as received and read by the JSON reader. */
	requestBody: unknown;
	/** The model the request asked for, once the body could be read safely. */
	model: string | undefined;
	/** Whether, and how, the request's key was checked. */
	authOutcome: TransactionAuthOutcome;
	/** The identifier the task was submitted to the central gateway under, once one exists. */
	gatewayTaskRequestId: string | undefined;
	/** The task identifier the central gateway assigned, once one exists. */
	gatewayTaskId: string | undefined;
	/** How the transaction ended. */
	outcome: TransactionOutcome;
	/** The HTTP status returned, or `0` when the caller went away before one was written. */
	status: number;
	/** What kind of body was returned. */
	responseType: TransactionResponseType;
	/** The response body, exactly as sent to the caller. */
	responseBody: unknown;
	/** How long the request took to answer, in milliseconds. */
	elapsedMs: number;
	/** Whether the caller's connection closed before this server finished answering it. */
	isCallerDisconnected: boolean;
};

/**
 * How much of a body is printed before the rest of it is left out, in characters.
 *
 * A body longer than this is cut short and followed by a line naming how much was left out, the
 * way the specification's own "Truncated Bodies" section shows, so one very long prompt or answer
 * cannot make a whole run's log unreadable.
 */
const maximumBodyChars = 4_096;

/** The line printed between one transaction and the next. */
const transactionSeparator = '='.repeat(50);

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Curl Style Transaction Logger
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Records every `POST /v1/chat/completions` transaction as one `curl -v`-style block of plain
 * text, the way that command, a browser's network inspector, or a reverse proxy's access log
 * already shows an HTTP exchange: a `>` line per request field, a `<` line per response field, a
 * blank line between headers and body, and a line naming how long the call took, so a developer
 * reading the log recognises the shape immediately and can copy a block straight into a bug
 * report.
 *
 * This is a human-facing rendering rather than a machine format: it is generated from what this
 * server already knows about a transaction, and nothing here is meant to be parsed back.
 *
 * One block is written per transaction, once its response has closed, rather than one block
 * appearing gradually as the exchange happens: nothing here is complete until the exchange has
 * ended.
 *
 * Nothing is redacted. Every header is printed as received, including `Authorization`, and both
 * bodies are printed as sent, pretty-printed as JSON. The whole point of this log is to explain
 * what a caller actually sent and what it was actually answered, which a redacted line cannot do:
 * a block here can be read, compared with `diff`, and replayed as the request it describes.
 *
 * The only thing this logger holds back is length: a body longer than {@link maximumBodyChars}
 * characters is cut short and followed by a line naming how much was left out, in the shape the
 * specification's own "Truncated Bodies" section shows, so one very long prompt or answer cannot
 * make a whole run's log unreadable.
 *
 * It follows that this file holds the keys presented to this server and every prompt and answer
 * that went through it, in full. It is therefore as sensitive as the credentials and the
 * histories it records, and `logs/` is ignored by git for that reason.
 *
 * A failure while writing a transaction, including one while first creating the log directory,
 * is caught and reported to this server's own output rather than left to escape, so a caller
 * always receives the answer or failure it was owed even when this log cannot be written to.
 */
export class CurlStyleTransactionLogger {
	/**
	 * @param logFilePath Path to the plain text file this logger appends to. Its parent
	 * directory is created automatically if it does not already exist. `undefined` turns this
	 * logger into a no-op, which a test uses when it has no log file to write to.
	 */
	constructor(private readonly logFilePath: string | undefined) {
		if (logFilePath === undefined) {
			return;
		}
		try {
			Fs.mkdirSync(Path.dirname(logFilePath), {
				recursive: true,
			});
		} catch (error: unknown) {
			console.error(
				`This server's own transaction log directory could not be created: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Records one completed transaction.
	 *
	 * @param transaction Everything this server learned about the request and the response it
	 * was given.
	 */
	log(transaction: HttpTransactionInput): void {
		if (this.logFilePath === undefined) {
			return;
		}
		const block = CurlStyleTransactionLogger._blockOf(transaction);
		try {
			Fs.appendFileSync(this.logFilePath, block, 'utf-8');
		} catch (error: unknown) {
			console.error(
				`This server's own transaction log could not be written to: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Renders one whole transaction, separators included.
	 *
	 * @param transaction Everything this server learned about the request and the response it
	 * was given.
	 * @returns The text to append to the log file.
	 */
	private static _blockOf(transaction: HttpTransactionInput): string {
		const lines: string[] = [transactionSeparator, ''];
		lines.push(...CurlStyleTransactionLogger._requestLinesOf(transaction));
		lines.push('');
		lines.push(...CurlStyleTransactionLogger._responseLinesOf(transaction));
		lines.push('');
		lines.push(`Transaction: ${transaction.id}`);
		lines.push(`Duration: ${transaction.elapsedMs} ms`);
		if (transaction.model !== undefined) {
			lines.push(`Model: ${transaction.model}`);
		}
		lines.push(`Auth: ${transaction.authOutcome}`);
		if (transaction.gatewayTaskRequestId !== undefined) {
			lines.push(`Gateway request: ${transaction.gatewayTaskRequestId}`);
		}
		if (transaction.gatewayTaskId !== undefined) {
			lines.push(`Gateway task: ${transaction.gatewayTaskId}`);
		}
		lines.push(`Outcome: ${transaction.outcome}`);
		lines.push('', transactionSeparator, '', '');
		return lines.join('\n');
	}

	/**
	 * Renders the `>` block: the request line, its headers, and its body.
	 *
	 * Node lowercases every incoming header name regardless of how the caller sent it, so that is
	 * what a reader sees here too, unlike `curl -v` reading a real socket.
	 *
	 * @param transaction Everything this server learned about the request and the response it
	 * was given.
	 * @returns The lines of the request block, without a trailing blank line.
	 */
	private static _requestLinesOf(transaction: HttpTransactionInput): string[] {
		const lines = [`> ${transaction.method} ${transaction.path} ${transaction.httpVersion}`];
		for (const [name, value] of Object.entries(transaction.requestHeaders)) {
			for (const oneValue of Array.isArray(value) ? value : [value]) {
				lines.push(`> ${name}: ${oneValue}`);
			}
		}
		lines.push('>');
		lines.push(...CurlStyleTransactionLogger._bodyLinesOf('>', transaction.requestBody));
		return lines;
	}

	/**
	 * Renders the `<` block: the status line, its headers, and its body.
	 *
	 * @param transaction Everything this server learned about the request and the response it
	 * was given.
	 * @returns The lines of the response block, without a trailing blank line.
	 */
	private static _responseLinesOf(transaction: HttpTransactionInput): string[] {
		if (transaction.isCallerDisconnected === true && transaction.responseType === 'none') {
			return ['< (no response: the caller disconnected before one was sent)'];
		}
		const reason = Http.STATUS_CODES[transaction.status] ?? 'Unknown Status';
		// A streamed answer is sent as server-sent events, not as one JSON body, so it states its
		// own content type rather than the one every other response here carries.
		const contentType =
			transaction.responseType === 'chat.completion.chunk' || transaction.responseType === 'response.stream'
				? 'text/event-stream; charset=utf-8'
				: 'application/json';
		const lines = [`< HTTP/1.1 ${transaction.status} ${reason}`, `< content-type: ${contentType}`, '<'];
		lines.push(...CurlStyleTransactionLogger._bodyLinesOf('<', transaction.responseBody));
		return lines;
	}

	/**
	 * Renders one body, exactly as it was sent, pretty-printed as JSON and cut short only when it
	 * runs longer than {@link maximumBodyChars}.
	 *
	 * @param marker The direction marker each line begins with, `>` for a request and `<` for a
	 * response.
	 * @param body The body as it was received or sent. `undefined` means there was none.
	 * @returns The lines of the body, each already carrying the direction marker.
	 */
	private static _bodyLinesOf(marker: string, body: unknown): string[] {
		if (body === undefined) {
			return [];
		}
		const written = JSON.stringify(body, null, 2);
		if (written === undefined) {
			return [];
		}
		if (written.length <= maximumBodyChars) {
			return written.split('\n').map((line) => `${marker} ${line}`);
		}
		const omittedChars = written.length - maximumBodyChars;
		const lines = written.slice(0, maximumBodyChars).split('\n').map((line) => `${marker} ${line}`);
		lines.push(`${marker}`, `${marker} Body truncated (${omittedChars} characters omitted of ${written.length})`);
		return lines;
	}
}
