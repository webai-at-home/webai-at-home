#!/usr/bin/env node
import * as Commander from 'commander';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { TaskInputFactory, taskTypeNames } from './libs/task_input_factory.js';
import { CliError } from './libs/cli_errors.js';
import { SubmitCommand } from './commands/submit_command.js';
import { StatusCommand, statusFormats } from './commands/status_command.js';
import { CapacityCommand, capacityFormats } from './commands/capacity_command.js';
import { LogStatsCommand } from './commands/log_stats_command.js';
import { LogStatisticsFormatter, logStatisticsFormats } from './message_log/log_statistics_formatter.js';
import { AccountOutputFormatter, accountOutputFormats } from './account/account_output_format.js';
import { AccountKeyCommand } from './commands/account_key_command.js';
import { AccountRegisterCommand } from './commands/account_register_command.js';
import { AccountInformationCommand } from './commands/account_information_command.js';
import { AccountBalanceCommand } from './commands/account_balance_command.js';
import { AccountHistoryCommand, accountHistoryDirections } from './commands/account_history_command.js';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { AccountIdentityFile } from '@webai/protocol/account_identity_file';
import { WebaiHomeDirectory } from '@webai/protocol/webai_home_directory';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the consumer command line program: submit, status, capacity, log_statistics, and the account commands
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const __filename = import.meta.filename;

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const DEFAULT_AUTHENTICATION_TOKEN = 'development-token';

/** The default central gateway WebSocket URL. */
const DEFAULT_GATEWAY_URL = 'wss://webai-gateway.dash-menu.com/';

/**
 * Where every account command defaults to reading this participant's configuration directory, which
 * holds the account key pair in `default.account_key.json` and the account profile in
 * `default.identity.json`.
 *
 * This is `consumer_cli`'s own identity on this machine, kept separate from `consumer_openai`'s in
 * `~/.webai-at-home/consumer_openai_config/` and `worker_openai`'s in
 * `~/.webai-at-home/worker_openai_config/`, so every `consumer_cli` command run here uses one
 * consistent account without `--config_dir` being passed by hand.
 *
 * Kept under the user's home directory rather than this package's own folder, because `consumer_cli`
 * installed and run through `npx` has no writable folder of its own to keep an account key pair in
 * between runs — that folder is a cache directory `npx` may clear. See issue #170.
 */
const DEFAULT_CONFIG_DIR = Path.join(Os.homedir(), '.webai-at-home', 'consumer_cli_config');

/** The shared options every subcommand accepts, before each subcommand's own options. */
type GlobalOptions = {
	/** The WebSocket URL of the central gateway every connecting subcommand talks to, when the `-u/--gateway-url` option was given. */
	gatewayUrl?: string;
	/** The bearer token to authenticate with, when the `-a/--auth-token` option was given. */
	authToken?: string;
};

/**
 * The command line program of the consumer: `submit` sends one task to the central gateway,
 * `status` reports the current worker cluster state, `capacity` estimates how many concurrent
 * runs of a task type the cluster can currently support, and `log_statistics` measures one already
 * recorded message log file without connecting to anything. `log_statistics` also answers to its
 * earlier name, `log_stats`.
 *
 * Five further commands read and write this participant's own account, which is what the accounting
 * system of issue #122 records contributed and consumed computation against: `account_key`
 * generates the key pair that is the account, `account_register` tells the central gateway about it,
 * and `account_information`, `account_balance`, and `account_history` read back what the gateway
 * holds for it.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 * @param programName The name to print in every usage line and every error message. Defaults
	 * to `consumer_cli`, which is what this program is called when it is run on its own. The
	 * `webai-at-home` program passes its own name instead, so a person who typed
	 * `webai-at-home submit` is not told about a program called `consumer_cli` that they never
	 * ran. See issue #171.
	 * @returns A promise that settles once the requested subcommand has finished.
	 */
	static async run(args: string[] = process.argv.slice(2), programName = 'consumer_cli'): Promise<void> {
		const program = Cli.buildProgram(programName);

		try {
			await program.parseAsync([process.argv[0] ?? '', process.argv[1] ?? '', ...args]);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exitCode = error instanceof CliError ? error.exitCode : 1;
		}
	}

	/**
	 * Builds every command of this program, without running any of them.
	 *
	 * Kept apart from {@link run} so that the `webai-at-home` program can build this one and read
	 * back the name and the description of every command it holds, rather than keeping a
	 * hand-written second copy of that list which drifts out of date. See issue #171.
	 *
	 * @param programName The name to print in every usage line and every error message.
	 * @returns The built, not yet run, command line program.
	 */
	static buildProgram(programName = 'consumer_cli'): Commander.Command {
		const program = new Commander.Command(programName)
			.configureHelp({ showGlobalOptions: true })
			// `--gateway-url`, the name `consumer_openai` already gave this same setting. It was
			// `--url` here and in `worker_openai` until issue #171, so one idea had two names
			// across the four programs. No alias was kept for the old name, following the same
			// decision made when `WEBAI_AUTH_TOKEN` became `GATEWAY_AUTH_TOKEN` and when
			// `identity_register` became `account_register`.
			.option(
				'-u, --gateway-url <url>',
				'central gateway WebSocket URL (falls back to the GATEWAY_WS_URL environment'
					+ ` variable, then to ${DEFAULT_GATEWAY_URL})`,
			)
			.option(
				'-a, --auth-token <token>',
				'bearer token for the central gateway (falls back to the GATEWAY_AUTH_TOKEN'
					+ ' environment variable, then to a development default)',
			);

		program
			.command('submit')
			.description('send one task to the central gateway, and print its updates until it completes or fails')
			.argument('<input>', 'number for dev_formula, free text for every language-model task type')
			// Required, and with no default: which task type to run is the decision of the person
			// submitting, and this program cannot make it for them. It used to default to
			// `dev_formula`, so `submit "What is the capital of France?"` — the first command a
			// user is likely to type — reached the development formula task and failed with
			// `Input must be a finite number`. `capacity` already declared this option the same
			// way. See issue #171.
			.requiredOption('-t, --task_type <type>', `task type: ${taskTypeNames.join(', ')}`)
			.option('-n, --consumer_name <name>', 'consumer name', 'consumer')
			.option(
				'-s, --stream',
				'ask for the answer in pieces as it is produced, rather than in one result once'
					+ ' it is finished',
			)
			.option(
				'-c, --config_dir <path>',
				'the directory holding this participant\'s account key pair in'
					+ ' default.account_key.json, so the stages this task runs are recorded against'
					+ ' that account. A machine with no key pair there submits with no account',
				DEFAULT_CONFIG_DIR,
			)
			// Written under the home directory, never into the directory this command was run
			// from, which is where they landed until issue #171 — `npx webai-at-home submit` left
			// a `logs` folder wherever the person was standing.
			.option('--log-dir <path>', 'the directory to write this submission\'s message log into', WebaiHomeDirectory.logsForProgram('consumer_cli'))
			.action(async (
				input: string,
				localOptions: {
					task_type: string;
					consumer_name: string;
					stream?: boolean;
					config_dir: string;
					logDir: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (TaskInputFactory.isTaskTypeName(options.task_type) === false) {
					throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
				}
				await SubmitCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					type: options.task_type,
					name: options.consumer_name,
					stream: options.stream === true,
					keyFilePath: AccountKeyFile.pathInConfigDir(options.config_dir),
					logsDirectory: options.logDir,
					input,
				});
			});

		program
			.command('status')
			.description(
				'print the worker cluster state: how many worker browsers are connected, how much'
					+ ' of their capacity is free, and one row per worker',
			)
			.option(
				'--watch',
				'after the first snapshot, stay connected and print a new snapshot every time the'
					+ ' worker cluster changes, until you interrupt with Ctrl-C or the connection'
					+ ' drops (default: print one snapshot and exit)',
			)
			.option('-f, --format <format>', `output format: ${statusFormats.join(', ')}`, 'text')
			.option(
				'--timeout <ms>',
				'milliseconds to wait for the central gateway to accept the connection and send'
					+ ' the first snapshot before giving up',
				'10000',
			)
			.action(async (
				localOptions: { watch?: boolean; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (StatusCommand.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${statusFormats.join(', ')}`);
				}
				await StatusCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					watch: options.watch === true,
					format: options.format,
				});
			});

		program
			.command('capacity')
			.description(
				'estimate how many concurrent runs of one task type the cluster could support,'
					+ ' from the workers connected right now',
			)
			// `-t`, the same letter `submit` gives the same option. Only the long name existed until
			// issue #171, so the two commands named one idea two different ways.
			.requiredOption('-t, --task_type <type>', `task type: ${taskTypeNames.join(', ')}`)
			.option('-f, --format <format>', `output format: ${capacityFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { task_type: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (CapacityCommand.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${capacityFormats.join(', ')}`);
				}
				await CapacityCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					type: options.task_type,
					format: options.format,
				});
			});

		program
			.command('log_statistics')
			// `log_stats` was this command's only name until issue #171, which found it to be the
			// one shortened name in a set that otherwise writes its names out in full, next to
			// `account_information`, `account_balance` and `account_history`. The old name keeps
			// working so that anything already written against it does not break.
			.alias('log_stats')
			// This command reads one file already on this machine and connects to nothing, so the
			// central gateway's URL and its bearer token do not apply to it and are left out of
			// its help, even though every connecting command shows them.
			.configureHelp({ showGlobalOptions: false })
			.description(
				'measure one .log_entry.jsonl message log file and print what it says: how much'
					+ ' traffic it carried, who carried it, how long every answer took, what'
					+ ' became of every task and every stage run, and anything worth a second look',
			)
			.argument('<file>', 'path of the .log_entry.jsonl file to measure')
			.option('-f, --format <format>', `output format: ${logStatisticsFormats.join(', ')}`, 'text')
			.option(
				'--top <count>',
				'how many rows of each table to print before the rest are only counted',
				'12',
			)
			.action(async (
				file: string,
				localOptions: { format: string; top: string },
			): Promise<void> => {
				if (LogStatisticsFormatter.isFormat(localOptions.format) === false) {
					throw new Error(`Format must be one of ${logStatisticsFormats.join(', ')}`);
				}
				const top = Number(localOptions.top);
				if (Number.isInteger(top) === false || top < 1) {
					throw new Error('Top must be a whole number of at least 1');
				}
				await LogStatsCommand.run({
					filePath: file,
					format: localOptions.format,
					top,
				});
			});

		program
			.command('account_key')
			// This command generates a key pair on this machine and connects to nothing — its own
			// description says so — so the central gateway's URL and its bearer token do not apply
			// to it and are left out of its help. See issue #171.
			.configureHelp({ showGlobalOptions: false })
			.description(
				'generate the key pair that is this participant\'s account, and print the account'
					+ ' identifier it produces. It talks to nothing: the identifier is a digest of'
					+ ' the public key, so it exists as soon as the key pair does',
			)
			.option('-c, --config_dir <path>', 'the directory to keep the key pair in, as default.account_key.json', DEFAULT_CONFIG_DIR)
			.option(
				'--force',
				'overwrite a key pair that is already there, losing the account it belongs to',
			)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.action(async (
				localOptions: { config_dir: string; force?: boolean; format: string },
			): Promise<void> => {
				if (AccountOutputFormatter.isFormat(localOptions.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountKeyCommand.run({
					keyFilePath: AccountKeyFile.pathInConfigDir(localOptions.config_dir),
					isForced: localOptions.force === true,
					format: localOptions.format,
				});
			});

		program
			.command('account_register')
			.description(
				'tell the central gateway about this machine\'s public key, so completed and'
					+ ' consumed stages can be recorded against the account it identifies',
			)
			.option('-c, --config_dir <path>', 'the directory holding the key pair in default.account_key.json and the account profile in default.identity.json', DEFAULT_CONFIG_DIR)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: {
					config_dir: string;
					format: string;
					timeout: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountRegisterCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: AccountKeyFile.pathInConfigDir(options.config_dir),
					identityFilePath: AccountIdentityFile.pathInConfigDir(options.config_dir),
					format: options.format,
				});
			});

		program
			.command('account_information')
			.description(
				'print the profile the central gateway holds for this account: its identifier,'
					+ ' its public key, its display name, its email address, and when it was'
					+ ' registered',
			)
			.option('-c, --config_dir <path>', 'the directory holding the key pair in default.account_key.json', DEFAULT_CONFIG_DIR)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { config_dir: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountInformationCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: AccountKeyFile.pathInConfigDir(options.config_dir),
					format: options.format,
				});
			});

		program
			.command('account_balance')
			.description(
				'print what this account holds: one credit for every stage it completed as a'
					+ ' worker, less one for every stage it had run as a consumer',
			)
			.option('-c, --config_dir <path>', 'the directory holding the key pair in default.account_key.json', DEFAULT_CONFIG_DIR)
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: { config_dir: string; format: string; timeout: string },
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				await AccountBalanceCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: AccountKeyFile.pathInConfigDir(options.config_dir),
					format: options.format,
				});
			});

		program
			.command('account_history')
			.description(
				'print this account\'s accounting entries, newest first. --direction earned lists'
					+ ' the stages this account completed, and --direction spent lists the stages'
					+ ' it had run',
			)
			.option('-c, --config_dir <path>', 'the directory holding the key pair in default.account_key.json', DEFAULT_CONFIG_DIR)
			.option(
				'-d, --direction <direction>',
				`which side of the ledger to print: ${accountHistoryDirections.join(', ')}`,
				'both',
			)
			.option('-l, --limit <count>', 'how many entries to ask for at a time', '20')
			.option('--all', 'keep asking for further pages until the whole history has been printed')
			.option('-f, --format <format>', `output format: ${accountOutputFormats.join(', ')}`, 'text')
			.option('--timeout <ms>', 'how long to wait for the central gateway to answer', '10000')
			.action(async (
				localOptions: {
					config_dir: string;
					direction: string;
					limit: string;
					all?: boolean;
					format: string;
					timeout: string;
				},
				command: Commander.Command,
			): Promise<void> => {
				const options = command.optsWithGlobals<GlobalOptions & typeof localOptions>();
				if (AccountOutputFormatter.isFormat(options.format) === false) {
					throw new Error(`Format must be one of ${accountOutputFormats.join(', ')}`);
				}
				if (AccountHistoryCommand.isDirection(options.direction) === false) {
					throw new Error(`Direction must be one of ${accountHistoryDirections.join(', ')}`);
				}
				const limit = Number(options.limit);
				if (Number.isInteger(limit) === false || limit < 1) {
					throw new Error('Limit must be a whole number of at least 1');
				}
				await AccountHistoryCommand.run({
					url: Cli.resolveGatewayUrl(options.gatewayUrl),
					authToken: Cli.resolveAuthToken(options.authToken),
					timeoutMs: Number(options.timeout),
					keyFilePath: AccountKeyFile.pathInConfigDir(options.config_dir),
					direction: options.direction,
					limit,
					isEverythingRequested: options.all === true,
					format: options.format,
				});
			});

		return program;
	}

	/**
	 * Reports whether this module was started directly, rather than imported.
	 *
	 * `npx`, and the `bin` symlink `npm install` creates for it, invoke this file through a
	 * symlink under `node_modules/.bin`, so `process.argv[1]` is the symlink path while
	 * `__filename` is Node's already-resolved real path. Comparing both sides after
	 * resolving symlinks handles that invocation the same as running this file directly.
	 *
	 * @returns `true` when this process was started to run this file.
	 */
	static isMainModule(): boolean {
		if (process.argv[1] === undefined) {
			return false;
		}
		try {
			return __filename === Fs.realpathSync(process.argv[1]);
		} catch {
			return false;
		}
	}

	/**
	 * Resolves the central gateway WebSocket URL to connect to, in priority order: the
	 * `-u/--gateway-url` option, the `GATEWAY_WS_URL` environment variable, then
	 * `DEFAULT_GATEWAY_URL`.
	 *
	 * `GATEWAY_WS_URL` is the same name `worker_openai` and `packages/docker_server` use for this
	 * setting, so one exported variable points every program on a machine at the same gateway.
	 * See issue #138.
	 *
	 * @param optionValue The `-u/--gateway-url` option, when given.
	 * @returns The central gateway WebSocket URL to connect to.
	 */
	private static resolveGatewayUrl(optionValue: string | undefined): string {
		if (optionValue !== undefined && optionValue !== '') {
			return optionValue;
		}
		const fromEnvironment = process.env.GATEWAY_WS_URL;
		if (fromEnvironment !== undefined && fromEnvironment !== '') {
			return fromEnvironment;
		}
		return DEFAULT_GATEWAY_URL;
	}

	/**
	 * Resolves the bearer token to authenticate with, in priority order: the `-a/--auth-token`
	 * option, the `GATEWAY_AUTH_TOKEN` environment variable, then the development default.
	 *
	 * `GATEWAY_AUTH_TOKEN` is the same name `worker_openai` and `packages/docker_server` use for
	 * this setting, so one exported variable gives every program on a machine the token the gateway
	 * requires. See issue #138.
	 *
	 * @param optionValue The `-a/--auth-token` option, when given.
	 * @returns The bearer token to authenticate with.
	 */
	private static resolveAuthToken(optionValue: string | undefined): string {
		return optionValue ?? process.env.GATEWAY_AUTH_TOKEN ?? DEFAULT_AUTHENTICATION_TOKEN;
	}
}

if (Cli.isMainModule()) {
	void Cli.run();
}
