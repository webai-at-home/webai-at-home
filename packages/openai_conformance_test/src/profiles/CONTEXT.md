# Directory Context: `/packages/openai_conformance_test/src/profiles`

## Purpose

One file per named profile, each an ordered list of the `ConformanceTest` objects it runs, as section 5 of issue #181 defines them.

## Key Exports & Entry Points

- `core.ts`: `coreProfile`, model discovery, basic chat completions, usage, and errors — the only profile this package runs today.

## Rules

- A profile file holds a list only, never test logic. A test's own behaviour lives in `src/tests/`, never here.
- A profile is a plain array of the tests already defined in `src/tests/`, in the order they are run and printed; it declares no new test of its own.

## Background

- `streaming`, `tools`, `agent`, and `full` are milestones two, three, and six of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182); each adds one file here, the same way `core.ts` does.
