# Provenance

This folder holds a package that belongs to Hugging Face, not to this project. Everything except `package.json`, `tsconfig.json`, `upstream.json`, `README.md`, `CONTEXT.md`, this file, `tests/`, and `tools/` is a build of somebody else's source, checked in.

## Where it comes from

[`upstream.json`](upstream.json) is the one authoritative place for the repository, the branch, the commit, the folder inside that repository, and the two tool versions the checked-in files are built with. Nothing here repeats those values, so nothing here can disagree with them.

## How to rebuild it

```sh
npm run vendor:refresh --workspace @huggingface/transformers-response-constraint
```

[`tools/vendor_refresh.mjs`](tools/vendor_refresh.mjs) fetches exactly the pinned commit, runs the same esbuild and TypeScript commands the upstream package's own `build` and `typegen` scripts run, and replaces `index.js`, the declarations, and `LICENSE` with what came out. It is never run by `npm install`.

Run against the pinned commit it reproduces the checked-in files byte for byte, which was confirmed on 20 August 2026 by comparing the checksums before and after. To move to a newer upstream commit, edit `upstream.json`, run the command above, and read the git difference — in particular against [`tests/index.test.ts`](tests/index.test.ts), which asserts the three things this project relies on and which a refresh can silently take away.

TypeScript reports two `Cannot find module '@huggingface/transformers'` errors during the refresh. The fetched checkout has no installed dependencies, and every declaration is emitted regardless, so the script ignores the exit code and checks the emitted files instead.

## Why the built files rather than the TypeScript source

The upstream source does not compile under this repository's TypeScript settings. Every `tsconfig.json` here sets `exactOptionalPropertyTypes: true`, and `engine/json.ts` and `engine/regex.ts` assign `undefined` to properties declared as optional-but-not-undefined, which that setting refuses — six errors, all of that one kind. The upstream package's own `tsconfig.json` does not set `exactOptionalPropertyTypes`, so this is a difference between two projects' settings and not a defect in the package.

Taking the built bundle and the generated declarations sidesteps it, and is also exactly the shape npm would publish: `index.js` with `@huggingface/transformers` left external, and one `.d.ts` per source file.

## Licence

Apache-2.0, copied verbatim as [`LICENSE`](LICENSE) from the root of the upstream repository. The package's own `package.json` names the same licence. This project publishes nothing from this folder: `package.json` here is marked `private`.
