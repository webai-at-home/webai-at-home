# Gemma 4 E2B · Issue #221 milestone 0 response constraint measurement

Loads [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) with [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same pinned revision, the same `q4f16` quantization, and the same WebGPU-only rule as [`stage_helper_llm_gemma_4_e2b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts), and answers milestone 0's question for [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221).

## The one assumption this page exists to prove or kill

**`@huggingface/transformers-response-constraint` can be depended on by someone who is not its author, and it constrains this model in this browser tab at a cost a browser tab can pay.**

The first half decides the issue. The package is version `0.0.0`, answers HTTP 404 on npm, and lives on the `feat/transformers-llguidance-js` branch behind [pull request #1733](https://github.com/huggingface/transformers.js/pull/1733), open since 31 July 2026. Its author depends on it as `"link:../transformers.js/packages/transformers-response-constraint/"`, a filesystem link to a checkout on one machine, which nobody else can repeat.

The copy this page runs was built from that branch at a recorded commit and vendored under [`src/vendor/transformers_response_constraint/`](src/vendor/transformers_response_constraint/), with [`PROVENANCE.md`](src/vendor/transformers_response_constraint/PROVENANCE.md) beside it naming the commit and writing out the two commands that produced it.

## Run

Start the development server from the package root and open `gemma4-e2b-response-constraint-measurement/`:

```sh
npm run dev --workspace @webai/onnx-experiments
```

The model is about 3111 megabytes at `q4f16` and is cached by the browser (IndexedDB), so a browser that already ran [`gemma4-e2b-it`](../gemma4-e2b-it/) or [`gemma4-e2b-tool-calls-gate`](../gemma4-e2b-tool-calls-gate/) does not download it again. It still takes several minutes to read back out of the cache before the first token.

## The ten phases

Each phase prints its raw input and its raw output, so a conclusion can be checked against what the model really wrote rather than taken on trust.

1. **Is this really running on WebGPU?** Gemma 4 E2B is never run on WebAssembly here, for the reasons [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211) settled. An adapter without `shader-f16` refuses before about 3111 megabytes are read, and a dropped execution provider is caught after loading.
2. **Is the released `@huggingface/transformers` 4.2.0 enough, or is the branch build needed?** The decisive phase. Read off the loaded class, then answered again by generating twice.
3. **What does the package cost to download?** A worker browser tab downloads it.
4. **What logical batch size and logits shape does this call use?** The package states it throws when the logical batch size is not 1.
5. **`json_object`**, asked both as `json_object` and as the `json_schema` of `{"type":"object"}`.
6. **`json_schema`, seven shapes, exactly as a consumer would send them.** Required properties, a string, an integer, a boolean, an enumeration, an array, an object inside an object, and `minLength` with `maxLength`.
7. **The same seven shapes with `x-guidance: { whitespace_flexible: false }`.**
8. **The same seven shapes on the call shape the stage helper really uses** — `do_sample: false`, a `TextStreamer`, and the stage's own `InterruptableStoppingCriteria` beside the constraint's.
9. **What does the constraint cost per token?**
10. **A schema the package states it does not enforce** — an external `$ref`, which milestone 5 must refuse at submission.

## Results

Measured on 20 August 2026, in a live browser run against the pinned revision at `q4f16` on the WebGPU execution provider, on an `apple metal-3` adapter with `shader-f16`, in the Claude browser (Chrome 148). No execution provider was dropped. Every number below was written by that run.

| Phase | Result |
| --- | --- |
| 1 · runs on WebGPU | yes — `apple metal-3`, `shader-f16` supported, no execution provider dropped, tokenizer `GemmaTokenizer` |
| 2 · released 4.2.0 is enough on its own | **no** — `LogitsProcessorList.prototype.onTokensSampled` does not exist, and the package used as its README says constrained nothing |
| 2 · with the missing calls restored | yes — `{"city": "Paris"}` in 8 tokens and 608 milliseconds, against 256 tokens and 18744 milliseconds without them |
| 3 · download cost | 92813 bytes of JavaScript, 21178 gzipped, no WebAssembly module, no runtime dependency |
| 4 · logical batch size | 1 on every step, which is what the package requires. Logits are `[1, 262144]` |
| 5 · `json_object` | wrote a whole object, 131 tokens, opening with one line break |
| 6 · seven shapes as a consumer sends them | **2 of 7** — the array and the plain required string. The other five ran to the 256 token limit writing whitespace |
| 7 · the same seven with `whitespace_flexible: false` | **7 of 7**, in 6 to 24 tokens and 462 to 1465 milliseconds |
| 8 · the same seven on the real call shape | **7 of 7**, byte for byte the same answers, each ending in `<eos>` |
| 9 · cost per token | 62.6 milliseconds unconstrained against 69.3 constrained, about 11 per cent |
| 10 · a schema it cannot enforce | throws while the constraint is built: `TypeError: External JSON Schema reference "…" is unsupported.` |

### The released `@huggingface/transformers` 4.2.0 is not enough, and the gap is 22 lines

`ConstraintLogitsProcessor` masks the logits in `_call` and advances its grammar in `onTokensSampled`. That second method is added to `LogitsProcessorList`, and called from the generation loop of `modeling_utils.js`, by pull request #1733 itself — 13 added lines in `generation/logits_process.js` and 8 added with 3 deleted in `models/modeling_utils.js`. The package's peer dependency of `^4.2.0` is satisfiable by npm and is not truthful about what is required.

Used exactly as its own README says, against the released 4.2.0, the package masks every step from the grammar's opening state and never leaves it. That is not an error a caller sees. It is a run that looks constrained and is not:

```text
{"
  
  
  … 253 more tokens of the same … (256 tokens, 18744 ms, cut off by the token limit)
```

The same schema, the same prompt, with those calls restored:

```text
{"city": "Paris"}          (8 tokens, 608 ms)
```

The pull request's core change is small, and it is not the only way to close the gap. The sampled token is already in `input_ids`: `PreTrainedModel.generate` appends it to `all_input_ids` immediately after sampling, and hands the same array to every logits processor on the next step and to every stopping criterion on this one. [`sampled_token_forwarder.ts`](src/sampled_token_forwarder.ts) reads the tokens that appeared since it last looked and calls `onTokensSampled` itself, from both places, in about 60 lines and with no change to the runtime at all. Every phase from 2 onwards runs through it.

Announcing from the stopping criterion as well as from the logits processor is not an optimisation. A logits processor runs before the sampler, so the token that completes the grammar would only ever be seen on a step that never happens — the run has already stopped. With both halves, the answer ends on `<eos>` on the step it completes.

### The grammar's flexible whitespace is a trap for greedy decoding

This is the finding that decides how milestone 3 has to be written, and it is the one the issue expected the package to have taken care of.

`transition` in `engine/json.ts` returns **the same state** for every whitespace byte wherever JSON allows whitespace, when `whitespaceFlexible` is at its default of `true`. Greedy decoding — `do_sample: false`, which is what `stage_helper_llm_gemma_4_e2b_full.ts` uses — therefore has a fixed point there. Whenever the highest-scoring allowed token is a space or a line break, the next step faces exactly the same choice and takes it again, until the token limit ends the answer.

Five of the seven shapes fell into it. It is not only a leading-whitespace problem: the nested case wrote a complete inner object and then looped, because `city` was still required, the model would rather have written another key of its own, and whitespace was the only thing it preferred that the grammar allowed:

```text
\n{\n  "weather": {\n    "celsius": 15,\n    "sky": "Partly Cloudy"\n  }\n  \n  \n  …
```

The reverted work of [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219) found this model writing about 400 characters of spaces and line breaks and never opening the object. Issue #221 says that defect "becomes the package's problem rather than this project's". It does not. The package has the same defect, and it also has the control that closes it.

`x-guidance: { whitespace_flexible: false }`, on the root schema only, removes the self-loop. All seven shapes then finish, in 6 to 24 tokens:

| Shape | With the schema as sent | With `whitespace_flexible: false` |
| --- | --- | --- |
| required properties and a string | `{"city": "Paris"}` — 8 tokens | `{"city":"]Paris"}` — 7 tokens |
| an integer | 256 tokens of whitespace | `{"sides":6}` — 7 tokens |
| a boolean | 256 tokens of whitespace | `{"answer":true}` — 6 tokens |
| an enumeration | 256 tokens of whitespace | `{"sky":"cloudy"}` — 10 tokens |
| an array of exactly three strings | `{"cities": ["Paris","Marseille","Lyon"]}` — 31 tokens | the same, compact — 16 tokens |
| an object inside an object | 256 tokens of whitespace after a complete inner object | `{"weather":{"sky":"","celsius":22.000},"city":"Paris"}` — 24 tokens |
| `minLength` and `maxLength` | 256 tokens of whitespace | `{"material":"]The Eiffel,"}` — 10 tokens |

`x-guidance` belongs to no JSON Schema draft and to no OpenAI interface, so no consumer can send it. A stage that wants it has to add it to the schema the consumer sent, and `json_object` cannot carry it at all — phase 5 shows that asking for the `json_schema` of `{"type":"object"}` instead is what makes the control reachable.

**It is not free.** Closing the self-loop takes away the whitespace the model wanted, and the token it then prefers can be worse. Twice the model opened a string with `]`: `{"city":"]Paris"}` comes from token 1935, which is `"]`, chosen after the space it wanted was refused. Both answers satisfy their schemas — `]` inside a JSON string is legal, and no `pattern` was asked for — and both are worse answers than the model would otherwise have written. Phase 5 shows the same effect at its sharpest: `json_object` wrote a full weather object in 131 tokens, while the `json_schema` of `{"type":"object"}` with the control on wrote `{"weather":{}}` in 6.

So the control is necessary and is not sufficient. Milestone 3 has a real decision to make, and this measurement is what it has to be made from.

### `22.000` under `{"type":"integer"}` is correct, not a defect

The nested case answered `"celsius":22.000`. JSON Schema's `integer` means a number with a zero fractional part, so `22.000` satisfies it, and `JSON.parse` returns `22`. The package explains in `engine/json.ts` why it allows the form: under `{type: "integer"}` a prefix such as `0.9` leaves only digits and exponents viable and can never close, so integer fields follow llguidance's shape `-?(0|[1-9]\d*)(\.0+)?([eE]+?\d+)?`, with the fraction zeros capped. A consumer that wants `22` and not `22.000` has to parse the answer, which it was going to do anyway.

### The other measurements

- **The real call shape works.** `do_sample: false`, a `TextStreamer`, and the stage's own `InterruptableStoppingCriteria` all coexist with the constraint. `stopping_criteria` is a single option of the pipeline call, and `StoppingCriteriaList.extend` takes a single criterion, a list, or an array, so both criteria go in one list. Phase 8 generated byte for byte what phase 7 generated, and each answer ended in `<eos>`.
- **The logical batch size is 1** on every step of every run, which is what the package requires. The logits are `[1, 262144]`, and the tokenizer's vocabulary fits inside that dimension, so `applyMask` never refused.
- **The cost is small.** 62.6 milliseconds per token unconstrained against 69.3 constrained, about 11 per cent, on the same prompt. Building one constraint costs 0 to 3 milliseconds. `ResponseConstraint.warmup` on this tokenizer costs 1128 to 1534 milliseconds, once per tokenizer, and a stage that does not call it pays that inside its first request.
- **A schema it cannot enforce throws while the constraint is built**, with the offending reference in the message: `TypeError: External JSON Schema reference "https://example.invalid/city.schema.json" is unsupported.` So milestone 5 can refuse by asking the package, without keeping a list of its own.
- **`extractTokenizer` accepts this tokenizer.** It needs every token identifier from 0 upwards to be present and needs an integer end-of-sequence identifier, and Gemma 4 E2B's `GemmaTokenizer` gives it both, through `_tokenizerJSON` and `eos_token_id`.

## What this page does not answer

- Whether vendoring is the route milestone 1 should keep. This page vendors the built bundle because it needed a copy to measure; milestone 1 decides between vendoring, a git submodule, a checked-in build, and waiting for a publish.
- Whether `whitespace_flexible: false` is the right trade for every task type, or whether a stage should instead keep flexible whitespace and stop a whitespace run some other way. That was milestone 3's decision, and it found a third answer this page did not try: the package's other two `x-guidance` options, `key_separator: ": "` and `item_separator: ", "`, give back exactly the whitespace the model was denied, as fixed bytes with nothing to loop on. With all three options the same one-string schema wrote `{"city": "Paris"}` rather than the `{"city":"]Paris"}` recorded above. See [`packages/worker_webpage/web/src/stages/structured_output`](../../../worker_webpage/web/src/stages/structured_output/).
- Anything about the regular expression response format, which issue #221 puts out of scope.
- Anything about any other task type. Each row of `structured_output_support.ts` is its own measurement.

See [`../../README.md`](../../README.md) for the other experiments in this package.
