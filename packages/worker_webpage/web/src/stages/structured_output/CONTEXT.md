# Directory Context: `/packages/worker_webpage/web/src/stages/structured_output`

## Purpose

Making a model write the shape a response format asks for, by masking the scores of the next token so nothing which would break that shape can be chosen.

## Key Exports & Entry Points

- `json_schema_logits_processor.ts`: `JsonSchemaLogitsProcessor`, handed to a `generate()` call as its `logits_processor`.
- `json_schema_mask_cache.ts`: `JsonSchemaMaskCache`, built once per schema, shared by every generation under it.
- `vocabulary_table.ts`: `VocabularyTable`, the text every entry of a vocabulary writes, decoded once per loaded model.

## Rules

- The reader is `JsonSchemaGrammar` from `@webai/protocol` and never a copy: the consumer refusing a schema and both kinds of worker enforcing one must agree what one means.
- A shape is enforced by masking the logits, never by asking `@huggingface/transformers` for one: its `constraints` field is declared and never read, and it has no guided decoding.
- `logits_processor` takes an iterable of processors, and `_call` returns the logits it was handed. Both are what `generate()` really does, and neither is what the bundled declarations say. A processor returning nothing hands `undefined` on.
- `VocabularyTable` reads `get_vocab()` as a `Map` as well as a record, because a tokenizer returns a `Map` where the declaration says a record. Reading only the declared shape finds an empty vocabulary, which masks nothing while looking as though it worked.
- A mask names the entries to remove when they are the fewer, and the ones to keep when they are: applying one costs a write per entry it names, and inside a string almost everything is legal.
- A mask never offers an entry writing only whitespace outside a string, nor anything but the end of the turn once the value is finished. Both are legal JSON, and both let a model that cannot write what it wants write layout until its budget is gone, ending on the budget rather than on the value.
- A mask cache belongs to one schema and one model, never to a task: a mask depends only on the grammar state and the vocabulary, and a state names schema nodes. A processor belongs to one generation, whose state is its reader.
- Nothing here reads a task, a stage, or a payload. A stage helper decides a shape was asked for; this folder enforces one.
- `stage_helper_llm_gemma_4_e2b_full.ts` is the one stage helper using this folder. It refuses a shape asked for beside tools: every tool call marker of that tokenizer is a special token, and none is legal until the value is finished.

## Background

- The whole folder comes from [#219](https://github.com/webai-at-home/webai-at-home/issues/219): milestone 0 proved live that a mask decides which token this model writes, and milestone 6 replaced the JSON reader with the schema reader. Both live checks are under `packages/_onnx_experiments/public/`, each carrying a reader of its own, since no working package may import from `_onnx_experiments`.
