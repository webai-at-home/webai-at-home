# Directory Context: `/packages/openai_test/src`

## Purpose

Every source file of the `openai_test` program: the command line itself, the options and data shapes all three subcommands share, and one folder per subcommand and per layer beneath them.

## Key Exports & Entry Points

- `cli.ts`: the program, which parses the command line and dispatches to one subcommand.
- `completion_types.ts`: every data shape the three subcommands share. Nothing here reaches an endpoint.
- `shared_options.ts`: the command line options more than one subcommand accepts, and how they are read.
- `clients/`: the ways this package reaches an endpoint — see [its own CONTEXT.md](clients/CONTEXT.md).
- `chat/`: the `chat` subcommand — see [its own CONTEXT.md](chat/CONTEXT.md).

## Rules

- Nothing in this folder imports from outside this package, other than `chalk`, `commander`, and `openai`.
- A subcommand never reaches an endpoint itself. Every request goes through `clients/`.
- `shared_options.ts` holds an option only when more than one subcommand accepts it. An option one subcommand alone accepts is declared in `cli.ts` beside that subcommand, because the help text for it names what that subcommand can reach.
- `RawEndpointOptions` is the part all three subcommands share. `RawSharedOptions` adds what only the subcommands that sweep models and write a report accept, which is why `chat` uses the first and not the second.

## Background

- The folder is laid out by the source tree of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208). Conformance tests live in `conformance/conformance_tests/` rather than `src/tests/`, so that `tests/` at the package root unambiguously means this package's own automated test suite.
