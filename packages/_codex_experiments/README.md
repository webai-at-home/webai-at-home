# `@webai/codex-experiments`

Runs the Codex command-line program against a small local model instead of against the OpenAI service, and records what breaks. The plan and the milestones are in [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213).

There are three experiments and three target models, and every experiment is run against every target model.

| Target model | Base address | Model identifier |
| --- | --- | --- |
| LM Studio | `http://localhost:1234/v1` | `google/gemma-4-e2b` |
| Ollama | `http://localhost:11434/v1` | `gemma4:e2b` |
| Ollama with a context length of 32768 | `http://localhost:11434/v1` | `gemma4-e2b-context-32768` |
| WebAI@Home | `http://localhost:8788/v1` | `llm_gemma_4_e2b_full` |

The fourth is the same Gemma 4 E2B as the second with one setting changed, because Ollama was cutting the prompt at about 2048 tokens. Build it once, which adds a model tag and reuses the weights already on disk:

```bash
ollama create gemma4-e2b-context-32768 -f target_models/ollama_context_32768.modelfile
```

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

## `exp_02_agent_loop_with_tool`

One small task with a checkable result, run three times against each target model.

```bash
npm run exp_02_agent_loop_with_tool:lmstudio --workspace @webai/codex-experiments
```

```bash
npm run exp_02_agent_loop_with_tool:ollama --workspace @webai/codex-experiments
```

```bash
npm run exp_02_agent_loop_with_tool:webai_at_home --workspace @webai/codex-experiments
```

Add `-- --repeats <count>` to run the task more or fewer times. The task is fixed text in [`tasks/exp_02_agent_loop_with_tool.task.md`](tasks/exp_02_agent_loop_with_tool.task.md), so every target model is given exactly the same task, word for word, and each run gets an empty workspace of its own under `workspaces/`.

Four things are measured for every run: how many tool calls the model made, whether it wrote anything after its last tool call, whether the turn ended on its own, and whether the file the task asks for holds exactly the right line. The results are read in [`data/exp_02_agent_loop_with_tool_results.md`](data/exp_02_agent_loop_with_tool_results.md): LM Studio did the whole task correctly three times out of three, Ollama answered `done` three times without making a single tool call or creating any file, Ollama with a context length of 32768 did the whole task correctly three times out of three, and WebAI@Home never started a turn.

## `exp_03_prompt_size_measure`

The same task again, with a recording proxy between the Codex command-line program and the target model, writing every request and every answer down.

```bash
npm run exp_03_prompt_size_measure:lmstudio --workspace @webai/codex-experiments
```

```bash
npm run exp_03_prompt_size_measure:ollama --workspace @webai/codex-experiments
```

```bash
npm run exp_03_prompt_size_measure:webai_at_home --workspace @webai/codex-experiments
```

The whole traffic goes to `recordings/<target model>/` and is not committed. What it answers is measured into `data/<target model>/exp_03_prompt_size_measure_measurements.json` and read in [`data/exp_03_prompt_size_measure_results.md`](data/exp_03_prompt_size_measure_results.md):

- The first request of every run is about 49800 bytes: 20751 characters of standing instructions, 18587 characters of ten tool definitions, and the history. About 39000 characters of that are resent whole on every request.
- Twelve fields go out and no others: `client_metadata`, `include`, `input`, `instructions`, `model`, `parallel_tool_calls`, `prompt_cache_key`, `reasoning`, `store`, `stream`, `tool_choice`, `tools`. None of the parameters recorded as failing in the conformance report is ever sent. Those twelve, on `POST /v1/responses`, are the whole specification the WebAI@Home gateway has to satisfy.
- Ollama cuts the prompt at about 2048 tokens, which throws the ten tool definitions away, which is why its agent loop made no tool call.

## `ollama_context_ceiling_probe`

```bash
npm run ollama_context_ceiling_probe --workspace @webai/codex-experiments
```

Sends the same question and the same offered tool to Ollama at three prompt sizes, and shows that the input token count it reports is a ceiling and not a count: 86 tokens for a small prompt with a tool call in the answer, then 2051 and no tool call for every larger one. Run `exp_03_prompt_size_measure:ollama` first, because the probe reads the real tools out of its recording. Pass a model name to ask a different one:

```bash
npm run ollama_context_ceiling_probe --workspace @webai/codex-experiments -- gemma4-e2b-context-32768
```

Asked of that model, every size answers with a tool call and the reported count tracks the prompt all the way to 8832 tokens.
