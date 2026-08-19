# Directory Context: `/packages/_codex_experiments`

## Purpose

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. Three experiments, each run against three target models: LM Studio, Ollama, and WebAI@Home, all three serving Gemma 4 E2B.

## Key Exports & Entry Points

- `src/exp_01_one_turn_with_no_tool.ts`: one whole turn, with a question that needs no tool. Command to run this folder: `npm run exp_01_one_turn_with_no_tool:lmstudio --workspace @webai/codex-experiments`, and the same for `:ollama` and `:webai_at_home`.
- `src/exp_02_agent_loop_with_tool.ts`: the fixed task of `tasks/`, and the four measurements of the agent loop. Same script names, plus `--repeats <count>`.
- `src/codex_run.ts`: the one way both experiments run the Codex command-line program.
- `target_models/`: one committed file per target model, `<target model>.target_model.toml`, copied into `codex_home/` as `<target model>.config.toml`, the name the Codex command-line program reads for `--profile <target model>`.
- `tasks/`: the fixed task text of an experiment, `<experiment>.task.md`.
- `data/`: the recorded runs, one folder per target model, and one results file per experiment reading them.
- `codex_home/` and `workspaces/`: generated, never committed. The first is the `CODEX_HOME`, the second holds one empty workspace per run.

## Rules

- The leading underscore marks this package as an experiment. It is private, it is not part of the root build script, and no working package may import from it.
- A run never uses the `CODEX_HOME` of the person running it, so the configuration of that person is neither read nor written.
- The target model is a setting, not a stage. Every experiment runs against all three target models with the same question and the same measurement, so a difference can be blamed on the target model.
- Never believe what a target model reports about itself. A measurement is read from recorded traffic or from the file on disk.
- `wire_api` is `responses` in every target model file. The Codex command-line program refuses `wire_api = "chat"` since version 0.145.0, and reads TOML only.
- A recording that answers a question is committed. Bulk recordings are not.

## Background

- The plan, the milestones, and the results are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).
- The rule about not believing a target model comes from [`data/exp_02_agent_loop_with_tool_results.md`](data/exp_02_agent_loop_with_tool_results.md), where Ollama reported the same input token count for two prompts of very different sizes.
- The model identifier of the WebAI@Home target model is the task type name without the leading `task_type_`, from [`docs/naming_scheme.md`](../../docs/naming_scheme.md).
