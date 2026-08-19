# Directory Context: `/packages/openai_test/src/benchmark`

## Purpose

The `benchmark` subcommand: how long one OpenAI-compatible endpoint takes to answer, as Time to First Character and Time to Last Character, one model at a time.

## Key Exports & Entry Points

- `benchmark_command.ts`: `BenchmarkCommand`, which validates the options, resolves the models, measures, and writes the report.
- `benchmark_runner.ts`: `BenchmarkRunner`, which sends the requests and aggregates them, and `BenchmarkProgressListener`, told about each request as it happens.
- `statistics_calculator.ts`: `StatisticsCalculator`, the four statistics of one metric.
- `report_renderer.ts`: `ReportRenderer`, the `text`, `markdown`, `json`, and `junit` forms of one report.
- Command to run this folder: `npx tsx ../cli.ts benchmark --base_url http://localhost:1234/v1 --model <name>`

## Rules

- Every request is streamed, which is why this subcommand does not accept `--stream`: the two Time to Character numbers are separate only while the answer arrives in pieces, so there is nothing to choose.
- `--thinking off`, the default, sends `reasoning_effort: "none"`, the one spelling Ollama and LM Studio both honour. Thinking lands wholly inside Time to First Character and never inside Output Characters, so a thinking model's numbers compare with nothing.
- No two requests are ever in flight at once, which is why `parallelism` is the constant `1`. A warm-up request is never reported, and exists so that the first measured request is not the one that loaded the model.
- The markdown format is laid out the way the `conformance` markdown report is, and lists every measured request behind the averages, because the spread between requests says how much to trust an average. It alone reads `BenchmarkMarkdownOptions`, and `../report_parameters.ts` replaces the bearer token first.
- A model that cannot be measured is recorded as a failure and the sweep carries on. Only a run in which no model at all could be measured throws.
- Every one of the four formats names the models that could not be measured, and the settings every measurement depended on, so a report cannot look complete while a model it was asked for is missing. No exit code is set either way: there are no verdicts here.
- Nothing here counts a verdict or writes `PASS`, `FAIL`, `SKIP`, or `WARN`; those belong to `../conformance/`.
- `benchmark_command.ts` is the only file here that prints, and writes a file only through `../report_writer.ts`. `-v/--verbose` prints through a `BenchmarkProgressListener` to standard error, so a report on standard output stays exactly the report.

## Background

- `benchmark_runner.ts` and `statistics_calculator.ts` come from [`packages/openai_api_tool`](../../../openai_api_tool/), proved to compute the same numbers in Milestone 5 of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208). The markdown rendering, the progress listener, and `--thinking` were added there.
