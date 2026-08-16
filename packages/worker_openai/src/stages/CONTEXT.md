# Directory Context: `/packages/worker_openai/src/stages`

## Purpose

One stage helper per stage this native worker can run, the fixed list of every one of them, and the machinery all of them share for reading an answer back from a local server that speaks the OpenAI-compatible Chat Completions API.

## Key Exports & Entry Points

- `stage_catalog.ts`: `StageCatalog`, the fixed list of every stage helper this worker carries, and the one that implements a given computation.
- `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_qwen3_5_0_8b_full.ts`: one complete model each, run by the local server.
- `local_server_generation.ts`: `LocalServerGeneration`, which reads one stage helper's answers from the local server, and `LocalModelReadiness`, its answer to whether the local server holds the model at all.

## Rules

- Adding a stage means adding one `stage_helper_<stage name>.ts` file whose name is the stage name from [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md), and registering it in `stage_catalog.ts`.
- A stage helper names the computation it implements and holds its own `LocalServerGeneration`, and states nothing else about the model: which server is reached and which model that server is asked for are options of the worker process, `--openai-base-url` and `--openai-model`.
- Every stage helper here holds a `LocalServerGeneration` of its own, so a run of one stage can neither carry on nor release an answer of another, even for the same task identifier.
- `--stage-names` is required on the command line, because one worker process serves one model and would otherwise answer every stage it can run with that one model.
- This folder imports from `../libs/` only for `OpenaiApiClient`, and nothing in `../libs/` reaches past `stage_catalog.ts` and `local_server_generation.ts` to a stage helper by name.
- An answer to a history that declared tools is read whole, never in pieces, whatever the consumer asked for, because a model that asks for a tool writes no answer text to report a piece of.
- A tool call whose arguments could not be read fails the stage naming what could not be read, rather than being reported half-formed, because the calling program runs whatever tool call it receives.

## Background

- The task type names the model and not the server, decided in [issue #100](https://github.com/webai-at-home/webai-at-home/issues/100).
- The token count and stop reason this folder reports were proven live in [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- The two tool rules above, and the reading of tool calls back from the local server at all, come from [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190).
