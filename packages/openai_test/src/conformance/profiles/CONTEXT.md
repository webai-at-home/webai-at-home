# Directory Context: `/packages/openai_test/src/conformance/profiles`

## Purpose

One file per named profile, each composing the groups declared in `../conformance_tests/*/group.ts` into the ordered list a run executes, as section 5 of issue #181 defines them.

## Key Exports & Entry Points

- `core.ts`: `coreProfile`, model discovery, basic chat completions, usage, and errors — the `models`, `chat`, `usage`, and `errors` groups, and the only capability profile built from more than one group.
- `streaming.ts`, `tools.ts`, `parameters.ts`, `structured_output.ts`, `sdk.ts`: one group each, re-exported under the profile name the command line uses.
- `agent.ts`: `agentProfile`, the subset an agent framework depends on. The one hand-picked selection, and the only file here that names individual tests.
- `full.ts`: `fullProfile`, every profile above spread into one list.

## Rules

- A profile file holds a list only, never test logic, and never a test's membership of its own group. Which tests a group holds, and in which order, is declared in that group's `../conformance_tests/<group>/group.ts`; a profile composes groups.
- `agent.ts` is the sole exception and names tests directly, because it is a selection across groups rather than a whole group. It never imports a test `full.ts` cannot reach, so the two lists can never disagree about which tests exist.
- A test added anywhere reaches `full.ts`, either through a base profile it spreads or on its own; `tests/index.test.ts` asserts this once Milestone 7 of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208) merges the two suites, so `full` cannot silently fall behind.
- A profile declares no new test of its own.

## Background

- The profile names, and which capability each one covers, come from section 5 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181).
- The membership lists moved into `../conformance_tests/*/group.ts` so that adding a test file and forgetting to list it is caught by a test that reads the folder from disk, rather than leaving the test written and never run.
