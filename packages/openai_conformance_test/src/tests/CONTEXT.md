# Directory Context: `/packages/openai_conformance_test/src/tests`

## Purpose

One file per conformance test, grouped into subfolders by the part of the protocol each group checks.

## Key Exports & Entry Points

- `models/`: whether `GET /models` lists the requested model.
- `chat/`: whether a basic completion, a `system` message, and a multi-turn history are accepted.
- `usage/`: whether the response body's `usage` object is present and internally consistent.
- `errors/`: whether an unknown model, malformed JSON, and a missing `messages` field are each refused with an error.
- `streaming/`: whether `stream: true` is answered with well-formed server-sent events, incremental content, a `finish_reason`, and `[DONE]`, and whether the chunks were genuinely streamed rather than buffered.
- `tools/`: the six separate tool call abilities, each file reading its own ability's outcome out of the one shared `ToolCallProber` run and translating it through `../../tool_call_verdict.ts`.
- `parameters/`: the five generation controls, the same arrangement over `GenerationControlProber` and `../../generation_control_verdict.ts`.
- `structured_output/`: whether `response_format` `json_object` and `json_schema` are honoured, reported separately.

## Rules

- Every file exports exactly one `ConformanceTest` object, named `<group><Name>Test` in `camelCase`. Its logic lives in a same-named `PascalCase` class in the same file, whose static `run` method the exported object's `run` field points to.
- A test never grades an answer's content: it checks that a field exists, has the right type, or is arithmetically consistent, never that a model's words are the ones expected, per section 38 of issue #181.
- A declared-unsupported refusal reports `SKIP`, never `FAIL`. `consumer_openai` refuses tool declarations and generation controls a model cannot honour, and that is a true statement about the endpoint rather than a fault.
- A test in `tools/` or `parameters/` never probes an endpoint itself. It reads its outcome from the shared cache on `TestContext` and translates it; the probing belongs to `ToolCallProber` and `GenerationControlProber` in `@webai/openai-api-tool`.
- A 4xx refusal of an optional request field is `SKIP` on the status alone, never on the error body's shape: LM Studio refuses `response_format` with `error` as a bare string carrying no `code` to key on.
- A server that answered correctly but in a way that may still break a client reports `WARN`, never `FAIL`. `streaming/timing.ts` is the worked example: a buffered answer is a compatibility concern, not a protocol violation, per section 12 of issue #181.

## Background

- The tests here today are the `core`, `streaming`, `tools`, `parameters`, and `structured_output` profiles, in `src/profiles/`. A later milestone's group adds its own subfolder here the same way.
