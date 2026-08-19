# `@webai/codex-experiments`

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. The plan and the milestones are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).

There are three experiments and three target models, and every experiment is run against every target model.

| Target model | Base address | Model identifier |
| --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | `google/gemma-4-e2b` |
| Ollama | `http://localhost:11434/v1` | `gemma4:e2b` |
| WebAI@Home | `http://localhost:8788/v1` | `llm_gemma_4_e2b_full` |

## `exp_01_one_turn_with_no_tool`

One whole turn, with a question that needs no tool at all.

```bash
npm run exp_01_one_turn_with_no_tool:lmstudio --workspace @webai/codex-experiments
```

```bash
npm run exp_01_one_turn_with_no_tool:ollama --workspace @webai/codex-experiments
```

```bash
npm run exp_01_one_turn_with_no_tool:webai_at_home --workspace @webai/codex-experiments
```

Each run writes the raw events, the last message, and the result under `data/<target model>/`. The results are read in [`data/exp_01_one_turn_with_no_tool_results.md`](data/exp_01_one_turn_with_no_tool_results.md): LM Studio and Ollama pass, and WebAI@Home fails because it does not serve `POST /v1/responses`.

## How A Target Model Is Chosen

`target_models/` holds one committed file per target model, named `<target model>.target_model.toml`. Before every run each of those files is copied into the generated `codex_home/` folder as `<target model>.config.toml`, which is the name the Codex command-line program reads when it is given `--profile <target model>`. The Codex command-line program reads TOML only, which is why the committed files are TOML as well and the copy needs no conversion.

The `CODEX_HOME` of the person running the experiment is never read and never written. The Codex command-line program writes its own sessions, logs, databases, and downloaded documentation into the `CODEX_HOME` it is given, so `codex_home/` is generated on every run and is never committed.

## `exp_02_agent_loop_with_tool` And `exp_03_prompt_size_measure`

Not started. `exp_02_agent_loop_with_tool` gives the Codex command-line program one small task with a checkable result and measures whether the model can hold an agent loop together. `exp_03_prompt_size_measure` puts a recording proxy in front of the target model, measures the size of the prompt in tokens, and lists every request field the Codex command-line program sends.
