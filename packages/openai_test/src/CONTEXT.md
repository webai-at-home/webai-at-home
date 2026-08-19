# Directory Context: `/packages/openai_test/src`

## Purpose

Every source file of the `openai_test` program: the command line, what all three subcommands share, and one folder per subcommand and per layer beneath them.

## Key Exports & Entry Points

- `cli.ts`: the program, which parses the command line and dispatches to one subcommand.
- `completion_types.ts`: every data shape the three subcommands share.
- `shared_options.ts`: the options more than one subcommand accepts.
- `exit_codes.ts`: what this program returns to the shell, named once so a subcommand sets one without importing `cli.ts`.
- `endpoint_reachability.ts`: the one request that says whether anything is listening at all.
- `model_resolver.ts`: the model identifiers the endpoint lists, read only to answer `-m/--model list`.
- `report_writer.ts` and `report_parameters.ts`: what `-o/--output` does, and what a run was given and the command line that produced it, without the bearer token — both written once for the two subcommands that write reports.
- `clients/`: the ways this package reaches an endpoint — see [its own CONTEXT.md](clients/CONTEXT.md).
- `readers/`: what actually arrived on the wire — see [its own CONTEXT.md](readers/CONTEXT.md).
- `probers/`: what the model behind an endpoint can do — see [its own CONTEXT.md](probers/CONTEXT.md).
- `conformance/`: the `conformance` subcommand — see [its own CONTEXT.md](conformance/CONTEXT.md).
- `benchmark/`: the `benchmark` subcommand — see [its own CONTEXT.md](benchmark/CONTEXT.md).
- `chat/`: the `chat` subcommand — see [its own CONTEXT.md](chat/CONTEXT.md).

## Rules

- Nothing here imports from outside this package, other than `chalk`, `commander`, and `openai`, and no subcommand reaches an endpoint itself; every request goes through `clients/`.
- `shared_options.ts` holds an option only when more than one subcommand accepts it; one subcommand's own option is declared in `cli.ts` beside it.
- A folder sits here because more than one subcommand reaches for it; a folder one subcommand alone uses lives inside that subcommand's folder.
- `conformance` and `benchmark` both send one `GET /models` first, so an endpoint nothing is listening on ends the run with exit code `2`.
- Every subcommand works with one model: `SharedOptions.readOneModelId` refuses `all`, a comma-separated list, and a pattern in all three.
- `reportFormats` in `completion_types.ts` is the one list of output formats, and `report_parameters.ts` the one place a bearer token is replaced; neither reporting subcommand keeps a copy of either.
- `RawEndpointOptions` is the part all three subcommands share; `RawSharedOptions` adds what only the reporting subcommands accept, which is why `chat` uses the first.

## Background

- The folder is laid out by the source tree of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208). Conformance tests live in `conformance/conformance_tests/`, so that `tests/` at the package root means this package's own suite.
