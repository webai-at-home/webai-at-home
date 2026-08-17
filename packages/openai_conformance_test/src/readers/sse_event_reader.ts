///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	SseEventReader — reads the `data:` line of one raw server-sent event, the one shape every
//	streaming test needs to read the same way
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Reads the `data:` field of a raw server-sent event, section 11 of issue #181's own wire format. */
export class SseEventReader {
	/**
	 * Reports whether this event carries a `data:` field at all.
	 *
	 * @param rawText One event's raw text, as `RawHttpClient` split it out.
	 * @returns `true` when a line of `rawText` begins with `data:`.
	 */
	static beginsWithData(rawText: string): boolean {
		return SseEventReader._dataLine(rawText) !== undefined;
	}

	/**
	 * Reads the text after `data:` on this event's `data:` line.
	 *
	 * @param rawText One event's raw text.
	 * @returns The text after `data:`, trimmed. `undefined` when this event carries no `data:` line.
	 */
	static dataPayload(rawText: string): string | undefined {
		const line = SseEventReader._dataLine(rawText);
		if (line === undefined) {
			return undefined;
		}
		return line.slice(line.indexOf(':') + 1).trim();
	}

	/**
	 * Reports whether this event is the `data: [DONE]` sentinel section 11 of issue #181 ends a
	 * stream with.
	 *
	 * @param rawText One event's raw text.
	 * @returns `true` when this event's `data:` payload is exactly `[DONE]`.
	 */
	static isDoneSentinel(rawText: string): boolean {
		return SseEventReader.dataPayload(rawText) === '[DONE]';
	}

	/**
	 * Parses this event's `data:` payload as JSON.
	 *
	 * @param rawText One event's raw text.
	 * @returns The parsed value, `undefined` when there is no `data:` line, the payload is the
	 * `[DONE]` sentinel, or the payload is not valid JSON.
	 */
	static parseDataJson(rawText: string): unknown {
		const payload = SseEventReader.dataPayload(rawText);
		if (payload === undefined || payload === '[DONE]') {
			return undefined;
		}
		try {
			return JSON.parse(payload);
		} catch {
			return undefined;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Finds this event's `data:` line, among the field lines a server-sent event may carry.
	 *
	 * @param rawText One event's raw text.
	 * @returns The `data:` line, untrimmed apart from its own leading whitespace. `undefined` when none is present.
	 */
	private static _dataLine(rawText: string): string | undefined {
		return rawText.split('\n').find((line) => line.trimStart().startsWith('data:'));
	}
}
