# `exp_02_agent_loop_with_tool` — One Small Task With A Checkable Result

The question of `exp_02_agent_loop_with_tool`, from [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):

> Given a small task it must actually perform, does the model emit a well-formed tool call, read the tool result back, and stop when the task is finished?

The task is fixed text in [`tasks/exp_02_agent_loop_with_tool.task.md`](../tasks/exp_02_agent_loop_with_tool.task.md), so all three target models were given exactly the same task, word for word: create `agent_loop.txt` holding the one line `agent loop ready`, read it back, run `ls agent_loop.txt`, then answer with the single word `done`. Each run got an empty workspace of its own. Every target model was run three times, because the seed parameter does not work and no run is reproducible.

## Result

| Target model | Runs | Tool calls per run | Read the tool result back | Stopped on its own | File written correctly |
| --- | --- | --- | --- | --- | --- |
| LM Studio | 3 | 3, 3, 3 | yes in all three | yes in all three | yes in all three |
| Ollama | 3 | 0, 0, 0 | no, there was nothing to read back | yes in all three | no, no file was ever created |
| WebAI@Home | 3 | 0, 0, 0 | no, the turn never started | no, exit code 1 in all three | no, no file was ever created |

The same model, at the same size, served by two different programs, gave opposite results. That is the finding of this experiment, and it is the reason the target model is an axis of the plan rather than a stage of it.

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

## The Reported Prompt Size Of Ollama Is A Constant

Ollama reported **exactly 2051 input tokens** in every recorded run: for the eight-word question of `exp_01_one_turn_with_no_tool`, and for the far longer task of this experiment, tool definitions included. The same number for two prompts of very different sizes is not a count of those prompts.

LM Studio, for the same two prompts, reported 8157 and then 35644, 35676, and 35891 input tokens, which grows with the prompt and with each tool result fed back in.

Two explanations fit, and this experiment cannot separate them:

- Ollama truncates the prompt to a fixed context length, which would cut the tool definitions out of it and would explain the zero tool calls.
- Ollama reports a number that is not the size of the prompt it received, and the truncation is imagined.

`exp_03_prompt_size_measure` settles this by measuring the prompt from recorded traffic instead of believing what the target model reports. Until then, no conclusion should be drawn about the ability of Gemma 4 E2B from the Ollama runs.

## WebAI@Home Failed Before The Task

All three runs failed with exit code 1 and `404 Not Found` on `POST /v1/responses`, the same missing endpoint recorded in [`exp_01_one_turn_with_no_tool_results.md`](exp_01_one_turn_with_no_tool_results.md). Nothing about the agent loop was measured, because no turn ever started.

## What Was Measured, And What Was Not

Measured for every run and recorded next to this file: the exit code, the seconds, the number and kind of tool calls, whether the model wrote anything after its last tool call, whether the turn completed on its own, whether the file exists, whether its content is exactly right, and the last message.

Not measured: whether the last message is exactly the word the task asked for. The last message is recorded verbatim in each run, and the leak described above is read from it by a person.
