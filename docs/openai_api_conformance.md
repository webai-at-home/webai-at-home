# OpenAI API Conformance

This document records what happens when the OpenAI API Conformance Test is pointed at this project's own OpenAI-compatible server, and at the local model server that same cluster forwards to. It answers one question: which parts of the OpenAI Chat Completions protocol does each of them actually honour?

It does not grade whether an answer is a good answer. A model that replies with something unhelpful still passes, as long as the protocol was followed. See [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) for why the two are kept apart.

## Running it

```bash
npx tsx packages/openai_conformance_test/src/cli.ts --model llm_llama3_2_1b_full --profile full
```

Without cloning this repository:

```bash
npx webai-at-home openai_conformance_test --model llm_llama3_2_1b_full --profile full
```

`--base_url` points it somewhere other than `consumer_openai`'s default of `http://localhost:8788/v1`. `--profile` selects how much to run: `core`, `streaming`, `tools`, `parameters`, `structured_output`, `sdk`, `agent`, or `full`. `--format` writes the report as `text`, `json`, `markdown`, or `junit`.

## What a result means

| Verdict | Meaning |
| --- | --- |
| ✅ PASS | The protocol was followed. |
| ❌ FAIL | The endpoint claims to support this and behaves incorrectly. |
| ⊘ SKIP | The endpoint said plainly that it does not support this. Left out of the percentage, because nothing was measured. |
| ⚠️ WARN | Correct, but in a way that may still break a client — a stream that arrives in one piece, or JSON wrapped in a code fence. |

A refusal is never a failure. An endpoint that says "I cannot do this" is behaving better than one that accepts the request and quietly ignores part of it, and the two must not collapse into the same mark.

## What was measured

Four targets, all on 2026-08-15, with the `full` profile. Two later runs are folded in, and both are on 2026-08-16. `consumer_openai` running `llm_qwen3_5_0_8b_full` was measured again in full after [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190) was fixed, and its column carries that later run. Then the two `structured_output` rows of both `consumer_openai` columns were measured again after [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191) was fixed, with the `structured_output` profile. The two LM Studio columns are the 2026-08-15 run throughout, so a row that changed in a re-measured column is no longer a same-day comparison with the LM Studio control beside it.

- `consumer_openai` running `llm_llama3_2_1b_full`, served by a `worker_openai` forwarding to LM Studio.
- `consumer_openai` running `llm_qwen3_5_0_8b_full`, served the same way.
- LM Studio directly, serving `llama-3.2-1b-instruct` — the same weights the first target reaches, one hop earlier.
- LM Studio directly, serving `qwen_qwen3.5-0.8b` — likewise for the second.

The two LM Studio columns are the control. When a test passes there and fails through `consumer_openai`, the difference is this project's, not the model's.

| | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| Passed | 18 | 24 | 25 | 24 |
| Failed | 0 | 3 | 2 | 7 |
| Skipped | 14 | 5 | 1 | 1 |
| Warned | 0 | 0 | 4 | 0 |
| Compatibility | 100.0% | 88.9% | 80.6% | 77.4% |

Per test:

| Test | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| `models.list` | ✅ | ✅ | ✅ | ✅ |
| `chat.basic` | ✅ | ✅ | ✅ | ✅ |
| `chat.system_message` | ✅ | ✅ | ✅ | ✅ |
| `chat.multi_turn` | ✅ | ✅ | ✅ | ❌ |
| `usage.present` | ✅ | ✅ | ✅ | ✅ |
| `usage.total_is_sum` | ✅ | ✅ | ✅ | ✅ |
| `errors.unknown_model` | ✅ | ✅ | ❌ | ❌ |
| `errors.malformed_json` | ✅ | ✅ | ✅ | ✅ |
| `errors.missing_messages` | ✅ | ✅ | ❌ | ❌ |
| `streaming.headers` | ✅ | ✅ | ✅ | ✅ |
| `streaming.basic` | ✅ | ✅ | ✅ | ✅ |
| `streaming.content_concatenates` | ✅ | ✅ | ✅ | ✅ |
| `streaming.finish_reason` | ✅ | ✅ | ✅ | ✅ |
| `streaming.done` | ✅ | ✅ | ✅ | ✅ |
| `streaming.timing` | ✅ | ✅ | ✅ | ✅ |
| `tools.generates_a_call` | ⊘ | ✅ | ⚠️ | ✅ |
| `tools.generates_a_call_when_forced` | ⊘ | ⊘ | ⚠️ | ✅ |
| `tools.fills_in_the_arguments` | ⊘ | ✅ | ⚠️ | ✅ |
| `tools.chooses_among_several_tools` | ⊘ | ✅ | ⚠️ | ✅ |
| `tools.reads_a_tool_result_back` | ⊘ | ✅ | ✅ | ✅ |
| `tools.answers_without_a_call_when_none_is_needed` | ⊘ | ✅ | ✅ | ✅ |
| `parameters.temperature` | ⊘ | ❌ | ✅ | ✅ |
| `parameters.top_p` | ⊘ | ⊘ | ✅ | ✅ |
| `parameters.max_completion_tokens` | ⊘ | ❌ | ✅ | ❌ |
| `parameters.stop` | ⊘ | ❌ | ✅ | ❌ |
| `parameters.seed` | ⊘ | ⊘ | ✅ | ❌ |
| `structured_output.json_object` | ⊘ | ⊘ | ⊘ | ⊘ |
| `structured_output.json_schema` | ⊘ | ⊘ | ✅ | ❌ |
| `sdk.node.models_list` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.basic` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.streaming` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.tools` | ⊘ | ✅ | ✅ | ✅ |

## What the numbers do not say

The percentages above rank `consumer_openai` running llama highest, at 100.0%. That is not the same as saying it is the most capable of the four, and the number went up when a defect was fixed by refusing something rather than by doing it. It refuses a great deal — fourteen of its thirty-two tests are skipped — and a refusal is left out of the percentage. LM Studio serving llama scores lower at 80.6% precisely because it attempts more, and can therefore be caught getting something wrong.

This is why the report prints a status for each capability and not only one number. A single percentage rewards a server for declining to do things.

## What this found

### Tool declarations never reached the model — fixed on 2026-08-16

The 2026-08-15 run found that `consumer_openai` reported that `llm_qwen3_5_0_8b_full` reads tool declarations, accepted a request carrying `tools`, and then dropped the declaration before the model saw it. The model answered in words, having never been offered a tool.

The token counts proved it, and now show the fix. The same request, the same model, the same LM Studio behind every row:

| Path | Prompt tokens | Result |
| --- | --- | --- |
| LM Studio, `tools` declared | 275 | emits a tool call |
| LM Studio, no `tools` | 17 | answers in words |
| `consumer_openai`, `tools` declared, 2026-08-15 | 17 | answers in words |
| `consumer_openai`, `tools` declared, 2026-08-16 | 275 | emits a tool call |

Seventeen is exactly the count for a prompt with no tools in it, so the declaration was not merely unhonoured, it was absent. Two hundred and seventy-five is the count with the declaration in the prompt, which is what the fixed path now sends.

The declaration was being dropped by `worker_openai` rather than by `consumer_openai`: the request it built for the local server carried no `tools` field at all. It now carries one, sends an assistant tool call and the tool result answering it under identifiers it mints, and reads the streamed tool call back. See [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190).

`tools.generates_a_call`, `tools.fills_in_the_arguments`, `tools.chooses_among_several_tools`, and `sdk.node.tools` all pass on the re-measured column. `tools.generates_a_call_when_forced` is skipped rather than failed, because `consumer_openai` refuses a `tool_choice: "required"` it cannot enforce: enforcing it means constraining generation, which the chat templates this cluster drives cannot express. That refusal is the decision [issue #78](https://github.com/webai-at-home/webai-at-home/issues/78) settled.

### `response_format` was accepted and ignored — fixed on 2026-08-16

The 2026-08-15 run found that `consumer_openai` never read `response_format`. The field appeared nowhere in `packages/consumer_openai/src/`, so both `json_object` and `json_schema` fell into the bucket of fields that were, by the schema's own comment, "accepted and then ignored" alongside `n` and `logprobs`.

Those fields tune an answer. `response_format` changes its shape, the way `tools` does — and `tools` was refused rather than ignored. The control run showed the cost: LM Studio serving llama honours `json_schema` and passes, while `consumer_openai` in front of that same LM Studio serving that same model failed, answering with prose.

An ignored field also fails at random, which is what made it hard to notice by hand. Across two runs of the same test against the same endpoint, `structured_output.json_object` passed once and warned once — the model happened to answer with bare JSON the first time and JSON in a code fence the second. Nothing about the endpoint changed between them.

`consumer_openai` now reads the field and refuses a shape the chosen task type cannot produce, with HTTP 400 and code `unhonourable_response_format`, on the same rule its generation controls follow. No task type produces a shape today: the de-risk gate of [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191) measured that the one engine in reach honouring `json_schema` is a local server behind `worker_openai`, while the worker browser tab that can serve the same task type generates through `@huggingface/transformers`, which offers no way to ask for a schema at all. A task type's contract is the intersection of what all of its workers honour, so both shapes are refused for every model this server offers.

Both `structured_output` rows in both `consumer_openai` columns are therefore ⊘ rather than ❌ or ⚠️, re-measured on 2026-08-16, and they are steady rather than changing from run to run. `@webai/protocol`'s `StructuredOutputSupport` is what a shape has to be entered into for that to change.

### `llm_qwen3_5_0_8b_full` answers plain questions with nothing at all

`chat.multi_turn` failed on this model on 2026-08-15 both through `consumer_openai` and against LM Studio directly, so the cause is upstream of this project. The mechanism is visible in one request:

```
finish_reason: length
usage: prompt_tokens 37, completion_tokens 8153, total_tokens 8190
completion_tokens_details: reasoning_tokens 8153
content: ''
reasoning_content: 29935 characters
```

Every one of the 8153 generated tokens is a reasoning token. The model thinks until the 8192-token context is exhausted and never reaches an answer, so `content` arrives empty with `finish_reason: length`. The same runaway explains this model's failures on `parameters.max_completion_tokens`, `parameters.stop`, `parameters.seed`, and `structured_output.json_schema`.

The root cause is the model and its context window rather than any code here, but the cluster offers this model, and a client asking it a two-turn question receives an empty answer.

It is a runaway rather than a certainty, so which tests it takes down varies between runs. On the 2026-08-16 re-measurement of the `consumer_openai` qwen column, `chat.multi_turn` passed.

That same column now fails `parameters.temperature`, `parameters.max_completion_tokens`, and `parameters.stop` with "the endpoint returned no answer text", where the 2026-08-15 run skipped all five `parameters` tests. Those three stopped being skipped because [`5be8998`](https://github.com/webai-at-home/webai-at-home/commit/5be8998) added them to this task type's generation control contract, so they are now attempted rather than refused — and what they run into is this same runaway. They were measured against a `worker_openai` built from the commit before [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190) was fixed as well as after, and failed identically both times, so they belong to the runaway and not to that fix.

### Two gaps in LM Studio, which `consumer_openai` does not share

- `errors.unknown_model`: LM Studio answers HTTP 200 for a model it was never told about, instead of refusing.
- `errors.missing_messages`: it returns HTTP 400 with `{"error":"'messages' field is required"}` — a bare string where the OpenAI protocol puts an object with `message`, `type`, `param`, and `code`.

`consumer_openai` passes both. These belong to LM Studio and are recorded here only because the comparison would otherwise look like this project's doing.

## What is deliberate and not a gap

A `parameters.*` test is skipped through `consumer_openai` for every control the model named does not honour, while LM Studio honours all five. That is a decision, not an oversight. A task type's declaration in `packages/protocol/src/task/generation_control_support.ts` is the contract of the task type, not the capability of whichever worker happens to take the job — and a task type such as `task_type_llm_llama3_2_1b_full` may be run either by a browser tab that cannot sample a `topP` or by a native worker that can. A consumer does not choose between them, so a control stays out of the contract until every worker of that task type honours it, which is why `topP` and `randomSeed` are refused there while `task_type_llm_qwen3_0_6b_sharded`, run only by a browser tab, honours all five. The conformance test marks a skipped control ⊘ and leaves it out of the percentage, which is the correct reading: nothing was measured, and nothing was broken.
