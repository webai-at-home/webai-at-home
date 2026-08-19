# Directory Context: `/packages/openai_test/tests`

## Purpose

This package's own automated test suite, split one file per part of the program, and merged from the suites of the two packages this one replaces.

## Key Exports & Entry Points

- `index.test.ts`: the options every subcommand shares, and the model resolver.
- `clients.test.ts`: what `CompletionSender` reads off a real connection, and the reported model identifier check.
- `probers.test.ts`: `GenerationControlProber` and `ToolCallProber`.
- `conformance.test.ts`: the conformance tests, the profiles, the probe caches, and the four reporters.
- `benchmark.test.ts`: the statistics, the runner, and the four report formats.
- `chat.test.ts`: the session loop, its three commands, and what it prints.
- Command to run this folder: `npm test --workspace @webai/openai-test`

## Rules

- A test that needs an endpoint starts its own local HTTP server on a free port and stops it again, so the whole suite needs neither this cluster nor a local model server. No test reaches a real endpoint, and none is skipped for want of one.
- A test states what it asserts through the package's own exports, never by reaching into a private field.
- Every test is declared flat as `Test('...')`, matching the two suites this one was merged from, and grouped by the section separator above it rather than by a wrapper.
- `conformance_tests/` under `src/` holds the shipped program; this folder holds the suite that checks it. Neither imports the other.
- A test that starts a server stops it in a `finally`, so one failure cannot leave a port held for the rest of the run.

## Background

- The suite is merged from `packages/_openai_api_tool_TOREMOVE/tests/index.test.ts` and `packages/_openai_conformance_test_TOREMOVE/tests/index.test.ts` by Milestone 7 of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208). The tests those two suites had for subcommands this package does not have — the `completion`, `usage`, and `history` sweep reports — did not come along, and neither did their renderers.
- The split into six files rather than one is the 600-line guideline: the merged suite is well past 2000 lines.
