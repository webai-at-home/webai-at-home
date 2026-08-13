# Directory Context: `/packages/webai_at_home_cli`

## Purpose

The single command line program published to the npm registry as `webai-at-home`, so a user runs `npx webai-at-home <command>` without cloning this repository. It dispatches to the other four command line programs in this repository — `@webai/gateway`, `@webai/consumer-openai`, `@webai/worker-openai`, and `@webai/consumer-cli` — rather than reimplementing any of them. See [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170).

## Key Exports & Entry Points

- `src/cli.ts`: the command line program, `Cli`. `gateway`, `consumer_openai` and `worker_openai` each name one of the other three command line programs and run it, unchanged, on whatever follows. Any other first word — a `consumer_cli` subcommand such as `submit`, or a global option such as `--url` written ahead of one — is handed whole to `@webai/consumer-cli`.

## Local Rules & Boundaries

- Which of the four programs runs is decided by looking at the first word of the command line alone, in plain code, rather than by letting commander itself decide between a matching subcommand and a fall-through to `consumer_cli`. Commander's own handling of an option it does not recognise before a subcommand name, tried live, reached its own help text instead of the intended subcommand. See `Cli.run`'s own comment for what was tried and why it was dropped.
- Each of the three named subcommands sets `helpOption(false)`, so `--help` passes through like any other option and reaches the wrapped program's own, more detailed help, rather than this program's generic one-line description of it.
- This program never declares its own version of an option one of the four wrapped programs already has — `--port`, `--url`, `--config_dir`, and so on. `allowUnknownOption` and `passThroughOptions` keep this program's own parser out of the way instead.
- Every test in `tests/index.test.ts` that exercises a real subcommand runs this program in its own process, with `node:child_process`, rather than calling `Cli.run` in the test process directly: commander's default `--help` handling calls `process.exit` in each of the four wrapped programs' own, separate command line parsers, none of which this program overrides, which would otherwise end the test process itself partway through the first test that asked for `--help`.
- `@webai/consumer-cli`'s `Cli` is imported through its dedicated `./cli` subpath, not its default entry point, which deliberately does not export `Cli` — see that package's `src/index.ts`.
- `bundledDependencies` is deliberately absent from this package's own `package.json`, even though a real publish needs it to vendor `@webai/gateway`, `@webai/consumer-openai`, `@webai/worker-openai`, `@webai/consumer-cli` and `@webai/protocol` into the tarball: left in permanently, it breaks `npm install` at the root of this repository. Milestone 3 of issue #170 adds it back through a `prepack`/`postpack` toggle instead.
