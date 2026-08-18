///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonResponseReader — narrows an unknown parsed JSON response body, so a field can be read from
//	it without `any`, and so every test reads the same three shapes the same way
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Reads the shapes a chat completion response body, or an OpenAI-style error body, can hold. */
export class JsonResponseReader {
	/**
	 * Narrows an unknown JSON value to a record.
	 *
	 * @param value The value to narrow.
	 * @returns The value as a record, `undefined` when it is not a non-null object.
	 */
	static asRecord(value: unknown): Record<string, unknown> | undefined {
		if (typeof value === 'object' && value !== null) {
			return value as Record<string, unknown>;
		}
		return undefined;
	}

	/**
	 * Reads `choices[0]` out of a chat completion response body.
	 *
	 * @param json The parsed response body.
	 * @returns The first choice, `undefined` when `choices` is missing, empty, or not an array.
	 */
	static firstChoice(json: unknown): Record<string, unknown> | undefined {
		const choices = JsonResponseReader.asRecord(json)?.['choices'];
		if (Array.isArray(choices) === false || choices.length === 0) {
			return undefined;
		}
		return JsonResponseReader.asRecord(choices[0]);
	}

	/**
	 * Reads `choices[0].message.content` out of a chat completion response body.
	 *
	 * @param json The parsed response body.
	 * @returns The message content, `undefined` when it is missing or not a string.
	 */
	static messageContent(json: unknown): string | undefined {
		const message = JsonResponseReader.asRecord(JsonResponseReader.firstChoice(json)?.['message']);
		const content = message?.['content'];
		return typeof content === 'string' ? content : undefined;
	}

	/**
	 * Reads `choices[0].delta.content` out of one streamed chunk.
	 *
	 * @param json One streamed chunk's parsed `data:` payload.
	 * @returns The delta's content, `undefined` when it is missing or not a string.
	 */
	static deltaContent(json: unknown): string | undefined {
		const delta = JsonResponseReader.asRecord(JsonResponseReader.firstChoice(json)?.['delta']);
		const content = delta?.['content'];
		return typeof content === 'string' ? content : undefined;
	}

	/**
	 * Reads `choices[0].finish_reason` out of a chat completion response body, or one streamed chunk.
	 *
	 * @param json The parsed response body, or one streamed chunk's parsed `data:` payload.
	 * @returns The finish reason, `undefined` when it is missing, `null`, or not a string.
	 */
	static finishReason(json: unknown): string | undefined {
		const finishReason = JsonResponseReader.firstChoice(json)?.['finish_reason'];
		return typeof finishReason === 'string' ? finishReason : undefined;
	}

	/**
	 * Reads `usage` out of a chat completion response body.
	 *
	 * @param json The parsed response body.
	 * @returns The usage object, `undefined` when it is missing or not an object.
	 */
	static usage(json: unknown): Record<string, unknown> | undefined {
		return JsonResponseReader.asRecord(JsonResponseReader.asRecord(json)?.['usage']);
	}

	/**
	 * Reads `error` out of an OpenAI-style error response body.
	 *
	 * @param json The parsed response body.
	 * @returns The error object, `undefined` when it is missing or not an object.
	 */
	static errorBody(json: unknown): Record<string, unknown> | undefined {
		return JsonResponseReader.asRecord(JsonResponseReader.asRecord(json)?.['error']);
	}
}
