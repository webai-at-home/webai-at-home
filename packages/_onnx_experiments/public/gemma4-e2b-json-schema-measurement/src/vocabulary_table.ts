import type { PreTrainedTokenizer } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VocabularyTable — the text every entry of a tokenizer's vocabulary writes, decoded once
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What one entry of the vocabulary turned out to be. */
export type VocabularyEntryKind =
	/** An entry that writes ordinary text, and that a grammar may therefore judge. */
	| 'text'
	/** An entry the tokenizer marks as special, such as an end-of-turn marker. */
	| 'special'
	/** An entry that writes nothing, or that writes an incomplete character no grammar can judge. */
	| 'unusable';

/** The character a decoder writes in place of bytes that do not form a character on their own. */
const REPLACEMENT_CHARACTER = '�';

/**
 * The text every entry of a tokenizer's vocabulary writes, decoded once and kept.
 *
 * Enforcing a shape means masking the vocabulary between the logits and the choice of token, and
 * masking the vocabulary means asking, for every entry, whether the text of that entry may legally
 * continue the answer. That question needs the text, and a tokenizer only gives it one entry at a
 * time, so the whole vocabulary is decoded once when a model is loaded and the answers are kept in
 * two flat arrays indexed by token identifier.
 *
 * Three kinds of entry come out of it, and the difference decides what a mask may leave legal:
 *
 * - `text` entries are the ones a grammar can judge.
 * - `special` entries are markers, and a grammar has nothing to say about them. They are masked out
 *   while a value is unfinished, so a model cannot end its turn in the middle of an object, and the
 *   end-of-sequence entries are the only thing left legal once it is finished.
 * - `unusable` entries write nothing at all, or write a replacement character because they carry
 *   part of a character rather than a whole one. A grammar that judged a replacement character
 *   would be judging the decoder rather than the model, so they are masked out throughout. Every
 *   one of them is a byte this approach can never let a model write.
 *
 * Measured live for `onnx-community/gemma-4-E2B-it-ONNX` at `q4f16` by milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219): 262144 entries decoded
 * in 331 milliseconds, of which 261986 are text, 24 are special, and 134 are unusable.
 */
export class VocabularyTable {
	/** How many entries the vocabulary has, counted as the largest identifier plus one. */
	readonly size: number;

	/** How long decoding the whole vocabulary took, in milliseconds. */
	readonly buildMilliseconds: number;

	/** How many entries of each kind there are. */
	readonly countByKind: Record<VocabularyEntryKind, number>;

	/** The text each entry writes, indexed by token identifier. */
	private readonly texts: string[];

	/** What each entry turned out to be, indexed by token identifier. */
	private readonly kinds: VocabularyEntryKind[];

	/**
	 * @param size How many entries the vocabulary has.
	 * @param texts The text each entry writes, indexed by token identifier.
	 * @param kinds What each entry is, indexed by token identifier.
	 * @param buildMilliseconds How long decoding the whole vocabulary took.
	 */
	private constructor(size: number, texts: string[], kinds: VocabularyEntryKind[], buildMilliseconds: number) {
		this.size = size;
		this.texts = texts;
		this.kinds = kinds;
		this.buildMilliseconds = buildMilliseconds;
		this.countByKind = {
			text: 0,
			special: 0,
			unusable: 0,
		};
		for (const kind of kinds) {
			this.countByKind[kind] = this.countByKind[kind] + 1;
		}
	}

	/**
	 * Decodes the whole vocabulary of a loaded tokenizer.
	 *
	 * Runs unbroken rather than giving the page a turn to paint between blocks. Yielding with
	 * `setTimeout` once per block looked reasonable and made the first live run of the milestone 0
	 * gate take half an hour: a browser tab that is not on screen clamps its timers to one a minute,
	 * and a worker browser tab is very often not on screen. The whole loop is about a third of a
	 * second, which is less than one clamped yield would cost.
	 *
	 * @param tokenizer The loaded tokenizer to read.
	 * @returns The decoded vocabulary.
	 * @throws When the tokenizer reports no vocabulary at all, because a mask over an empty
	 * vocabulary silently leaves every entry legal and enforces nothing.
	 */
	static build(tokenizer: PreTrainedTokenizer): VocabularyTable {
		const reader = tokenizer as unknown as {
			get_vocab: () => Map<string, number> | Record<string, number>;
			decode: (tokenIds: number[], options: Record<string, unknown>) => string;
			_tokenizer?: { get_added_tokens_decoder?: () => Map<number, { content: string; special: boolean }> };
		};
		// `get_vocab()` hands back a `Map` here, where `types/tokenization_utils.d.ts` declares a plain
		// record. Both are read, because reading only the declared shape finds an empty vocabulary and
		// masks nothing at all — a processor that looks like it is running and does no work, which is
		// what the first live run of the milestone 0 gate did.
		const vocabulary = reader.get_vocab();
		const identifiers = vocabulary instanceof Map
			? Array.from(vocabulary.values())
			: Object.values(vocabulary);
		let largestIdentifier = -1;
		for (const identifier of identifiers) {
			if (identifier > largestIdentifier) {
				largestIdentifier = identifier;
			}
		}
		const size = largestIdentifier + 1;
		if (size <= 0) {
			throw new Error('The tokenizer reports an empty vocabulary, so no response format can be enforced.');
		}

		const specialIdentifiers = new Set<number>();
		const addedTokensDecoder = reader._tokenizer?.get_added_tokens_decoder?.();
		if (addedTokensDecoder !== undefined) {
			for (const [identifier, addedToken] of addedTokensDecoder.entries()) {
				if (addedToken.special === true) {
					specialIdentifiers.add(identifier);
				}
			}
		}

		const texts: string[] = new Array<string>(size);
		const kinds: VocabularyEntryKind[] = new Array<VocabularyEntryKind>(size);
		const startedAt = performance.now();
		for (let identifier = 0; identifier < size; identifier = identifier + 1) {
			// Decoded with the special tokens kept, because an entry that is stripped decodes to an
			// empty string and would be indistinguishable from an entry that writes nothing.
			const text = reader.decode([identifier], { skip_special_tokens: false });
			texts[identifier] = text;
			if (specialIdentifiers.has(identifier) === true) {
				kinds[identifier] = 'special';
			} else if (text === '' || text.includes(REPLACEMENT_CHARACTER) === true) {
				kinds[identifier] = 'unusable';
			} else {
				kinds[identifier] = 'text';
			}
		}
		return new VocabularyTable(size, texts, kinds, performance.now() - startedAt);
	}

	/**
	 * The text one entry writes.
	 *
	 * @param identifier The token identifier.
	 * @returns The text, empty for an identifier outside the vocabulary.
	 */
	textOf(identifier: number): string {
		return this.texts[identifier] ?? '';
	}

	/**
	 * What one entry is.
	 *
	 * @param identifier The token identifier.
	 * @returns The kind, `unusable` for an identifier outside the vocabulary.
	 */
	kindOf(identifier: number): VocabularyEntryKind {
		return this.kinds[identifier] ?? 'unusable';
	}
}
