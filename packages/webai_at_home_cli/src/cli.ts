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
import { Cli as OpenaiConformanceTestCli } from '@webai/openai-conformance-test/dist/cli.js';
import { Cli as OpenaiTestCli } from '@webai/openai-test/dist/cli.js';
import { Cli as ConsumerCliCli } from '@webai/consumer-cli/cli';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the webai-at-home command line program: dispatches to the others
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const __dirname = import.meta.dirname;

/** The name this program is published under, printed in every usage line and every error message. */
const programName = 'webai-at-home';

/**
 * The command line program of `webai-at-home`.
 *
 * `gateway`, `consumer_openai`, `worker_openai`, `consumer_cli`, `openai_conformance_test` and
 * `openai_test` each name one of the other command line programs in this repository and run it,
 * unchanged, on whatever follows. Every one of them is exposed the same way: one line in this
 * program's own help, and that program's own `--help` for anything more.
 *
 * No other first word runs anything. `submit`, `status`, `capacity`, `log_statistics`, and every
 * account command belong to `@webai/consumer-cli`, and run behind the `consumer_cli` word alone; a
 * global option such as `--gateway-url` belongs after that word too, exactly as `--port` belongs
 * after `gateway`. Anything else is reported as an unknown command. See issue #170.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * Zero arguments, `-h`/`--help`, and `-V`/`--version` are all answered here, before the
	 * commander program is built or parsed at all. That is what lets {@link _buildProgram} turn
	 * commander's own automatic help handling off, which in turn is what makes an unrecognised first
	 * word report `error: unknown command` even when `--help` follows it. With that handling left
	 * on, `webai-at-home account_key --help` was answered with this program's own help text and an
	 * exit code of 0, rather than with the fact that `account_key` is not a command of this program
	 * at all.
	 *
	 * Everything after that is left to commander: each wrapped program is an ordinary
	 * named subcommand, and `allowUnknownOption` and `passThroughOptions` keep this program's own
	 * parser from rejecting or reinterpreting an option it does not itself declare, such as the
	 * gateway's `--port`.
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
	 * `helpOption(false)` turns off commander's own automatic handling of `-h`/`--help` on this
	 * program itself, so that a first word naming no wrapped program is reported as
	 * an unknown command rather than being answered with this program's own help text and an exit
	 * code of 0 — which is what commander did with `webai-at-home account_key --help` while that
	 * handling was on, because it answers `--help` before it ever matches the first word against a
	 * subcommand. {@link run} answers `-h`/`--help` itself, ahead of this program being parsed at
	 * all, so the option keeps working; it is redeclared here only so the help text still lists it.
	 *
	 * @returns The built, not yet run, command line program.
	 */
	private static _buildProgram(): Commander.Command {
		const program = new Commander.Command(programName)
			.description(
				"Run one participant of the WebAI@Home cluster. \"gateway\", \"consumer_openai\","
					+ ' "worker_openai", "consumer_cli", "openai_conformance_test" and "openai_test" each run'
					+ ' the command line program of the same name in this cluster.',
			)
			.version(Cli.readVersion(), '-V, --version', 'print the version of webai-at-home that is running')
			.enablePositionalOptions()
			.helpOption(false)
			.addOption(new Commander.Option('-h, --help', 'display help for command'))
			.addHelpText('after', `\nRun "${programName} <command> --help" for a command's own options.`);

		// `helpOption(false)` turns off commander's own automatic `-h`/`--help` handling for each of
		// these, so that option passes through like any other and reaches the program it is
		// meant for, which prints its own real, detailed usage — rather than commander printing
		// this program's generic "Usage: webai-at-home gateway [options] [gatewayArgs...]" instead.
		program
			.command('consumer_cli')
			.description("submit tasks, report cluster state, and manage this participant's own account")
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[consumerCliArgs...]', "one of consumer_cli's own commands, and its own options")
			.action(async (consumerCliArgs: string[]): Promise<void> => {
				await ConsumerCliCli.run(consumerCliArgs, `${programName} consumer_cli`);
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

		program
			.command('openai_conformance_test')
			.description('report which parts of the OpenAI-compatible protocol a server actually honours')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[openaiConformanceTestArgs...]', "the conformance test's own options")
			.action(async (openaiConformanceTestArgs: string[]): Promise<void> => {
				await OpenaiConformanceTestCli.run(openaiConformanceTestArgs, `${programName} openai_conformance_test`);
			});

		program
			.command('openai_test')
			.description('test, measure, and talk to a server speaking the OpenAI-compatible API')
			.allowUnknownOption()
			.passThroughOptions()
			.helpOption(false)
			.argument('[openaiTestArgs...]', "the program's own options")
			.action(async (openaiTestArgs: string[]): Promise<void> => {
				await OpenaiTestCli.run(openaiTestArgs, `${programName} openai_test`);
			});

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

		return program;
	}

}

if (Cli.isMainModule()) {
	await Cli.run();
}
