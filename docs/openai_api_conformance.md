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

Four targets, all on 2026-08-15, with the `full` profile:

- `consumer_openai` running `llm_llama3_2_1b_full`, served by a `worker_openai` forwarding to LM Studio.
- `consumer_openai` running `llm_qwen3_5_0_8b_full`, served the same way.
- LM Studio directly, serving `llama-3.2-1b-instruct` — the same weights the first target reaches, one hop earlier.
- LM Studio directly, serving `qwen_qwen3.5-0.8b` — likewise for the second.

The two LM Studio columns are the control. When a test passes there and fails through `consumer_openai`, the difference is this project's, not the model's.

| | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| Passed | 18 | 20 | 25 | 24 |
| Failed | 1 | 6 | 2 | 7 |
| Skipped | 12 | 6 | 1 | 1 |
| Warned | 1 | 0 | 4 | 0 |
| Compatibility | 90.0% | 76.9% | 80.6% | 77.4% |

Per test:

| Test | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| `models.list` | ✅ | ✅ | ✅ | ✅ |
| `chat.basic` | ✅ | ✅ | ✅ | ✅ |
| `chat.system_message` | ✅ | ✅ | ✅ | ✅ |
| `chat.multi_turn` | ✅ | ❌ | ✅ | ❌ |
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
| `tools.generates_a_call` | ⊘ | ❌ | ⚠️ | ✅ |
| `tools.generates_a_call_when_forced` | ⊘ | ⊘ | ⚠️ | ✅ |
| `tools.fills_in_the_arguments` | ⊘ | ❌ | ⚠️ | ✅ |
| `tools.chooses_among_several_tools` | ⊘ | ❌ | ⚠️ | ✅ |
| `tools.reads_a_tool_result_back` | ⊘ | ✅ | ✅ | ✅ |
| `tools.answers_without_a_call_when_none_is_needed` | ⊘ | ✅ | ✅ | ✅ |
| `parameters.temperature` | ⊘ | ⊘ | ✅ | ✅ |
| `parameters.top_p` | ⊘ | ⊘ | ✅ | ✅ |
| `parameters.max_completion_tokens` | ⊘ | ⊘ | ✅ | ❌ |
| `parameters.stop` | ⊘ | ⊘ | ✅ | ❌ |
| `parameters.seed` | ⊘ | ⊘ | ✅ | ❌ |
| `structured_output.json_object` | ⚠️ | ✅ | ⊘ | ⊘ |
| `structured_output.json_schema` | ❌ | ❌ | ✅ | ❌ |
| `sdk.node.models_list` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.basic` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.streaming` | ✅ | ✅ | ✅ | ✅ |
| `sdk.node.tools` | ⊘ | ❌ | ✅ | ✅ |

## What the numbers do not say

The percentages above rank `consumer_openai` running llama highest, at 90.0%. That is not the same as saying it is the most capable of the four. It refuses a great deal — twelve of its thirty-two tests are skipped — and a refusal is left out of the percentage. LM Studio serving llama scores lower at 80.6% precisely because it attempts more, and can therefore be caught getting something wrong.

This is why the report prints a status for each capability and not only one number. A single percentage rewards a server for declining to do things.

## What this found

### Tool declarations never reach the model

`consumer_openai` reports that `llm_qwen3_5_0_8b_full` reads tool declarations, accepts a request carrying `tools`, and then drops the declaration before the model sees it. The model answers in words, having never been offered a tool.

The token counts prove it. The same request, the same model, the same LM Studio behind both:

| Path | Prompt tokens | Result |
| --- | --- | --- |
| LM Studio, `tools` declared | 275 | emits a tool call |
| LM Studio, no `tools` | 17 | answers in words |
| `consumer_openai`, `tools` declared | 17 | answers in words |

Seventeen is exactly the count for a prompt with no tools in it. The declaration is not merely unhonoured, it is absent.

This is the failure this project's own rule forbids. `packages/consumer_openai/src/api/openai_types.ts` states that a request declaring tools to a model that cannot read them is refused rather than answered as though it had declared none. Here the model *can* read them, and the request is answered as though none had been declared, which is the same wrong outcome by the opposite route.

### `response_format` is accepted and ignored

`consumer_openai` never reads `response_format`. The field appears nowhere in `packages/consumer_openai/src/`, so both `json_object` and `json_schema` fall into the bucket of fields that are, by the schema's own comment, "accepted and then ignored" alongside `n` and `logprobs`.

Those fields tune an answer. `response_format` changes its shape, the way `tools` does — and `tools` is refused rather than ignored. The control run shows the cost: LM Studio serving llama honours `json_schema` and passes, while `consumer_openai` in front of that same LM Studio serving that same model fails, answering with prose.

An ignored field also fails at random, which is what makes it hard to notice by hand. Across two runs of the same test against the same endpoint, `structured_output.json_object` passed once and warned once — the model happened to answer with bare JSON the first time and JSON in a code fence the second. Nothing about the endpoint changed between them.

### `llm_qwen3_5_0_8b_full` answers plain questions with nothing at all

`chat.multi_turn` fails on this model both through `consumer_openai` and against LM Studio directly, so the cause is upstream of this project. The mechanism is visible in one request:

```
finish_reason: length
usage: prompt_tokens 37, completion_tokens 8153, total_tokens 8190
completion_tokens_details: reasoning_tokens 8153
content: ''
reasoning_content: 29935 characters
```

Every one of the 8153 generated tokens is a reasoning token. The model thinks until the 8192-token context is exhausted and never reaches an answer, so `content` arrives empty with `finish_reason: length`. The same runaway explains this model's failures on `parameters.max_completion_tokens`, `parameters.stop`, `parameters.seed`, and `structured_output.json_schema`.

The root cause is the model and its context window rather than any code here, but the cluster offers this model, and a client asking it a two-turn question receives an empty answer.

### Two gaps in LM Studio, which `consumer_openai` does not share

- `errors.unknown_model`: LM Studio answers HTTP 200 for a model it was never told about, instead of refusing.
- `errors.missing_messages`: it returns HTTP 400 with `{"error":"'messages' field is required"}` — a bare string where the OpenAI protocol puts an object with `message`, `type`, `param`, and `code`.

`consumer_openai` passes both. These belong to LM Studio and are recorded here only because the comparison would otherwise look like this project's doing.

## What is deliberate and not a gap

A `parameters.*` test is skipped through `consumer_openai` for every control the model named does not honour, while LM Studio honours all five. That is a decision, not an oversight. A task type's declaration in `packages/protocol/src/task/generation_control_support.ts` is the contract of the task type, not the capability of whichever worker happens to take the job — and a task type such as `task_type_llm_llama3_2_1b_full` may be run either by a browser tab that cannot sample a `topP` or by a native worker that can. A consumer does not choose between them, so a control stays out of the contract until every worker of that task type honours it, which is why `topP` and `randomSeed` are refused there while `task_type_llm_qwen3_0_6b_sharded`, run only by a browser tab, honours all five. The conformance test marks a skipped control ⊘ and leaves it out of the percentage, which is the correct reading: nothing was measured, and nothing was broken.
