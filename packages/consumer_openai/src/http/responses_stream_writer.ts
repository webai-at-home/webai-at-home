// npm imports
import type Express from 'express';

// local imports
import type {
	ResponsesOutputItem,
	ResponsesResponse,
	ResponsesUsage,
} from '../api/responses_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResponsesStreamWriter — writes one streamed answer of POST /v1/responses
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Writes one streamed answer of `POST /v1/responses` as named server-sent events.
 *
 * The order of the events, their names, and the fields of each one are not invented here. They are
 * the ones recorded byte for byte between the Codex command-line program and a server it accepts,
 * in `exp_03_prompt_size_measure` of
 * [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):
 *
 * `response.created`, `response.in_progress`, then for each item `response.output_item.added`, its
 * own middle events, and `response.output_item.done`, and finally `response.completed`. A message
 * item carries `response.content_part.added`, one `response.output_text.delta` per piece,
 * `response.output_text.done`, and `response.content_part.done`. A tool call carries
 * `response.function_call_arguments.done`.
 *
 * Every event carries a `sequence_number`, counting from zero across the whole answer.
 */
export class ResponsesStreamWriter {
	/** Where the events are written. */
	private readonly _response: Express.Response;

	/** The answer being built, sent whole in the first, second, and last events. */
	private readonly _answer: ResponsesResponse;

	/** How many events have been written, which numbers the next one. */
	private _sequenceNumber = 0;

	/** How many items have been started, which numbers the next one. */
	private _outputIndex = 0;

	/**
	 * @param response Where the events are written.
	 * @param answer The answer being built, whose `output` and `usage` this writer fills in as the
	 * items are written.
	 */
	constructor(response: Express.Response, answer: ResponsesResponse) {
		this._response = response;
		this._answer = answer;
	}

	/**
	 * Sends the response headers and the two events that open every answer.
	 *
	 * @param extraHeaders Anything else to state in the headers, which can only be stated here: the
	 * headers of a streamed answer are sent with its first event and cannot be set afterwards.
	 * @returns Nothing.
	 */
	start(extraHeaders: Record<string, string> = {}): void {
		this._response.status(200).set({
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			...extraHeaders,
		});
		this._response.flushHeaders();

		this._write('response.created', {
			response: this._answer,
		});
		this._write('response.in_progress', {
			response: this._answer,
		});
	}

	/**
	 * Writes one whole message item, from its opening event to its closing one.
	 *
	 * The text is written as one delta rather than as many, because this server holds the whole
	 * text by the time it writes the item. The streamed pieces of a cluster answer are written by
	 * {@link writeTextPiece} instead, while they arrive.
	 *
	 * @param item The message item to write, already finished.
	 * @returns Nothing.
	 */
	writeMessageItem(item: ResponsesOutputItem): void {
		if (item.type !== 'message') {
			this.writeFunctionCallItem(item);
			return;
		}

		const text = item.content[0]?.text ?? '';
		this.startMessageItem(item.id);
		if (text !== '') {
			this.writeTextPiece(item.id, text);
		}
		this.finishMessageItem(item);
	}

	/**
	 * Writes the two events that open a message item.
	 *
	 * @param itemId The identifier of the item being opened.
	 * @returns Nothing.
	 */
	startMessageItem(itemId: string): void {
		this._write('response.output_item.added', {
			output_index: this._outputIndex,
			item: {
				id: itemId,
				type: 'message',
				status: 'in_progress',
				role: 'assistant',
				content: [],
			},
		});
		this._write('response.content_part.added', {
			item_id: itemId,
			output_index: this._outputIndex,
			content_index: 0,
			part: {
				type: 'output_text',
				text: '',
				annotations: [],
			},
		});
	}

	/**
	 * Writes one piece of the text of the message item being written.
	 *
	 * @param itemId The identifier of that item.
	 * @param piece The piece of text, as the cluster reported it.
	 * @returns Nothing.
	 */
	writeTextPiece(itemId: string, piece: string): void {
		this._write('response.output_text.delta', {
			item_id: itemId,
			output_index: this._outputIndex,
			content_index: 0,
			delta: piece,
		});
	}

	/**
	 * Writes the three events that close a message item, and adds it to the answer.
	 *
	 * @param item The finished item, holding the whole text.
	 * @returns Nothing.
	 */
	finishMessageItem(item: ResponsesOutputItem): void {
		if (item.type !== 'message') {
			return;
		}
		const text = item.content[0]?.text ?? '';

		this._write('response.output_text.done', {
			item_id: item.id,
			output_index: this._outputIndex,
			content_index: 0,
			text: text,
		});
		this._write('response.content_part.done', {
			item_id: item.id,
			output_index: this._outputIndex,
			content_index: 0,
			part: {
				type: 'output_text',
				text: text,
				annotations: [],
			},
		});
		this._write('response.output_item.done', {
			output_index: this._outputIndex,
			item: item,
		});

		this._answer.output.push(item);
		this._outputIndex = this._outputIndex + 1;
	}

	/**
	 * Writes one whole tool call item, from its opening event to its closing one, and adds it to
	 * the answer.
	 *
	 * @param item The tool call item to write, already finished.
	 * @returns Nothing.
	 */
	writeFunctionCallItem(item: ResponsesOutputItem): void {
		if (item.type !== 'function_call') {
			return;
		}

		this._write('response.output_item.added', {
			output_index: this._outputIndex,
			item: {
				id: item.id,
				type: 'function_call',
				status: 'in_progress',
				call_id: item.call_id,
				name: item.name,
				arguments: '',
			},
		});
		this._write('response.function_call_arguments.done', {
			item_id: item.id,
			output_index: this._outputIndex,
			arguments: item.arguments,
		});
		this._write('response.output_item.done', {
			output_index: this._outputIndex,
			item: item,
		});

		this._answer.output.push(item);
		this._outputIndex = this._outputIndex + 1;
	}

	/**
	 * Writes the event that ends a finished answer, and ends the stream.
	 *
	 * @param usage How many tokens the answer cost, absent when the worker reported no counts.
	 * @returns Nothing.
	 */
	finish(usage: ResponsesUsage | undefined): void {
		this._answer.status = 'completed';
		this._answer.completed_at = Math.floor(Date.now() / 1000);
		this._answer.usage = usage ?? null;

		this._write('response.completed', {
			response: this._answer,
		});
		this._response.end();
	}

	/**
	 * Writes the event that ends a failed answer, and ends the stream.
	 *
	 * Once the first event has been written the status line is gone, so there is no HTTP status
	 * left to fail with. The failure is written into the stream instead, which is the rule the
	 * streamed chat completion already follows.
	 *
	 * @param code The error code, as the OpenAI interface spells it.
	 * @param message What went wrong, in words.
	 * @returns Nothing.
	 */
	fail(code: string, message: string): void {
		this._answer.status = 'failed';
		this._answer.completed_at = Math.floor(Date.now() / 1000);
		this._answer.error = {
			code: code,
			message: message,
		};

		this._write('response.failed', {
			response: this._answer,
		});
		this._response.end();
	}

	/** Whether anything has been written yet, which says whether a failure still has a status. */
	get hasWritten(): boolean {
		return this._sequenceNumber > 0;
	}

	/** The answer being built, whose items are added as they are written. */
	get answer(): ResponsesResponse {
		return this._answer;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Writes one event, on its own `event:` line and `data:` line, and numbers it.
	 *
	 * @param eventName The name of the event, which is also its `type` field.
	 * @param fields Everything the event carries besides its name and its number.
	 * @returns Nothing.
	 */
	private _write(eventName: string, fields: Record<string, unknown>): void {
		if (this._response.writableEnded === true) {
			return;
		}

		const event = {
			type: eventName,
			...fields,
			sequence_number: this._sequenceNumber,
		};
		this._sequenceNumber = this._sequenceNumber + 1;
		this._response.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
	}
}
