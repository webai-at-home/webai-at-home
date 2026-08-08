#!/usr/bin/env node
import * as Commander from 'commander';
import Path from 'node:path';
import Url from 'node:url';
import WebSocket from 'ws';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { GatewayWorkerClient, type WorkerSocket } from './libs/gateway_worker_client.js';
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
 * This is `worker_openai`'s own identity for this checkout of the repository, kept separate from
 * `consumer_cli`'s in `data/consumer_cli_config/` and `consumer_openai`'s in
 * `data/consumer_openai_config/`, so every stage this worker completes earns credit for one
 * consistent account without `--config_dir` being passed by hand.
 *
 * Resolved from this file's own location rather than written as a bare
 * `data/worker_openai_config` string, because a relative path resolves against the process's
 * working directory, not this file's — and `npm run dev --workspace @webai/worker-openai --` and
 * `npx tsx src/cli.ts` both run with the working directory somewhere other than the repository root.
 */
const defaultConfigDir = Path.resolve(Path.dirname(Url.fileURLToPath(import.meta.url)), '../../../data/worker_openai_config');

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
			.option('-c, --config_dir <path>', 'the directory holding this worker\'s own account key pair, as default.account_key.json, so the stages it completes earn credits for that account. A directory with no key pair in it means no account', defaultConfigDir);

		program.parse(args, { from: 'user' });
		const options = program.opts<WorkerOptions>();
		await Cli.connect(options);
	}

	/**
	 * Opens the connection to the central gateway and keeps it until the connection closes.
	 *
	 * @param options The options this worker was started with.
	 * @returns A promise that resolves once the connection has closed.
	 */
	private static async connect(options: WorkerOptions): Promise<void> {
		// Read before the connection opens, so a key file this program cannot read stops the worker with
		// that as the reason, rather than half-way through the conversation with the gateway.
		const accountKeyPair = await AccountKeyFile.readIfPresent(AccountKeyFile.pathInConfigDir(options.config_dir));
		const openaiApiClient = new OpenaiApiClient(options.baseUrl.replace(/\/+$/, ''));
		const gatewayUrl = Cli.resolveGatewayUrl(options.url);
		const socket = new WebSocket(gatewayUrl) as unknown as WorkerSocket;
		return new Promise<void>((resolve) => {
			new GatewayWorkerClient(
				socket,
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
						if (isConnected === false) {
							resolve();
						}
					},
				},
			);
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
}

await Cli.run();
