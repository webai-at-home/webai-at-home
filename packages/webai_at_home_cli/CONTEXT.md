# Directory Context: `/packages/webai_at_home_cli`

## Purpose

The single command line program published to the npm registry as `webai-at-home`, so a user runs `npx webai-at-home <command>` without cloning this repository. It dispatches to `@webai/gateway`, `@webai/consumer-openai`, `@webai/worker-openai`, and `@webai/consumer-cli` rather than reimplementing any of them.

## Key Exports & Entry Points

- `src/cli.ts`: the program, `Cli`. `gateway`, `consumer_openai`, `worker_openai` and `consumer_cli` each run one wrapped program unchanged, on whatever follows; any other first word is an unknown command.
- `scripts/vendor_wrapped_programs.ts`: run by `prepack`. Copies the built files of every wrapped program into `dist/vendor` and rewrites the four package-name imports in `dist/cli.js` into relative paths pointing there.

## Rules

- Each wrapped program takes the name it was invoked under as a parameter, so no usage line names a program the person never typed.
- All four wrapped programs are exposed the same way: one named commander subcommand each, one line each in the top-level help, and that program's own `--help` for anything more. None of them ever expands its own commands into this program's help, and no program runs under a name other than its own.
- `-V/--version`, `-h/--help`, and the no-arguments case are answered inside `Cli.run` before the commander program is parsed, which is what lets the program itself set `helpOption(false)`.
- The program sets `helpOption(false)` so that a first word naming none of the four is reported as an unknown command, instead of being answered with this program's own help and an exit code of `0`.
- This program never declares its own version of an option a wrapped program already has; `allowUnknownOption` and `passThroughOptions` keep its parser out of the way, and each named subcommand sets `helpOption(false)` so `--help` reaches the wrapped program's own, fuller help.
- No wrapped package is ever named in this package's own `package.json`, because naming a workspace member in `dependencies` makes `npm install` and `npx` resolve it against the real npm registry. The vendoring script copies the built files in instead, which Node finds on disk.
- This package's `version` need not match the wrapped programs' versions, because that script copies whatever is currently built.
- Every test exercising a real subcommand runs this program in its own process, because commander's `--help` handling calls `process.exit` inside each wrapped program's own parser.
- `@webai/consumer-cli`'s `Cli` is imported through its dedicated `./cli` subpath, the only place that package exports it.

## Background

- This package comes from [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170), and passing the invoked name to each wrapped program from [issue #171](https://github.com/webai-at-home/webai-at-home/issues/171). `scripts/vendor_wrapped_programs.ts` and `Cli.run` each carry a comment recording what was tried and dropped.
- `@webai/consumer-cli` was reached without naming it until the rule above was written: any first word matching none of the other three ran it, its own nine commands were expanded into this program's help, and it was the one wrapped program with no name of its own at this level. Merging it into the root that way was a mistake. Commander's own automatic help handling had to be turned off to undo it, because it answers `--help` before it matches a first word against a subcommand, so `webai-at-home account_key --help` printed this program's own help and exited `0` rather than reporting that `account_key` is not a command here.
