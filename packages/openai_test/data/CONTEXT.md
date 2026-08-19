# Directory Context: `/packages/openai_test/data`

## Purpose

Where the `report:*` scripts of `package.json` write the markdown reports this package produces, one folder per subcommand that writes one.

## Key Exports & Entry Points

- `conformance_reports/`: what `conformance` wrote, one file per endpoint and model.
- `benchmark_reports/`: what `benchmark` wrote, one file per endpoint and model.
- Command to write one: `npm run report:conformance:lmstudio:llama-3.2-3b --workspace @webai/openai-test`

## Rules

- Nothing here is written by hand. A file in either folder is the output of one `report:*` script, and is replaced by running that script again.
- A report file's name says which endpoint and which model produced it, because a measurement of one model on one server says nothing about another.
- A file in `conformance_reports/` ends in `.conformance_report.md`, and a file in `benchmark_reports/` ends in `.benchmark_report.md`, so a report carries which subcommand wrote it once the file is read outside its folder.
- Every report carries its own command line and its generation date, written by the reporter, so a file found later says what produced it and when.
- A `report:*` script names a real endpoint this project measures — LM Studio, this cluster's own `consumer_openai`, or `api.openai.com`. There is no Ollama script: this project stopped using Ollama, and `packages/openai_conformance_test/data/conformance_reports/` keeps the Ollama reports already written.

## Background

- The two folders come from the source tree of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208), which splits by subcommand what `packages/openai_conformance_test/data/conformance_reports/` held for one subcommand alone.
