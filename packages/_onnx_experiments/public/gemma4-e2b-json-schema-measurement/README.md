# Gemma 4 E2B · Issue #219 JSON Schema measurement

Loads [`onnx-community/gemma-4-E2B-it-ONNX`](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX) with
[`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) (Transformers.js), at the same
pinned revision, the same `q4f16` quantization, and the same WebGPU-only rule as
[`stage_helper_llm_gemma_4_e2b_full.ts`](../../../worker_webpage/web/src/stages/stage_helper_llm_gemma_4_e2b_full.ts),
and answers milestone 6's question for [issue #219](https://github.com/webai-at-home/webai-at-home/issues/219).

## Why this page exists, when milestone 0 already measured the masking

Milestone 0's [JSON grammar page](../gemma4-e2b-json-grammar-gate/) settled the thing underneath: a `LogitsProcessor`
handed to the pipeline call decides which token this model writes, it still does with the call shape the real stage
helper uses, and it costs 44.7 milliseconds per token on this machine. Milestone 5 then entered `json_object` into the
`task_type_llm_gemma_4_e2b_full` row of `structured_output_support.ts`.

`json_schema` asks for more than any object. It asks for the keys a schema requires, of the types it declares, from the
values it enumerates, and nothing else. Two things about that could have failed, and neither is settled by anything
milestone 0 measured:

1. **A key is written a token at a time, and this tokenizer merges characters.** Holding the model to the key
   `capital` means masking down to the entries whose text carries that key on from wherever it has got to. If no entry
   survives at some position, the answer stops dead in the middle of a key.
2. **A schema state carries far more than a JSON state.** It holds which keys have been written and how far into one
   the model is, so a run reaches many more distinct states than the 8 milestone 0 measured, and every new state scans
   the whole vocabulary once. That is a cost nobody had put a number on.

Every schema on this page asks for something the question alone would not produce — a key the question never mentions,
an integer where the question asked for words, a value from an enumeration the question never names — so an answer that
satisfies the schema is an answer the **mask** decided rather than one the model happened to write.

## What is in `src/`

- `json_schema_compiler.ts` — turns one JSON Schema document into a flat array of nodes, and refuses any keyword it
  cannot enforce rather than reading past it.
- `json_schema_grammar.ts` — `json_grammar.ts` of milestone 1 with the schema added: the same pushdown reader over the
  same JSON, narrowed at every point by what the schema allows there.
- `json_schema_mask_cache.ts`, `json_schema_logits_processor.ts` — the milestone 1 mask cache and processor, with the
  schema grammar in place of the plain one and with the step by step timing milestone 0 used.
- `vocabulary_table.ts`, `webgpu_requirement.ts`, `correctness_check.ts` — copied from the milestone 1 worker code and
  from the earlier pages, because this package keeps every experiment standalone.

## The subset of JSON Schema this enforces

`type`, `properties`, `required`, `additionalProperties`, `items`, and `enum`. `$schema`, `title`, and `description`
are read past, because each describes a schema rather than constraining a value.

**Every other keyword is refused.** A schema naming `minLength`, `pattern`, `oneOf`, or anything else is refused with a
message naming the keyword, rather than compiled with that keyword ignored. This is the same rule the rest of the
project follows for a request it cannot honour: a schema enforced in part is worse than a refused one and worse than an
enforced one both, because the answer comes back looking exactly as it should and satisfies less than it says.

Two limits come from tracking a set as one bit per member in a single number, which is what keeps the reader's state
cheap to copy: at most 31 declared properties per object, and at most 31 values per enumeration. Both are refused above
the limit rather than enforced in part.

## Results

Measured on 20 August 2026, in a live browser run against the pinned revision at `q4f16` on the WebGPU backend, on an
`apple metal-3` adapter. **All five schemas were satisfied. A mask can hold this model to a schema, and it costs
between 23 and 45 milliseconds per token on this machine — no more than `json_object` cost in milestone 0.**

| Phase | What came back | Satisfied |
| --- | --- | --- |
| 4 · nothing constraining it | the object wrapped in a markdown code fence, so `JSON.parse` refuses it | — |
| 5 · three required keys | `{"name": "Paris", "country": "France", "population": "Approximately 2.1 million (city proper)"}` | yes |
| 6 · two keys where the question asked for four | `{"name": "Paris", "country": "France"}` | yes |
| 7 · an integer and a boolean where the question asked for words | `{"isCapital": true, "population": 2141000}` | yes |
| 8 · enumerations the question never names | `{"sky": "cloudy", "temperatureUnit": "celsius"}` | yes |
| 9 · a nested object and a list | `{"city": {"name": "Paris", "country": "France (Île-de-France region)"}, "landmarks": ["Eiffel Tower", "Louvre Museum"]}` | yes |

In every one of the five, the value was finished when generation stopped, and the reader refused none of the tokens the
mask had left legal — so the mask and the reader agree, which is the one way this could be wrong while looking right.

### The mask overrules the question, which is the whole point

Phase 7 is the clearest. The question was:

```text
Describe Paris as a JSON object. Write the population in words, and say in words whether it is a capital.
```

It asked twice, in words, for words. The schema declared `population` an `integer` and `isCapital` a `boolean`, and
what came back was:

```json
{
  "isCapital": true,
  "population": 2141000
}
```

Phase 6 is the same story about keys. The question asked for `name`, `country`, `population`, and `mayor`; the schema
declared `name` and `country` and closed the door on the rest; the answer holds two keys.

Phase 8 asked for the weather and never mentioned `clear`, `cloudy`, `raining`, `celsius`, or `fahrenheit` anywhere.
Both values came from the enumerations.

### What it costs

53.2 milliseconds per token with no processor in the way, against 76.6 to 98.3 with the schema mask, so the schema cost
between 23.4 and 45.1 milliseconds per token depending on the schema. Milestone 0 measured 44.7 for `json_object`, so a
schema is **no more expensive than any object**, and the largest schema here was the cheapest per token.

| Phase | Steps | Distinct states | Scans | Average scan | Average reuse | Per token |
| --- | --- | --- | --- | --- | --- | --- |
| 5 · required keys | 36 | 18 | 18 | 59.1 ms | 0.09 ms | 85.0 ms |
| 6 · forbidden keys | 20 | 13 | 13 | 55.5 ms | 0.11 ms | 90.6 ms |
| 7 · integer and boolean | 25 | 14 | 14 | 53.6 ms | 0.13 ms | 84.1 ms |
| 8 · enumerations | 23 | 19 | 19 | 52.8 ms | 0.10 ms | 98.3 ms |
| 9 · nested object and list | 60 | 26 | 26 | 58.6 ms | 0.06 ms | 76.6 ms |

Two things in that table decide how milestone 6 should be built.

**A schema reaches two to three times as many distinct states as `json_object` did**, 13 to 26 against 8, which is what
holding a key one character at a time costs. It is a long way short of a new state at every step: the longest answer
here, 60 steps, reached 26 states and reused a mask 34 times.

**A reused mask costs 0.06 to 0.13 milliseconds and a scan costs about 55.** So the cache is worth ten times more here
than it was for `json_object`, and it must be kept **per schema** as well as per model: a mask worked out under one
schema means nothing under another, because the state signature names schema node indices.

### The masks are narrow, which is why applying one is free

Under `json_object`, milestone 0 measured 261040 entries legal inside a string, and applying that mask cost 47
milliseconds because it wrote a quarter of a million scores back. Under a schema the masks name between 2 and 1119
entries, and `GrammarMask.namesTheEntriesToKeep` picks whichever of the two lists is shorter, so applying one is a few
hundred writes at worst. All of the cost above is in working a mask out, and none of it in applying one.

The narrowest masks are the interesting ones. Writing the second character of an enumerated value left **2** entries
legal out of 262144:

```text
step  8: state chosen_text|1|object|0|1|0|2|6|false|false|0||0 named 2 entries kept, 26.2 ms
step  4: state chosen_text|0|object|0|0|-1|3|1|true|false|0||0 named 12 entries kept, 64.7 ms
```

### Compiling a schema costs nothing worth measuring

0.00 to 0.70 milliseconds, for schemas of 3 to 6 nodes. It is done once per answer and does not need caching.
