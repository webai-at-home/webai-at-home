# Directory Context: `/packages/openai_conformance_test/src/reporter`

## Purpose

One file per output format section 33 of issue #181 names with `-f/--format`.

## Key Exports & Entry Points

- `terminal.ts`: `TerminalReporter`, the `text` format — the only format this package writes today.

## Rules

- A reporter renders `TestRunRecord[]` from `../runner.ts` into a string; it never runs a test and never talks to an endpoint.
- `render` returns the report as a string rather than printing it, so a test can assert on the returned text and `cli.ts` is the only place that calls `console.log`.
- The compatibility percentage never replaces the per-test lines above it, per section 30 of issue #181; a reporter that only printed the percentage would not satisfy this rule.

## Background

- `json.ts`, `markdown.ts`, and `junit.ts` are milestone six of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182); each adds one file here, the same way `terminal.ts` does.
