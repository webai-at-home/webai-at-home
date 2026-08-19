# Directory Context: `/packages/_codex_experiments`

## Purpose

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. Three experiments, each run against three target models serving Gemma 4 E2B: LM Studio, Ollama, and WebAI@Home.

## Key Exports & Entry Points

- `src/exp_01_one_turn_with_no_tool.ts`: one whole turn, with a question that needs no tool. Command to run this folder: `npm run exp_01_one_turn_with_no_tool:lmstudio --workspace @webai/codex-experiments`, and the same for every experiment and every target model.
- `src/exp_02_agent_loop_with_tool.ts`: the fixed task of `tasks/`, and the four measurements of the agent loop. Same script names, plus `--repeats <count>`.
- `src/exp_03_prompt_size_measure.ts`: the same task through `src/recording_proxy.ts`, and the measurement of every request it wrote down.
- `src/ollama_context_ceiling_probe.ts`: the real tools sent to Ollama at three sizes, which proved the ceiling.
- `src/codex_run.ts`: the one way every experiment runs the Codex command-line program.
- `target_models/`: one committed file per target model, `<target model>.target_model.toml`, copied into `codex_home/` as `<target model>.config.toml`, the name read for `--profile <target model>`.
- `tasks/`: the fixed task text. `data/`: the recorded runs and one results file per experiment.
- `codex_home/`, `workspaces/`, `recordings/`: generated, never committed.

## Rules

- The leading underscore marks this package as an experiment. It is private, it is not part of the root build script, and no working package may import from it.
- A run never uses the `CODEX_HOME` of the person running it, so the configuration of that person is neither read nor written.
- The target model is a setting, not a stage. Every experiment runs against all three with the same task and the same measurement, so a difference can be blamed on the target model.
- Never believe what a target model reports about itself. A measurement is read from recorded traffic or from the file on disk.
- Never run `CodexRun.execute` while this process is also serving requests: it blocks the whole process and the recording proxy then answers nothing. `CodexRun.executeWithoutBlocking` is there for that.
- `wire_api` is `responses` everywhere: the Codex command-line program refuses `wire_api = "chat"` since version 0.145.0, and reads TOML only.
- A recording that answers a question is committed. Bulk recordings are not.

## Background

- The plan and the results are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).
- The rule about not believing a target model comes from [`data/exp_03_prompt_size_measure_results.md`](data/exp_03_prompt_size_measure_results.md): the count Ollama reports is a ceiling that cuts the tool definitions away.
- The model identifier of WebAI@Home is the task type name without `task_type_`, from [`docs/naming_scheme.md`](../../docs/naming_scheme.md).
