#!/usr/bin/env -S npx tsx

// node imports
import Fs from 'node:fs';
import Url from 'node:url';

// npm imports
import { Command } from 'commander';

// local imports
import { BenchmarkCommand, type RawBenchmarkOptions } from './benchmark/benchmark_command.js';
import { ChatCommand, type RawChatOptions } from './chat/chat_command.js';
import { ConformanceCommand, knownProfiles, type RawConformanceOptions } from './conformance/conformance_command.js';
import { exitCodes } from './exit_codes.js';
import { SharedOptions } from './shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the openai_test command line program and its three subcommands
//
//	Run with:
//	  ./src/cli.ts conformance --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct --profile full
//	  ./src/cli.ts benchmark --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct
//	  ./src/cli.ts chat --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct
//	  ./src/cli.ts chat --base_url http://localhost:1234/v1 --model llama-3.2-1b-instruct --prompt "What is the capital of France?"
//	or, from the workspace:
//	  npm run chat --workspace @webai/openai-test -- --model llama-3.2-1b-instruct --prompt "..."
//
//	Three subcommands, each answering a different question about one OpenAI-compatible endpoint:
//	  conformance — does this server honour the protocol, and what can the model behind it do
//	  benchmark   — how fast is this endpoint
//	  chat        — what does this endpoint actually answer
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `openai_test` command line program. */
export class Cli {
	/**
	 * Parses the command line and dispatches to `conformance`, `benchmark`, or `chat`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the arguments
	 * this process was started with.
	 * @returns Nothing, once the subcommand has finished. Sets `process.exitCode` to `2` when the
	 * run could not start at all — an unusable command line, or an endpoint that could not be
	 * reached — reported in words rather than as a stack trace. A test that failed sets `1`, and
	 * only `conformance` can do that.
	 */
	static async run(args: string[] = process.argv.slice(2), invokedName = 'openai_test'): Promise<void> {
		const program = new Command();
		program.name(invokedName).description('Tests, measures, and talks to a server that speaks the OpenAI-compatible API.');

		const conformance = program
			.command('conformance')
			.description('Reports which parts of the OpenAI-compatible Chat Completions API one server actually honours.')
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the identifiers the endpoint serves',
				process.env.OPENAI_MODEL,
			)
			.option('--profile <name>', `which group of tests to run: ${[...knownProfiles.keys()].join(', ')}`, 'core')
			.option('-g, --group <name>', 'run only the tests of one group, such as streaming')
			.option('-t, --test <id...>', 'run only the tests with these identifiers, such as chat.basic')
			.option('-r, --repeats <number>', 'how many times a tool call or generation control probe repeats its prompt', '3')
			.option('-o, --output <file>', 'write the report to this file rather than to standard output')
			.option('-v, --verbose', 'print each test as it starts and as it finishes, and print the detail of every test, including the ones that passed')
			.option('--ci', 'exit 1 when any test failed, for a continuous integration run');
		SharedOptions.addFormatOption(conformance);
		SharedOptions.addStreamOption(conformance);
		SharedOptions.addEndpointOptions(conformance);
		conformance.action(async (rawOptions: RawConformanceOptions) => {
			await ConformanceCommand.run(rawOptions, args, invokedName);
		});

		const benchmark = program
			.command('benchmark')
			.description("Measures one OpenAI-compatible endpoint's streamed chat completion latency, one model at a time.")
			.option(
				'-m, --model <name>',
				'model identifier, a comma-separated list of identifiers, a pattern such as llm_*, all, or list to print the identifiers the endpoint serves',
				process.env.OPENAI_MODEL,
			)
			.option('-p, --prompt <text>', 'the one prompt sent to the endpoint', BenchmarkCommand.defaultPrompt)
			.option('-r, --runs <number>', 'measured requests per model', '1')
			.option('-w, --warmup_runs <number>', 'unreported warm-up requests per model', '1')
			.option('--thinking <on|off>', 'off sends reasoning_effort none, so a thinking model answers straight away; on leaves the decision to the endpoint', 'off')
			.option('-o, --output <file>', 'write the report to this file rather than to standard output')
			.option('-v, --verbose', 'print each warm-up and measured request as it is sent, and what it measured when it came back');
		SharedOptions.addFormatOption(benchmark);
		SharedOptions.addEndpointOptions(benchmark);
		benchmark.action(async (rawOptions: RawBenchmarkOptions) => {
			await BenchmarkCommand.run(rawOptions, args, invokedName);
		});

		const chat = program
			.command('chat')
			.description('Opens a session against one model, and streams each answer back to the terminal.')
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
			process.exitCode = exitCodes.runnerError;
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
