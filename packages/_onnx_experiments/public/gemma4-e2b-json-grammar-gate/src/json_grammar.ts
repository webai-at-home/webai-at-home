///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonGrammar — reads JSON one character at a time, and says what may come next
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where the reader is inside the JSON value it is reading.
 *
 * Every mode names the thing that is expected next, not the thing that was just read, because the
 * only question this file ever answers is whether a character may come next.
 */
export type JsonGrammarMode =
	/** The start of a value is expected. */
	| 'value'
	/** The start of a value is expected, or the closing bracket of an array that is still empty. */
	| 'array_first_value'
	/** The opening quotation mark of the first key is expected, or the closing brace of an object that is still empty. */
	| 'object_first_key'
	/** The opening quotation mark of a key is expected, after a comma inside an object. */
	| 'object_next_key'
	/** The reader is inside a string, between the two quotation marks. */
	| 'string'
	/** The reader has just read a backslash inside a string. */
	| 'string_escape'
	/** The reader has just read `\u` inside a string, and is counting the four hexadecimal digits. */
	| 'string_unicode'
	/** The colon between a key and its value is expected. */
	| 'colon'
	/** A digit is expected, after a minus sign that started a number. */
	| 'number_after_minus'
	/** The number so far is a single zero, which may be followed by a decimal point or an exponent but never by a digit. */
	| 'number_after_zero'
	/** The reader is inside the whole-number part of a number. */
	| 'number_integer'
	/** A digit is expected, after the decimal point of a number. */
	| 'number_after_point'
	/** The reader is inside the fractional part of a number. */
	| 'number_fraction'
	/** A sign or a digit is expected, after the `e` of a number. */
	| 'number_after_exponent'
	/** A digit is expected, after the sign of an exponent. */
	| 'number_after_exponent_sign'
	/** The reader is inside the exponent of a number. */
	| 'number_exponent'
	/** The reader is inside `true`, `false`, or `null`. */
	| 'literal'
	/** A value has just been finished, so a comma or a closing bracket is expected, or nothing at all. */
	| 'after_value';

/** One container the reader is inside, innermost last. */
export type JsonContainer = 'object' | 'array';

/**
 * Everything the reader remembers about the JSON it has read so far.
 *
 * It is a plain object of primitives and one array on purpose: {@link JsonGrammar.copy} is called
 * once per candidate token of the vocabulary at every generation step, so a state that is cheap to
 * copy is the difference between a usable processor and an unusable one.
 */
export type JsonGrammarState = {
	/** What the reader expects next. */
	mode: JsonGrammarMode;
	/** The containers the reader is inside, outermost first. */
	stack: JsonContainer[];
	/** Whether the string being read is an object key rather than a value. */
	isReadingKey: boolean;
	/** How many of the four hexadecimal digits of a `\uXXXX` escape have been read. */
	unicodeDigitCount: number;
	/** The literal being read, `true`, `false`, or `null`, and an empty string when none is being read. */
	literalText: string;
	/** How many characters of {@link JsonGrammarState.literalText} have been read. */
	literalIndex: number;
	/** Whether the whole answer has to be one object, which is what `json_object` asks for. */
	isTopLevelObjectRequired: boolean;
};

/** What one character turned out to be, when the reader was inside a number. */
type NumberCharacterVerdict = 'accepted' | 'ends_the_number' | 'illegal';

/** The characters JSON allows between one token of the text and the next. */
const WHITESPACE_CHARACTERS = ' \t\n\r';

/** The two-character escapes JSON allows after a backslash, without counting `\u`. */
const SIMPLE_ESCAPE_CHARACTERS = '"\\/bfnrt';

/**
 * Reads JSON one character at a time and says, at every point, which characters may come next.
 *
 * This is the smallest thing that can enforce a shape during generation. Constraining output means
 * masking the vocabulary between the logits and the choice of token, and masking the vocabulary
 * means answering, for every entry of the vocabulary, whether the text of that entry may legally
 * continue the answer written so far. That question is this file, and nothing else here knows
 * anything about tokens, logits, or models.
 *
 * The grammar is JSON as [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) states it, with one
 * narrowing that {@link JsonGrammarState.isTopLevelObjectRequired} turns on: the whole answer has
 * to be one object, which is what the OpenAI Chat Completions interface's `json_object` asks for.
 * Whitespace is allowed wherever JSON allows it, which does let a model write a long run of spaces
 * rather than finishing; that is a property of the grammar and is left in, because a grammar that
 * quietly forbids what JSON allows is a grammar nobody can reason about.
 *
 * Written for milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219), which is the de-risk
 * gate of [issue #218](https://github.com/webai-at-home/webai-at-home/issues/218). It lives here
 * rather than in `packages/worker_webpage` because no working package may import from
 * `packages/_onnx_experiments`, and milestone 1 writes the worker's own reader.
 */
export class JsonGrammar {
	/**
	 * The state of a reader that has read nothing yet.
	 *
	 * @param isTopLevelObjectRequired Whether the whole answer has to be one object, as `json_object`
	 * asks for, rather than any JSON value.
	 * @returns A fresh state.
	 */
	static initialState(isTopLevelObjectRequired: boolean): JsonGrammarState {
		return {
			mode: 'value',
			stack: [],
			isReadingKey: false,
			unicodeDigitCount: 0,
			literalText: '',
			literalIndex: 0,
			isTopLevelObjectRequired: isTopLevelObjectRequired,
		};
	}

	/**
	 * Copies a state, so a candidate can be tried without disturbing the reader.
	 *
	 * @param state The state to copy.
	 * @returns A state that reads on from the same point.
	 */
	static copy(state: JsonGrammarState): JsonGrammarState {
		return {
			mode: state.mode,
			stack: [...state.stack],
			isReadingKey: state.isReadingKey,
			unicodeDigitCount: state.unicodeDigitCount,
			literalText: state.literalText,
			literalIndex: state.literalIndex,
			isTopLevelObjectRequired: state.isTopLevelObjectRequired,
		};
	}

	/**
	 * Whether the value being read is finished, so that nothing more may be written.
	 *
	 * @param state The reader's state.
	 * @returns `true` when a complete JSON value has been read and no container is still open.
	 */
	static isComplete(state: JsonGrammarState): boolean {
		if (state.stack.length > 0) {
			return false;
		}
		return state.mode === 'after_value' || JsonGrammar.isFinishedNumberMode(state.mode);
	}

	/**
	 * Reads one character, moving the state on when the character is legal.
	 *
	 * The state is changed in place, and an illegal character may still have moved part of it: a
	 * number is finished by the first character that cannot be part of it, so a character that ends
	 * a number and is then itself refused leaves the reader past the number. Every caller here works
	 * on a copy and throws the copy away when the answer is `false`, which is why that costs nothing.
	 *
	 * @param state The reader's state, changed in place.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	static acceptCharacter(state: JsonGrammarState, character: string): boolean {
		if (JsonGrammar.isNumberMode(state.mode) === true) {
			const verdict = JsonGrammar._readNumberCharacter(state, character);
			if (verdict === 'accepted') {
				return true;
			}
			if (verdict === 'illegal') {
				return false;
			}
			// The character is not part of a number, so the number is finished and the character is
			// read again as whatever comes after a value.
			state.mode = 'after_value';
		}
		switch (state.mode) {
			case 'value':
			case 'array_first_value':
				return JsonGrammar._readValueCharacter(state, character);
			case 'object_first_key':
				if (WHITESPACE_CHARACTERS.includes(character) === true) {
					return true;
				}
				if (character === '"') {
					state.mode = 'string';
					state.isReadingKey = true;
					return true;
				}
				if (character === '}') {
					return JsonGrammar._closeContainer(state, 'object');
				}
				return false;
			case 'object_next_key':
				if (WHITESPACE_CHARACTERS.includes(character) === true) {
					return true;
				}
				if (character === '"') {
					state.mode = 'string';
					state.isReadingKey = true;
					return true;
				}
				return false;
			case 'colon':
				if (WHITESPACE_CHARACTERS.includes(character) === true) {
					return true;
				}
				if (character === ':') {
					state.mode = 'value';
					return true;
				}
				return false;
			case 'string':
				return JsonGrammar._readStringCharacter(state, character);
			case 'string_escape':
				if (SIMPLE_ESCAPE_CHARACTERS.includes(character) === true) {
					state.mode = 'string';
					return true;
				}
				if (character === 'u') {
					state.mode = 'string_unicode';
					state.unicodeDigitCount = 0;
					return true;
				}
				return false;
			case 'string_unicode':
				if (JsonGrammar._isHexadecimalDigit(character) === false) {
					return false;
				}
				state.unicodeDigitCount = state.unicodeDigitCount + 1;
				if (state.unicodeDigitCount === 4) {
					state.mode = 'string';
				}
				return true;
			case 'literal':
				if (character !== state.literalText[state.literalIndex]) {
					return false;
				}
				state.literalIndex = state.literalIndex + 1;
				if (state.literalIndex === state.literalText.length) {
					state.mode = 'after_value';
					state.literalText = '';
					state.literalIndex = 0;
				}
				return true;
			case 'after_value':
				return JsonGrammar._readCharacterAfterValue(state, character);
			default:
				return false;
		}
	}

	/**
	 * Reads a whole piece of text, without disturbing the reader.
	 *
	 * This is the question asked of every entry of the vocabulary at every generation step: may the
	 * text of this entry legally continue the answer written so far?
	 *
	 * @param state The reader's state, left untouched.
	 * @param text The text to try.
	 * @returns `true` when every character of the text may legally come next, in order.
	 */
	static acceptsText(state: JsonGrammarState, text: string): boolean {
		const candidate = JsonGrammar.copy(state);
		for (const character of text) {
			if (JsonGrammar.acceptCharacter(candidate, character) === false) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Reads a whole piece of text, moving the state on when every character of it is legal.
	 *
	 * @param state The reader's state, changed in place only when the whole text is legal.
	 * @param text The text to read.
	 * @returns `true` when the whole text was read.
	 */
	static acceptText(state: JsonGrammarState, text: string): boolean {
		const candidate = JsonGrammar.copy(state);
		for (const character of text) {
			if (JsonGrammar.acceptCharacter(candidate, character) === false) {
				return false;
			}
		}
		state.mode = candidate.mode;
		state.stack = candidate.stack;
		state.isReadingKey = candidate.isReadingKey;
		state.unicodeDigitCount = candidate.unicodeDigitCount;
		state.literalText = candidate.literalText;
		state.literalIndex = candidate.literalIndex;
		return true;
	}

	/**
	 * A short text naming everything about a state that decides which characters may come next.
	 *
	 * Two states with the same signature accept exactly the same set of texts, so a mask worked out
	 * for one may be reused for the other. The whole stack is part of the signature and not only its
	 * innermost container, because a single token may carry several closing brackets and so may
	 * reach further down the stack than one level.
	 *
	 * @param state The reader's state.
	 * @returns A text that is equal for two states exactly when they accept the same texts.
	 */
	static signatureOf(state: JsonGrammarState): string {
		return [
			state.mode,
			state.stack.join(''),
			String(state.isReadingKey),
			String(state.unicodeDigitCount),
			state.literalText,
			String(state.literalIndex),
			String(state.isTopLevelObjectRequired),
		].join('|');
	}

	/**
	 * Whether a mode means the reader is inside a number.
	 *
	 * @param mode The mode to ask about.
	 * @returns `true` for every mode that reads part of a number.
	 */
	static isNumberMode(mode: JsonGrammarMode): boolean {
		return mode.startsWith('number_');
	}

	/**
	 * Whether a mode means the reader is inside a number that is already a complete number.
	 *
	 * A number has no closing bracket, so it is finished by the first character that cannot be part
	 * of it. `1` and `1.5` and `1e9` are complete; `1.` and `-` and `1e` are not.
	 *
	 * @param mode The mode to ask about.
	 * @returns `true` when the number read so far could stop where it is.
	 */
	static isFinishedNumberMode(mode: JsonGrammarMode): boolean {
		return mode === 'number_after_zero'
			|| mode === 'number_integer'
			|| mode === 'number_fraction'
			|| mode === 'number_exponent';
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one character where the start of a value is expected.
	 *
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readValueCharacter(state: JsonGrammarState, character: string): boolean {
		if (WHITESPACE_CHARACTERS.includes(character) === true) {
			return true;
		}
		if (state.mode === 'array_first_value' && character === ']') {
			return JsonGrammar._closeContainer(state, 'array');
		}
		// The one narrowing of JSON this grammar makes: `json_object` asks for an object, so at the
		// top level nothing but an object may start.
		const isTopLevel = state.stack.length === 0;
		if (isTopLevel === true && state.isTopLevelObjectRequired === true && character !== '{') {
			return false;
		}
		if (character === '{') {
			state.stack.push('object');
			state.mode = 'object_first_key';
			return true;
		}
		if (character === '[') {
			state.stack.push('array');
			state.mode = 'array_first_value';
			return true;
		}
		if (character === '"') {
			state.mode = 'string';
			state.isReadingKey = false;
			return true;
		}
		if (character === '-') {
			state.mode = 'number_after_minus';
			return true;
		}
		if (character === '0') {
			state.mode = 'number_after_zero';
			return true;
		}
		if (character >= '1' && character <= '9') {
			state.mode = 'number_integer';
			return true;
		}
		for (const literalText of ['true', 'false', 'null']) {
			if (character === literalText[0]) {
				state.mode = 'literal';
				state.literalText = literalText;
				state.literalIndex = 1;
				return true;
			}
		}
		return false;
	}

	/**
	 * Reads one character where the reader is inside a string.
	 *
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readStringCharacter(state: JsonGrammarState, character: string): boolean {
		if (character === '"') {
			state.mode = state.isReadingKey === true ? 'colon' : 'after_value';
			state.isReadingKey = false;
			return true;
		}
		if (character === '\\') {
			state.mode = 'string_escape';
			return true;
		}
		// JSON forbids an unescaped control character inside a string, which is what stops a model
		// from writing a raw newline in the middle of one.
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 0x20) {
			return false;
		}
		return true;
	}

	/**
	 * Reads one character where a value has just been finished.
	 *
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readCharacterAfterValue(state: JsonGrammarState, character: string): boolean {
		if (WHITESPACE_CHARACTERS.includes(character) === true) {
			return true;
		}
		const container = state.stack.at(-1);
		if (container === 'object') {
			if (character === ',') {
				state.mode = 'object_next_key';
				return true;
			}
			if (character === '}') {
				return JsonGrammar._closeContainer(state, 'object');
			}
			return false;
		}
		if (container === 'array') {
			if (character === ',') {
				state.mode = 'value';
				return true;
			}
			if (character === ']') {
				return JsonGrammar._closeContainer(state, 'array');
			}
			return false;
		}
		// No container is open, so the whole value is finished and nothing more may be written.
		return false;
	}

	/**
	 * Reads one character where the reader is inside a number.
	 *
	 * @param state The reader's state, changed in place when the character is part of the number.
	 * @param character The character to read.
	 * @returns What the character turned out to be.
	 */
	private static _readNumberCharacter(state: JsonGrammarState, character: string): NumberCharacterVerdict {
		const isDigit = character >= '0' && character <= '9';
		const isExponentMark = character === 'e' || character === 'E';
		switch (state.mode) {
			case 'number_after_minus':
				if (isDigit === false) {
					return 'illegal';
				}
				state.mode = character === '0' ? 'number_after_zero' : 'number_integer';
				return 'accepted';
			case 'number_after_zero':
				// A digit after a leading zero is illegal JSON, and saying `ends_the_number` here is
				// what refuses it: a digit is not legal after a value either.
				if (character === '.') {
					state.mode = 'number_after_point';
					return 'accepted';
				}
				if (isExponentMark === true) {
					state.mode = 'number_after_exponent';
					return 'accepted';
				}
				return 'ends_the_number';
			case 'number_integer':
				if (isDigit === true) {
					return 'accepted';
				}
				if (character === '.') {
					state.mode = 'number_after_point';
					return 'accepted';
				}
				if (isExponentMark === true) {
					state.mode = 'number_after_exponent';
					return 'accepted';
				}
				return 'ends_the_number';
			case 'number_after_point':
				if (isDigit === false) {
					return 'illegal';
				}
				state.mode = 'number_fraction';
				return 'accepted';
			case 'number_fraction':
				if (isDigit === true) {
					return 'accepted';
				}
				if (isExponentMark === true) {
					state.mode = 'number_after_exponent';
					return 'accepted';
				}
				return 'ends_the_number';
			case 'number_after_exponent':
				if (character === '+' || character === '-') {
					state.mode = 'number_after_exponent_sign';
					return 'accepted';
				}
				if (isDigit === false) {
					return 'illegal';
				}
				state.mode = 'number_exponent';
				return 'accepted';
			case 'number_after_exponent_sign':
				if (isDigit === false) {
					return 'illegal';
				}
				state.mode = 'number_exponent';
				return 'accepted';
			case 'number_exponent':
				return isDigit === true ? 'accepted' : 'ends_the_number';
			default:
				return 'illegal';
		}
	}

	/**
	 * Closes the innermost container, when it is the one being closed.
	 *
	 * @param state The reader's state, changed in place when the container matches.
	 * @param container The container the closing bracket belongs to.
	 * @returns `true` when the innermost open container is the one named.
	 */
	private static _closeContainer(state: JsonGrammarState, container: JsonContainer): boolean {
		if (state.stack.at(-1) !== container) {
			return false;
		}
		state.stack.pop();
		state.mode = 'after_value';
		return true;
	}

	/**
	 * Whether a character is one of the sixteen hexadecimal digits.
	 *
	 * @param character The character to ask about.
	 * @returns `true` for `0` to `9`, `a` to `f`, and `A` to `F`.
	 */
	private static _isHexadecimalDigit(character: string): boolean {
		return (character >= '0' && character <= '9')
			|| (character >= 'a' && character <= 'f')
			|| (character >= 'A' && character <= 'F');
	}
}
