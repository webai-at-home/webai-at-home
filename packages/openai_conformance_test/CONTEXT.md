# Directory Context: `/packages/openai_conformance_test`

## Purpose

The OpenAI API Conformance Test command line program: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours. It does not grade whether an answer is a good one; it grades whether the protocol was followed.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_conformance_test` program, no subcommand, options only, per section 33 of issue #181. Run with `npx tsx src/cli.ts --model <name>`.
- `src/types.ts`: `Verdict`, `TestResult`, `TestContext`, `ConformanceTest` — the shapes every test, client, and report share.
- `src/clients/`, `src/tests/`, `src/profiles/`, `src/reporter/`: each has its own `CONTEXT.md`.
- `src/runner.ts`: `Runner`, runs a profile's tests in order, timing each and turning a thrown error into `FAIL` rather than stopping the run.
- `src/json_response_reader.ts`: `JsonResponseReader`, the one place every test reads `choices[0]`, `delta`, `usage`, and `error` out of an unknown parsed body.
- `src/sse_event_reader.ts`: `SseEventReader`, the one place every streaming test reads a raw server-sent event's `data:` line.
- `milestone_zero/gate.ts`: the de-risking gate for [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182), kept for the record, superseded by `src/runner.ts`.

## Rules

- `RawHttpClient` is the only file in this package that builds or parses a request or response body by hand; every test goes through it or through `OpenaiPackageClient`.
- `ToolCallProber` and `GenerationControlProber` from `@webai/openai-api-tool` are reused, never reimplemented; see decision two of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- The endpoint options and `-f/--format` come from `@webai/openai-api-tool`'s `SharedOptions`, through its `./shared_options` subpath export.
- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, exactly as section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) defines them. `SKIP` is a server's declared-unsupported refusal, never `FAIL`; `WARN` is correct behaviour that may still break a client — a buffered stream, or a model's own choice not to use an accepted capability — never `FAIL`.
- Never grade an answer's content, only whether the protocol was followed, per section 38 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181).
- `tests/index.test.ts` starts its own local HTTP server rather than depending on a cluster or LM Studio, as `packages/openai_api_tool/tests/index.test.ts` does.

## Background

- Each milestone's own findings are posted as comments on [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) rather than restated here.
