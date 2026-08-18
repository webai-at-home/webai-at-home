# Directory Context: `/packages/openai_test/src/conformance/conformance_tests`

## Purpose

One file per conformance test, grouped into subfolders by the part of the protocol each checks. Each subfolder declares which tests it holds, and in which order, in its own `group.ts`.

## Key Exports & Entry Points

- `<group>/group.ts`: the ordered list of that folder's tests, exported as `<group>Group`. This is what `../profiles/` composes.
- `models/`: whether `GET /models` lists the requested model.
- `chat/`: whether a basic completion and a `system` message are accepted. Single-turn only.
- `history/`: whether a history carrying a previous `assistant` message is accepted, and whether the model reads it.
- `usage/`: whether the `usage` object is present and internally consistent.
- `errors/`: whether an unknown model, malformed JSON, and a missing `messages` field are each refused.
- `streaming/`: whether `stream: true` is answered with well-formed server-sent events, incremental content, a `finish_reason`, and `[DONE]`.
- `tools/`: the six tool call abilities, each file reading its own ability out of the one shared `ToolCallProber` run — see [../probes/CONTEXT.md](../probes/CONTEXT.md).
- `parameters/`: the five generation controls, the same arrangement over `GenerationControlProber`.
- `structured_output/`: whether `response_format` `json_object` and `json_schema` are honoured, separately.
- `sdk/`: the same requests through the official `openai` Node.js package — the only group using `context.openaiPackageClient`.

## Rules

- Every file except `group.ts` exports one `ConformanceTest` named `<group><Name>Test`, whose `run` points at the static `run` of a same-named `PascalCase` class in that file.
- A test added to a folder is added to that folder's `group.ts`, the only place its membership is declared.
- A `group.ts` holds a list only, never test logic, and never a test declared nowhere else.
- A test never grades whether an answer is a good answer. It may read an answer's words only when the prompt was built so the behaviour under test is visible in them; the rule is stated once, in [../CONTEXT.md](../CONTEXT.md).
- A test in `tools/` or `parameters/` never probes an endpoint itself; it reads its outcome from the shared cache on `TestContext` and translates it through `../probes/`.
- A 4xx refusal of an optional request field is `SKIP` on the status alone, never on the error body's shape, since an endpoint may send no `code` to key on.
- `streaming/timing.ts` is the worked example of `WARN` rather than `FAIL`: a buffered answer is a compatibility concern, not a protocol violation (section 12 of issue #181).

## Background

- A group and a profile are two different axes, which is why membership lives here: `-g/--group` names a part of the protocol, `--profile` an audience.
