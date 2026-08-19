# Directory Context: `/packages/_openai_conformance_test_TOREMOVE`

## Purpose

The OpenAI API Conformance Test command line program: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours, not whether its answers are good ones.

## Key Exports & Entry Points

- `src/cli.ts`: the `openai_conformance_test` program, no subcommand, options only, per section 33 of issue #181.
- `src/types.ts`: the shapes every test, client, and report share.
- `src/clients/`, `src/readers/`, `src/probes/`, `src/tests/`, `src/profiles/`, `src/reporter/`: each has its own `CONTEXT.md`.
- `src/runner.ts`: runs the chosen tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- Command to run this folder: `npm run core -- --model <name>`. A `report:*` script beside it writes one target's markdown report into this package's own `data/conformance_reports/`.

## Rules

- `RawHttpClient` is the only file that builds or parses a body by hand; a test goes through it or `OpenaiPackageClient`.
- `ToolCallProber` and `GenerationControlProber` from `@webai/openai-api-tool` are reused, never reimplemented; see [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- The endpoint options come from `@webai/openai-api-tool`'s `SharedOptions`; `-f/--format` is declared here, the four formats being this package's own.
- `src/cli.ts` is the only file that prints, reads a file path, or sets an exit code: 0 when nothing failed, 1 when a test failed, 2 when the run itself could not start.
- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal; `WARN` is correct behaviour that may still break a client. Neither is ever `FAIL`.
- Never grade an answer's content, only whether the protocol was followed, per section 38 of issue #181.
- `tests/index.test.ts` starts its own local HTTP server rather than depending on a cluster or LM Studio.
- **This package is frozen: bug fixes only, no new feature.** [`packages/openai_test`](../openai_test/) holds all of it now, and a feature added here would be added to a copy nobody runs.
- `src/tests/` and `tests/` share a word and mean different things: `src/tests/` holds the conformance tests, which are the shipped program; `tests/` holds this package's own automated test suite. Neither may import the other.

## Background

- The freeze comes from [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208), which merged this package and `packages/_openai_api_tool_TOREMOVE` into `packages/openai_test`. Both packages stay, and neither is deleted.
- Whether a run counts as a failure is decided by the verdicts alone, never by `--ci`.
- Each milestone's own findings are posted as comments on [#182](https://github.com/webai-at-home/webai-at-home/issues/182) rather than restated here.
