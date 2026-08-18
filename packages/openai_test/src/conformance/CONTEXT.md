# Directory Context: `/packages/openai_test/src/conformance`

## Purpose

The `conformance` subcommand: it points at a server speaking the OpenAI-compatible Chat Completions API and reports which parts of the protocol that server honours, and what the model behind it can do.

## Key Exports & Entry Points

- `conformance_command.ts`: `ConformanceCommand`, which validates the options, runs the chosen tests, writes the report, and sets the exit code.
- `types.ts`: the shapes every test, client, and report share, including the `TestContext` a test is handed.
- `runner.ts`: runs the chosen tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- `conformance_tests/`: one file per test, grouped by the part of the protocol it checks — see [its own CONTEXT.md](conformance_tests/CONTEXT.md).
- `profiles/`: the named lists of tests a run can ask for — see [its own CONTEXT.md](profiles/CONTEXT.md).
- `probes/`: runs each prober of `../probers/` once and turns its statuses into verdicts — see [its own CONTEXT.md](probes/CONTEXT.md).
- `reporter/`: one file per output format — see [its own CONTEXT.md](reporter/CONTEXT.md).
- Command to run this folder: `npx tsx ../cli.ts conformance --model <name> --profile full`

## Rules

- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal; `WARN` is correct behaviour that may still break a client, such as a buffered stream. Neither is ever `FAIL`. A run counts as failed on its verdicts alone, never on `--ci`.
- **Never grade whether an answer is a good answer. Behaviour proved by construction is allowed.** A test may read an answer's words when the prompt was built so the behaviour under test is visible in them and in nothing else: `history.recalled` states a fact its question can be answered from nowhere else, and `parameters/` and `tools/` compare repeated answers. It may never say an answer was helpful or well written. The general form is in [../../CONTEXT.md](../../CONTEXT.md).
- What the endpoint did and what the model did are separate tests, never one: `history.accepted` says the history was carried, `history.recalled` says the model read it.
- `conformance_command.ts` is the only file here that prints or sets an exit code, and it writes a file only through `../report_writer.ts`.
- A test reaches an endpoint through `../clients/` only.
- A second request mode reruns the tests of `parameters` and `tools` alone, the groups a probe cache backs; every other test's request shape is fixed.
- `conformance_tests/` holds the shipped program; `tests/` at the package root holds this package's automated test suite. Neither imports the other.

## Background

- The "never read an answer's content" rule this refines could not survive: `parameters/` and `tools/` already read content. See [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
