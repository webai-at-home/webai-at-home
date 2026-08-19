# Gemma 4 E2B · Issue #216 tool calls de-risk gate

Loads [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision, the same `q4f16` quantization, and the same WebGPU-only rule as
[`stage_helper_llm_gemma_4_e2b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts),
and answers milestone 0's question for [issue #216](https://github.com/webai-at-home/webai-at-home/issues/216).

## Why this gate exists even though the model already passed

`google/gemma-4-e2b` served by LM Studio, and served by Ollama with its context length raised, does the whole agent
loop of [`packages/_codex_experiments`](../../../_codex_experiments/) correctly, three runs out of three. That is a
measurement of the model weights, taken through servers that apply the chat template and parse the tool calls
themselves, and hand back structured `tool_calls`.

`llm_gemma_4_e2b_full` is a different arrangement of the same model: Transformers.js in a worker browser tab, running
the `q4f16` ONNX export on WebGPU, with this project applying the chat template and reading the tool calls back out of
the generated text by hand. Four things can fail there that cannot fail through LM Studio, and none of them is
assumed:

1. the chat template bundled with this export may have no slot for tool declarations at all;
2. the `q4f16` export on WebGPU may not generate a tool call where the served build does;
3. whatever the model writes has to be found and parsed back out of the generated text, in a format that belongs to
   this model and that this project has never measured;
4. the markers of that format may be special tokens, in which case `skip_special_tokens: true` strips them before any
   reader ever sees them.

Treating the LM Studio result as proof for this path would be the same mistake as the original de-risk gate of
[issue #78](https://github.com/webai-at-home/webai-at-home/issues/78), which was run against one server and read as a
finding about tool calling in general. The fourth point is the one the gate of
[issue #115](https://github.com/webai-at-home/webai-at-home/issues/115) taught: Qwen3.5's `<tool_call>` markers survive
decoding only because they are added tokens with `special: false` in that tokenizer, which is a property of that
tokenizer and not a rule.

## The nine phases

Each phase prints its raw input and its raw output, so a conclusion can be checked against what the model really
wrote rather than taken on trust.

1. **Is this really running on WebGPU?** Gemma 4 E2B is never run on WebAssembly here, for the reasons
   [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211) settled. An adapter without `shader-f16`
   refuses before about 3111 megabytes are read, and a dropped execution provider is caught after loading.
2. **Does this run answer questions whose answers are known?** WebGPU returns wrong numbers without reporting an
   error, which is what killed [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172), so a model
   that writes a fluent tool call may still be a model whose output is wrong.
3. **Does the bundled chat template have a slot for tool declarations?** The cheapest possible kill: if it does not,
   nothing below can work and the answer is known without generating a token.
4. **Do the tool declarations reach the rendered prompt?** The template is rendered as text and printed whole, both
   with the tools and without them.
5. **Do the tool call markers survive `skip_special_tokens: true`?** Read off the loaded tokenizer's own added
   tokens, and then shown on a tool call written by hand, encoded, and decoded both ways.
6. **Does the model generate a tool call?** The question that cannot be answered by reading anything, and the one
   this gate exists for. The raw generated text is recorded character for character.
7. **Does it choose the right tool out of two?**
8. **Does it answer in words when no tool is needed?** The negative control. Without it, a model that writes a tool
   call every time would pass every phase above and still be useless.
9. **Does a tool result render, and does the model answer from it?** The other half of a round trip, and a separate
   ability a model can have without the first.

## Results

Measured on 19 August 2026, in a live browser run against the pinned revision at `q4f16` on the WebGPU backend, on an
`apple metal-3` adapter, in Chrome 151. **Every phase produced its answer, and the model does tool calls on this
path.** Phase 5 is the one that found a problem, and the problem has a known fix that milestone 2 must make.

| Phase | Result |
| --- | --- |
| 1 · runs on WebGPU | yes — `apple metal-3`, `shader-f16` supported, no execution provider dropped |
| 2 · known answers are right | yes — `Paris` and `42` |
| 3 · chat template has a tools slot | yes — 16317 characters, mentioning both `tools` and `tool_call` |
| 4 · declarations reach the rendered prompt | yes — declaring two tools added 755 characters to a 75-character prompt |
| 5 · markers survive `skip_special_tokens: true` | **no** — both markers are special tokens, and so is the string marker |
| 6 · generates a tool call | yes — `get_current_weather` with `city` = `Paris`, 17 tokens in 8113 milliseconds |
| 7 · chooses the right tool out of two | yes — `get_current_time` for the time question, 17 tokens in 5521 milliseconds |
| 8 · answers in words when no tool is needed | yes — wrote `hello` and asked for nothing, 2 tokens in 1077 milliseconds |
| 9 · tool result renders, and it answers from it | yes — "The current weather in Paris is 31 degrees Celsius and clear skies." |

Five findings shape the implementation, and not one of them could have been learned from the LM Studio measurement.

**The tool call format is neither JSON nor the format Qwen3.5 writes.** This is what the model wrote, character for
character, decoded with `skip_special_tokens: false`:

```text
<|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>}<tool_call|><|tool_response>
```

The bar sits inside the opening marker and outside the closing one, so the two markers of a pair look almost
identical and must never be confused with each other. A string value is written between two `<|"|>` markers, which is
the only thing that tells a string from a number, because this format writes no quotation marks of its own. So this
format carries its own idea of a type, unlike Qwen3.5's, where every parameter value arrives as text and has to be
converted using the type its tool declared.

**The rendered prompt never states the format.** Only the declarations reach the prompt, each one between `<|tool>`
and `<tool|>`:

```text
<bos><|turn>system
<|tool>declaration:get_current_weather{description:<|"|>Reports the current weather in one city. …<|"|>,parameters:{properties:{city:{description:<|"|>The name of the city …<|"|>,type:<|"|>STRING<|"|>}},required:[<|"|>city<|"|>],type:<|"|>OBJECT<|"|>}}<tool|>…<turn|>
<|turn>user
What is the current weather in Paris?<turn|>
<|turn>model
```

Nowhere does the template tell the model what a call should look like. Qwen3.5's template writes those instructions
out, and this one does not: the format is carried by the special tokens and by the training behind them. That is why
phase 6 is the only thing that could have answered this, and why reading the template alone would have left the
format unknown.

**Both tool call markers are special tokens, so `skip_special_tokens: true` strips them.** Read off the pinned
revision's own tokenizer: `<|tool_call>` is token 48, `<tool_call|>` is token 49, and the string marker `<|"|>` is
token 52, all three with `special = true`. The same generated tokens decode two ways:

| Decoded with | The answer |
| --- | --- |
| `skip_special_tokens: false` | `<\|tool_call>call:get_current_weather{city:<\|"\|>Paris<\|"\|>}<tool_call\|>` |
| `skip_special_tokens: true` | `call:get_current_weather{city:Paris}` |

The second one has lost both markers and both string markers, so a reader cannot find the call and cannot tell a
string from a number. `stage_helper_llm_gemma_4_e2b_full.ts` decodes with `skip_special_tokens: true` today, so
milestone 2 has to decode with `skip_special_tokens: false` and take the end-of-turn marker off the answer itself.
This is the opposite of Qwen3.5, whose markers are `special: false` and survive.

**The model stops itself exactly where the tool result belongs, and no stopping rule has to be written.** The 17th
and last token of the call is `<|tool_response>`, token 50, which the export's own `generation_config.json` names as
an end-of-sequence token: `eos_token_id` is `[1, 106, 50]`, which is `<eos>`, `<turn|>`, and `<|tool_response>`. So
the model writes the call, opens the place its answer goes, and stops. Milestone 2 does not have to watch the
generated text for a complete tool call, as issue #216 assumed it would: it has to take that trailing
`<|tool_response>` off the end.

**A tool result round trips through the template.** A history carrying an assistant message with `tool_calls` and a
following `role: tool` message renders whole, and the model answers from it:

```text
<|turn>model
<|tool_call>call:get_current_weather{city:<|"|>Paris<|"|>}<tool_call|><|tool_response>response:get_current_weather{value:<|"|>{"city":"Paris","celsius":31,"sky":"clear"}<|"|>}<tool_response|>
```

The template renders the assistant's tool call back into the same form, wraps the tool result between
`<|tool_response>` and `<tool_response|>`, and adds no `<|turn>model` after it, because the model turn is already
open. So a history carrying a tool result round trips without this project having to write either half by hand.

One measurement worth carrying forward: an answer that calls a tool took **5.5 to 8.1 seconds for 17 tokens** with
two tools declared, against 1.1 seconds for the 2 tokens of an answer that needed no tool. Declaring two tools adds
755 characters the model must read before it writes anything, and that prefill is where the time goes. A real tool
interface declares more tools than two — the Codex command-line program declares ten, in 18587 characters, which
[`packages/_codex_experiments`](../../../_codex_experiments/) measured.

## Run

Start the development server from the package root and open `gemma4-e2b-tool-calls-gate/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model is about 3111 megabytes at `q4f16` and is cached by the browser (IndexedDB), so a browser that already ran
[`gemma4-e2b-it`](../gemma4-e2b-it/) does not download it again. It still takes several minutes to read back out of
the cache before the first token.

See [`../../README.md`](../../README.md) for the other experiments in this package.
