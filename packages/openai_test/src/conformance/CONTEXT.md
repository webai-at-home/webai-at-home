# Directory Context: `/packages/openai_test/src/conformance`

## Purpose

The `conformance` subcommand: it reports which parts of the OpenAI-compatible Chat Completions API a server honours, and what the model behind it can do.

## Key Exports & Entry Points

- `conformance_command.ts`: `ConformanceCommand`, which validates the options, runs the tests, and writes the report.
- `types.ts`: the shapes every test, client, and report share, including the `TestContext`.
- `runner.ts`: runs the tests in order, turning a thrown error into `FAIL` rather than stopping the run.
- `conformance_tests/`: one file per test, grouped by protocol part — see [its own CONTEXT.md](conformance_tests/CONTEXT.md).
- `profiles/`: the named lists of tests a run can ask for — see [its own CONTEXT.md](profiles/CONTEXT.md).
- `probes/`: runs each prober of `../probers/` once and turns its statuses into verdicts — see [its own CONTEXT.md](probes/CONTEXT.md).
- `reporter/`: one file per output format — see [its own CONTEXT.md](reporter/CONTEXT.md).
- Command to run this folder: `npx tsx ../cli.ts conformance --model <name> --profile full`

## Rules

- A test result is `PASS`, `FAIL`, `SKIP`, or `WARN`, per section 32 of [issue #181](https://github.com/webai-at-home/webai-at-home/issues/181). `SKIP` is a declared-unsupported refusal and `WARN` is correct behaviour that may still break a client; neither is ever `FAIL`.
- **Never grade whether an answer is a good answer. Behaviour proved by construction is allowed.** A test may read an answer's words only when the prompt was built so the behaviour under test is visible in them: `history.recalled` states a fact answerable from nowhere else, and `parameters/` and `tools/` compare repeated answers. The general form is in [../../CONTEXT.md](../../CONTEXT.md).
- What the endpoint did and what the model did are separate tests: `history.accepted` says the history was carried, `history.recalled` says the model read it.
- `conformance_command.ts` is the only file here that prints or writes a file, and it writes only through `../report_writer.ts`. Nothing here sets an exit code: a `FAIL` is a verdict, and the run still returns `0`.
- A test reaches an endpoint through `../clients/` only.
- One `GET /models` runs before the first test; only a thrown error stops the run, since any HTTP status at all means something is listening.
- `runner.ts` never prints; it tells an optional listener when each test starts and finishes, and `conformance_command.ts` writes those lines to standard error under `-v/--verbose`.
- A second request mode reruns `parameters` and `tools` alone, the groups a probe cache backs.
- `conformance_tests/` holds the shipped program; `tests/` at the package root holds this package's own suite. Neither imports the other.

## Background

- The "never read an answer's content" rule this refines could not survive `parameters/` and `tools/`. See [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208).
