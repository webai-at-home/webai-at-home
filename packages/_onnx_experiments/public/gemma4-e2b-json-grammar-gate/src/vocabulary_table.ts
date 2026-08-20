import type { TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VocabularyTable — the text every entry of the vocabulary writes, decoded once
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

/**
 * How many entries are decoded between two progress reports.
 *
 * The loop never gives the page a turn to paint between them, and that is deliberate. Yielding with
 * `setTimeout` once per block looked reasonable and made the first live run of this gate take half
 * an hour: a browser tab that is not on screen clamps its timers to one a minute, so thirty-two
 * yields became thirty-two minutes. Decoding the whole vocabulary is about a second of work in one
 * unbroken run, which is less than the page would lose to a single clamped yield.
 */
const ENTRIES_PER_PROGRESS_REPORT = 8192;

/** The character a decoder writes in place of bytes that do not form a character on their own. */
const REPLACEMENT_CHARACTER = '�';

/**
 * The text every entry of the vocabulary writes, decoded once and kept.
 *
 * Masking the vocabulary means asking, for every entry, whether the text of that entry may legally
 * continue the answer. That question needs the text, and the tokenizer only gives it one entry at a
 * time, so the whole vocabulary is decoded once before generation starts and the answers are kept
 * in two flat arrays indexed by token identifier.
 *
 * How long that takes is one of the things milestone 0 of
 * [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) has to record, because it
 * is a cost the real processor of milestone 1 pays too, once per loaded model.
 *
 * Three kinds of entry come out of it, and the difference matters:
 *
 * - `text` entries are the ones a grammar can judge.
 * - `special` entries are markers, and a grammar has nothing to say about them. They are masked out
 *   while the value is unfinished, and the end-of-sequence entry is the only thing left legal once
 *   it is finished.
 * - `unusable` entries write nothing at all, or write a replacement character because they carry
 *   part of a character rather than a whole one. A grammar that judged the replacement character
 *   would be judging the decoder rather than the model, so they are masked out throughout. How many
 *   there are is itself a finding, because every one of them is a byte this masking approach cannot
 *   let the model write.
 */
export class VocabularyTable {
	/** How many entries the vocabulary has, counted as the largest identifier plus one. */
	readonly size: number;

	/** How long decoding the whole vocabulary took, in milliseconds. */
	readonly buildMilliseconds: number;

	/** The text each entry writes, indexed by token identifier. */
	private readonly texts: string[];

	/** What each entry turned out to be, indexed by token identifier. */
	private readonly kinds: VocabularyEntryKind[];

	/** How many entries of each kind there are. */
	readonly countByKind: Record<VocabularyEntryKind, number>;

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
	 * @param generator The loaded text-generation pipeline whose tokenizer to read.
	 * @param onProgress Called with how many entries are done and how many there are, so a page can
	 * say what it is doing.
	 * @returns The decoded vocabulary.
	 */
	static async build(
		generator: TextGenerationPipeline,
		onProgress?: (doneCount: number, totalCount: number) => void,
	): Promise<VocabularyTable> {
		const tokenizer = generator.tokenizer as unknown as {
			get_vocab: () => Map<string, number> | Record<string, number>;
			decode: (tokenIds: number[], options: Record<string, unknown>) => string;
			_tokenizer?: { get_added_tokens_decoder?: () => Map<number, { content: string; special: boolean }> };
		};
		// `get_vocab()` hands back a `Map` here, where `tokenization_utils.d.ts` declares a plain record.
		// Both are read, because a milestone that trusted the declaration would find an empty vocabulary
		// and mask nothing at all — which is exactly what the first live run of this gate did.
		const vocabulary = tokenizer.get_vocab();
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
			throw new Error('The tokenizer reported an empty vocabulary, so nothing can be masked.');
		}

		const specialIdentifiers = new Set<number>();
		const addedTokensDecoder = tokenizer._tokenizer?.get_added_tokens_decoder?.();
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
			// Every entry is decoded with the special tokens kept, because an entry that is stripped
			// decodes to an empty string and would be indistinguishable from an entry that writes
			// nothing.
			const text = tokenizer.decode([identifier], { skip_special_tokens: false });
			texts[identifier] = text;
			if (specialIdentifiers.has(identifier) === true) {
				kinds[identifier] = 'special';
			} else if (text === '' || text.includes(REPLACEMENT_CHARACTER) === true) {
				kinds[identifier] = 'unusable';
			} else {
				kinds[identifier] = 'text';
			}
			if (identifier % ENTRIES_PER_PROGRESS_REPORT === 0) {
				onProgress?.(identifier, size);
			}
		}
		const buildMilliseconds = performance.now() - startedAt;
		onProgress?.(size, size);
		return new VocabularyTable(size, texts, kinds, buildMilliseconds);
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

	/**
	 * The identifiers whose text is exactly one given piece of text.
	 *
	 * Used to report which entries of this tokenizer write a JSON structural character, which is the
	 * measurement that says whether a per-character grammar is even the right shape for this
	 * vocabulary.
	 *
	 * @param text The text to look for.
	 * @returns Every identifier whose entry writes exactly that text.
	 */
	identifiersWritingExactly(text: string): number[] {
		const identifiers: number[] = [];
		for (let identifier = 0; identifier < this.size; identifier = identifier + 1) {
			if (this.texts[identifier] === text) {
				identifiers.push(identifier);
			}
		}
		return identifiers;
	}

	/**
	 * How many entries write a text that starts with a given piece of text.
	 *
	 * @param prefix The text to look for at the start of an entry.
	 * @returns How many entries start with it.
	 */
	countStartingWith(prefix: string): number {
		let count = 0;
		for (let identifier = 0; identifier < this.size; identifier = identifier + 1) {
			if (this.kinds[identifier] === 'text' && this.texts[identifier].startsWith(prefix) === true) {
				count = count + 1;
			}
		}
		return count;
	}
}
