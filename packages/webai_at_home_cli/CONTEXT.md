# Directory Context: `/packages/webai_at_home_cli`

## Purpose

The single command line program published to the npm registry as `webai-at-home`, so a user runs `npx webai-at-home <command>` without cloning this repository. It dispatches to the wrapped programs below rather than reimplementing them.

## Key Exports & Entry Points

- `src/cli.ts`: the program, `Cli`. `gateway`, `consumer_openai`, `worker_openai` and `openai_conformance_test` each run the like-named workspace package unchanged; any other first word is handed whole to `@webai/consumer-cli`.
- `scripts/vendor_wrapped_programs.ts`: run by `prepack`. Copies the built files of every wrapped program into `dist/vendor` and rewrites each package-name import in `dist/cli.js` into a relative path pointing there.

## Rules

- Each wrapped program takes the name it was invoked under, so no usage line names a program nobody typed.
- The `@webai/consumer-cli` command list in the top-level help is generated from each command's own name and description, never hand-written.
- `-V/--version` and `-h/--help` are answered inside `Cli.run` before the first word is matched, because an unrecognised first word goes to `@webai/consumer-cli`, which answers either with `error: unknown option`.
- Which program runs is decided by reading the first word in plain code, never by letting commander choose between a subcommand and a fall-through.
- This program never declares its own version of an option a wrapped program has; `allowUnknownOption` and `passThroughOptions` keep its parser out of the way, and each named subcommand sets `helpOption(false)` so `--help` reaches the wrapped program's own help.
- No wrapped package is named in this package's own `package.json`, because naming a workspace member in `dependencies` makes `npm install` and `npx` resolve it against the real npm registry; the vendoring script copies the built files in instead, and this package's `version` need not match theirs because it copies whatever is built.
- Every test exercising a real subcommand runs this program in its own process, because commander's `--help` handling calls `process.exit` inside the wrapped program's parser.
- `@webai/consumer-cli`'s `Cli` is imported through its dedicated `./cli` subpath, the only place that package exports it.
- A wrapped program that imports another workspace package is vendored with that package copied inside its own folder under `dist/vendor`, so no copied program reaches back out of it; `@webai/openai-conformance-test` is the first to need this.

## Background

- This package comes from [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170), passing the invoked name from [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171), and the `openai_conformance_test` subcommand from [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- `scripts/vendor_wrapped_programs.ts` and `Cli.run` each carry a comment recording what was tried and dropped.
