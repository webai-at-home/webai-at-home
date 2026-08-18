#!/usr/bin/env -S npx tsx

// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import { Command } from 'commander';

// local imports
import { ChatCommand, type RawChatOptions } from './chat/chat_command.js';
import { SharedOptions } from './shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_test command line program and its three subcommands
//
//	Run with:
//	  ./src/cli.ts chat --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct --prompt "What is the capital of France?"
//	or, from the workspace:
//	  npm run chat --workspace @webai/openai-test -- --model llama-3.2-1b-instruct --prompt "..."
//
//	Three subcommands, each answering a different question about one OpenAI-compatible endpoint:
//	  conformance — does this server honour the protocol, and what can the model behind it do
//	  benchmark   — how fast is this endpoint
//	  chat        — what does this endpoint actually answer
//
//	`conformance` and `benchmark` arrive in Milestones 2 and 5 of
//	https://github.com/webai-at-home/webai-at-home/issues/208, and are not registered until they do,
//	so that a subcommand this program lists is a subcommand this program runs.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `openai_test` command line program. */
export class Cli {
	/**
	 * Parses the command line and dispatches to `chat`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @returns Nothing, once the subcommand has finished. Sets `process.exitCode` to `2` when the
	 * run could not start at all — an unusable command line, or an endpoint that could not be
	 * reached — reported in words rather than as a stack trace. A test that failed sets `1`, and
	 * only `conformance` can do that.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Command();
		program.name('openai_test').description('Tests, measures, and talks to a server that speaks the OpenAI-compatible API.');

		const chat = program
			.command('chat')
			.description('Sends turns to one model and streams each answer back to the terminal.')
			.option('-m, --model <name>', 'the one model identifier to send turns to', process.env.OPENAI_MODEL)
			.option('--system <text>', 'the system message sent as the first message of the session')
			.option('-p, --prompt <text>', 'send this one turn and leave, rather than starting a session');
		SharedOptions.addEndpointOptions(chat);
		chat.action(async (rawOptions: RawChatOptions) => {
			await ChatCommand.run(rawOptions);
		});

		try {
			await program.parseAsync(args, { from: 'user' });
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = 2;
		}
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `tsx` invokes this file through `process.argv[1]`, while `import.meta.url` is Node's
	 * already-resolved real path. Comparing both sides after resolving symlinks means a test that
	 * imports this module for its exports never triggers command line parsing.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) {
			return false;
		}
		try {
			return Url.fileURLToPath(import.meta.url) === Fs.realpathSync(process.argv[1]);
		} catch {
			return false;
		}
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
