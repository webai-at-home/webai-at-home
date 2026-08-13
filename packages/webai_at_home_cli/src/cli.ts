#!/usr/bin/env node
// node imports
import Fs from 'node:fs';
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

/** The first word of the command line that names one of the other three command line programs. */
const namedSubcommands = ['gateway', 'consumer_openai', 'worker_openai'] as const;

/**
 * The command line program of `webai-at-home`.
 *
 * `gateway`, `consumer_openai` and `worker_openai` each name one of the other three command line
 * programs in this repository and run it, unchanged, on whatever follows. Any other first word —
 * `submit`, `status`, `capacity`, `log_stats`, or one of the account commands, but also a global
 * option such as `--url` written before any of those, the way `@webai/consumer-cli`'s own usage
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
	 * `@webai/consumer-cli`'s own `--url` written ahead of one of its subcommand names, turned out
	 * not to reach the intended subcommand at all, only its own help text, when tried live. Once
	 * one of the three named subcommands is confirmed, commander parses everything that follows
	 * it; `allowUnknownOption` and `passThroughOptions` keep it from rejecting or reinterpreting
	 * an option it does not itself declare, such as the gateway's `--port`.
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
		if ((namedSubcommands as readonly string[]).includes(firstWord) === false) {
			await ConsumerCliCli.run(args);
			return;
		}

		const program = Cli._buildProgram();
		await program.parseAsync([process.argv[0] ?? '', process.argv[1] ?? '', ...args]);
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
	 * Builds the three subcommands this program itself recognises.
	 *
	 * `enablePositionalOptions` is required for `passThroughOptions`, which each of the three
	 * subcommands sets so that an option they do not themselves declare, such as the gateway's
	 * `--port`, reaches the program it is meant for unchanged.
	 *
	 * @returns The built, not yet run, command line program.
	 */
	private static _buildProgram(): Commander.Command {
		const program = new Commander.Command('webai-at-home')
			.description(
				"Run one participant of the WebAI@Home cluster. \"gateway\", \"consumer_openai\" and"
					+ ' "worker_openai" each run the command line program of the same name in this'
					+ ' cluster; every other command is handed to consumer_cli, which submits tasks,'
					+ ' reports cluster state, and manages this participant\'s own account.',
			)
			.enablePositionalOptions()
			.addHelpText(
				'after',
				'\nconsumer_cli commands:\n'
					+ '  submit                send one task to the central gateway\n'
					+ '  status                report the current worker cluster state\n'
					+ '  capacity              estimate how many concurrent runs of a task type the cluster can support\n'
					+ '  log_stats             measure one already recorded message log file\n'
					+ '  account_key           generate this participant\'s account key pair\n'
					+ '  identity_register     tell the central gateway about this participant\'s account\n'
					+ '  account_information   read this participant\'s own account profile\n'
					+ '  account_balance       read this participant\'s own account balance\n'
					+ '  account_history       read this participant\'s own account history\n'
					+ '\nRun "webai-at-home <command> --help" for a command\'s own options.',
			);

		// `helpOption(false)` turns off commander's own automatic `-h`/`--help` handling for each of
		// these three, so that option passes through like any other and reaches the program it is
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
				await GatewayCli.run(gatewayArgs);
			});

		program
			.command('consumer_openai')
			.description('serve the OpenAI-compatible completion interface in front of the cluster')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[consumerOpenaiArgs...]', 'the "server" subcommand, and its own options')
			.action(async (consumerOpenaiArgs: string[]): Promise<void> => {
				await ConsumerOpenaiCli.run(consumerOpenaiArgs);
			});

		program
			.command('worker_openai')
			.description('run a worker that calls a local server speaking the OpenAI-compatible API')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[workerOpenaiArgs...]', "the worker's own options")
			.action(async (workerOpenaiArgs: string[]): Promise<void> => {
				await WorkerOpenaiCli.run(workerOpenaiArgs);
			});

		return program;
	}
}

if (Cli.isMainModule()) {
	await Cli.run();
}
