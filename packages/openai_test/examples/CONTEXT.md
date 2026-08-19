# Directory Context: `/packages/openai_test/examples`

## Purpose

One short runnable program per task type and per calling style, each one showing how a client sends a chat completion request to this project's `consumer_openai` server with the official `openai` package on npm.

## Key Exports & Entry Points

- `list_models.ts`: the cheapest one, which reaches the server alone and needs neither a gateway nor a connected volunteer browser.
- `chat_completion_dev_formula.ts`: the one to start with, because the development formula task type needs no model download.
- `chat_completion_history_llm_qwen3_5_0_8b_full.ts`, `chat_completion_history_llm_llama3_2_1b_full.ts`: the two whose task type accepts a whole history rather than one prompt alone.
- Command to run one: `npm run example:chat_completion_dev_formula --workspace @webai/openai-test`

## Rules

- Nothing here is imported by `src/`, and nothing here imports from `src/`. An example is a program a reader copies, not a part of the `openai_test` program.
- Every example goes through the official `openai` package on npm, never through this package's own client, because what an example demonstrates is what an outside client writes.
- Every example reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment when they are set, and falls back to `http://localhost:8788/v1` and a placeholder key.
- Every example says at the top, in a comment, which command runs it and what the cluster has to have running for it to answer.
- Every example is registered as one `example:*` script of `package.json`. An example no script names is an example nobody runs.

## Background

- These examples came from `@webai/consumer-openai` to `packages/openai_api_tool_TOREMOVE`, and moved here when that package was frozen by [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
