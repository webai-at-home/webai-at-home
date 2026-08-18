# Directory Context: `/packages/openai_test/src/readers`

## Purpose

Reads what actually arrived on the wire: the server-sent event framing of a streamed answer, a JSON response body, and the content buried inside one. These exist because the `openai` npm package hides all three, and a conformance test has to see them.

## Key Exports & Entry Points

- `sse_event_reader.ts`: `SseEventReader`, which turns a streamed response into the events it carried, including the `[DONE]` terminator and when each event arrived.
- `json_response_reader.ts`: `JsonResponseReader`, which reads a whole response body as JSON while keeping the HTTP status it arrived with.
- `json_content_extractor.ts`: `JsonContentExtractor`, which finds the assistant content inside a parsed response body.

## Rules

- A reader parses and never sends. Reaching an endpoint belongs in `../clients/`.
- A reader reports what arrived and draws no conclusion from it. Deciding that what arrived is a `PASS` or a `WARN` belongs to the conformance test that asked.
- Nothing here knows about profiles, verdicts, or report formats.

## Background

- These readers sit beside `../clients/` rather than inside `../conformance/` because `benchmark` reads the same wire, so they are not the `conformance` subcommand's own. See [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
