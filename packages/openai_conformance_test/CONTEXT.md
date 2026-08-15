# Directory Context: `/packages/openai_conformance_test`

## Purpose

The OpenAI API Conformance Test command line program: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours. It does not grade whether an answer is a good one; it grades whether the protocol was followed.

## Key Exports & Entry Points

- `milestone_zero/gate.ts`: the de-risking gate for [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182). Not the conformance runner. Runs eight candidate tests ten times each against two live endpoints and reports which verdicts held, proving whether a conformance verdict can be made stable before the runner is built on top of that answer. Run with `npx tsx milestone_zero/gate.ts`.
- The runner, the test definitions, the report writers, and the profiles named in [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) do not exist yet; they are milestones one through seven of that issue.

## Rules

- A chat completion request body, a server-sent event, and an error response body are read directly here, never through `@webai/openai-api-tool`'s `CompletionSender`, because that package's own rule is that `openai` npm package is its single transport. This package is where the raw protocol is inspected instead.
- `ToolCallProber` and `GenerationControlProber` from `@webai/openai-api-tool` are reused for tool calling and generation control tests, never reimplemented here; see decision two of [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- A test result is one of `PASS`, `FAIL`, `SKIP`, or `WARN`, exactly as section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) defines them. `SKIP` is what a server's own declared-unsupported error becomes, never `FAIL`; `WARN` is what a model's own choice not to use a declared capability becomes, never `FAIL`.
- This package never grades whether an answer is a good one, only whether the protocol was followed, per section 38 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181).

## Background

- Milestone zero's own findings, including the one candidate test that flipped between ten repeated requests and why, are posted as a comment on [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182) rather than restated here.
