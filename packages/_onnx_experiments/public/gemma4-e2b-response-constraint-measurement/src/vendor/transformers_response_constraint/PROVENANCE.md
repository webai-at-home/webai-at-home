# `@huggingface/transformers-response-constraint`, vendored

This folder is a copy of a package that belongs to Hugging Face, not to this project. It is here because the package is not published: `npm view @huggingface/transformers-response-constraint` answered HTTP 404 on 20 August 2026, and the only other route its author uses is `"link:../transformers.js/packages/transformers-response-constraint/"`, a filesystem link to a checkout on one machine, which nobody else can repeat.

## Where it came from

- Repository: <https://github.com/huggingface/transformers.js>
- Branch: `feat/transformers-llguidance-js`, proposed in [pull request #1733](https://github.com/huggingface/transformers.js/pull/1733)
- Commit: [`7c4593c6b43ad5975865184b3f79e17535b99eeb`](https://github.com/huggingface/transformers.js/commit/7c4593c6b43ad5975865184b3f79e17535b99eeb), 19 August 2026, "clean up"
- Folder in that repository: `packages/transformers-response-constraint`
- Package version: `0.0.0`
- Licence: Apache-2.0, copied here as [`LICENSE`](LICENSE)

## How the two files here were produced

```sh
git clone --depth 1 --branch feat/transformers-llguidance-js --single-branch \
	https://github.com/huggingface/transformers.js.git
cd transformers.js/packages/transformers-response-constraint

npx esbuild@0.27.2 src/index.ts --bundle --platform=neutral --target=es2022 \
	--format=esm --external:@huggingface/transformers --outfile=index.js

npx tsc --ignoreConfig src/index.ts --declaration --emitDeclarationOnly \
	--outDir types --rootDir src --target esnext --module esnext \
	--moduleResolution bundler --strict --skipLibCheck --esModuleInterop
```

The first command is the package's own `scripts/build.mjs`, written out by hand so that this folder can be rebuilt without a pnpm workspace. The second is its own `typegen` script with the same settings. Both print the two `Cannot find module '@huggingface/transformers'` errors that a checkout without the workspace peer produces, and both emit their output regardless.

## Why the built bundle rather than the TypeScript source

The source does not compile under this repository's TypeScript settings. `packages/_onnx_experiments/tsconfig.json` sets `exactOptionalPropertyTypes: true`, and `engine/json.ts` and `engine/regex.ts` assign `undefined` to properties declared as optional-but-not-undefined, which that setting refuses — six errors, all of that one kind. The package's own `tsconfig.json` does not set `exactOptionalPropertyTypes`, so this is a difference between two projects' settings and not a defect in the package. Taking the built bundle and the generated declarations sidesteps it, and is also exactly the shape npm would publish.
