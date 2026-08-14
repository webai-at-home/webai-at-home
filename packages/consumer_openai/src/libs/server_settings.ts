import { Command } from 'commander';
import Os from 'node:os';
import Path from 'node:path';
import { AccountKeyFile } from '@webai/protocol/account_key_file';
import { WebaiHomeDirectory } from '@webai/protocol/webai_home_directory';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ServerSettings — this server's command line options, read once and typed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where this server defaults to reading its configuration directory, which holds its own account key
 * pair in `default.account_key.json`.
 *
 * This is `consumer_openai`'s own identity on this machine, kept separate from `consumer_cli`'s in
 * `~/.webai-at-home/consumer_cli_config/` and `worker_openai`'s in
 * `~/.webai-at-home/worker_openai_config/`, so every task this server submits lands on one
 * consistent account without `--config_dir` being passed by hand.
 *
 * Kept under the user's home directory rather than this package's own folder, because
 * `consumer_openai` installed and run through `npx` has no writable folder of its own to keep an
 * account key pair in between runs — that folder is a cache directory `npx` may clear. See
 * issue #170.
 */
const defaultConfigDir = Path.join(Os.homedir(), '.webai-at-home', 'consumer_openai_config');

/** The default central gateway WebSocket URL, the hosted gateway this project runs. */
const defaultGatewayUrl = 'wss://webai-gateway.dash-menu.com/';

/** The command line options exactly as they arrive, before they are converted. */
type RawOptions = {
	port: string;
	gatewayUrl?: string;
	authToken?: string;
	apiKey?: string;
	consumer_name: string;
	config_dir: string;
	logDir: string;
	requestTimeoutMs: string;
	connectionWaitMs: string;
	maxTasksInFlight: string;
	commitSha: string;
};

/**
 * Reads this server's command line options and presents them as the values the rest of the
 * server uses.
 *
 * Every option arrives as text and is converted in one place here, so that no other part of
 * the server repeats the conversion or has to remember which options are numbers. This
 * follows `GatewaySettings` in `packages/gateway/src/libs/gateway_settings.ts`.
 */
export class ServerSettings {
	/** The port this server listens on for OpenAI-compatible requests. */
	readonly port: number;
	/** The WebSocket address of the central gateway to submit tasks to. */
	readonly gatewayUrl: string;
	/** The bearer token the central gateway requires from this server. */
	readonly authToken: string;
	/** The key a request must present to this server. Absent means no key is required. */
	readonly apiKey: string | undefined;
	/** The consumer name this server registers under with the central gateway. */
	readonly name: string;
	/**
	 * Where this server's own account key pair is kept, as `default.account_key.json` inside the
	 * configuration directory.
	 *
	 * One deployment of this server is one account. A directory with no key pair in it means this
	 * server runs with no account, and the stages its tasks run are recorded against the shared
	 * development account.
	 */
	readonly accountKeyFile: string;
	/** The directory this server writes its message log and its transaction log into. */
	readonly logsDirectory: string;
	/** How long one task may run before it is cancelled and the request is given up on. */
	readonly requestTimeoutMs: number;
	/** How long a request waits for a registered gateway connection before it is refused. */
	readonly connectionWaitMs: number;
	/** How many cluster tasks this server will have in flight at once. */
	readonly maximumTasksInFlight: number;
	/** The git commit this build was made from, published on the `/health` route. */
	readonly commitSha: string;

	/**
	 * @param argv The command line arguments. Defaults to this process's own.
	 * @param programName The name to print in the usage line and in every error message. Defaults
	 * to `consumer_openai server`, which is what this command is called when this program is run
	 * on its own. Without a name commander prints `Usage: program [options]`, which names nothing
	 * a person ever typed. See issue #171.
	 */
	constructor(argv?: string[], programName = 'consumer_openai server') {
		const command = new Command(programName)
			.option('-p, --port <number>', 'Port to serve OpenAI-compatible requests on', '8788')
			.option(
				'-u, --gateway-url <url>',
				'central gateway WebSocket URL (falls back to the GATEWAY_WS_URL environment'
					+ ` variable, then to ${defaultGatewayUrl})`,
			)
			// `-a`, matching `consumer_cli` and `worker_openai`. It was `-t` until issue #171,
			// where `-t` meant `--task_type` in `consumer_cli submit` and the bearer token here,
			// so one letter meant two unrelated things depending on which command was being run.
			.option(
				'-a, --auth-token <token>',
				'bearer token the central gateway requires (falls back to the GATEWAY_AUTH_TOKEN'
					+ ' environment variable, then to a development default)',
			)
			// No short letter, deliberately. This is the key a caller presents *to this server*,
			// while `worker_openai`'s `-k, --openai-api-key` is the key that program presents *to
			// the local model server*. One letter cannot mean both directions, so `-k` is left to
			// mean "a key we present" in the one place it already did. See issue #171.
			.option('--api-key <key>', 'Key a request must present to this server. Omit to require none')
			.option('-n, --consumer_name <name>', 'Consumer name to register under with the central gateway', 'consumer_openai server')
			.option('-c, --config_dir <path>', 'The directory holding this server\'s own account key pair, as default.account_key.json, so the stages its tasks run are recorded against that account. A directory with no key pair in it means no account', defaultConfigDir)
			// Written under the home directory, never into the directory this server was started
			// from, which is where they landed until issue #171 — `npx webai-at-home serve` left a
			// `logs` folder wherever the person was standing. The gateway's `--log-dir` is the same
			// option for the same reason.
			.option('--log-dir <path>', 'Directory this server writes its logs into', WebaiHomeDirectory.logsForProgram('consumer_openai'))
			.option('--request-timeout-ms <number>', 'How long one task may run before it is cancelled', '600000')
			.option(
				'--connection-wait-ms <number>',
				'How long a request waits for a registered gateway connection before it is refused',
				'5000',
			)
			// The central gateway's own --max-tasks-per-principal defaults to 20, and it refuses a
			// submission beyond that, so this server holds no more than that in flight either and
			// answers the caller itself rather than passing on a refusal it could have foreseen.
			.option('--max-tasks-in-flight <number>', 'How many cluster tasks to have in flight at once', '20')
			.option('--commit-sha <sha>', 'Git commit this build was made from', 'unknown');
		const options = (
			argv === undefined
				? command.parse()
				: command.parse(argv, {
						from: 'user',
					})
		).opts<RawOptions>();

		this.port = Number(options.port);
		this.gatewayUrl = ServerSettings._resolve(options.gatewayUrl, 'GATEWAY_WS_URL', defaultGatewayUrl);
		this.authToken = ServerSettings._resolve(options.authToken, 'GATEWAY_AUTH_TOKEN', 'development-token');
		this.apiKey = options.apiKey;
		this.name = options.consumer_name;
		this.accountKeyFile = AccountKeyFile.pathInConfigDir(options.config_dir);
		this.logsDirectory = options.logDir;
		this.requestTimeoutMs = Number(options.requestTimeoutMs);
		this.connectionWaitMs = Number(options.connectionWaitMs);
		this.maximumTasksInFlight = Number(options.maxTasksInFlight);
		this.commitSha = options.commitSha;
	}

	/**
	 * Chooses one setting's value in the three-step order `docs/environment_variables.md` states:
	 * the command line option, then the environment variable, then the built-in default.
	 *
	 * This server read no environment variable at all until issue #171, so exporting
	 * `GATEWAY_WS_URL` and `GATEWAY_AUTH_TOKEN` pointed `consumer_cli` and `worker_openai` on a
	 * machine at one gateway and silently did nothing to this server on that same machine.
	 *
	 * @param fromCommandLine The value given on the command line, if one was given.
	 * @param variableName The environment variable to read when no option was given.
	 * @param fallback What to use when neither the option nor the variable says anything.
	 * @returns The value to use.
	 */
	private static _resolve(fromCommandLine: string | undefined, variableName: string, fallback: string): string {
		if (fromCommandLine !== undefined && fromCommandLine !== '') {
			return fromCommandLine;
		}
		const fromEnvironment = process.env[variableName];
		if (fromEnvironment !== undefined && fromEnvironment !== '') {
			return fromEnvironment;
		}
		return fallback;
	}
}
