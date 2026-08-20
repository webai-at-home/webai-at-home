# Directory Context: `/packages/worker_openai/src/stages`

## Purpose

One stage helper per stage this native worker can run, the fixed list of them, and the machinery they share for reading an answer back from a local server speaking the OpenAI-compatible Chat Completions API.

## Key Exports & Entry Points

- `stage_catalog.ts`: the fixed list of every stage helper this worker carries.
- One `stage_helper_<stage name>.ts` per stage, each one complete model run by the local server.
- `local_server_generation.ts`: `LocalServerGeneration`, reading one stage helper's answers from the local server, and `LocalModelReadiness`, whether that server holds the model at all.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named for the stage in [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md), registered in `stage_catalog.ts`.
- A stage helper names the computation it implements and states nothing else about the model: which server is reached and which model it is asked for are worker process options, `--openai-base-url` and `--openai-model` ([#100](https://github.com/webai-at-home/webai-at-home/issues/100)).
- Every stage helper holds its own `LocalServerGeneration`, so one stage's run can neither carry on nor release another stage's answer, even for the same task identifier.
- `--stage-names` is required, because one worker process serves one model and would otherwise answer every stage it can run with that one model.
- This folder imports from `../libs/` only for `OpenaiApiClient`, and nothing in `../libs/` reaches past `stage_catalog.ts` and `local_server_generation.ts` to a stage helper by name.
- An answer to a history that declared tools is read whole, never in pieces, whatever the consumer asked for, because a model that asks for a tool writes no answer text to report a piece of.
- A tool call whose arguments could not be read fails the stage naming them, rather than being reported half-formed, because the calling program runs whatever tool call it receives.
- An answer that is not the shape the consumer asked for fails the stage: this worker can only ask the local server for a shape, never hold the model to one ([#219](https://github.com/webai-at-home/webai-at-home/issues/219)).
- An answer holding no text fails the stage when the local server reported `finish_reason: length`, because only running out of room says the model had more to say and no room to say it. An empty answer that ended any other way is reported as it stands.

## Background

- The token count and stop reason this folder reports were proven live in [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150).
- The tool rules, and reading tool calls back at all, come from [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190).
- The empty-answer rule comes from [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192), where a thinking model spent a whole context window and wrote no answer.
