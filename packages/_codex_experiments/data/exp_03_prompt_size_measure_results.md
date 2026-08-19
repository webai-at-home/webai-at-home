# `exp_03_prompt_size_measure` — What The Codex Command-Line Program Sends, Measured From The Traffic

The question of `exp_03_prompt_size_measure`, from [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213):

> How large is the prompt the Codex command-line program builds, and which request fields does it actually use?

A recording proxy sat between the Codex command-line program and the target model, passed every request and every answer through unchanged, and wrote both down. Every measurement below is read from that recording, never from what a target model reports about itself. The task was the one of `exp_02_agent_loop_with_tool`, so the prompt grows turn after turn exactly as it does there.

## The Prompt Of The Codex Command-Line Program

The first request of every run, against all three target models, was about 49800 bytes:

| Part of the request | Size | Changes between turns |
| --- | --- | --- |
| The whole body | 49788 bytes against LM Studio, 49764 against Ollama, 49830 against WebAI@Home | grows with the history |
| `instructions`, the standing prompt | 20751 characters | never |
| `tools`, ten of them | 18587 characters | never |
| `input`, the history | 8747 characters in 3 items | grows every turn |

So about 39000 of the 49800 characters are fixed overhead that is resent whole on every single request, and only the history grows.

Against LM Studio, which was the only target model that held the agent loop together, the six requests of one run grew like this:

| Request | Bytes | Input items | Input characters | Input tokens LM Studio reported |
| --- | --- | --- | --- | --- |
| 1 | 49788 | 3 | 8747 | 8630 |
| 2 | 51361 | 6 | 10320 | 8966 |
| 3 | 51979 | 9 | 10938 | 9090 |
| 4 | 52559 | 12 | 11518 | 9208 |
| 5 | 53200 | 15 | 12159 | 9335 |
| 6 | 54088 | 18 | 13047 | 9514 |

Three tool calls cost about 4300 bytes of history and about 900 tokens. A prompt of about 8600 tokens is the floor for one turn of the Codex command-line program, whatever is asked of it.

The `estimatedTokens` field in the recorded measurements divides characters by four. Against the counts LM Studio reported, that estimate is about 45 percent high for this kind of JSON, so it is an upper bound and not a count.

## Every Field The Codex Command-Line Program Sends

The same twelve fields went out on every request, to all three target models:

`client_metadata`, `include`, `input`, `instructions`, `model`, `parallel_tool_calls`, `prompt_cache_key`, `reasoning`, `store`, `stream`, `tool_choice`, `tools`

**None of the four parameters recorded as failing in the conformance report is ever sent.** No `max_output_tokens`, no `stop`, no `seed`, no `top_p`, and no `temperature` either. Those failures cannot reach the Codex command-line program, and the report that found them measures a request format it does not use.

That list of twelve fields, on `POST /v1/responses`, is the whole specification the WebAI@Home gateway has to satisfy.

## Why Ollama Made No Tool Call: The Prompt Is Cut

`exp_02_agent_loop_with_tool` left two explanations open for the 2051 input tokens Ollama reported for every prompt. The recorded traffic settles it. The request that reached Ollama carried the whole thing: 20751 characters of instructions and all ten tools, in 49764 bytes. Nothing truncated it on the way out.

`npm run ollama_context_ceiling_probe --workspace @webai/codex-experiments` then sends the real tools and the real instructions to Ollama at three sizes:

| What was sent | Bytes | Made a tool call | Input tokens Ollama reported |
| --- | --- | --- | --- |
| one tool, short instructions | 437 | yes | 86 |
| the ten tools of the Codex command-line program, short instructions | 18847 | no | 2051 |
| the ten tools and the whole instructions | 40000 | no | 2051 |

**2051 is a ceiling, not a constant.** For a small prompt Ollama reports 86, which tracks the prompt. For every larger prompt it reports 2051 and stops there, which is about 2048 tokens. Everything past that ceiling is cut away, the ten tool definitions with it, and a model that is never shown a tool cannot call one.

So the agent loop of `exp_02_agent_loop_with_tool` did not fail because Gemma 4 E2B is too small. It failed because Ollama served it about 2048 tokens of a prompt that is about 8600 tokens long. The model file itself declares a context length of 131072 and the `tools` capability, and Ollama does produce a well-formed tool call when the prompt fits.

The next step is to raise the context length of the Ollama server above the prompt of the Codex command-line program and run `exp_02_agent_loop_with_tool` against Ollama again. That is a change to the Ollama installation of the person running the experiment, so it is not made here.

## WebAI@Home, And The Cross-Check That Could Not Be Made

All six recorded requests to WebAI@Home were identical, 49830 bytes each, and all six were answered `404 Not Found`. The Codex command-line program sent the first and then retried five times, and every retry carried the whole 49830 bytes again.

The plan asked for the proxy recording to be cross-checked against the `curl -v`-style request log the OpenAI-compatible server of `packages/consumer_openai` writes for every request, from [issue #75](https://github.com/webai-at-home/webai-at-home/issues/75). That cross-check cannot be made: the log holds zero `POST /v1/responses` entries, because a request to a route the server does not serve never reaches the part of it that writes the log. The proxy recording is therefore the only record of those six requests, and it is the reason the proxy exists.

## What Is Committed

The whole recorded traffic runs to several megabytes and is not committed. What answers the questions above is: `exp_03_prompt_size_measure_measurements.json` and `exp_03_prompt_size_measure_result.txt` for each target model, and `ollama_context_ceiling_probe_result.txt` for the probe. The traffic itself is written to `recordings/<target model>/` and can be made again by running the experiment.
