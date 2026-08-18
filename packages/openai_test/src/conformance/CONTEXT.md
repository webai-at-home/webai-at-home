# Directory Context: `/packages/openai_test/src/conformance`

## Purpose

The `conformance` subcommand: it points at a server claiming to speak the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server actually honours, and what the model behind it can do.

## Key Exports & Entry Points

- `conformance_command.ts`: `ConformanceCommand`, which validates the options, runs the chosen tests, writes the report, and sets the exit code. It also names the profiles and the formats the command line help text lists.
- `types.ts`: the shapes every test, client, and report share, including `TestContext`, which is what a test is handed.
- `runner.ts`: runs the chosen tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- `conformance_tests/`: one file per test, grouped by the part of the protocol it checks — see [its own CONTEXT.md](conformance_tests/CONTEXT.md).
- `profiles/`: the named lists of tests a run can ask for — see [its own CONTEXT.md](profiles/CONTEXT.md).
- `probes/`: runs each prober of `../probers/` once per run and translates its statuses into verdicts — see [its own CONTEXT.md](probes/CONTEXT.md).
- `reporter/`: one file per output format — see [its own CONTEXT.md](reporter/CONTEXT.md).
- Command to run this folder: `npx tsx ../cli.ts conformance --model <name> --profile full`

## Rules

- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal; `WARN` is correct behaviour that may still break a client, such as a buffered stream. Neither is ever `FAIL`. These four verdicts belong to this subcommand and to no other.
- `conformance_command.ts` is the only file here that prints, reads a file path, or sets an exit code.
- A test reaches an endpoint through `../clients/` and never any other way.
- `conformance_tests/` and the package's own `tests/` mean different things and neither imports the other: `conformance_tests/` holds the shipped program and is compiled into `dist/`, while `tests/` at the package root holds this package's automated test suite, which `tsconfig.build.json` leaves out.

## Background

- The folder is named `conformance_tests/` rather than `tests/` so that the word collision the package this was merged from needed a rule to keep straight cannot arise. See [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
- Whether a run counts as a failure is decided by the verdicts alone, never by `--ci`, which only turns the colouring and the progress lines off.
- The tests, the profiles, and the four verdicts come from [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181), and were built under [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182), whose comments hold each milestone's findings.
