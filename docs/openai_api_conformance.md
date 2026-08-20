# OpenAI API Conformance

This document records what happens when the OpenAI API Conformance Test is pointed at this project's own OpenAI-compatible server, and at the local model server that same cluster forwards to. It answers one question: which parts of the OpenAI Chat Completions protocol does each of them actually honour?

It does not grade whether an answer is a good answer. A model that replies with something unhelpful still passes, as long as the protocol was followed. See [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181) for why the two are kept apart.

## Running it

```bash
npx tsx packages/_openai_conformance_test_TOREMOVE/src/cli.ts --model llm_llama3_2_1b_full --profile full
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

Four targets, first measured on 2026-08-15 with the `full` profile. Later runs are folded in, all on 2026-08-16.

The two qwen columns were both measured again in full on 2026-08-16, after [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192) was worked through, so those two are a same-day pair and the comparison between them holds. The two llama columns are the 2026-08-15 run, except for the two `structured_output` rows of `consumer_openai` llama, measured again on 2026-08-16 with the `structured_output` profile after [issue #191](https://github.com/webai-at-home/webai-at-home/issues/191) was fixed. So a qwen column is no longer a same-day comparison with the llama column beside it.

Both LM Studio columns were served by LM Studio 0.4.20 throughout, so no row moved because that server changed.

- `consumer_openai` running `llm_llama3_2_1b_full`, served by a `worker_openai` forwarding to LM Studio.
- `consumer_openai` running `llm_qwen3_5_0_8b_full`, served the same way.
- LM Studio directly, serving `llama-3.2-1b-instruct` — the same weights the first target reaches, one hop earlier.
- LM Studio directly, serving `qwen_qwen3.5-0.8b` — likewise for the second.

The two LM Studio columns are the control. When a test passes there and fails through `consumer_openai`, the difference is this project's, not the model's.

| | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| Passed | 18 | 24 | 25 | 26 |
| Failed | 0 | 3 | 2 | 5 |
| Skipped | 14 | 5 | 1 | 1 |
| Warned | 0 | 0 | 4 | 0 |
| Compatibility | 100.0% | 88.9% | 80.6% | 83.9% |

Per test:

| Test | `consumer_openai` llama | `consumer_openai` qwen | LM Studio llama | LM Studio qwen |
| --- | --- | --- | --- | --- |
| `models.list` | ✅ | ✅ | ✅ | ✅ |
| `chat.basic` | ✅ | ✅ | ✅ | ✅ |
| `chat.system_message` | ✅ | ✅ | ✅ | ✅ |
| `chat.multi_turn` | ✅ | ❌ | ✅ | ✅ |
| `usage.present` | ✅ | ✅ | ✅ | ✅ |
| `usage.total_is_sum` | ✅ | ✅ | ✅ | ✅ |
| `errors.unknown_model` | ✅ | ✅ | ❌ | ✅ |
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
| `parameters.temperature` | ⊘ | ✅ | ✅ | ❌ |
| `parameters.top_p` | ⊘ | ⊘ | ✅ | ✅ |
| `parameters.max_completion_tokens` | ⊘ | ❌ | ✅ | ❌ |
| `parameters.stop` | ⊘ | ❌ | ✅ | ❌ |
| `parameters.seed` | ⊘ | ⊘ | ✅ | ❌ |
| `structured_output.json_object` | ⊘ | ⊘ | ⊘ | ⊘ |
| `structured_output.json_schema` | ⊘ | ⊘ | ✅ | ✅ |
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

That was true until 2026-08-20, when `task_type_llm_gemma_4_e2b_full` became the first task type to produce both shapes: `@huggingface/transformers-response-constraint` constrains generation in the worker browser tab, and the native worker sends `response_format` to the local server it forwards to. Both kinds of worker were measured live before the row was entered. See [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221).

### `llm_qwen3_5_0_8b_full` thinks until its budget is gone, and never begins an answer

This model thinks before it answers, and on some questions it never stops thinking. One request against LM Studio directly, no cluster involved:

```
finish_reason: length
usage: prompt_tokens 37, completion_tokens 8153, total_tokens 8190
completion_tokens_details: reasoning_tokens 8153
content: ''
```

Every one of the 8153 generated tokens is a reasoning token. The thinking is stripped out of `content`, and what is left is empty. The cause is upstream of this project: it reproduces against LM Studio directly, and it reproduced again in a browser tab on a different engine, where the model ran to a 2048-token cap in 63.8 seconds without ever closing its thinking block. See [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192).

It is a runaway rather than a certainty, so which tests it takes down moves between runs. `chat.multi_turn` failed on both qwen targets on 2026-08-15; on 2026-08-16 it failed through `consumer_openai` and passed against LM Studio, same model, same question, same day.

Two ways out were tried on 2026-08-16 and both failed, so neither is an open option any more:

- **Raising the context window does not work.** Reloaded at 32768 tokens, the same question produced 32731 reasoning tokens and the same empty answer. The thinking expands to fill whatever room it is given.
- **`chat_template_kwargs` is dropped by LM Studio.** The model's own chat template does read `enable_thinking`, but sending `true`, sending `false`, and sending nothing all produced the same behaviour.

What does work is `reasoning_effort`, which LM Studio does read: `"none"` takes the reasoning token count to zero and returns a finished answer in 42 tokens, while `"low"` and `"medium"` both still run away. It is now a consumer-set control carried from a request through to the local server, which is why the refusals in the `consumer_openai` qwen column for `parameters.top_p` and `parameters.seed` now name it among the controls this model honours.

**The remaining failures are the runaway, and they are now stated rather than hidden.** `chat.multi_turn` and `parameters.max_completion_tokens` fail in the `consumer_openai` qwen column with an explicit HTTP 502:

> The cluster could not finish this task: The model generated all 8149 tokens it was allowed without writing any answer text, and stopped because it ran out of room rather than because it had finished. A model that thinks before it answers can do this by never finishing thinking; asking for reasoning_effort "none" stops it.

Before this, those runs returned HTTP 200 carrying an empty string, which a client cannot tell apart from a model that genuinely had nothing to say. A ❌ that says what happened is not the same defect as a ❌ that says nothing — and the four LM Studio `parameters` failures beside it, still reported as "the endpoint returned no answer text", are what the old behaviour looks like from the outside.

`parameters.stop` is the one qwen failure in that column that is not this. It returns an empty answer having ended on its stop sequence rather than at its limit, and a model that stopped of its own accord is reported as it stands rather than failed.

`parameters.temperature` now passes, where the 2026-08-15 run skipped it and a later 2026-08-16 run failed it. It stopped being skipped because [`5be8998`](https://github.com/webai-at-home/webai-at-home/commit/5be8998) added it to this task type's generation control contract, so it is attempted rather than refused; whether it then meets the runaway is luck.

None of this makes the model able to answer a plain two-turn question. A consumer that knows to send `reasoning_effort: "none"` gets an answer; one that sends nothing gets a clear failure.

The cluster goes on offering `llm_qwen3_5_0_8b_full` on those terms, decided on [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192). A model that answers when asked properly and fails loudly when not is worth offering; it was the silent empty answer that was not, and that is gone. This is written down so the two ❌ rows above are not read as an oversight: they are a model's limitation, stated.

### Two gaps in LM Studio, which `consumer_openai` does not share

- `errors.unknown_model`: LM Studio answered HTTP 200 for a model it was never told about, instead of refusing. Both LM Studio columns recorded that on 2026-08-15, and the 2026-08-16 qwen run passed it, on the same LM Studio 0.4.20. Nothing observed here explains the difference, so nothing is claimed about it.
- `errors.missing_messages`: it returns HTTP 400 with `{"error":"'messages' field is required"}` — a bare string where the OpenAI protocol puts an object with `message`, `type`, `param`, and `code`. Unchanged in every LM Studio run.

`consumer_openai` passes both. These belong to LM Studio and are recorded here only because the comparison would otherwise look like this project's doing.

## What is deliberate and not a gap

A `parameters.*` test is skipped through `consumer_openai` for every control the model named does not honour, while LM Studio honours all five. That is a decision, not an oversight. A task type's declaration in `packages/protocol/src/task/generation_control_support.ts` is the contract of the task type, not the capability of whichever worker happens to take the job — and a task type such as `task_type_llm_llama3_2_1b_full` may be run either by a browser tab that cannot sample a `topP` or by a native worker that can. A consumer does not choose between them, so a control stays out of the contract until every worker of that task type honours it, which is why `topP` and `randomSeed` are refused there while `task_type_llm_qwen3_0_6b_sharded`, run only by a browser tab, honours all five. The conformance test marks a skipped control ⊘ and leaves it out of the percentage, which is the correct reading: nothing was measured, and nothing was broken.
