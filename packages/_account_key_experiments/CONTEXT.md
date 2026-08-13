# Directory Context: `/packages/_account_key_experiments`

## Purpose

Browser experiments about the signing key pair that a participant's account is: what a real browser tab can and cannot do with a key pair of its own.

## Key Exports & Entry Points

- `public/index.html`: the home page, with the experiment at `/account_key_pair_log/`. Command to run this folder: `npm run dev --workspace @webai/account-key-experiments -- --port 5185 --strictPort`.
- `public/account_key_pair_log/src/account_key_pair_store.ts`: generating the key pair and keeping it across reloads and restarts.
- `public/account_key_pair_log/src/account_signature_algorithm.ts`: which signature algorithm the browser actually supports.
- `tools/verify_account_key_signature.js`: verifies in Node.js a signature the browser produced, the half of the gate the browser cannot prove on its own.
- `verification_documents/` and `run_reports/`: the recorded output of real runs, one file per browser and per run.

## Rules

- The leading underscore marks this package as an experiment. It is private, standalone, is not part of the root build script, and imports from no other package of this repository.
- A gate is only passed against a real browser. Record the run under `run_reports/` and its signed document under `verification_documents/`, named by browser and timestamp, and never report a gate as passed from a headless or mocked stand-in.
- `npm test --workspace @webai/account-key-experiments` runs the type check only.
- What this package proves is carried into working code by [`packages/worker_webpage`](../worker_webpage) and [`packages/protocol`](../protocol). Do not import from here to get there.

## Background

- These experiments are the de-risk gate of the accounting system, [issue #122](https://github.com/webai-at-home/webai-at-home/issues/122) and [issue #123](https://github.com/webai-at-home/webai-at-home/issues/123).
