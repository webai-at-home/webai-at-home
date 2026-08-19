///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	JsonContentExtractor — recovers the JSON object out of an answer that carries one, whether or
//	not the model wrapped it in a markdown code fence
//
//	This exists because of a finding milestone zero of
//	[issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) made live. Asked for a
//	JSON object with `response_format: { type: "json_object" }`, `llm_llama3_2_1b_full` answered
//	with valid JSON every time, and wrapped it in a markdown code fence in nine of ten tries:
//
//	    ```json
//	    {"greeting": "hello"}
//	    ```
//
//	Handing that string straight to `JSON.parse` reported `FAIL` nine times and `PASS` once — the
//	only unstable verdict in that whole gate. What varied was the model's formatting habit, not the
//	server's protocol behaviour, and a conformance test that cannot tell those apart is measuring
//	the wrong thing. Stripping the fence before parsing makes the verdict stable and keeps the test
//	about what section 17 of issue #181 actually asks: is the content JSON.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Recovers a JSON object out of an answer, tolerating a markdown code fence around it. */
export class JsonContentExtractor {
	/**
	 * Parses `content` as a JSON object, first as it stands and then with any surrounding markdown
	 * code fence or stray backticks removed.
	 *
	 * @param content The message content to recover a JSON object from.
	 * @returns The parsed value, and whether a fence had to be stripped to reach it. `parsed` is
	 * `undefined` when no valid JSON could be recovered either way.
	 */
	static extract(content: string): { parsed: unknown; wasFenced: boolean } {
		const asItStands = JsonContentExtractor._tryParse(content.trim());
		if (asItStands !== undefined) {
			return { parsed: asItStands, wasFenced: false };
		}
		const unfenced = JsonContentExtractor._stripCodeFence(content);
		if (unfenced === undefined) {
			return { parsed: undefined, wasFenced: false };
		}
		const afterStripping = JsonContentExtractor._tryParse(unfenced);
		if (afterStripping === undefined) {
			return { parsed: undefined, wasFenced: false };
		}
		return { parsed: afterStripping, wasFenced: true };
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Removes a surrounding markdown code fence, in either the triple-backtick form with an
	 * optional language tag or the single-backtick form.
	 *
	 * @param content The message content to strip.
	 * @returns The text inside the fence, `undefined` when `content` carried no fence at all.
	 */
	private static _stripCodeFence(content: string): string | undefined {
		const trimmed = content.trim();
		const tripleBacktick = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
		if (tripleBacktick !== null && tripleBacktick[1] !== undefined) {
			return tripleBacktick[1].trim();
		}
		const singleBacktick = /^`([\s\S]*?)`$/.exec(trimmed);
		if (singleBacktick !== null && singleBacktick[1] !== undefined) {
			return singleBacktick[1].trim();
		}
		return undefined;
	}

	/**
	 * Parses text as JSON without throwing.
	 *
	 * @param text The text to parse.
	 * @returns The parsed value, `undefined` when the text is not valid JSON.
	 */
	private static _tryParse(text: string): unknown {
		if (text === '') {
			return undefined;
		}
		try {
			return JSON.parse(text);
		} catch {
			return undefined;
		}
	}
}
