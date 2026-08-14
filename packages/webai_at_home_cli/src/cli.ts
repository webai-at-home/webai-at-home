#!/usr/bin/env node
// node imports
import Fs from 'node:fs';
import Path from 'node:path';
import Url from 'node:url';

// npm imports
import * as Commander from 'commander';

// local imports
import { Cli as GatewayCli } from '@webai/gateway/dist/cli.js';
import { Cli as ConsumerOpenaiCli } from '@webai/consumer-openai/dist/cli.js';
import { Cli as WorkerOpenaiCli } from '@webai/worker-openai/dist/cli.js';
import { Cli as ConsumerCliCli } from '@webai/consumer-cli/cli';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the webai-at-home command line program: dispatches to the other four
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const __dirname = import.meta.dirname;

/** The name this program is published under, printed in every usage line and every error message. */
const programName = 'webai-at-home';

/** The first word of the command line that names one of the other three command line programs. */
const namedSubcommands = ['gateway', 'consumer_openai', 'worker_openai'] as const;

/**
 * The command line program of `webai-at-home`.
 *
 * `gateway`, `consumer_openai` and `worker_openai` each name one of the other three command line
 * programs in this repository and run it, unchanged, on whatever follows. Any other first word —
 * `submit`, `status`, `capacity`, `log_statistics`, or one of the account commands, but also a global
 * option such as `--gateway-url` written before any of those, the way `@webai/consumer-cli`'s own usage
 * documents it — is not a command of this program at all: it is handed whole to
 * `@webai/consumer-cli`, the participant program every other command name and every bare option
 * belongs to. See issue #170.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * Which of the four command line programs runs is decided by looking at the first word alone,
	 * rather than by letting commander itself decide between a matching subcommand and a fall
	 * through: commander's own handling of an option it does not recognise, such as
	 * `@webai/consumer-cli`'s own `--gateway-url` written ahead of one of its subcommand names, turned out
	 * not to reach the intended subcommand at all, only its own help text, when tried live. Once
	 * one of the three named subcommands is confirmed, commander parses everything that follows
	 * it; `allowUnknownOption` and `passThroughOptions` keep it from rejecting or reinterpreting
	 * an option it does not itself declare, such as the gateway's `--port`.
	 *
	 * `-V`/`--version` is answered here rather than being declared on the built program, for the
	 * same reason `-h`/`--help` is: a first word this program does not recognise goes straight to
	 * `@webai/consumer-cli`, which would answer `--version` with `error: unknown option`.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @returns Nothing, once the chosen subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const [firstWord] = args;
		if (args.length === 0 || firstWord === '-h' || firstWord === '--help') {
			Cli._buildProgram().outputHelp();
			process.exitCode = args.length === 0 ? 1 : 0;
			return;
		}
		if (firstWord === '-V' || firstWord === '--version') {
			console.log(Cli.readVersion());
			return;
		}
		if ((namedSubcommands as readonly string[]).includes(firstWord) === false) {
			await ConsumerCliCli.run(args, programName);
			return;
		}

		const program = Cli._buildProgram();
		await program.parseAsync([process.argv[0] ?? '', process.argv[1] ?? '', ...args]);
	}

	/**
	 * Reads the version of this package, which is the version `npx` fetched.
	 *
	 * Read from `package.json` at run time rather than written into this file, so the two can
	 * never disagree. `npm version patch` rewrites `package.json` alone. The file sits one level
	 * above both `src` and `dist`, so the same relative path works whether this module was started
	 * from its TypeScript source or from its compiled output.
	 *
	 * @returns The version, or `unknown` when `package.json` cannot be read or holds no version.
	 */
	static readVersion(): string {
		try {
			const manifest = JSON.parse(
				Fs.readFileSync(Path.join(__dirname, '..', 'package.json'), 'utf8'),
			) as { version?: string };
			return manifest.version ?? 'unknown';
		} catch {
			return 'unknown';
		}
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `npx`, and the `bin` symlink `npm install` creates for it, invoke this file through a
	 * symlink under `node_modules/.bin`, so `process.argv[1]` is the symlink path while
	 * `import.meta.url` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
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

	/**
	 * Builds every subcommand this program itself recognises.
	 *
	 * `enablePositionalOptions` is required for `passThroughOptions`, which each of the
	 * subcommands sets so that an option they do not themselves declare, such as the gateway's
	 * `--port`, reaches the program it is meant for unchanged.
	 *
	 * @returns The built, not yet run, command line program.
	 */
	private static _buildProgram(): Commander.Command {
		const program = new Commander.Command(programName)
			.description(
				"Run one participant of the WebAI@Home cluster. \"gateway\", \"consumer_openai\" and"
					+ ' "worker_openai" each run the command line program of the same name in this'
					+ ' cluster; every other command is handed to consumer_cli, which submits tasks,'
					+ ' reports cluster state, and manages this participant\'s own account.',
			)
			.version(Cli.readVersion(), '-V, --version', 'print the version of webai-at-home that is running')
			.enablePositionalOptions()
			.addHelpText(
				'after',
				`\nconsumer_cli commands:\n${Cli._describeConsumerCliCommands()}`
					+ `\nRun "${programName} <command> --help" for a command's own options.`,
			);

		// `helpOption(false)` turns off commander's own automatic `-h`/`--help` handling for each of
		// these, so that option passes through like any other and reaches the program it is
		// meant for, which prints its own real, detailed usage — rather than commander printing
		// this program's generic "Usage: webai-at-home gateway [options] [gatewayArgs...]" instead.
		program
			.command('gateway')
			.description('start the central gateway')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[gatewayArgs...]', "the gateway's own options")
			.action(async (gatewayArgs: string[]): Promise<void> => {
				await GatewayCli.run(gatewayArgs, `${programName} gateway`);
			});

		program
			.command('consumer_openai')
			.description('serve the OpenAI-compatible completion interface in front of the cluster')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[consumerOpenaiArgs...]', 'the "server" subcommand, and its own options')
			.action(async (consumerOpenaiArgs: string[]): Promise<void> => {
				await ConsumerOpenaiCli.run(consumerOpenaiArgs, `${programName} consumer_openai`);
			});

		program
			.command('worker_openai')
			.description('run a worker that calls a local server speaking the OpenAI-compatible API')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[workerOpenaiArgs...]', "the worker's own options")
			.action(async (workerOpenaiArgs: string[]): Promise<void> => {
				await WorkerOpenaiCli.run(workerOpenaiArgs, `${programName} worker_openai`);
			});

		return program;
	}

	/**
	 * Describes every command of `@webai/consumer-cli`, as the lines the top-level help lists them
	 * on.
	 *
	 * Built by asking `@webai/consumer-cli` to build its own program and reading the name and the
	 * description of every command it holds, rather than being written out by hand here. The
	 * hand-written copy this replaced had already drifted: it described `submit` and `capacity`,
	 * and neither command had a description of its own at all. See issue #171.
	 *
	 * @returns One line per command, each already indented and newline-terminated.
	 */
	private static _describeConsumerCliCommands(): string {
		const commands = ConsumerCliCli.buildProgram(programName).commands
			.filter((command) => command.name() !== 'help');
		const widestName = Math.max(...commands.map((command) => command.name().length));
		return commands
			.map((command) => `  ${command.name().padEnd(widestName + 2)}${Cli._summarise(command.description())}\n`)
			.join('');
	}

	/**
	 * Shortens one command's own description down to the single clause this list has room for.
	 *
	 * Every `@webai/consumer-cli` command describes itself in full, over one or more sentences,
	 * because that description is what its own `--help` prints. This list has one line per command
	 * and no room for any of that, so it keeps only the leading clause: everything before the first
	 * colon, comma, or full stop. A full stop only ends the clause when a space or the end of the
	 * text follows it, so a file name such as `.log_entry.jsonl` is not mistaken for one.
	 *
	 * @param description The command's own description, in full.
	 * @returns Its leading clause, with no punctuation left on the end.
	 */
	private static _summarise(description: string): string {
		const match = /[:,]|\.(\s|$)/.exec(description);
		if (match === null) {
			return description;
		}
		return description.slice(0, match.index);
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
