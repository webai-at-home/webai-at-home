# `@huggingface/transformers-response-constraint`, vendored

Constrained generation for Transformers.js: it turns an OpenAI `response_format` into the `logits_processor` and `stopping_criteria` a `@huggingface/transformers` generation call already accepts, so a model can be made to write JSON that satisfies a JSON Schema.

The package is Hugging Face's, not this project's. It is checked in here because **it is not published**: `npm view @huggingface/transformers-response-constraint` answered HTTP 404 on 20 August 2026, and it lives on an unmerged branch behind a pull request open since 31 July 2026. [`PROVENANCE.md`](PROVENANCE.md) says where it comes from and how to rebuild it; [`upstream.json`](upstream.json) pins the commit.

## Why a checked-in build, and not one of the other four routes

A volunteer runs the worker web page. Whatever route is chosen, `npm install` from a fresh clone has to produce a working worker web page with no manual step, and that is what ruled the others out.

- **Waiting for a publish** blocks every other milestone of [issue #221](https://github.com/webai-at-home/webai-at-home/issues/221) on a pull request with no stated publication plan.
- **A git submodule** does not survive `npm install` on its own. It needs `git submodule update --init` and then a build, both manual steps, and it drags the whole history of `transformers.js` along for one file of 92813 bytes.
- **An npm dependency on a git address** cannot name a folder inside a repository, which is where this package lives, and would pin this project to a branch that can be rebased or deleted under it.
- **Vendoring the TypeScript source** does not compile under this repository's settings, for the reason `PROVENANCE.md` gives.

A checked-in build installs with no manual step, works with no network, is byte-identical for every volunteer, and is a workspace package named exactly what the published package will be named. So every import in this repository already reads `@huggingface/transformers-response-constraint`, and the day it is published, the change is one line in each dependent `package.json` and no source file moves.

## Use

```ts
import { ResponseConstraint } from '@huggingface/transformers-response-constraint';

const constraint = ResponseConstraint.fromResponseFormat(tokenizer, {
	type: 'json_schema',
	json_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
});
```

Two things measured live against Gemma 4 E2B in the milestone 0 de-risk test of issue #221 have to be known before calling it, and neither is in the package's own README. Both are recorded in [`packages/_onnx_experiments/public/gemma4-e2b-response-constraint-measurement`](../_onnx_experiments/public/gemma4-e2b-response-constraint-measurement/).

1. **Released `@huggingface/transformers` 4.2.0 never calls `onTokensSampled`**, which is where the package advances its grammar. Used as its README says, it masks every step from the grammar's opening state, constrains nothing, and reports no error. This project makes those calls itself.
2. **The grammar's flexible whitespace is a fixed point for greedy decoding.** `x-guidance: { whitespace_flexible: false }`, on the root schema only, is the way out, and it is not free.

## Test

```sh
npm test --workspace @huggingface/transformers-response-constraint
```

[`tests/index.test.ts`](tests/index.test.ts) asserts the facts this project relies on — the `onTokensSampled` method, the throw on a schema that cannot be enforced, and the whitespace control — so that a refresh which takes one away fails here in a second rather than in a volunteer's browser tab after a model download of about 3111 megabytes. No model is loaded.
