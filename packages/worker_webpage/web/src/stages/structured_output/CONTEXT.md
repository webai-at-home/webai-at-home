# Directory Context: `/packages/worker_webpage/web/src/stages/structured_output`

## Purpose

Making a model write the shape a response format asks for, by masking the scores of the next token so that nothing which would break that shape can be chosen.

## Key Exports & Entry Points

- `json_grammar_logits_processor.ts`: `JsonGrammarLogitsProcessor`, handed to one `generate()` call as its `logits_processor`.
- `json_grammar_mask_cache.ts`: `JsonGrammarMaskCache`, built once per loaded model and shared by every generation on it.
- `vocabulary_table.ts`: `VocabularyTable`, the text every entry of a tokenizer's vocabulary writes, decoded once per loaded model.
- `json_grammar.ts`: `JsonGrammar`, reading JSON one character at a time. Knows nothing about tokens, logits, or models, and is the part of this folder a test can check without a model.

## Rules

- A shape is enforced by masking the logits, never by asking `@huggingface/transformers` for one: its `constraints` field is declared and never read, and it offers no grammar and no guided decoding.
- `logits_processor` takes an iterable of processors, and `_call` returns the logits it was handed. Both are what `generate()` really does, and neither is what the bundled type declarations say. A processor that returns nothing hands `undefined` to the next one.
- `VocabularyTable` reads `get_vocab()` as a `Map` as well as a record, because a tokenizer returns a `Map` where the declaration says a record. Reading only the declared shape finds an empty vocabulary, and an empty vocabulary masks nothing while looking as though it were working.
- A mask names the entries to remove when they are the fewer, and the entries to keep when they are. Applying a mask costs one write per entry it names, and inside a string almost the whole vocabulary is legal.
- A mask cache belongs to a loaded model, never to a task, because a mask depends only on the grammar state and the vocabulary. A processor belongs to one generation, because the reader it holds is the state of one answer.
- Nothing here reads a task, a stage, or a payload. A stage helper decides that a shape was asked for; this folder only enforces one.

## Background

- The whole folder comes from [#219](https://github.com/webai-at-home/webai-at-home/issues/219), whose milestone 0 gate proved live that a mask decides which token this model writes, and measured what it costs.
- That gate is `packages/_onnx_experiments/public/gemma4-e2b-json-grammar-gate/`, and it carries a reader of its own rather than importing this one, because no working package may import from `_onnx_experiments`.
