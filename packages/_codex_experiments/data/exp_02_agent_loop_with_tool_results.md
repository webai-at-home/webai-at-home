# `exp_02_agent_loop_with_tool` — One Small Task With A Checkable Result

The question of `exp_02_agent_loop_with_tool`, from [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):

> Given a small task it must actually perform, does the model emit a well-formed tool call, read the tool result back, and stop when the task is finished?

The task is fixed text in [`tasks/exp_02_agent_loop_with_tool.task.md`](../tasks/exp_02_agent_loop_with_tool.task.md), so all three target models were given exactly the same task, word for word: create `agent_loop.txt` holding the one line `agent loop ready`, read it back, run `ls agent_loop.txt`, then answer with the single word `done`. Each run got an empty workspace of its own. Every target model was run three times, because the seed parameter does not work and no run is reproducible.

## Result

| Target model | Runs | Tool calls per run | Read the tool result back | Stopped on its own | File written correctly |
| --- | --- | --- | --- | --- | --- |
| LM Studio | 3 | 3, 3, 3 | yes in all three | yes in all three | yes in all three |
| Ollama, as it was serving the model | 3 | 0, 0, 0 | no, there was nothing to read back | yes in all three | no, no file was ever created |
| Ollama, with a context length of 32768 | 3 | 1, 1, 1 | yes in all three | yes in all three | yes in all three |
| WebAI@Home | 3 | 3, 3, 3 | yes in all three | yes in all three | yes in all three |

The same model, at the same size, gave opposite results depending only on how it was served: three of the four rows did the whole task and one did nothing at all. The cause was found by `exp_03_prompt_size_measure` and is written below: it was one setting of the serving program, not the model. That is the finding of this experiment, and it is the reason the target model is an axis of the plan rather than a stage of it.

## LM Studio Held The Agent Loop Together

Each of the three runs made the same three tool calls, all of them `command_execution`, and each command was the obvious one:

```
/bin/zsh -lc 'echo "agent loop ready" > agent_loop.txt'
/bin/zsh -lc 'cat agent_loop.txt'
/bin/zsh -lc 'ls agent_loop.txt'
```

The output of each command came back to the model, the model wrote after the last one, the turn ended on its own, and `agent_loop.txt` held exactly the line the task asked for. Three runs out of three did the whole task correctly.

One flaw survives: the last message is not the single word the task asked for. It is `done` with prompt text stuck to it, such as `done<environment_context>` or `done` followed by the path of the workspace. The same leak was recorded in `exp_01_one_turn_with_no_tool`, so it is not caused by the tools.

## Ollama Answered `done` Without Doing Anything

All three runs made zero tool calls, created no file, and answered `done` anyway. The turn ended on its own with exit code 0, so nothing in the recorded events says the run failed. Only the check on the file on disk shows that nothing was done.

This is not the serving program refusing to pass the tools. Asked directly, with one small prompt and one tool, both serving programs produce a well-formed tool call from the same model:

```json
{"type": "function_call", "call_id": "call_rufjoey2", "name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}
```

That answer came from Ollama. LM Studio answered with the same tool call for the same request. So the capability is there in both, and something about the much larger prompt of the Codex command-line program removes it in one of the two.

## Ollama Did The Whole Task Once Its Context Length Was Raised

`exp_03_prompt_size_measure` found the cause: Ollama was cutting the prompt at about 2048 tokens, which threw the ten tool definitions away before the model ever saw them. `target_models/ollama_context_32768.modelfile` is the same Gemma 4 E2B with one setting changed, `num_ctx 32768`, and the same three runs against it did the whole task correctly three times out of three.

Each run made one tool call rather than three, because the model chained the three steps into one command:

```
/bin/zsh -lc 'echo "agent loop ready" > agent_loop.txt && cat agent_loop.txt && ls agent_loop.txt'
```

The output came back, the turn ended on its own, `agent_loop.txt` held exactly the right line, and the last message was the single word `done` with nothing stuck to it, which is one thing LM Studio never managed.

## The Reported Prompt Size Of Ollama Is A Constant

Ollama reported **exactly 2051 input tokens** in every recorded run: for the eight-word question of `exp_01_one_turn_with_no_tool`, and for the far longer task of this experiment, tool definitions included. The same number for two prompts of very different sizes is not a count of those prompts.

LM Studio, for the same two prompts, reported 8157 and then 35644, 35676, and 35891 input tokens, which grows with the prompt and with each tool result fed back in.

Two explanations fit, and this experiment cannot separate them:

- Ollama truncates the prompt to a fixed context length, which would cut the tool definitions out of it and would explain the zero tool calls.
- Ollama reports a number that is not the size of the prompt it received, and the truncation is imagined.

`exp_03_prompt_size_measure` settled this by measuring the prompt from recorded traffic instead of believing what the target model reports: the first explanation is the right one, and 2051 is a ceiling of about 2048 tokens rather than a count. No conclusion about the ability of Gemma 4 E2B should be drawn from the Ollama runs made before the context length was raised.

## WebAI@Home Did The Whole Task, Three Runs Out Of Three

The first two attempts never reached the task at all. The first failed with `404 Not Found` on `POST /v1/responses`, which [issue #214](https://github.com/webai-at-home/webai-at-home/issues/214) added. The second failed because every request of the Codex command-line program declares ten tools and `llm_gemma_4_e2b_full` accepted none, which [issue #216](https://github.com/webai-at-home/webai-at-home/issues/216) fixed by making the task type actually read a tool call rather than by weakening the refusal. Both are written up in [`exp_01_one_turn_with_no_tool_results.md`](exp_01_one_turn_with_no_tool_results.md).

The three runs recorded here were made after both fixes, against a native `worker_openai` in front of LM Studio's `google/gemma-4-e2b`. Each made the same three `command_execution` tool calls LM Studio made when it was asked directly:

```
/bin/zsh -lc 'echo "agent loop ready" > agent_loop.txt'
/bin/zsh -lc 'cat agent_loop.txt'
/bin/zsh -lc 'ls agent_loop.txt'
```

The output of each command came back to the model, the model wrote after the last one, the turn ended on its own, and `agent_loop.txt` held exactly the line the task asked for, in 25 to 29 seconds. Three runs out of three did the whole task correctly.

**One thing this target model does that LM Studio does not: the last message is exactly `done`.** Asked directly, LM Studio leaks part of its own prompt into that message — `done<environment_context>`, or `done` followed by the path of the workspace — and the same leak was recorded in `exp_01_one_turn_with_no_tool`. Through WebAI@Home the answer is the single word the task asked for, in all three runs. The same model behind the same server, reached one way, leaks, and reached the other way, does not. What is different is the route, and this experiment does not say which part of it removes the leak.

## What Was Measured, And What Was Not

Measured for every run and recorded next to this file: the exit code, the seconds, the number and kind of tool calls, whether the model wrote anything after its last tool call, whether the turn completed on its own, whether the file exists, whether its content is exactly right, and the last message.

Not measured: whether the last message is exactly the word the task asked for. The last message is recorded verbatim in each run, and the leak described above is read from it by a person.
