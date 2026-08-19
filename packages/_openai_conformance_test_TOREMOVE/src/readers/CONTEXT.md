# Directory Context: `/packages/_openai_conformance_test_TOREMOVE/src/readers`

## Purpose

Turns a response that has already arrived into a value a test can assert on. Everything a test reads out of a body, a chunk, or an answer's text is read here, so a field is looked up in one place rather than in every test that wants it.

## Key Exports & Entry Points

- `json_response_reader.ts`: `JsonResponseReader`, the one place `choices[0]`, `message.content`, `delta.content`, `finish_reason`, `usage`, and `error` are read out of an unknown parsed body.
- `sse_event_reader.ts`: `SseEventReader`, the one place a raw server-sent event's `data:` line is read — `beginsWithData`, `dataPayload`, `isDoneSentinel`, `parseDataJson`. It finds the `data:` line among the other fields an event may carry, rather than assuming an event is one line.
- `json_content_extractor.ts`: `JsonContentExtractor`, recovers a JSON object from an answer wrapped in a markdown code fence, in the triple-backtick form with or without a language tag, and the single-backtick form.

## Rules

- Nothing here sends a request or opens a connection; a reader is given text or a parsed value and returns a value. Sending belongs to `../clients/`.
- Nothing here decides a verdict. A reader reports what a response holds; whether that counts as `PASS`, `FAIL`, `SKIP`, or `WARN` is the test's own reading, and for a probed capability it belongs in `../probes/`.
- A reader never throws on a shape it did not expect; it returns `undefined`, so a test can report a `FAIL` that says what was seen.

## Background

- `JsonContentExtractor` exists because milestone zero of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) found a model that wrapped valid JSON in a code fence in nine of ten replies. Handing the raw content string straight to `JSON.parse` measures the model's formatting habit rather than whether `response_format` was honoured.
