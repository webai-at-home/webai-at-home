#!/usr/bin/env node
import * as Commander from 'commander';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Url from 'node:url';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { GatewayConnectionSupervisor } from './libs/gateway_connection_supervisor.js';
import { OpenaiApiClient } from './libs/openai_api_client.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the native worker command line program: connect, register, run stages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The default bearer token, matching the gateway's own `--auth-token` default. */
const defaultAuthenticationToken = 'development-token';

/** The default central gateway WebSocket URL, matching the gateway's own `--port` default. */
const defaultGatewayUrl = 'ws://localhost:8787';

/**
 * Where this worker defaults to reading its configuration directory, which holds its own account key
 * pair in `default.account_key.json`.
 *
 * This is `worker_openai`'s own identity on this machine, kept separate from `consumer_cli`'s in
 * `~/.webai-at-home/consumer_cli_config/` and `consumer_openai`'s in
 * `~/.webai-at-home/consumer_openai_config/`, so every stage this worker completes earns credit for
 * one consistent account without `--config_dir` being passed by hand.
 *
 * Kept under the user's home directory rather than this package's own folder, because a worker
 * installed and run through `npx` has no writable folder of its own to keep an account key pair
 * in between runs — that folder is a cache directory `npx` may clear. See issue #170.
 */
const defaultConfigDir = Path.join(Os.homedir(), '.webai-at-home', 'worker_openai_config');

/** The options this worker was started with. */
type WorkerOptions = {
	url?: string;
	authToken?: string;
	worker_name: string;
	baseUrl: string;
	model: string;
	stageNames?: string[];
	/** The directory holding this worker's own account key pair, as `default.account_key.json`. */
	config_dir: string;
	/**
	 * Whether a connection that closes is opened again after a wait.
	 *
	 * Commander sets this from `--no-automatic-reconnection`, so it is `true` unless that option
	 * is given.
	 */
	automaticReconnection: boolean;
};

/**
 * The command line program of the worker that runs a model through a local server speaking the
 * OpenAI-compatible API.
 *
 * It holds one connection to the central gateway for as long as it runs, registering as a
 * worker and running the stages the gateway assigns to it.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const program = new Commander.Command('worker_openai')
			.description('A worker that runs its assigned stage by calling a local server speaking the OpenAI-compatible Chat Completions API, such as LM Studio')
			.option('-u, --url <url>', `central gateway WebSocket URL (falls back to the GATEWAY_WS_URL environment variable, then to ${defaultGatewayUrl})`)
			.option('-a, --auth-token <token>', 'bearer token for the central gateway (falls back to the GATEWAY_AUTH_TOKEN environment variable, then to a development default)')
			.option('-n, --worker_name <name>', 'worker name, which the gateway shows in its device list', 'openai-worker')
			.option('-b, --base-url <url>', "base URL of the local server's OpenAI-compatible API", 'http://localhost:1234/v1')
			.option('-m, --model <model>', 'the model the local server is asked for', 'llama-3.2-1b-instruct')
			.option('-s, --stage-names <name...>', 'restrict this worker to these stages, instead of every stage it can run')
			.option('-c, --config_dir <path>', 'the directory holding this worker\'s own account key pair, as default.account_key.json, so the stages it completes earn credits for that account. A directory with no key pair in it means no account', defaultConfigDir)
			.option('--no-automatic-reconnection', 'stop as soon as the connection to the central gateway closes, instead of opening a connection again after a wait that grows up to one minute');

		program.parse(args, { from: 'user' });
		const options = program.opts<WorkerOptions>();
		await Cli.connect(options);
	}

	/**
	 * Keeps this worker connected to the central gateway until it is interrupted.
	 *
	 * A connection that closes is opened again after a wait that grows up to one minute, so a
	 * gateway that restarts — a deployment, a container restart, a network interruption — no
	 * longer ends this worker and leave the volunteer to start it by hand. See
	 * https://github.com/webai-at-home/webai-at-home/issues/158. `--no-automatic-reconnection`
	 * asks for the earlier behaviour, where the first connection to close ended the program.
	 *
	 * @param options The options this worker was started with.
	 * @returns A promise that resolves once this worker has been interrupted, or, with automatic
	 * reconnection turned off, once the connection has closed.
	 */
	private static async connect(options: WorkerOptions): Promise<void> {
		// Read before the connection opens, so a key file this program cannot read stops the worker with
		// that as the reason, rather than half-way through the conversation with the gateway.
		const accountKeyPair = await AccountKeyFile.readIfPresent(AccountKeyFile.pathInConfigDir(options.config_dir));
		const openaiApiClient = new OpenaiApiClient(options.baseUrl.replace(/\/+$/, ''));
		const gatewayUrl = Cli.resolveGatewayUrl(options.url);
		/**
		 * Ends this program, once there is a promise to resolve.
		 *
		 * The supervisor's callbacks are built before the promise that waits for them exists, so
		 * this is filled in below rather than being known here.
		 */
		let stop: (() => void) | undefined;
		const supervisor = new GatewayConnectionSupervisor(
			{
				gatewayUrl,
				isAutomaticReconnectionEnabled: options.automaticReconnection,
			},
			{
				name: options.worker_name,
				authenticationToken: Cli.resolveAuthToken(options.authToken),
				requestedStageNames: options.stageNames ?? [],
				openaiApiClient,
				modelId: options.model,
				accountKeyPair,
			},
			{
				onMessage: (direction, message) => {
					Cli.print(`${direction === 'sent' ? '→' : '←'} ${message.type}`);
				},
				onRegistered: (deviceId, stageNames) => {
					Cli.print(`registered as ${options.worker_name}, device ${deviceId}, offering ${stageNames.join(', ')}`);
				},
				onNotice: (text) => {
					Cli.print(text);
				},
				onFailure: (text) => {
					Cli.print(`failure: ${text}`);
				},
				onAccountSettled: (accountId) => {
					Cli.print(accountId === undefined
						? 'running with no account of its own, so the stages it completes are recorded against the shared development account'
						: `earning credits for ${accountId}`);
				},
				onAccountNote: (note) => {
					Cli.print(note);
				},
				onConnectionChange: (isConnected) => {
					Cli.print(isConnected ? `connected to ${gatewayUrl}` : 'disconnected');
					// Without automatic reconnection this program ends when its one connection
					// closes, which is what it did before it learned to connect again.
					if (isConnected === false && options.automaticReconnection === false) {
						stop?.();
					}
				},
			},
		);
		return await new Promise<void>((resolve) => {
			stop = (): void => {
				supervisor.stop();
				resolve();
			};
			// Ctrl-C is the way out of a worker that is meant to be left running for hours, so it
			// has to reach the supervisor: without this the process would keep waiting for the
			// gateway to come back after the person running it had already asked it to stop.
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
			supervisor.start();
		});
	}

	/**
	 * Chooses the central gateway WebSocket URL to connect to.
	 *
	 * @param fromCommandLine The URL given on the command line, if one was given.
	 * @returns The URL to connect to.
	 */
	private static resolveGatewayUrl(fromCommandLine: string | undefined): string {
		if (fromCommandLine !== undefined && fromCommandLine !== '') {
			return fromCommandLine;
		}
		const fromEnvironment = process.env.GATEWAY_WS_URL;
		if (fromEnvironment !== undefined && fromEnvironment !== '') {
			return fromEnvironment;
		}
		return defaultGatewayUrl;
	}

	/**
	 * Chooses the bearer token to present to the central gateway.
	 *
	 * @param fromCommandLine The token given on the command line, if one was given.
	 * @returns The token to present.
	 */
	private static resolveAuthToken(fromCommandLine: string | undefined): string {
		if (fromCommandLine !== undefined && fromCommandLine !== '') {
			return fromCommandLine;
		}
		const fromEnvironment = process.env.GATEWAY_AUTH_TOKEN;
		if (fromEnvironment !== undefined && fromEnvironment !== '') {
			return fromEnvironment;
		}
		return defaultAuthenticationToken;
	}

	/**
	 * Writes one line of output, stamped with the time it was written.
	 *
	 * @param text What to write.
	 */
	private static print(text: string): void {
		process.stdout.write(`${new Date().toISOString()} ${text}\n`);
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
}

if (Cli.isMainModule()) {
	await Cli.run();
}
