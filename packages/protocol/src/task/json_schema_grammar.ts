import type { CompiledSchemaNode } from './json_schema_compiler.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonSchemaGrammar — reads JSON against a compiled schema, and says what may come next
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where the reader is inside the JSON value it is reading.
 *
 * Every mode names the thing that is expected next, not the thing that was just read, because the
 * only question this file ever answers is whether a character may come next.
 */
export type JsonSchemaGrammarMode =
	/** The start of a value is expected. */
	| 'value'
	/** The start of a value is expected, or the closing bracket of an array that is still empty. */
	| 'array_first_value'
	/** The opening quotation mark of the first key is expected, or the closing brace of an empty object. */
	| 'object_first_key'
	/** The opening quotation mark of a key is expected, after a comma inside an object. */
	| 'object_next_key'
	/** The reader is inside a string, between the two quotation marks. */
	| 'string'
	/** The reader has just read a backslash inside a string. */
	| 'string_escape'
	/** The reader has just read `\u` inside a string, and is counting the four hexadecimal digits. */
	| 'string_unicode'
	/** The reader is writing out one of a fixed set of texts, which is what a key or an enumeration is. */
	| 'chosen_text'
	/** The colon between a key and its value is expected. */
	| 'colon'
	/** A digit is expected, after a minus sign that started a number. */
	| 'number_after_minus'
	/** The number so far is a single zero, which may be followed by a point or an exponent but never a digit. */
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

/**
 * Everything the reader remembers about the JSON it has read so far.
 *
 * Every field is a number, a short string, or a small array of numbers, because
 * {@link JsonSchemaGrammar.copy} is called once per entry of a vocabulary of 262144 at every
 * generation step. Nothing here holds a schema node: a node is named by its index into the compiled
 * array, which is shared and never copied.
 */
export type JsonSchemaGrammarState = {
	/** What the reader expects next. */
	mode: JsonSchemaGrammarMode;
	/** The node index of the value being read, or about to be read, and `-1` when the schema says nothing about it. */
	valueNodeIndex: number;
	/** Which kind of container the reader is inside, outermost first. */
	containerKinds: JsonContainer[];
	/** The node index of each container the reader is inside, outermost first, and `-1` for one the schema says nothing about. */
	containerNodeIndexes: number[];
	/** Which declared properties have been written in each open object, one bit per property. */
	writtenPropertyMasks: number[];
	/** Which property the value now being read belongs to, in each open object, or `-1` for an array. */
	openPropertyIndexes: number[];
	/** While writing one of a fixed set of texts, which of them are still possible, one bit each. */
	chosenTextMask: number;
	/** How many characters of that text have been written. */
	chosenTextIndex: number;
	/** Whether the fixed set being written is an object's key rather than an enumerated value. */
	isChoosingKey: boolean;
	/** Whether the free string being read is an object key rather than a value. */
	isReadingKey: boolean;
	/** How many of the four hexadecimal digits of a `\uXXXX` escape have been read. */
	unicodeDigitCount: number;
	/** The literal being read, `true`, `false`, or `null`, and an empty string when none is being read. */
	literalText: string;
	/** How many characters of {@link JsonSchemaGrammarState.literalText} have been read. */
	literalIndex: number;
};

/** One container the reader is inside, innermost last. */
export type JsonContainer = 'object' | 'array';

/** What one character turned out to be, when the reader was inside a number, or writing a chosen text. */
type NumberCharacterVerdict = 'accepted' | 'ends_the_number' | 'illegal';

/** The characters JSON allows between one token of the text and the next. */
const WHITESPACE_CHARACTERS = ' \t\n\r';

/** The two-character escapes JSON allows after a backslash, without counting `\u`. */
const SIMPLE_ESCAPE_CHARACTERS = '"\\/bfnrt';

/**
 * Reads JSON one character at a time against a compiled schema, and says which characters may come
 * next.
 *
 * This is the one place in the project that says what a response format means. Three readers ask it
 * the same question and must get the same answer, which is why it lives in the protocol rather than
 * in one of them:
 *
 * - `@webai/consumer-openai` refuses, at submission, a schema no worker could enforce.
 * - The worker browser tab masks every token this reader would refuse, so the model cannot write an
 *   answer the schema forbids.
 * - The native worker asks its local server for the schema and reads this reader over the answer
 *   that came back, so a server that ignored the schema is caught rather than believed.
 *
 * A `json_object` request is the schema `{ "type": "object" }` and goes through the same reader, so
 * there is one grammar and not two.
 *
 * It is a pushdown reader over JSON, narrowed at every point by what the schema allows there. Where
 * a plain JSON reader asks only whether a character is legal JSON, this one asks whether it is legal
 * JSON **and** allowed by the node the reader is inside.
 *
 * The three places the schema narrows anything:
 *
 * - **Which value may start.** A node of kind `string` lets a value start only with a quotation
 *   mark, a node of kind `integer` only with a minus sign or a digit, and so on.
 * - **Which key may be written.** An object whose schema closed its properties may write only a key
 *   it declared and has not written yet, so the key is one of a fixed set of texts rather than a
 *   free string.
 * - **When an object may close.** A closing brace is legal only once every required property has
 *   been written.
 *
 * An enumeration is the same mechanism as a key: a fixed set of texts, written one character at a
 * time, with the still-possible members tracked as a bit each. That is why `"celsius"`, `42`, and
 * `true` are all enforced by the same few lines.
 */
export class JsonSchemaGrammar {
	/**
	 * The state of a reader that has read nothing yet.
	 *
	 * @param rootNodeIndex The node index of the whole answer's schema, which is `0` for a compiled
	 * document.
	 * @returns A fresh state.
	 */
	static initialState(rootNodeIndex: number): JsonSchemaGrammarState {
		return {
			mode: 'value',
			valueNodeIndex: rootNodeIndex,
			containerKinds: [],
			containerNodeIndexes: [],
			writtenPropertyMasks: [],
			openPropertyIndexes: [],
			chosenTextMask: 0,
			chosenTextIndex: 0,
			isChoosingKey: false,
			isReadingKey: false,
			unicodeDigitCount: 0,
			literalText: '',
			literalIndex: 0,
		};
	}

	/**
	 * Copies a state, so a candidate can be tried without disturbing the reader.
	 *
	 * @param state The state to copy.
	 * @returns A state that reads on from the same point.
	 */
	static copy(state: JsonSchemaGrammarState): JsonSchemaGrammarState {
		return {
			mode: state.mode,
			valueNodeIndex: state.valueNodeIndex,
			containerKinds: [...state.containerKinds],
			containerNodeIndexes: [...state.containerNodeIndexes],
			writtenPropertyMasks: [...state.writtenPropertyMasks],
			openPropertyIndexes: [...state.openPropertyIndexes],
			chosenTextMask: state.chosenTextMask,
			chosenTextIndex: state.chosenTextIndex,
			isChoosingKey: state.isChoosingKey,
			isReadingKey: state.isReadingKey,
			unicodeDigitCount: state.unicodeDigitCount,
			literalText: state.literalText,
			literalIndex: state.literalIndex,
		};
	}

	/**
	 * Whether the value being read is finished, so that nothing more may be written.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state.
	 * @returns `true` when a complete value has been read and no container is still open.
	 */
	static isComplete(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState): boolean {
		if (state.containerKinds.length > 0) {
			return false;
		}
		if (state.mode === 'after_value' || JsonSchemaGrammar.isFinishedNumberMode(state.mode) === true) {
			return true;
		}
		return state.mode === 'chosen_text' && JsonSchemaGrammar._isChosenTextFinished(nodes, state);
	}

	/**
	 * Reads one character, moving the state on when the character is legal.
	 *
	 * The state is changed in place, and an illegal character may still have moved part of it: a
	 * number and an enumerated value are both finished by the first character that cannot be part of
	 * them, so a character that ends one and is then itself refused leaves the reader past the value.
	 * Every caller here works on a copy and throws the copy away when the answer is `false`.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	static acceptCharacter(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): boolean {
		if (JsonSchemaGrammar.isNumberMode(state.mode) === true) {
			const verdict = JsonSchemaGrammar._readNumberCharacter(nodes, state, character);
			if (verdict === 'accepted') {
				return true;
			}
			if (verdict === 'illegal') {
				return false;
			}
			state.mode = 'after_value';
		}
		if (state.mode === 'chosen_text') {
			const verdict = JsonSchemaGrammar._readChosenTextCharacter(nodes, state, character);
			if (verdict === 'accepted') {
				return true;
			}
			if (verdict === 'illegal') {
				return false;
			}
			// Every text of the set is written out, so the value is finished and the character is read
			// again as whatever comes after one. A key reaches this only through its closing quotation
			// mark, which `_readChosenTextCharacter` handles itself, so only a value arrives here.
			state.mode = 'after_value';
		}
		switch (state.mode) {
			case 'value':
			case 'array_first_value':
				return JsonSchemaGrammar._readValueCharacter(nodes, state, character);
			case 'object_first_key':
			case 'object_next_key':
				return JsonSchemaGrammar._readKeyStartCharacter(nodes, state, character);
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
				return JsonSchemaGrammar._readStringCharacter(state, character);
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
				if (JsonSchemaGrammar._isHexadecimalDigit(character) === false) {
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
				return JsonSchemaGrammar._readCharacterAfterValue(nodes, state, character);
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
	 * @param nodes The compiled schema.
	 * @param state The reader's state, left untouched.
	 * @param text The text to try.
	 * @returns `true` when every character of the text may legally come next, in order.
	 */
	static acceptsText(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, text: string): boolean {
		const candidate = JsonSchemaGrammar.copy(state);
		for (const character of text) {
			if (JsonSchemaGrammar.acceptCharacter(nodes, candidate, character) === false) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Reads a whole piece of text, moving the state on when every character of it is legal.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place only when the whole text is legal.
	 * @param text The text to read.
	 * @returns `true` when the whole text was read.
	 */
	static acceptText(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, text: string): boolean {
		const candidate = JsonSchemaGrammar.copy(state);
		for (const character of text) {
			if (JsonSchemaGrammar.acceptCharacter(nodes, candidate, character) === false) {
				return false;
			}
		}
		state.mode = candidate.mode;
		state.valueNodeIndex = candidate.valueNodeIndex;
		state.containerKinds = candidate.containerKinds;
		state.containerNodeIndexes = candidate.containerNodeIndexes;
		state.writtenPropertyMasks = candidate.writtenPropertyMasks;
		state.openPropertyIndexes = candidate.openPropertyIndexes;
		state.chosenTextMask = candidate.chosenTextMask;
		state.chosenTextIndex = candidate.chosenTextIndex;
		state.isChoosingKey = candidate.isChoosingKey;
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
	 * for one may be reused for the other. Every container is named and not only the innermost,
	 * because a single token may carry several closing brackets and so may reach further down the
	 * stack than one level.
	 *
	 * @param state The reader's state.
	 * @returns A text that is equal for two states exactly when they accept the same texts.
	 */
	static signatureOf(state: JsonSchemaGrammarState): string {
		return [
			state.mode,
			String(state.valueNodeIndex),
			state.containerKinds.join(''),
			state.containerNodeIndexes.join(','),
			state.writtenPropertyMasks.join(','),
			state.openPropertyIndexes.join(','),
			String(state.chosenTextMask),
			String(state.chosenTextIndex),
			String(state.isChoosingKey),
			String(state.isReadingKey),
			String(state.unicodeDigitCount),
			state.literalText,
			String(state.literalIndex),
		].join('|');
	}

	/**
	 * Whether a mode means the reader is inside a number.
	 *
	 * @param mode The mode to ask about.
	 * @returns `true` for every mode that reads part of a number.
	 */
	static isNumberMode(mode: JsonSchemaGrammarMode): boolean {
		return mode.startsWith('number_');
	}

	/**
	 * Whether the reader is inside a string, where a space is an ordinary character of the value.
	 *
	 * Everywhere else a space, a tab, or a line break is JSON's own layout: legal, and carrying
	 * nothing. A reader has to accept it, because a local server may pretty-print what it sends back.
	 * A mask must not offer it, because a model that may write a space and nothing else writes spaces
	 * until its budget is gone — measured live on Gemma 4 E2B, which answered one masked question
	 * with 400 characters of nothing but spaces and line breaks. See
	 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219).
	 *
	 * @param state The state to ask about.
	 * @returns `true` when whitespace written now would be part of the value rather than layout.
	 */
	static isInsideString(state: JsonSchemaGrammarState): boolean {
		return state.mode === 'string';
	}

	/**
	 * Whether a mode means the reader is inside a number that is already a complete number.
	 *
	 * @param mode The mode to ask about.
	 * @returns `true` when the number read so far could stop where it is.
	 */
	static isFinishedNumberMode(mode: JsonSchemaGrammarMode): boolean {
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
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readValueCharacter(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): boolean {
		if (WHITESPACE_CHARACTERS.includes(character) === true) {
			return true;
		}
		if (state.mode === 'array_first_value' && character === ']') {
			return JsonSchemaGrammar._closeContainer(nodes, state, 'array');
		}
		// A node index of `-1` says the schema declared nothing about this value, which happens under a
		// key the schema never named and inside an array with no item schema. Nothing is narrowed
		// there, and every kind below is allowed, exactly as plain JSON allows it.
		const node = nodes[state.valueNodeIndex];
		// An enumerated value is one of a fixed set of texts, whatever its type, so it is written out
		// rather than parsed. This runs before every kind below, because the enumeration is the
		// narrower of the two constraints and the type only has to agree with it.
		if (node !== undefined && node.enumTexts.length > 0) {
			state.mode = 'chosen_text';
			state.isChoosingKey = false;
			state.chosenTextMask = (1 << node.enumTexts.length) - 1;
			state.chosenTextIndex = 0;
			return JsonSchemaGrammar._readChosenTextCharacter(nodes, state, character) === 'accepted';
		}
		if (character === '{') {
			if (JsonSchemaGrammar._allowsKind(node, 'object') === false) {
				return false;
			}
			state.containerKinds.push('object');
			state.containerNodeIndexes.push(node === undefined ? -1 : state.valueNodeIndex);
			state.writtenPropertyMasks.push(0);
			state.openPropertyIndexes.push(-1);
			state.mode = 'object_first_key';
			return true;
		}
		if (character === '[') {
			if (JsonSchemaGrammar._allowsKind(node, 'array') === false) {
				return false;
			}
			state.containerKinds.push('array');
			state.containerNodeIndexes.push(node === undefined ? -1 : state.valueNodeIndex);
			state.writtenPropertyMasks.push(0);
			state.openPropertyIndexes.push(-1);
			// An array whose schema declared no item schema lets its items be anything, which is what
			// the node index `-1` says.
			state.valueNodeIndex = node?.itemNodeIndex ?? -1;
			state.mode = 'array_first_value';
			return true;
		}
		if (character === '"') {
			if (JsonSchemaGrammar._allowsKind(node, 'string') === false) {
				return false;
			}
			state.mode = 'string';
			state.isReadingKey = false;
			return true;
		}
		if (character === '-' || (character >= '0' && character <= '9')) {
			if (JsonSchemaGrammar._allowsKind(node, 'number') === false && JsonSchemaGrammar._allowsKind(node, 'integer') === false) {
				return false;
			}
			if (character === '-') {
				state.mode = 'number_after_minus';
				return true;
			}
			state.mode = character === '0' ? 'number_after_zero' : 'number_integer';
			return true;
		}
		for (const literalText of ['true', 'false', 'null']) {
			if (character !== literalText[0]) {
				continue;
			}
			const kind = literalText === 'null' ? 'null' : 'boolean';
			if (JsonSchemaGrammar._allowsKind(node, kind) === false) {
				return false;
			}
			state.mode = 'literal';
			state.literalText = literalText;
			state.literalIndex = 1;
			return true;
		}
		return false;
	}

	/**
	 * Reads one character where the opening quotation mark of an object key is expected.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readKeyStartCharacter(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): boolean {
		if (WHITESPACE_CHARACTERS.includes(character) === true) {
			return true;
		}
		if (state.mode === 'object_first_key' && character === '}') {
			return JsonSchemaGrammar._closeContainer(nodes, state, 'object');
		}
		if (character !== '"') {
			return false;
		}
		const node = JsonSchemaGrammar._innermostContainerNode(nodes, state);
		const unwrittenMask = JsonSchemaGrammar._unwrittenPropertyMask(node, state);
		// An object whose schema left its properties open may write any key at all, so the key is an
		// ordinary string. One that closed them may write only a declared key it has not written yet,
		// so the key is one of a fixed set of texts and is masked down to exactly those.
		if (node === undefined || node.allowsOtherProperties === true) {
			state.mode = 'string';
			state.isReadingKey = true;
			return true;
		}
		if (unwrittenMask === 0) {
			return false;
		}
		state.mode = 'chosen_text';
		state.isChoosingKey = true;
		state.chosenTextMask = unwrittenMask;
		state.chosenTextIndex = 0;
		return JsonSchemaGrammar._readChosenTextCharacter(nodes, state, character) === 'accepted';
	}

	/**
	 * Reads one character of a text being written out of a fixed set, which is a key or an enumerated
	 * value.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the character is part of a still-possible
	 * text.
	 * @param character The character to read.
	 * @returns What the character turned out to be.
	 */
	private static _readChosenTextCharacter(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): NumberCharacterVerdict {
		const texts = JsonSchemaGrammar._chosenTexts(nodes, state);
		let survivingMask = 0;
		for (let textIndex = 0; textIndex < texts.length; textIndex = textIndex + 1) {
			if ((state.chosenTextMask & (1 << textIndex)) === 0) {
				continue;
			}
			const text = texts[textIndex] ?? '';
			if (text[state.chosenTextIndex] === character) {
				survivingMask = survivingMask | (1 << textIndex);
			}
		}
		if (survivingMask === 0) {
			// Nothing continues. Either one text is already written out in full, and the value is
			// finished, or the character is simply wrong.
			return JsonSchemaGrammar._isChosenTextFinished(nodes, state) === true ? 'ends_the_number' : 'illegal';
		}
		state.chosenTextMask = survivingMask;
		state.chosenTextIndex = state.chosenTextIndex + 1;
		if (JsonSchemaGrammar._isChosenTextFinished(nodes, state) === false) {
			return 'accepted';
		}
		// A key is finished by its own closing quotation mark, so what follows it is the colon. An
		// enumerated value has no such mark to go by and is left to be ended by whatever comes next.
		if (state.isChoosingKey === true) {
			JsonSchemaGrammar._takeChosenKey(nodes, state);
			state.mode = 'colon';
		}
		return 'accepted';
	}

	/**
	 * Marks the key just written as written, and points the reader at that property's own schema.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place.
	 */
	private static _takeChosenKey(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState): void {
		const node = JsonSchemaGrammar._innermostContainerNode(nodes, state);
		if (node === undefined) {
			return;
		}
		// Exactly one text can be written out in full, because no quoted key is a prefix of another:
		// two names that share a prefix are told apart by the closing quotation mark at the latest.
		const propertyIndex = Math.log2(state.chosenTextMask);
		const containerDepth = state.containerNodeIndexes.length - 1;
		state.openPropertyIndexes[containerDepth] = propertyIndex;
		state.writtenPropertyMasks[containerDepth] = (state.writtenPropertyMasks[containerDepth] ?? 0) | state.chosenTextMask;
		state.valueNodeIndex = node.propertyNodeIndexes[propertyIndex] ?? -1;
	}

	/**
	 * The fixed set of texts the reader is currently writing one of.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state.
	 * @returns The quoted names of the object's declared properties while a key is being written, and
	 * the enumeration's written values while a value is being written.
	 */
	private static _chosenTexts(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState): string[] {
		if (state.isChoosingKey === false) {
			return nodes[state.valueNodeIndex]?.enumTexts ?? [];
		}
		const node = JsonSchemaGrammar._innermostContainerNode(nodes, state);
		return (node?.propertyNames ?? []).map((propertyName: string) => JSON.stringify(propertyName));
	}

	/**
	 * Whether one of the texts still possible has been written out in full.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state.
	 * @returns `true` when the characters written so far are a whole text of the set.
	 */
	private static _isChosenTextFinished(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState): boolean {
		const texts = JsonSchemaGrammar._chosenTexts(nodes, state);
		for (let textIndex = 0; textIndex < texts.length; textIndex = textIndex + 1) {
			if ((state.chosenTextMask & (1 << textIndex)) === 0) {
				continue;
			}
			if ((texts[textIndex] ?? '').length === state.chosenTextIndex) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Reads one character where the reader is inside a free string.
	 *
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readStringCharacter(state: JsonSchemaGrammarState, character: string): boolean {
		if (character === '"') {
			state.mode = state.isReadingKey === true ? 'colon' : 'after_value';
			if (state.isReadingKey === true) {
				// A key written freely belongs to a property the schema never declared, so nothing is
				// known about its value.
				state.valueNodeIndex = -1;
			}
			state.isReadingKey = false;
			return true;
		}
		if (character === '\\') {
			state.mode = 'string_escape';
			return true;
		}
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 0x20) {
			return false;
		}
		return true;
	}

	/**
	 * Reads one character where a value has just been finished.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the character is legal.
	 * @param character The character to read.
	 * @returns `true` when the character may legally come next.
	 */
	private static _readCharacterAfterValue(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): boolean {
		if (WHITESPACE_CHARACTERS.includes(character) === true) {
			return true;
		}
		const node = JsonSchemaGrammar._innermostContainerNode(nodes, state);
		if (state.containerKinds.length === 0) {
			return false;
		}
		if (state.containerKinds.at(-1) === 'array') {
			if (character === ',') {
				state.mode = 'value';
				state.valueNodeIndex = node?.itemNodeIndex ?? -1;
				return true;
			}
			if (character === ']') {
				return JsonSchemaGrammar._closeContainer(nodes, state, 'array');
			}
			return false;
		}
		if (character === ',') {
			// A comma promises one more key, so it is legal only while there is a key left to write.
			if (node !== undefined && node.allowsOtherProperties === false && JsonSchemaGrammar._unwrittenPropertyMask(node, state) === 0) {
				return false;
			}
			state.mode = 'object_next_key';
			return true;
		}
		if (character === '}') {
			return JsonSchemaGrammar._closeContainer(nodes, state, 'object');
		}
		return false;
	}

	/**
	 * Reads one character where the reader is inside a number.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the character is part of the number.
	 * @param character The character to read.
	 * @returns What the character turned out to be.
	 */
	private static _readNumberCharacter(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, character: string): NumberCharacterVerdict {
		const isDigit = character >= '0' && character <= '9';
		const isExponentMark = character === 'e' || character === 'E';
		// `integer` is `number` without the two things that make a number fractional. Refusing them
		// here rather than at the start of the value is what makes `1` legal and `1.5` not.
		const isIntegerOnly = nodes[state.valueNodeIndex]?.kind === 'integer';
		const isFractionMark = character === '.' || isExponentMark === true;
		if (isIntegerOnly === true && isFractionMark === true) {
			return 'ends_the_number';
		}
		switch (state.mode) {
			case 'number_after_minus':
				if (isDigit === false) {
					return 'illegal';
				}
				state.mode = character === '0' ? 'number_after_zero' : 'number_integer';
				return 'accepted';
			case 'number_after_zero':
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
	 * Closes the innermost container, when it is the one being closed and it may close.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state, changed in place when the container may close.
	 * @param container Which kind of container the closing bracket belongs to.
	 * @returns `true` when the innermost open container is the one named and every required property
	 * of it has been written.
	 */
	private static _closeContainer(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState, container: JsonContainer): boolean {
		if (state.containerKinds.at(-1) !== container) {
			return false;
		}
		const node = JsonSchemaGrammar._innermostContainerNode(nodes, state);
		if (container === 'object' && node !== undefined) {
			// Every required property has to have been written, which is the whole of what `required`
			// means and the one thing a reader of well-formed JSON alone could never enforce.
			const writtenMask = state.writtenPropertyMasks.at(-1) ?? 0;
			if ((writtenMask & node.requiredMask) !== node.requiredMask) {
				return false;
			}
		}
		state.containerKinds.pop();
		state.containerNodeIndexes.pop();
		state.writtenPropertyMasks.pop();
		state.openPropertyIndexes.pop();
		state.valueNodeIndex = state.containerNodeIndexes.at(-1) ?? -1;
		state.mode = 'after_value';
		return true;
	}

	/**
	 * The schema node of the container the reader is innermost inside.
	 *
	 * @param nodes The compiled schema.
	 * @param state The reader's state.
	 * @returns That node, or `undefined` when no container is open or the schema said nothing about it.
	 */
	private static _innermostContainerNode(nodes: readonly CompiledSchemaNode[], state: JsonSchemaGrammarState): CompiledSchemaNode | undefined {
		const nodeIndex = state.containerNodeIndexes.at(-1);
		if (nodeIndex === undefined || nodeIndex === -1) {
			return undefined;
		}
		return nodes[nodeIndex];
	}

	/**
	 * Which declared properties of the innermost object have not been written yet.
	 *
	 * @param node The schema node of that object.
	 * @param state The reader's state.
	 * @returns One bit per declared property that may still be written.
	 */
	private static _unwrittenPropertyMask(node: CompiledSchemaNode | undefined, state: JsonSchemaGrammarState): number {
		if (node === undefined) {
			return 0;
		}
		const declaredMask = (1 << node.propertyNames.length) - 1;
		return declaredMask & ~(state.writtenPropertyMasks.at(-1) ?? 0);
	}

	/**
	 * Whether a schema node allows a value of one kind.
	 *
	 * @param node The schema node.
	 * @param kind The kind of value about to start.
	 * @returns `true` when the node declared that kind, or declared no kind at all.
	 */
	private static _allowsKind(node: CompiledSchemaNode | undefined, kind: string): boolean {
		if (node === undefined || node.kind === 'any') {
			return true;
		}
		if (node.kind === 'number' && kind === 'integer') {
			return true;
		}
		return node.kind === kind;
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
