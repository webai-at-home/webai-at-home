# Qwen3.5-0.8B · Issue #115 tool calls de-risk gate

Loads [`onnx-community/Qwen3.5-0.8B-ONNX`](https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision and `q4f16` quantization as
[`stage_helper_llm_qwen3_5_0_8b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_qwen3_5_0_8b_full.ts),
and answers milestone 0's question for [issue #115](https://github.com/webai-at-home/webai-at-home/issues/115).

## Why this gate exists even though the model already passed

`qwen_qwen3.5-0.8b` served by LM Studio passes all six tool call abilities the `tool_calls` subcommand of
[`@webai/openai-api-tool`](../../../openai_api_tool_TOREMOVE/) probes, in both the streamed and the nostream mode. That is a
measurement of the model weights, taken through a server that applies the chat template and parses the tool calls
itself, and hands back structured `tool_calls`.

`llm_qwen3_5_0_8b_full` is a different arrangement of the same model: Transformers.js in a volunteer browser tab,
running the `q4f16` ONNX export, with this project applying the chat template and reading the tool calls back out of
the generated text by hand. Three things can fail there that cannot fail through LM Studio, and none of them is
assumed:

1. the chat template bundled with this export may have no slot for tool declarations at all;
2. the `q4f16` export may not generate a tool call where the build LM Studio serves does;
3. whatever the model writes has to be found and parsed back out of the streamed text.

Treating the LM Studio result as proof for this path would be the same mistake as the original de-risk gate of
[issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), which was run against one server and read as a
finding about tool calling in general.

## The six phases

Each phase prints its raw input and its raw output, so a conclusion can be checked against what the model really
wrote rather than taken on trust.

1. **Does the bundled chat template have a slot for tool declarations?** The cheapest possible kill: if it does not,
   nothing below can work and the answer is known without generating a token.
2. **Do the tool declarations reach the rendered prompt?** The template is rendered as text and printed whole. A
   template that mentions tools but drops these ones looks identical to a working one until the text is read.
3. **Does the model generate a tool call?** The question that cannot be answered by reading anything, and the one this
   gate exists for. Reports the call's name and arguments.
4. **Does it choose the right tool out of two?**
5. **Does it answer in words when no tool is needed?** The negative control. Without it, a model that writes a tool
   call every time would pass every phase above and still be useless.
6. **Does a tool result render, and does the model answer from it?** The other half of a round trip, and a separate
   ability a model can have without the first.

## What the gate already settles without running

Two things were read out of the installed packages rather than measured, and both shape the implementation:

- `@huggingface/transformers` 4.2.0 **does** accept a `tools` option on `apply_chat_template`. Its own documentation
  adds that the option has no effect when the template does not support tools, which is what phase 1 and phase 2
  check.
- The text-generation pipeline exposes **no** `tools` option of its own. It applies the chat template itself when it is
  handed a message list, with no way to pass tool declarations through. So the prompt has to be rendered separately
  and passed to the pipeline as a string — which is how this gate generates, so that it generates the same way the
  real stage would have to.

## Results

Measured on 11 August 2026, in a live browser run against the pinned revision at `q4f16` on the WebGPU backend. **Every
phase passed.** The gate is green, and issue #115 is unblocked on the real transport rather than on a stand-in.

| Phase | Result |
| --- | --- |
| 1 · chat template has a tools slot | yes — 7755 characters, mentioning both `tools` and `tool_call` |
| 2 · declarations reach the rendered prompt | yes — declaring two tools added 1668 characters to a 106-character prompt |
| 3 · generates a tool call | yes — `get_current_weather` with `city` = `Paris` |
| 4 · chooses the right tool out of two | yes — `get_current_time` for the time question |
| 5 · answers in words when no tool is needed | yes — wrote `hello` and asked for nothing |
| 6 · tool result renders, and it answers from it | yes — "The current weather in Paris is **31 degrees Celsius** with a **clear sky**." |

Two findings shape the implementation, and neither could have been learned from the LM Studio measurement.

**The tool call format is not JSON.** This export's chat template instructs the model to write an XML-like form, and
the model follows it exactly:

```text
<tool_call>
<function=get_current_weather>
<parameter=city>
Paris
</parameter>
</function>
</tool_call>
```

That is not the JSON-inside-`<tool_call>` form Qwen2.5 and Qwen3 use, which is what this gate was first written to
expect and what anyone who knows those models would reach for. The first run reported "does not parse as JSON" on two
otherwise perfect tool calls for exactly that reason. Every parameter value arrives as text, because this format
carries no types at all, so turning one into the JSON arguments the OpenAI interface defines means converting each
value using the type its tool declared.

**A tool result is rendered as a `user` turn, not a turn of its own.** The template wraps it in
`<tool_response>…</tool_response>` inside `<|im_start|>user`, and it renders an assistant message carrying `tool_calls`
back into the same XML-like form. So a history carrying a tool result round trips through this template
correctly, without this project having to write either half by hand.

One measurement worth carrying forward: each of these answers took **22 to 29 seconds** for 2 to 27 generated tokens,
against about 7 seconds for a short answer in the [issue #96 gate](../qwen3_5-0.8b-gate/). Declaring two tools adds
1668 characters of prompt that the model must read before it writes anything, and that prefill is where the time goes.
A real tool interface would declare more tools than two.

## Run

Start the dev server from the package root and open `qwen3_5-tool-calls-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model files are cached by the browser (IndexedDB), so a browser that already ran
[`qwen3_5-0.8b-gate`](../qwen3_5-0.8b-gate/) or [`qwen3_5-usage-metadata-gate`](../qwen3_5-usage-metadata-gate/) does
not re-download them.

See [`../../README.md`](../../README.md) for the other experiments in this package.
