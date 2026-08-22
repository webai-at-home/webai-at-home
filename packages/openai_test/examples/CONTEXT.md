# Directory Context: `/packages/openai_test/examples`

## Purpose

Holds the runnable example programs of this package, one subfolder per language, each one showing how a client sends a chat completion request to this project's `consumer_openai` server.

## Key Exports & Entry Points

- `typescript/`: the examples written in TypeScript against the official `openai` package on npm — see its own [CONTEXT.md](typescript/CONTEXT.md).
- `clis/`: the examples written as shell scripts against the official OpenAI command line program — see its own [CONTEXT.md](clis/CONTEXT.md).
- Command to run one: `npm run example:chat_completion_dev_formula --workspace @webai/openai-test`

## Rules

- Nothing here is imported by `src/`, and nothing here imports from `src/`. An example is a program a reader copies, not a part of the `openai_test` program.
- An example file lives in the subfolder of the language it is written in, never directly in this folder.
- Every subfolder covers the same task types and the same calling styles, so a reader who knows one subfolder can find the same example in the other.

## Background

- These examples came from `@webai/consumer-openai` to `packages/_openai_api_tool_TOREMOVE`, and moved here when that package was frozen by [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
