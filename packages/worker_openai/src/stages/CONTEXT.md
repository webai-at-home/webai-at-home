# Directory Context: `/packages/worker_openai/src/stages`

## Purpose

One stage helper per stage this native worker can run, and the machinery they share for reading an answer back from a local server speaking the OpenAI-compatible Chat Completions API.

## Key Exports & Entry Points

- `stage_catalog.ts`: the fixed list of every stage helper this worker carries.
- `stage_helper_llm_gemma_4_e2b_full.ts`, `stage_helper_llm_llama3_2_1b_full.ts`, `stage_helper_llm_qwen3_5_0_8b_full.ts`: one complete model each, run by the local server.
- `local_server_generation.ts`: `LocalServerGeneration`, reading one stage helper's answers from the local server, and `LocalModelReadiness`, whether that server holds the model.

## Rules

- Adding a stage means one `stage_helper_<stage name>.ts` named for the stage in [`docs/naming_scheme.md`](../../../../docs/naming_scheme.md), registered in `stage_catalog.ts`.
- A stage helper names the computation it implements and states nothing else about the model: which server is reached and which model it is asked for are worker process options, `--openai-base-url` and `--openai-model`.
- Every stage helper here holds a `LocalServerGeneration` of its own, so a run of one stage can neither carry on nor release an answer of another, even for the same task identifier.
- `--stage-names` is required on the command line, because one worker process serves one model and would otherwise answer every stage it can run with that one model.
- This folder imports from `../libs/` only for `OpenaiApiClient`, and nothing in `../libs/` reaches past `stage_catalog.ts` and `local_server_generation.ts` to a stage helper by name.
- An answer to a history that declared tools is read whole, never in pieces, whatever the consumer asked for, because a model that asks for a tool writes no answer text to report a piece of.
- A tool call whose arguments could not be read fails the stage naming what could not be read, rather than being reported half-formed, because the calling program runs whatever tool call it receives.
- An answer holding no text fails the stage when the local server reported `finish_reason: length`, or no finish reason at all: only running out of room says the model had more to say, and only a broken stream says nothing. An empty answer that stopped for any other stated reason is reported as it stands.

## Background

- The task type names the model and not the server: [issue #100](https://github.com/webai-at-home/webai-at-home/issues/100). Token counts and stop reasons: [issue #150](https://github.com/webai-at-home/webai-at-home/issues/150). The tool rules: [issue #190](https://github.com/webai-at-home/webai-at-home/issues/190). The empty-answer rule: [issue #192](https://github.com/webai-at-home/webai-at-home/issues/192), a thinking model that spent a whole context window and wrote no answer, and [issue #215](https://github.com/webai-at-home/webai-at-home/issues/215), a failure inside a successful stream that produced none.
