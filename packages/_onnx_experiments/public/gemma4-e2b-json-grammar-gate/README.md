# Gemma 4 E2B · Issue #219 JSON grammar de-risk gate

Loads [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision, the same `q4f16` quantization, and the same WebGPU-only rule as
[`stage_helper_llm_gemma_4_e2b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts),
and answers milestone 0's question for [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219), which
is the plan for [issue #218](https://github.com/webai-at-home/webai-at-home/issues/218).

## Why this gate exists even though the seam was already found by reading the source

[Issue #218](https://github.com/webai-at-home/webai-at-home/issues/218) read the installed
`@huggingface/transformers` 4.2.0 and found that the extension point already exists and is already public, so no fork,
no patch, and no upstream change is needed:

- `generate()` destructures `logits_processor` as a named parameter of its own, at `src/models/modeling_utils.js`
  line 840;
- `_get_logits_processor` extends the prepared processor list with it, at line 542, after every built-in processor;
- the prepared list is applied at every step, at line 991;
- `pipeline('text-generation', ...)` reaches that call at `src/pipelines/text-generation.js` line 175 and spreads its
  options into it at line 178;
- `LogitsProcessor` and `LogitsProcessorList` are exported from the package entry point, `src/transformers.js` line 47.

All of that says a processor is **reached**. None of it says a mask **decides the output**. Three things can fail that
reading the source cannot rule out, and each of them would sink the plan on its own:

1. setting a score to negative infinity may not keep the sampler away from that entry, for this model, at this
   quantization, on WebGPU;
2. it may stop working with the call shape the real stage helper uses, which carries the `stopping_criteria` that
   cancellation depends on and a `TextStreamer`;
3. the cost of deciding, at every step, which of a vocabulary this size may legally come next may be more than a
   browser tab can pay.

Reporting a gate as passed on the strength of a source reading is the same false green that
[issue #311](https://github.com/jeromeetienne/warmly_private/issues/311) describes, and it is why nothing on this page
is taken on trust.

## The eight phases

Each phase prints its raw input and its raw output, so a conclusion can be checked against what the model really wrote
rather than taken on trust.

1. **Is this really running on WebGPU?** Gemma 4 E2B is never run on WebAssembly here, for the reasons
   [issue #211](https://github.com/webai-at-home/webai-at-home/issues/211) settled. An adapter without `shader-f16`
   refuses before about 3111 megabytes are read, and a dropped execution provider is caught after loading.
2. **Does this run answer questions whose answers are known?** WebGPU returns wrong numbers without reporting an
   error, which is what killed [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172).
3. **What does this tokenizer look like, and what would a mask have to cover?** The whole vocabulary is decoded once
   and the time it took is recorded, because milestone 1 pays that cost too. Entries that write nothing, and entries
   that write an incomplete character, are counted: every one of them is a byte this approach can never let the model
   write.
4. **Is a logits processor handed to a pipeline call reached, and what is it handed?** Called once per generated
   token, and the shape and element type of the logits tensor recorded.
5. **Does a mask decide which token the model writes?** The half no amount of source reading can settle. The mask
   leaves exactly one entry usable per step, forcing a sentence the model would never write on its own, and the answer
   is checked against it token by token.
6. **Does the mask still decide the output with the call shape the real stage helper uses?** A processor that only
   works on a bare call is no use to a worker whose cancellation depends on `stopping_criteria`.
7. **What does the model write when it is asked for JSON and nothing constrains it?** The baseline, and the cost of a
   token with no processor in the way.
8. **What does the model write with the JSON grammar in place?** The same question as phase 7, so the two answers can
   be read side by side, with the cost per step and the number of entries left legal at each one.

## What is in `src/`

- `json_grammar.ts` — reads JSON one character at a time and says what may come next. Knows nothing about tokens,
  logits, or models.
- `vocabulary_table.ts` — the text every entry of the vocabulary writes, decoded once.
- `counting_logits_processor.ts` — changes nothing, and records that it was reached and what it was handed.
- `forced_token_logits_processor.ts` — leaves exactly one entry usable per step, which is phase 5's proof.
- `json_grammar_logits_processor.ts` — the two above joined: a grammar reader advanced over the generated tokens, and
  a mask worked out from it at every step.
- `webgpu_requirement.ts` and `correctness_check.ts` — copied from the
  [tool calls gate](../gemma4-e2b-tool-calls-gate/), because this package keeps every experiment standalone.

## Results

Measured on 20 August 2026, in a live browser run against the pinned revision at `q4f16` on the WebGPU backend, on an
`apple metal-3` adapter. **The gate passes: a mask handed to the pipeline call decides which token this model writes,
it still does so with the call shape the real stage helper uses, and the cost is 44.7 milliseconds per token on this
machine.**

| Phase | Result |
| --- | --- |
| 1 · runs on WebGPU | yes — `apple metal-3`, `shader-f16` supported, no execution provider dropped |
| 2 · known answers are right | yes — `Paris` and `42` |
| 3 · the vocabulary a mask must cover | 262144 entries, decoded in 331 ms; 24 special, 134 unusable, 261986 ordinary text |
| 4 · the processor is reached | yes — called once per generated token, handed a `[1, 262144]` `float32` tensor |
| 5 · a mask decides the output | **yes** — forced 8 tokens the model would never write, and it wrote them |
| 6 · it still does with the real call shape | yes — same 9 tokens, `stopping_criteria` present |
| 7 · unconstrained answer | wrapped in a markdown code fence, so `JSON.parse` refuses it |
| 8 · grammar-masked answer | a bare object, parses, right keys, 101.9 ms per token against 57.1 ms unmasked |

### The mask decides the output

Phase 5 asked the model for the capital of France and masked every entry of the vocabulary except the one the written
sentence needed at each step. The model wrote the sentence, did not write `Paris`, and then stopped on an
end-of-sequence token:

```text
forced 8 tokens: [236824, 4842, 502, 2221, 12511, 2221, 12511, 236761]
generated 9 tokens: [236824, 4842, 502, 2221, 12511, 2221, 12511, 236761, 106]
raw generated text: "Wombat wombat wombat.<turn|>"
```

Phase 6 ran the same thing with the `stopping_criteria` the real stage helper passes and that its cancellation depends
on, and generated the same nine tokens. There is no explanation for a model writing that sentence other than the mask
deciding it.

### The masked answer is JSON and the unmasked one is not

Both runs were asked `Describe Paris as a JSON object with the keys name, country, and population.` Unconstrained, the
model wrapped the object in a markdown code fence, so the answer does not parse:

````text
```json
{
  "name": "Paris",
  "country": "France",
  "population": "Approximately 2.1 million (city proper)"
}
```
````

With the grammar in place, it wrote the same object without the fence, `JSON.parse` accepted it, and its keys are
`name`, `country`, and `population`:

```text
{
  "name": "Paris",
  "country": "France",
  "population": "Approximately 2.1 million (city proper)"
}
```

The fence is not a detail. `structured_output.json_object` of `packages/openai_test` reports an object inside a fence
as a warning rather than a pass, and a client that called `JSON.parse` on the first answer would receive an exception
where it asked for an object.

### What masking costs, and where the cost actually is

101.9 milliseconds per token against 57.1 unmasked, so masking cost **44.7 milliseconds per token**. The step by step
record says something the total hides, and it is the finding that shapes milestone 1:

| Steps | Average |
| --- | --- |
| 8 steps that worked a mask out by scanning the whole vocabulary | 47.2 ms |
| 28 steps that reused a mask worked out earlier | 30.8 ms |

A reused mask should cost nothing, and it costs 30.8 milliseconds. The reason is visible in the per-step lines: cost
follows **how many entries are legal**, not whether the mask had to be worked out.

```text
step  5: state string|object|true|…      left 261040 entries legal, 47.0 ms, reused
step  8: state string|object|false|…     left 261085 entries legal, 46.8 ms, reused
step 10: state object_next_key|object|…  left    384 entries legal,  0.1 ms, reused
step 11: state object_next_key|object|…  left    384 entries legal,  0.0 ms, reused
```

Inside a string almost the whole vocabulary is legal, and this gate applies a mask by clearing the row and writing
every legal score back, which is 261085 writes. Outside a string only a few hundred entries are legal and the same
work is free. **So the dominant cost is applying the mask, not working it out**, and milestone 1 should write the
illegal entries rather than rebuild the row from the legal ones whenever most of the vocabulary is legal. That turns
the expensive case into a few hundred writes instead of a quarter of a million.

The other half is cheap and stays cheap. Only **8 distinct grammar states** were reached across 36 steps, so keying
the masks by `JsonGrammar.signatureOf` removes almost all of the scanning: 28 of 36 steps never scanned the vocabulary
at all.

### Three things the interface does not say, and each would have failed silently

None of these is in the documentation, and each was found by running rather than by reading.

1. **`logits_processor` must be an iterable of processors, not a processor.** `_get_logits_processor` calls
   `processors.extend(logits_processor)`, and `extend` spreads what it is given. Handing it one `LogitsProcessor`
   throws. `LogitsProcessorList` is the shape `GenerationFunctionParameters` declares, and it is what works.
2. **`_call` must return the logits.** `LogitsProcessorList._call` assigns each processor's return value back over the
   logits it passes on, so a processor that returns nothing hands `undefined` to the next one. The bundled
   `types/generation/logits_process.d.ts` declares `_call` as returning `void`.
3. **`get_vocab()` hands back a `Map`.** `types/tokenization_utils.d.ts` declares `Record<string, number>`. Reading it
   with `Object.values` finds an empty vocabulary, and an empty vocabulary masks **nothing** — a processor that
   silently does no work, which is the worst of the three because it looks like it is running. The first live run of
   this gate hit exactly this.

### The vocabulary, for milestone 1

262144 entries, decoded once in 331 milliseconds, which is a cost the real processor pays once per loaded model.

- 261986 write ordinary text and can be judged by a grammar.
- 24 are special, and are masked out until the value is finished.
- 134 write nothing or write an incomplete character, and are masked out throughout. Every one of them is a byte this
  approach can never let the model write.

The structural characters of JSON are each written alone by two or three entries, and are the start of many more:

| Character | Entries writing it alone | Entries starting with it |
| --- | --- | --- |
| `{` | 2 — `361`, `236782` | 45 |
| `}` | 2 — `363`, `236783` | 373 |
| `[` | 2 — `329`, `236840` | 61 |
| `]` | 2 — `331`, `236842` | 179 |
| `:` | 2 — `296`, `236787` | 83 |
| `,` | 3 — `282`, `1031`, `236764` | 87 |
| `"` | 2 — `272`, `236775` | 205 |

This is why the reader is character-based and the vocabulary is judged against it, rather than the other way round: a
per-character grammar cannot be turned into a fixed list of allowed entries, because an entry may carry several
characters and may close more than one container at once.

### One thing that is not about the model at all

The first run of this gate took half an hour to decode the vocabulary. The loop gave the page a turn to paint with
`setTimeout` once per block of 8192 entries, and a browser tab that is not on screen clamps its timers to one a
minute, so thirty-two yields became thirty-two minutes. The loop now runs unbroken, which takes 331 milliseconds.
