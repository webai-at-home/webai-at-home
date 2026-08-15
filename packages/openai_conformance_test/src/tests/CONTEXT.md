# Directory Context: `/packages/openai_conformance_test/src/tests`

## Purpose

One file per conformance test, grouped into subfolders by the part of the protocol each group checks.

## Key Exports & Entry Points

- `models/`: whether `GET /models` lists the requested model.
- `chat/`: whether a basic completion, a `system` message, and a multi-turn history are accepted.
- `usage/`: whether the response body's `usage` object is present and internally consistent.
- `errors/`: whether an unknown model, malformed JSON, and a missing `messages` field are each refused with an error.
- `streaming/`: whether `stream: true` is answered with well-formed server-sent events, incremental content, a `finish_reason`, and `[DONE]`, and whether the chunks were genuinely streamed rather than buffered.

## Rules

- Every file exports exactly one `ConformanceTest` object, named `<group><Name>Test` in `camelCase`, e.g. `chatBasicTest`. The test's own logic lives in a same-named `PascalCase` class in the same file, e.g. `class ChatBasicTest`, whose static `run` method the exported object's `run` field points to.
- A test never grades an answer's content. A test checks that a field exists, has the right type, or is arithmetically consistent — never that a model's words are the ones expected, per section 38 of issue #181.
- A test that finds a declared-unsupported refusal — an HTTP 400 whose `error.code` names the exact capability refused — reports `SKIP`, never `FAIL`. None of the `core` or `streaming` groups' own tests hit this case; `packages/openai_conformance_test/CONTEXT.md` and the milestone zero report on [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) record why later groups must.
- A server that answered correctly but in a way that may still break a client reports `WARN`, never `FAIL`. `streaming/timing.ts` is the worked example: a buffered answer is a compatibility concern, not a protocol violation, per section 12 of issue #181.

## Background

- The tests here today are the `core` and `streaming` profiles, in `src/profiles/`. A later milestone's group, such as `tools`, adds its own subfolder here the same way.
