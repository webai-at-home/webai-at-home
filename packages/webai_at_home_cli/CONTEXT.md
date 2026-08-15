# Directory Context: `/packages/webai_at_home_cli`

## Purpose

The single command line program published to the npm registry as `webai-at-home`, so a user runs `npx webai-at-home <command>` without cloning this repository. It dispatches to the wrapped programs below rather than reimplementing them.

## Key Exports & Entry Points

- `src/cli.ts`: the program, `Cli`. `gateway`, `consumer_openai`, `worker_openai`, `consumer_cli` and `openai_conformance_test` each run one wrapped program unchanged; anything else is an unknown command.
- `scripts/vendor_wrapped_programs.ts`: run by `prepack`. Copies every wrapped program's built files into `dist/vendor` and rewrites each package-name import in `dist/cli.js` into a relative path pointing there.

## Rules

- Each wrapped program takes the name it was invoked under and runs under no other, so no usage line names a program nobody typed.
- All five wrapped programs are exposed the same way: one named commander subcommand each, one line each in the top-level help, and that program's own `--help` for more.
- `-V/--version`, `-h/--help`, and the no-arguments case are answered inside `Cli.run` before commander parses. That lets the program set `helpOption(false)`, so a first word naming none of the five is an unknown command rather than this program's own help and exit code `0`.
- This program never declares its own version of an option a wrapped program has; `allowUnknownOption` and `passThroughOptions` keep its parser out of the way, and each subcommand sets `helpOption(false)` so `--help` reaches that program's own help.
- No wrapped package is named in this package's own `package.json`: naming a workspace member in `dependencies` makes `npm install` and `npx` resolve it against the real npm registry. The vendoring script copies the built files in, so this `version` need not match theirs.
- Every test exercising a real subcommand runs this program in its own process, because `--help` calls `process.exit` inside the wrapped program's parser.
- `@webai/consumer-cli`'s `Cli` is imported through its dedicated `./cli` subpath, the only place that package exports it.
- A wrapped program that imports another workspace package is vendored with that package copied inside its own folder under `dist/vendor`, so no copy reaches back out of it.

## Background

- This package comes from [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170), the invoked name from [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171), and `openai_conformance_test` from [issue #182](https://github.com/webai-at-home/webai-at-home/issues/182).
- `scripts/vendor_wrapped_programs.ts` and `Cli.run` each carry a comment recording what was tried and dropped.
- `@webai/consumer-cli` once ran as the fall-through for any unmatched first word; undoing that is why commander's help handling is off. See [issue #184](https://github.com/webai-at-home/webai-at-home/issues/184).
