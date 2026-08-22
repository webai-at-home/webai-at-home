# Directory Context: `/packages/openai_test/examples/clis`

## Purpose

One short runnable shell script per task type and per calling style, each one showing how a client sends a request to this project's `consumer_openai` server from a terminal, with the official OpenAI command line program, https://developers.openai.com/api/docs/libraries/openai-cli.

## Key Exports & Entry Points

- `find_openai_command.sh`: sourced by every other script in this folder, and the only file here that is not an example. It names which `openai` on the PATH to run, and reports a missing `openai` or a missing `jq` in words.
- `list_models.sh`: the cheapest one, which reaches the server alone and needs neither a gateway nor a connected volunteer browser.
- `chat_completion_dev_formula.sh`: the one to start with, because the development formula task type needs no model download.
- `responses_dev_formula.sh`: the only one that posts to `/v1/responses`; every other one posts to `/v1/chat/completions`.
- Command to run one: `npm run example:cli:chat_completion_dev_formula --workspace @webai/openai-test`

## Rules

- Nothing here is imported by `src/`, and nothing here imports from `src/`. An example is a program a reader copies, not a part of the `openai_test` program.
- Every example calls the official OpenAI command line program through `"${openaiCommand}"` from `find_openai_command.sh`, never plain `openai`, because the `openai` npm package installs an unrelated program of that name into `node_modules/.bin`, which `npm run` puts first on the PATH.
- Every example reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set, and falls back to `http://localhost:8788/v1` and a placeholder key, matching [`../typescript/`](../typescript/CONTEXT.md).
- Every example says at the top, in a comment, which command runs it and what the cluster has to have running for it to answer.
- Every example is registered as one `example:cli:*` script of `package.json`. An example no script names is an example nobody runs.
- A streamed example reads its pieces with `jq '.choices[0].delta.content // empty'` rather than with the `--transform` flag, because the first and the last chunk of a stream carry no piece, and `--transform` prints the whole chunk when its path finds nothing.

## Background

- These examples mirror, one for one, the TypeScript examples of [`../typescript/`](../typescript/CONTEXT.md), and add `responses_dev_formula.sh` for the second interface.
