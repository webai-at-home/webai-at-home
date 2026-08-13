import { Command } from 'commander';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	GatewaySettings — the gateway's command line options, read once and typed
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The command line options exactly as they arrive, before they are converted. */
type RawOptions = {
	port: string;
	leaseMs: string;
	submissionTimeoutMs: string;
	maxAttempts: string;
	stateFile: string;
	accountFile: string;
	accountChallengeMs: string;
	ledgerFile: string;
	authToken: string;
	maxTasksPerPrincipal: string;
	sessionMs: string;
	pipelineFile?: string;
	deviceActivityCoalesceMs: string;
	commitSha: string;
	heartbeatIntervalMs: string;
	dev?: boolean;
};

/**
 * Reads the gateway's command line options and presents them as the values the rest of the
 * gateway uses.
 *
 * Every option arrives as text and is converted in one place here, so no other part of the
 * gateway repeats the conversion or has to remember which options are numbers.
 */
export class GatewaySettings {
	/** The port the HTTP and WebSocket server listens on. */
	readonly port: number;
	/** How long a stage assignment's lease lasts, unless its own stage states otherwise. */
	readonly leaseMs: number;
	/** How long a queued task may wait before it is failed. */
	readonly submissionTimeoutMs: number;
	/** How many times one stage may be assigned before the task is failed. */
	readonly maximumAttempts: number;
	/** The file durable task state is written to. Empty means state is not kept on disk. */
	readonly stateFile: string;
	/** The file account profiles are written to. Empty means accounts are not kept on disk. */
	readonly accountFile: string;
	/** How long a challenge handed out for an account to sign stays usable. */
	readonly accountChallengeMs: number;
	/** The append-only file every accounting event is written to. */
	readonly ledgerFile: string;
	/** The bearer token every connection and every diagnostics report must present. */
	readonly authToken: string;
	/** How many tasks one principal may have in flight at once. */
	readonly maximumTasksPerPrincipal: number;
	/** How long an authenticated session lasts before the client must authenticate again. */
	readonly sessionMs: number;
	/** A JSON file of additional pipeline specifications to load, when one was given. */
	readonly pipelineFile: string | undefined;
	/** How long device activity changes are batched before one combined update is sent. */
	readonly deviceActivityCoalesceMs: number;
	/** The git commit this build was made from, published on the `/health` route. */
	readonly commitSha: string;
	/** How often an open WebSocket connection is pinged to keep it alive through a reverse proxy's own idle timeout. */
	readonly heartbeatIntervalMs: number;
	/** Whether to serve the browser pages through a Vite development server instead of the already built `web/dist`. */
	readonly dev: boolean;

	/**
	 * @param argv The command line arguments. Defaults to this process's own.
	 * @param programName The name to print in the usage line and in every error message. Defaults
	 * to `gateway`, which is what this program is called when it is run on its own. Without a name
	 * commander prints `Usage: program [options]`, which names nothing a person ever typed. The
	 * `webai-at-home` program passes `webai-at-home gateway` instead. See issue #171.
	 */
	constructor(argv?: string[], programName = 'gateway') {
		const command = new Command(programName)
			.option('-p, --port <number>', 'HTTP and WebSocket port', '8787')
			.option('--lease-ms <number>', 'Assignment lease duration', '15000')
			.option('--submission-timeout-ms <number>', 'Queued task deadline', '30000')
			.option('--max-attempts <number>', 'Maximum assignment attempts', '3')
			.option('--state-file <path>', 'Durable task state file', 'gateway-state.json')
			.option('--account-file <path>', 'Account profile file', 'gateway-accounts.json')
			.option('--account-challenge-ms <number>', 'How long a challenge handed out for an account to sign stays usable', '60000')
			.option('--ledger-file <path>', 'Append-only accounting ledger file', 'gateway-ledger.jsonl')
			.option('--auth-token <token>', 'Required bearer token for development connections', 'development-token')
			.option('--max-tasks-per-principal <number>', 'Maximum non-terminal tasks per principal', '20')
			.option('--session-ms <number>', 'How long an authenticated session lasts before the client must authenticate again', '3600000')
			.option('--pipeline-file <path>', 'JSON file containing additional pipeline specifications')
			.option('--device-activity-coalesce-ms <number>', 'How long device activity changes are batched before one combined update is sent', '250')
			.option('--commit-sha <sha>', 'Git commit this build was made from', 'unknown')
			.option('--heartbeat-interval-ms <number>', 'How often an open WebSocket connection is pinged to keep it alive through a reverse proxy', '30000')
			.option('--dev', 'serve the browser pages through a Vite development server, instead of the already built web/dist');
		const options = (argv === undefined ? command.parse() : command.parse(argv, { from: 'user' })).opts<RawOptions>();

		this.port = Number(options.port);
		this.leaseMs = Number(options.leaseMs);
		this.submissionTimeoutMs = Number(options.submissionTimeoutMs);
		this.maximumAttempts = Number(options.maxAttempts);
		this.stateFile = options.stateFile;
		this.accountFile = options.accountFile;
		this.accountChallengeMs = Number(options.accountChallengeMs);
		this.ledgerFile = options.ledgerFile;
		this.authToken = options.authToken;
		this.maximumTasksPerPrincipal = Number(options.maxTasksPerPrincipal);
		this.sessionMs = Number(options.sessionMs);
		this.pipelineFile = options.pipelineFile;
		this.deviceActivityCoalesceMs = Number(options.deviceActivityCoalesceMs);
		this.commitSha = options.commitSha;
		this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs);
		this.dev = options.dev === true;
	}
}
