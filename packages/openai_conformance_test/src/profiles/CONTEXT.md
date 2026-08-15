# Directory Context: `/packages/openai_conformance_test/src/profiles`

## Purpose

One file per named profile, each an ordered list of the `ConformanceTest` objects it runs, as section 5 of issue #181 defines them.

## Key Exports & Entry Points

- `core.ts`: `coreProfile`, model discovery, basic chat completions, usage, and errors.
- `streaming.ts`: `streamingProfile`, the server-sent event transport, chunk format, incremental content, `finish_reason`, `[DONE]`, and whether the answer was genuinely streamed.
- `tools.ts`: `toolsProfile`, the six separate tool call abilities, with the negative control last.
- `parameters.ts`: `parametersProfile`, the five generation controls, measured rather than merely accepted.
- `structured_output.ts`: `structuredOutputProfile`, `json_object` and `json_schema`, reported separately.
- `sdk.ts`: `sdkProfile`, the same requests through the official `openai` Node.js package, deliberately repeating what the raw groups already asked, because the second transport is the point.
- `agent.ts`: `agentProfile`, the subset an agent framework depends on, selected from the profiles above.
- `full.ts`: `fullProfile`, every profile above spread into one list.

## Rules

- A profile file holds a list only, never test logic. A test's own behaviour lives in `src/tests/`, never here.
- A profile is a plain array of the tests already defined in `src/tests/`, in the order they are run and printed; it declares no new test of its own.
- A test added anywhere reaches `full.ts`, either through a base profile it spreads or on its own; `tests/index.test.ts` asserts this, so `full` cannot silently fall behind.
- `agent.ts` selects from the other profiles and never imports a test `full.ts` cannot reach, so the two lists can never disagree about which tests exist.

## Background

- The profile names, and which capability each one covers, come from section 5 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181).
