import type { ToolCall, ToolDeclaration } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Gemma4E2bToolCallReader — reads the tool calls Gemma 4 E2B writes out of its generated text
//
//	This is not `ToolCallReader`, and neither reader can read the other's format. `ToolCallReader`
//	reads what Qwen3.5 writes and nothing else. The two formats share no marker, no shape of
//	arguments, and not even the question of whether a value carries a type, so widening one reader
//	to cover both would produce a reader that is wrong about both.
//
//	The format is the one `onnx-community/gemma-4-E2B-it-ONNX` really writes, recorded character for
//	character in the milestone 0 de-risk gate for
//	[issue #216](https://github.com/webai-at-home/webai-at-home/issues/216) rather than assumed:
//
//	```text
//	<|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>}<tool_call|><|tool_response>
//	```
//
//	Three things about that text are worth stating before any of the code below is read.
//
//	The bar sits **inside** the opening marker and **outside** the closing one, so the two markers of
//	a pair look almost identical and must never be confused with each other.
//
//	Every marker here is an added token of this tokenizer with `special: true`, read off the pinned
//	revision's own `tokenizer.json`: `<|tool_call>` is token 48, `<tool_call|>` is token 49, and the
//	string marker `<|"|>` is token 52. So this reader only ever sees them when the generated text was
//	decoded with `skip_special_tokens: false`. That is the opposite of Qwen3.5, whose markers are
//	`special: false` and survive either decoding.
//
//	There is no `hasCompleteToolCall` here, unlike `ToolCallReader`, because nothing needs to watch
//	for one. The `<|tool_response>` that follows the call is token 50, which this export's own
//	`generation_config.json` names an end-of-sequence token, so the model writes the call, opens the
//	place the tool's answer goes, and stops by itself.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The marker that opens a tool call, `stc_token` in the pinned revision's `tokenizer_config.json`. */
const openingMarker = '<|tool_call>';

/** The marker that closes a tool call, `etc_token` in the pinned revision's `tokenizer_config.json`. */
const closingMarker = '<tool_call|>';

/**
 * The marker that opens and closes a string value, `escape_token` in the pinned revision's
 * `tokenizer_config.json`.
 *
 * The same marker stands at both ends, so a string is the text between one of these and the next
 * one. It is the only thing that tells a string value from a number or from `true`, because this
 * format writes no quotation marks of its own.
 */
const stringValueMarker = '<|"|>';

/** The text that stands between the opening marker and the name of the tool being called. */
const callKeyword = 'call:';

/** One value read out of a tool call's arguments, before it is written back out as text. */
type ReadValue = string | number | boolean | ReadValue[] | { [key: string]: ReadValue };

/** Reads the tool calls a Gemma 4 E2B model wrote out of the text it generated. */
export class Gemma4E2bToolCallReader {
	/**
	 * Reports whether the model has begun writing a tool call.
	 *
	 * A run that has seen this must not report what it has read as an answer, because what it has
	 * read is the opening of a tool call rather than the opening of a sentence.
	 *
	 * @param generatedText Everything the model has written so far, decoded with
	 * `skip_special_tokens: false`.
	 * @returns `true` once an opening marker has appeared.
	 */
	static hasStartedAToolCall(generatedText: string): boolean {
		return generatedText.includes(openingMarker);
	}

	/**
	 * Reads every tool call out of one generated answer.
	 *
	 * A tool call the model wrote incorrectly is reported as a failure naming what could not be
	 * read, never silently dropped and never passed on half-formed. The reason is worth stating: a
	 * calling program that receives a tool call runs it, and a call read wrongly is a call run
	 * wrongly, on the caller's own machine, with the caller's own credentials. Answering "the model
	 * asked for something I could not read" is the only safe answer.
	 *
	 * A call the model was cut off in the middle of is a different case, and is read as far as it
	 * got. It has to be: an answer that ends halfway through a tool call must not read as an answer
	 * written in words, which is what a reader demanding the closing marker would report.
	 *
	 * @param generatedText The whole text the model wrote, decoded with `skip_special_tokens: false`.
	 * @param declaredTools The tools the history declared, used to refuse a call naming a tool that
	 * was never offered.
	 * @returns The tool calls, in the order the model wrote them. Empty when it wrote none, which is
	 * the ordinary case of a model that answered in words.
	 * @throws {Error} If a tool call was opened and could not be read, or names a tool that was
	 * never declared.
	 */
	static read(generatedText: string, declaredTools: readonly ToolDeclaration[]): ToolCall[] {
		if (Gemma4E2bToolCallReader.hasStartedAToolCall(generatedText) === false) {
			return [];
		}
		const declaredNames = new Set(declaredTools.map((tool) => tool.name));
		const toolCalls: ToolCall[] = [];
		let searchFrom = 0;
		for (;;) {
			const openedAt = generatedText.indexOf(openingMarker, searchFrom);
			if (openedAt === -1) {
				break;
			}
			const bodyFrom = openedAt + openingMarker.length;
			const closedAt = generatedText.indexOf(closingMarker, bodyFrom);
			const body = closedAt === -1 ? generatedText.slice(bodyFrom) : generatedText.slice(bodyFrom, closedAt);
			toolCalls.push(Gemma4E2bToolCallReader._readOneCall(body, declaredNames));
			searchFrom = closedAt === -1 ? generatedText.length : closedAt + closingMarker.length;
		}
		if (toolCalls.length === 0) {
			throw new Error(`The model opened a tool call this worker could not read: ${JSON.stringify(generatedText)}.`);
		}
		return toolCalls;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one tool call out of the text between the two markers.
	 *
	 * @param body The text of the call, both markers left out.
	 * @param declaredNames The names of the tools the history declared.
	 * @returns The tool call the model asked for.
	 * @throws {Error} If the text is not a tool call at all, names no tool, or names a tool that was
	 * never declared.
	 */
	private static _readOneCall(body: string, declaredNames: ReadonlySet<string>): ToolCall {
		const trimmed = body.trim();
		if (trimmed.startsWith(callKeyword) === false) {
			throw new Error(`The model opened a tool call this worker could not read: no ${JSON.stringify(callKeyword)} inside ${JSON.stringify(body)}.`);
		}
		const afterKeyword = trimmed.slice(callKeyword.length);
		const argumentsOpenAt = afterKeyword.indexOf('{');
		// A call cut off before its arguments were opened still names a tool, and that name is worth
		// more to a caller than nothing at all.
		const name = (argumentsOpenAt === -1 ? afterKeyword : afterKeyword.slice(0, argumentsOpenAt)).trim();
		if (name === '') {
			throw new Error(`The model asked for a tool with no name, in ${JSON.stringify(body)}.`);
		}
		if (declaredNames.has(name) === false) {
			throw new Error(`The model asked for a tool named ${JSON.stringify(name)}, which this history never declared. The tools declared were ${[...declaredNames].join(', ') || 'none'}.`);
		}
		if (argumentsOpenAt === -1) {
			return {
				name,
				argumentValues: {},
			};
		}
		const argumentsCloseAt = Gemma4E2bToolCallReader._matchingBracketOf(afterKeyword, argumentsOpenAt, '{', '}');
		const argumentsBody = argumentsCloseAt === -1
			? afterKeyword.slice(argumentsOpenAt + 1)
			: afterKeyword.slice(argumentsOpenAt + 1, argumentsCloseAt);
		return {
			name,
			argumentValues: Gemma4E2bToolCallReader._readArgumentValues(argumentsBody, name),
		};
	}

	/**
	 * Reads the inside of a call's braces into the argument text the protocol carries.
	 *
	 * Every value becomes text here, even though this format does say which type the model meant.
	 * That is the shape `ToolCall.argumentValues` defines, and the rule for turning one value into
	 * its text is the one this project already uses in `history_builder.ts` and in
	 * `local_server_generation.ts`: a string is its own characters, and everything else is its JSON.
	 * Converting it back belongs to whichever consumer reads the tool's arguments schema, which is
	 * where the declared type is, and the round trip is exact for every type that schema names.
	 *
	 * @param argumentsBody The text between the call's braces, the braces themselves left out.
	 * @param toolName The tool being called, named in the failure when an argument has no name.
	 * @returns The argument text, keyed by argument name, empty when the call declared none.
	 * @throws {Error} If an argument has no name.
	 */
	private static _readArgumentValues(argumentsBody: string, toolName: string): Record<string, string> {
		const argumentValues: Record<string, string> = {};
		let position = Gemma4E2bToolCallReader._pastSpaces(argumentsBody, 0);
		while (position < argumentsBody.length) {
			const colonAt = argumentsBody.indexOf(':', position);
			// No colon left means the model was cut off partway through writing an argument's name.
			// There is no value to report for it, so the call is reported with the arguments that were
			// written whole.
			if (colonAt === -1) {
				break;
			}
			const argumentName = argumentsBody.slice(position, colonAt).trim();
			if (argumentName === '') {
				throw new Error(`The model gave an argument with no name to ${JSON.stringify(toolName)}.`);
			}
			const read = Gemma4E2bToolCallReader._readValue(argumentsBody, colonAt + 1);
			argumentValues[argumentName] = typeof read.value === 'string' ? read.value : JSON.stringify(read.value);
			position = Gemma4E2bToolCallReader._pastSpaces(argumentsBody, read.endedAt);
			if (argumentsBody.startsWith(',', position) === true) {
				position = Gemma4E2bToolCallReader._pastSpaces(argumentsBody, position + 1);
			}
		}
		return argumentValues;
	}

	/**
	 * Reads one value, starting at the first character of it.
	 *
	 * This format carries its own idea of a type: a string is written between two
	 * {@link stringValueMarker} markers, an object between braces with bare names, an array between
	 * square brackets, and everything else as bare text.
	 *
	 * @param body The whole text the value sits in.
	 * @param startAt Where the value starts, spaces allowed before it.
	 * @returns The value, and the position of the first character after it.
	 */
	private static _readValue(body: string, startAt: number): { value: ReadValue; endedAt: number } {
		const position = Gemma4E2bToolCallReader._pastSpaces(body, startAt);
		if (body.startsWith(stringValueMarker, position) === true) {
			const textFrom = position + stringValueMarker.length;
			const textTo = body.indexOf(stringValueMarker, textFrom);
			// A string the model was cut off in the middle of is read to the end of what it wrote.
			if (textTo === -1) {
				return {
					value: body.slice(textFrom),
					endedAt: body.length,
				};
			}
			return {
				value: body.slice(textFrom, textTo),
				endedAt: textTo + stringValueMarker.length,
			};
		}
		if (body.charAt(position) === '{') {
			const closedAt = Gemma4E2bToolCallReader._matchingBracketOf(body, position, '{', '}');
			const inside = closedAt === -1 ? body.slice(position + 1) : body.slice(position + 1, closedAt);
			return {
				value: Gemma4E2bToolCallReader._readMapping(inside),
				endedAt: closedAt === -1 ? body.length : closedAt + 1,
			};
		}
		if (body.charAt(position) === '[') {
			const closedAt = Gemma4E2bToolCallReader._matchingBracketOf(body, position, '[', ']');
			const inside = closedAt === -1 ? body.slice(position + 1) : body.slice(position + 1, closedAt);
			return {
				value: Gemma4E2bToolCallReader._readList(inside),
				endedAt: closedAt === -1 ? body.length : closedAt + 1,
			};
		}
		let endedAt = position;
		while (endedAt < body.length && ',}]'.includes(body.charAt(endedAt)) === false) {
			endedAt += 1;
		}
		return {
			value: Gemma4E2bToolCallReader._readBareValue(body.slice(position, endedAt).trim()),
			endedAt,
		};
	}

	/**
	 * Reads the inside of a pair of braces into named values.
	 *
	 * @param inside The text between the braces, the braces themselves left out.
	 * @returns The named values, empty when there are none.
	 */
	private static _readMapping(inside: string): Record<string, ReadValue> {
		const named: Record<string, ReadValue> = {};
		let position = Gemma4E2bToolCallReader._pastSpaces(inside, 0);
		while (position < inside.length) {
			const colonAt = inside.indexOf(':', position);
			if (colonAt === -1) {
				break;
			}
			const key = inside.slice(position, colonAt).trim();
			const read = Gemma4E2bToolCallReader._readValue(inside, colonAt + 1);
			named[key] = read.value;
			position = Gemma4E2bToolCallReader._pastSpaces(inside, read.endedAt);
			if (inside.startsWith(',', position) === true) {
				position = Gemma4E2bToolCallReader._pastSpaces(inside, position + 1);
			}
		}
		return named;
	}

	/**
	 * Reads the inside of a pair of square brackets into a list of values.
	 *
	 * @param inside The text between the brackets, the brackets themselves left out.
	 * @returns The values, in the order they were written, empty when there are none.
	 */
	private static _readList(inside: string): ReadValue[] {
		const values: ReadValue[] = [];
		let position = Gemma4E2bToolCallReader._pastSpaces(inside, 0);
		while (position < inside.length) {
			const read = Gemma4E2bToolCallReader._readValue(inside, position);
			values.push(read.value);
			position = Gemma4E2bToolCallReader._pastSpaces(inside, read.endedAt);
			if (inside.startsWith(',', position) === true) {
				position = Gemma4E2bToolCallReader._pastSpaces(inside, position + 1);
			}
		}
		return values;
	}

	/**
	 * Reads a value written as bare text, which is every value that is not a string, an object, or
	 * a list.
	 *
	 * @param text The bare text of the value, with the surrounding spaces already removed.
	 * @returns `true`, `false`, a number when the text is one, and the text itself otherwise.
	 */
	private static _readBareValue(text: string): ReadValue {
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
	 * Finds the bracket that closes the one at `openedAt`, counting the pairs opened in between.
	 *
	 * A string value is stepped over whole, so a bracket the model wrote inside one is not counted
	 * as a bracket.
	 *
	 * @param body The whole text the brackets sit in.
	 * @param openedAt The position of the opening bracket.
	 * @param opening The opening bracket character.
	 * @param closing The closing bracket character.
	 * @returns The position of the matching closing bracket, or `-1` when the model wrote none,
	 * which is what a generation cut short leaves behind.
	 */
	private static _matchingBracketOf(body: string, openedAt: number, opening: string, closing: string): number {
		let depth = 0;
		let position = openedAt;
		while (position < body.length) {
			if (body.startsWith(stringValueMarker, position) === true) {
				const textTo = body.indexOf(stringValueMarker, position + stringValueMarker.length);
				if (textTo === -1) {
					return -1;
				}
				position = textTo + stringValueMarker.length;
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
		return -1;
	}

	/**
	 * Steps past any spaces starting at one position.
	 *
	 * @param body The text being read.
	 * @param startAt Where to start looking.
	 * @returns The position of the first character that is not a space, or the end of the text.
	 */
	private static _pastSpaces(body: string, startAt: number): number {
		let position = startAt;
		while (position < body.length && /\s/.test(body.charAt(position)) === true) {
			position += 1;
		}
		return position;
	}
}
