///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gemma4E2bToolCallReader — reads the tool calls Gemma 4 E2B writes out of its generated text
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The marker that opens a tool call, `stc_token` in the pinned revision's `tokenizer_config.json`.
 *
 * Gemma 4 writes its markers with the bar on the inside of the opening one and on the outside of the closing one,
 * which is the opposite way round from the more usual `<x>` and `</x>` pair, so the two markers of a pair look
 * almost identical and must not be confused with each other.
 */
const TOOL_CALL_OPENING_MARKER = '<|tool_call>';
/** The marker that closes a tool call, `etc_token` in the pinned revision's `tokenizer_config.json`. */
const TOOL_CALL_CLOSING_MARKER = '<tool_call|>';
/**
 * The marker that opens and closes a string value, `escape_token` in the pinned revision's
 * `tokenizer_config.json`.
 *
 * The same marker is used at both ends, so a string is the text between one of these and the next one. This marker
 * is the only thing that tells a string value apart from a number or from `true`, because this format writes no
 * quotation marks of its own.
 */
const STRING_VALUE_MARKER = '<|"|>';
/** The text that stands between the opening marker and the name of the tool being called. */
const CALL_KEYWORD = 'call:';

/** One value read out of the arguments of a tool call, in the shape the OpenAI tool interface asks for. */
export type ToolCallArgumentValue = string | number | boolean | ToolCallArgumentValue[] | { [key: string]: ToolCallArgumentValue };

/** One tool call read out of a generated answer, with whatever could be read out of it. */
export type ToolCallReading = {
	/** The whole text of the call, from the opening marker to the closing one, both markers left out. */
	raw: string;
	/** The name of the tool the model asked for, absent when the name could not be read. */
	name: string | undefined;
	/** The arguments the model filled in, keyed by parameter name. Empty when the call declared none. */
	arguments: Record<string, ToolCallArgumentValue>;
	/** What could not be read, absent when the whole call was read. A call is never dropped for being unreadable. */
	readingError: string | undefined;
	/** Whether the closing marker was found, so an answer cut short is reported as cut short rather than as complete. */
	isClosed: boolean;
};

/**
 * Reads the tool calls Gemma 4 E2B writes into its generated text.
 *
 * The format is the one the chat template of `onnx-community/gemma-4-E2B-it-ONNX` instructs the model to use, read
 * off the rendered prompt rather than assumed:
 *
 * ```text
 * <|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>}<tool_call|>
 * ```
 *
 * It is neither JSON nor the XML-like format Qwen3.5 writes, so `tool_call_reader.ts` of
 * `packages/worker_webpage` cannot read it and this reader cannot read Qwen3.5. Both markers of a tool call, and
 * the marker around every string value, are special tokens in the pinned revision's own `tokenizer.json`, so this
 * reader only ever sees them when the generated text was decoded with `skip_special_tokens: false`.
 *
 * Nothing is dropped for being unreadable. A call this reader cannot read is reported with its
 * {@link ToolCallReading.readingError} filled in and its raw text kept, because a tool call silently thrown away
 * looks exactly like a model that never asked for a tool.
 */
export class Gemma4E2bToolCallReader {
	/**
	 * Reads every tool call in one generated answer.
	 *
	 * @param generatedText The answer as the model wrote it, decoded with `skip_special_tokens: false`.
	 * @returns One reading per opening marker found, in the order they were written.
	 */
	static read(generatedText: string): ToolCallReading[] {
		const readings: ToolCallReading[] = [];
		let searchFrom = 0;
		for (;;) {
			const openingAt = generatedText.indexOf(TOOL_CALL_OPENING_MARKER, searchFrom);
			if (openingAt === -1) {
				return readings;
			}
			const bodyFrom = openingAt + TOOL_CALL_OPENING_MARKER.length;
			const closingAt = generatedText.indexOf(TOOL_CALL_CLOSING_MARKER, bodyFrom);
			const isClosed = closingAt !== -1;
			const raw = isClosed === true ? generatedText.slice(bodyFrom, closingAt) : generatedText.slice(bodyFrom);
			readings.push(Gemma4E2bToolCallReader._readOneCall(raw, isClosed));
			searchFrom = isClosed === true ? closingAt + TOOL_CALL_CLOSING_MARKER.length : generatedText.length;
		}
	}

	/**
	 * Reads one tool call out of the text between the two markers.
	 *
	 * @param raw The text of the call, both markers left out.
	 * @param isClosed Whether the closing marker was found after this call.
	 * @returns What could be read out of the call.
	 */
	private static _readOneCall(raw: string, isClosed: boolean): ToolCallReading {
		const trimmed = raw.trim();
		if (trimmed.startsWith(CALL_KEYWORD) === false) {
			return {
				raw: raw,
				name: undefined,
				arguments: {},
				readingError: `the text between the markers does not start with ${JSON.stringify(CALL_KEYWORD)}`,
				isClosed: isClosed,
			};
		}
		const afterKeyword = trimmed.slice(CALL_KEYWORD.length);
		const bodyOpensAt = afterKeyword.indexOf('{');
		if (bodyOpensAt === -1) {
			return {
				raw: raw,
				name: afterKeyword.trim() === '' ? undefined : afterKeyword.trim(),
				arguments: {},
				readingError: 'the name of the tool is not followed by an opening brace, so no arguments could be read',
				isClosed: isClosed,
			};
		}
		const name = afterKeyword.slice(0, bodyOpensAt).trim();
		const bodyEndsAt = afterKeyword.lastIndexOf('}');
		if (bodyEndsAt === -1 || bodyEndsAt < bodyOpensAt) {
			return {
				raw: raw,
				name: name === '' ? undefined : name,
				arguments: {},
				readingError: 'the arguments are not closed by a brace, so the call was cut short',
				isClosed: isClosed,
			};
		}
		const body = afterKeyword.slice(bodyOpensAt + 1, bodyEndsAt);
		try {
			return {
				raw: raw,
				name: name === '' ? undefined : name,
				arguments: Gemma4E2bToolCallReader._readMappingBody(body),
				readingError: name === '' ? 'the call names no tool' : undefined,
				isClosed: isClosed,
			};
		} catch (error) {
			return {
				raw: raw,
				name: name === '' ? undefined : name,
				arguments: {},
				readingError: error instanceof Error ? error.message : String(error),
				isClosed: isClosed,
			};
		}
	}

	/**
	 * Reads the inside of a pair of braces into named values.
	 *
	 * @param body The text between the braces, the braces themselves left out.
	 * @returns The named values, empty when the body holds nothing.
	 * @throws When a name has no colon after it, or when a value cannot be read.
	 */
	private static _readMappingBody(body: string): Record<string, ToolCallArgumentValue> {
		const named: Record<string, ToolCallArgumentValue> = {};
		let position = 0;
		const rest = (): string => {
			return body.slice(position);
		};
		while (rest().trim() !== '') {
			position += rest().length - rest().trimStart().length;
			const colonAt = body.indexOf(':', position);
			if (colonAt === -1) {
				throw new Error(`the argument name at ${JSON.stringify(rest().slice(0, 40))} has no colon after it`);
			}
			const name = body.slice(position, colonAt).trim();
			position = colonAt + 1;
			const value = Gemma4E2bToolCallReader._readValue(body, position);
			named[name] = value.value;
			position = value.endedAt;
			position += rest().length - rest().trimStart().length;
			if (rest().startsWith(',') === true) {
				position += 1;
			}
		}
		return named;
	}

	/**
	 * Reads one value, starting at the first character of it.
	 *
	 * This format carries its own idea of a type: a string is written between two {@link STRING_VALUE_MARKER}
	 * markers, an object between braces with bare names, an array between square brackets, and everything else as
	 * bare text. So a number arrives as a number and a string arrives as a string, and neither has to be guessed at
	 * from the parameter the tool declared.
	 *
	 * @param body The whole text the value sits in.
	 * @param startAt Where the value starts, spaces allowed before it.
	 * @returns The value, and the position of the first character after it.
	 * @throws When a marker or a bracket is opened and never closed.
	 */
	private static _readValue(body: string, startAt: number): { value: ToolCallArgumentValue; endedAt: number } {
		let position = startAt;
		while (position < body.length && /\s/.test(body.charAt(position)) === true) {
			position += 1;
		}
		if (body.startsWith(STRING_VALUE_MARKER, position) === true) {
			const textFrom = position + STRING_VALUE_MARKER.length;
			const textTo = body.indexOf(STRING_VALUE_MARKER, textFrom);
			if (textTo === -1) {
				throw new Error(`a string value opened at ${position} is never closed`);
			}
			return {
				value: body.slice(textFrom, textTo),
				endedAt: textTo + STRING_VALUE_MARKER.length,
			};
		}
		if (body.charAt(position) === '{') {
			const closingAt = Gemma4E2bToolCallReader._matchingBracketOf(body, position, '{', '}');
			return {
				value: Gemma4E2bToolCallReader._readMappingBody(body.slice(position + 1, closingAt)),
				endedAt: closingAt + 1,
			};
		}
		if (body.charAt(position) === '[') {
			const closingAt = Gemma4E2bToolCallReader._matchingBracketOf(body, position, '[', ']');
			return {
				value: Gemma4E2bToolCallReader._readArrayBody(body.slice(position + 1, closingAt)),
				endedAt: closingAt + 1,
			};
		}
		let endedAt = position;
		while (endedAt < body.length && ',}]'.includes(body.charAt(endedAt)) === false) {
			endedAt += 1;
		}
		return {
			value: Gemma4E2bToolCallReader._readBareValue(body.slice(position, endedAt).trim()),
			endedAt: endedAt,
		};
	}

	/**
	 * Reads the inside of a pair of square brackets into a list of values.
	 *
	 * @param body The text between the brackets, the brackets themselves left out.
	 * @returns The values, in order, empty when the body holds nothing.
	 * @throws When one of the values cannot be read.
	 */
	private static _readArrayBody(body: string): ToolCallArgumentValue[] {
		const values: ToolCallArgumentValue[] = [];
		let position = 0;
		while (body.slice(position).trim() !== '') {
			const value = Gemma4E2bToolCallReader._readValue(body, position);
			values.push(value.value);
			position = value.endedAt;
			while (position < body.length && /\s/.test(body.charAt(position)) === true) {
				position += 1;
			}
			if (body.startsWith(',', position) === true) {
				position += 1;
			}
		}
		return values;
	}

	/**
	 * Reads a value written as bare text, which is every value that is not a string, an object, or an array.
	 *
	 * @param text The bare text of the value, with the surrounding spaces already removed.
	 * @returns `true`, `false`, a number when the text is one, and the text itself otherwise.
	 */
	private static _readBareValue(text: string): ToolCallArgumentValue {
		if (text === 'true') {
			return true;
		}
		if (text === 'false') {
			return false;
		}
		if (text !== '' && Number.isNaN(Number(text)) === false) {
			return Number(text);
		}
		return text;
	}

	/**
	 * Finds the bracket that closes the one at `openingAt`, counting the pairs opened in between.
	 *
	 * @param body The whole text the brackets sit in.
	 * @param openingAt The position of the opening bracket.
	 * @param opening The opening bracket character.
	 * @param closing The closing bracket character.
	 * @returns The position of the matching closing bracket.
	 * @throws When the opening bracket is never closed.
	 */
	private static _matchingBracketOf(body: string, openingAt: number, opening: string, closing: string): number {
		let depth = 0;
		let position = openingAt;
		while (position < body.length) {
			// A string value is stepped over whole, so a bracket written inside one is not counted as a bracket.
			if (body.startsWith(STRING_VALUE_MARKER, position) === true) {
				const textTo = body.indexOf(STRING_VALUE_MARKER, position + STRING_VALUE_MARKER.length);
				if (textTo === -1) {
					throw new Error(`a string value opened at ${position} is never closed`);
				}
				position = textTo + STRING_VALUE_MARKER.length;
				continue;
			}
			const character = body.charAt(position);
			if (character === opening) {
				depth += 1;
			} else if (character === closing) {
				depth -= 1;
				if (depth === 0) {
					return position;
				}
			}
			position += 1;
		}
		throw new Error(`the ${opening} at ${openingAt} is never closed by a ${closing}`);
	}
}
