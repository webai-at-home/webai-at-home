# Directory Context: `/packages/openai_test/src/chat`

## Purpose

The `chat` subcommand: a session somebody types turns into, where the history accumulates and each answer streams back to the terminal. It answers "what does this endpoint actually answer", which is neither a verdict nor a measurement to compare runs by.

## Key Exports & Entry Points

- `chat_command.ts`: `ChatCommand`, which reads the subcommand's options and wires the session to the terminal.
- `chat_session.ts`: `ChatSession`, the loop that reads a turn, sends the history, streams the answer, and acts on the three commands.
- `chat_renderer.ts`: `ChatRenderer`, every line the session prints except the answer itself.
- Command to run this folder: `npx tsx ../cli.ts chat --model <name>`

## Rules

- Turns are read through the line iterator of `node:readline`, never through `readline/promises`'s `question`, which reads the first line of a piped standard input and then never settles.
- Everything the session reaches the outside world through is handed to it — where turns come from, where text goes, how a turn is sent — so a test drives a whole session with neither a terminal nor an endpoint.
- `-p/--prompt` is the same loop fed one line, not a second code path, so the two can never disagree about what is sent with a turn or printed under an answer. It is told nothing about the three commands it cannot reach.
- The three in-session commands are `/reset`, `/history`, and `/quit`, and there are no others. Each is matched whole: a line that merely starts with a slash is a turn, since a model may be asked about a command it has never heard of.
- `/reset` keeps the system message, because that message opens the session rather than belonging to a turn in it.
- A turn the endpoint would not answer ends the turn, never the session, and leaves the history exactly as it was. A session that stopped on the first refusal would throw away everything already typed.
- `-m/--model` takes exactly one model identifier, read through `SharedOptions.readOneModelId`, and refuses `list` on top of what that refuses, since a session has nowhere to print a listing to.
- `chat` accepts no `-f/--format` and no `-o/--output`. It is a terminal session, not a report.
- `chat` produces no verdict and sets no failing exit code. It returns `0`, or `2` when the run could not start at all — not even a refused turn changes that. All three subcommands now answer this way.
- `chat_renderer.ts` returns strings and prints nothing, so a test reads what would have been shown. The answer is the one thing it does not build, since that arrives piece by piece.

## Background

- The line iterator rule was proved rather than assumed, in Milestone 6 of [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208): `question` read one line of a pipe and then exited with an unsettled await, while the iterator read every line and ended by itself.
