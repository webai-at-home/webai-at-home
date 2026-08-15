# Directory Context: `/packages/openai_conformance_test`

## Purpose

The OpenAI API Conformance Test command line program: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours. It does not grade whether an answer is a good one; it grades whether the protocol was followed.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_conformance_test` program, no subcommand, options only, per section 33 of issue #181. Run with `npx tsx src/cli.ts --model <name>`.
- `src/types.ts`: the shapes every test, client, and report share.
- `src/clients/`, `src/tests/`, `src/profiles/`, `src/reporter/`: each has its own `CONTEXT.md`.
- `src/runner.ts`: runs a profile's tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- `src/json_response_reader.ts`: the one place every test reads `choices[0]`, `delta`, `usage`, and `error` out of an unknown parsed body.
- `src/sse_event_reader.ts`: the one place every streaming test reads a raw server-sent event's `data:` line.
- `src/tool_call_probe_cache.ts`, `src/generation_control_probe_cache.ts`: the one shared prober run each group reads from, so probing costs one run rather than one per test.
- `src/tool_call_verdict.ts`, `src/generation_control_verdict.ts`: the translation of each prober's five statuses into this package's four verdicts.
- `src/json_content_extractor.ts`: recovers a JSON object from an answer wrapped in a markdown code fence.
- `milestone_zero/gate.ts`: the de-risking gate, kept for the record, superseded by `src/runner.ts`.

## Rules

- `RawHttpClient` is the only file that builds or parses a body by hand; every test goes through it or `OpenaiPackageClient`.
- `ToolCallProber` and `GenerationControlProber` from `@webai/openai-api-tool` are reused, never reimplemented; see decision two of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- The endpoint options and `-f/--format` come from `@webai/openai-api-tool`'s `SharedOptions`, through its `./shared_options` subpath export.
- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal; `WARN` is correct behaviour that may still break a client, such as a buffered stream or JSON wrapped in a code fence. Neither is ever `FAIL`.
- Never grade an answer's content, only whether the protocol was followed, per section 38 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181).
- `tests/index.test.ts` starts its own local HTTP server rather than depending on a cluster or LM Studio, as `packages/openai_api_tool/tests/index.test.ts` does.

## Background

- Each milestone's own findings are posted as comments on [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) rather than restated here.
