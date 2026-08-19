# `exp_01_one_turn_with_no_tool` — One Whole Turn, With A Question That Needs No Tool

The question of `exp_01_one_turn_with_no_tool`, from [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):

> Can the Codex command-line program be pointed at a base address that is not the OpenAI service, using the chat-completions request format, and complete one whole turn against `google/gemma-4-e2b`?

The question needed one correction before it could be answered, and the correction is the main result. See "The request format changed" below.

## Result

| Target model | Base address | Model identifier | Exit code | Seconds | Input tokens reported | Last message |
| --- | --- | --- | --- | --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | `google/gemma-4-e2b` | 0 | 16 | 8157 | `ready` |
| Ollama | `http://localhost:11434/v1` | `gemma4:e2b` | 0 | 5 | 2051 | `ready` |
| WebAI@Home | `http://localhost:8788/v1` | `llm_gemma_4_e2b_full` | 1 | 0 | none, the turn failed | none, the turn failed |

Two target models out of three pass the gate. The plan continues.

Every run was made with `codex-cli 0.145.0` and the question `Reply with exactly one word and nothing else: ready`, which needs no tool at all. The raw events, the last message, and the result of each run are in the folder of that target model, next to this file.

## The Request Format Changed

The Codex command-line program no longer speaks the chat-completions request format at all. Setting `wire_api = "chat"` is refused before any request is made:

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
More info: https://github.com/openai/codex/discussions/7782
in `model_providers.lmstudio_target_model.wire_api`
```

Every target model must therefore serve `POST /v1/responses`. LM Studio and Ollama both do, and both were confirmed by hand before any run of the Codex command-line program. This also means the conformance report of `google/gemma-4-e2b` measures a request format the Codex command-line program does not use, so none of its results carry over unchanged.

## Why WebAI@Home Failed, Twice, For Two Different Reasons

**The first reason was a missing endpoint, and it is fixed.** The OpenAI-compatible server of `packages/consumer_openai` served `POST /v1/chat/completions` and `GET /v1/models`, and answered `404 Not Found` to `POST /v1/responses`:

```
{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: <pre>Cannot POST /v1/responses</pre>, url: http://localhost:8788/v1/responses"}}
```

The Codex command-line program retried five times before giving up. That was a missing endpoint, not a missing worker, and it was reached before any task ever got to a worker. Separately, `GET /v1/models` answered with an empty list, so no worker was connected either. [Issue #214](https://github.com/webai-at-home/webai-at-home/issues/214) added the endpoint, and both conditions were removed before the rerun below: the server serves `POST /v1/responses`, and a native `worker_openai` in front of LM Studio's `google/gemma-4-e2b` was connected, so `GET /v1/models` answered `["llm_gemma_4_e2b_full"]`.

**The second reason is that every request declares tools, and this model accepts none.** The rerun failed in zero seconds:

```
{"type":"turn.failed","error":{"message":"The model llm_gemma_4_e2b_full cannot read tool declarations, and this server refuses a request it would have to ignore rather than answering it as though no tool had been declared. The models that accept tool declarations are llm_qwen3_5_0_8b_full. Send the request again without tools, or send it to a model that reads them."}}
```

The name `exp_01_one_turn_with_no_tool` describes the question, not the request. The question needs no tool, and the Codex command-line program declares its ten tools all the same, on this request as on every other, which `exp_03_prompt_size_measure` measured at 18587 characters of the body. `llm_gemma_4_e2b_full` is not one of the task types that accept tool declarations: `taskTypeNamesAcceptingTools` in `packages/consumer_cli/src/libs/task_input_factory.ts` holds `llm_qwen3_5_0_8b_full` and nothing else, so the request is refused rather than answered as though no tool had been declared.

So this experiment cannot pass against WebAI@Home while `target_models/webai_at_home.target_model.toml` names `llm_gemma_4_e2b_full`. There are two ways to make it pass, and neither is done: name a model that accepts tool declarations, or add `llm_gemma_4_e2b_full` to the ones that do, which needs a live gate of its own against the worker path and is declared out of scope in [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214).

## Recorded On The Way

- **The prompt is large.** For a question of eight words needing no tool, LM Studio reported 8157 input tokens. That is the base prompt of the Codex command-line program, and `exp_03_prompt_size_measure` measures it properly.
- **The two target models disagree on the count.** Ollama reported 2051 input tokens for the same question. The two target models cannot both be right, which is the reason `exp_03_prompt_size_measure` measures the prompt from recorded traffic rather than from what a target model reports.
- **Neither model is known to the Codex command-line program.** Both runs recorded `Model metadata for ... not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`, so the context window it assumes is a fallback and not the real one of Gemma 4 E2B.
- **The model already leaks its prompt, sometimes.** The runs recorded here answer exactly `ready`, but one earlier LM Studio run answered `ready` followed by the `<environment_context>` block of its own prompt. Nothing about the run changed between the two, because the seed parameter does not work on this endpoint. The turn still completed, so the gate passes, but this is the failure `exp_02_agent_loop_with_tool` measures.

## Cost

About one hour, including the correction of the request format.
