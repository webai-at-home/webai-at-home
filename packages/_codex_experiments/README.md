# `@webai/codex-experiments`

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. The plan and the milestones are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).

There are three experiments and three destinations, and every experiment is run against every destination.

| Destination | Base address | Model identifier |
| --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | `google/gemma-4-e2b` |
| Ollama | `http://localhost:11434/v1` | `gemma4:e2b` |
| WebAI@Home | `http://localhost:8788/v1` | `llm_gemma_4_e2b_full` |

## Experiment One — Connect The Codex Command-Line Program To A Destination

```bash
npm run experiment_one:lmstudio --workspace @webai/codex-experiments
```

```bash
npm run experiment_one:ollama --workspace @webai/codex-experiments
```

```bash
npm run experiment_one:webai_at_home --workspace @webai/codex-experiments
```

Each run asks one question that needs no tool at all, and writes the raw events, the last message, and the result under `data/<destination>/`. The results are read in [`data/experiment_one_results.md`](data/experiment_one_results.md): LM Studio and Ollama pass, and WebAI@Home fails because it does not serve `POST /v1/responses`.

## How A Destination Is Chosen

`destinations/` holds one configuration file per destination, named `<destination>.config.toml`. Before every run those files are copied into the generated `codex_home/` folder, which is given to the Codex command-line program as its `CODEX_HOME`, and the destination is chosen with `--profile <destination>`.

The `CODEX_HOME` of the person running the experiment is never read and never written. The Codex command-line program writes its own sessions, logs, databases, and downloaded documentation into the `CODEX_HOME` it is given, so `codex_home/` is generated on every run and is never committed.

## Experiment Two And Experiment Three

Not started. Experiment two gives the Codex command-line program one small task with a checkable result and measures whether the model can hold an agent loop together. Experiment three puts a recording proxy in front of the destination, measures the size of the prompt in tokens, and lists every request field the Codex command-line program sends.
