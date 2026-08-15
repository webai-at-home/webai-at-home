# Directory Context: `/packages/openai_conformance_test`

## Purpose

The OpenAI API Conformance Test command line program: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours, not whether its answers are good ones.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_conformance_test` program, no subcommand, options only, per section 33 of issue #181. Run with `npx tsx src/cli.ts --model <name>`, or as a subcommand of `webai_at_home_cli`.
- `src/types.ts`: the shapes every test, client, and report share.
- `src/clients/`, `src/tests/`, `src/profiles/`, `src/reporter/`: each has its own `CONTEXT.md`.
- `src/runner.ts`: runs the chosen tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- `src/json_response_reader.ts`, `src/sse_event_reader.ts`: the one place a test reads a parsed body, and the one place it reads a raw server-sent event's `data:` line.
- `src/tool_call_probe_cache.ts`, `src/generation_control_probe_cache.ts`: the one shared prober run a group reads from, so probing costs one run rather than one per test; the two `*_verdict.ts` files beside them translate a prober's five statuses into this package's four verdicts.
- `src/json_content_extractor.ts`: recovers a JSON object from an answer wrapped in a code fence.

## Rules

- `RawHttpClient` is the only file that builds or parses a body by hand; a test goes through it or `OpenaiPackageClient`.
- `ToolCallProber` and `GenerationControlProber` from `@webai/openai-api-tool` are reused, never reimplemented; see decision two of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- The endpoint options come from `@webai/openai-api-tool`'s `SharedOptions`, through its `./shared_options` subpath export; `-f/--format` is declared here, the four formats being this package's own.
- `src/cli.ts` is the only file that prints, reads a file path, or sets an exit code: 0 when nothing failed, 1 when a test failed, 2 when the run itself could not start.
- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal; `WARN` is correct behaviour that may still break a client, such as a buffered stream. Neither is ever `FAIL`.
- Never grade an answer's content, only whether the protocol was followed, per section 38 of issue #181.
- `tests/index.test.ts` starts its own local HTTP server rather than depending on a cluster or LM Studio.

## Background

- `milestone_zero/gate.ts` is the de-risking gate, kept for the record, superseded by `src/runner.ts`.
- Whether a run counts as a failure is decided by the verdicts alone, never by `--ci`, which only turns the colouring and the progress lines off.
- Each milestone's own findings are posted as comments on [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) rather than restated here.
