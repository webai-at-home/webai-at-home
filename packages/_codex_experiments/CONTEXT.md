# Directory Context: `/packages/_codex_experiments`

## Purpose

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. Three experiments, each run against three target models: LM Studio, Ollama, and WebAI@Home, all three serving Gemma 4 E2B.

## Key Exports & Entry Points

- `src/experiment_one_connect.ts`: experiment one, which connects the Codex command-line program to one target model and completes one whole turn with a question that needs no tool at all. Command to run this folder: `npm run experiment_one:lmstudio --workspace @webai/codex-experiments`, and the same for `experiment_one:ollama` and `experiment_one:webai_at_home`.
- `target_models/`: one committed configuration file per target model, named `<target_model>.config.toml`, which the Codex command-line program layers on with `--profile <target_model>`.
- `data/`: one folder per target model, holding the recorded events, the last message, and the result of every run, and [`data/experiment_one_results.md`](data/experiment_one_results.md), which reads them.
- `codex_home/`: generated, never committed. It is the `CODEX_HOME` given to the Codex command-line program, and the target model configuration files are copied into it before every run.

## Rules

- The leading underscore marks this package as an experiment. It is private, it is not part of the root build script, and no working package may import from it.
- A run never uses the `CODEX_HOME` of the person running it. It always uses the generated `codex_home/` folder of this package, so that the configuration of that person is neither read nor written.
- The target model is a setting, not a stage. Every experiment runs against all three target models with the same question and the same measurement, so a difference in the result can be blamed on the target model.
- `wire_api` is `responses` in every target model configuration file. The Codex command-line program refuses `wire_api = "chat"` since version 0.145.0.
- A recording that answers a question is committed. Bulk recordings are not.

## Background

- The plan, the milestones, and the results are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).
- The model identifier of the WebAI@Home target model is the task type name without the leading `task_type_`, which is the rule stated in [`docs/naming_scheme.md`](../../docs/naming_scheme.md).
