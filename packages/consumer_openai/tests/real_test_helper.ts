import ChildProcess from 'node:child_process';
import Net from 'node:net';
import Path from 'node:path';

import Puppeteer from 'puppeteer';
import type { Browser, Page } from 'puppeteer';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	RealTestHelper — starts and stops the real gateway/worker/browser cluster real tests need
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The worker cluster fields this helper reads out of `consumer_cli status --format json`. */
type WorkerStatusSnapshot = {
	/** How many workers the cluster currently has. */
	workerCount: number;
	/** How many of those workers report themselves ready. */
	readyCount: number;
};

/** The exit code and output collected from running one command to completion. */
type CompletionResult = {
	/** The process's exit code, or `null` if it was killed by a signal. */
	code: number | null;
	/** Everything the process wrote to standard output. */
	stdout: string;
	/** Everything the process wrote to standard error. */
	stderr: string;
};

const __dirname = import.meta.dirname;

const repositoryDirectory = Path.resolve(__dirname, '../../..');

// Reused, rather than a fresh temporary profile per run, so a worker tab's downloaded model
// shards stay cached in its IndexedDB storage across test runs instead of being re-downloaded
// from Hugging Face every time. Left out of version control by tests/.gitignore.
const puppeteerUserDataDirectory = Path.resolve(__dirname, '.puppeteer_user_data');

/**
 * Starts the central gateway, the worker web page, the OpenAI-compatible server, and a headless Chrome
 * browser with the ready worker tabs a given debug page sets up, then tears them all down again.
 */
export class RealTestHelper {
	/** The base URL the central gateway answers HTTP requests on. */
	readonly gatewayUrl = 'http://localhost:8787';
	/** The base URL the worker web page answers on. */
	readonly workerUrl = 'http://127.0.0.1:8789';
	/** The base URL this package's own OpenAI-compatible server answers on. */
	readonly openaiUrl = 'http://localhost:8788';
	/** The gateway's debug page that sets up the worker browser tabs this helper waits for. */
	readonly debugUrl: string;

	/** How long `_waitFor` polls before giving up. */
	private readonly waitTimeoutMs: number;
	/** How long `_waitFor` sleeps between polling attempts. */
	private readonly pollIntervalMs = 250;
	/** How many ready workers `setup` waits for before returning, matching the debug page's own tab count. */
	private readonly expectedWorkerCount: number;

	/** Every long-running process this helper has started and not yet stopped. */
	private readonly children = new Set<ChildProcess.ChildProcess>();
	/** The Chrome browser Puppeteer launched, once `setup` has started it. */
	private browser: Browser | undefined;
	/** Whether `setup` launches Chrome headless (`true`) or as a visible window (`false`). */
	private readonly headless: boolean;
	/** How many milliseconds Puppeteer delays each browser operation by, to make a run easier to watch. */
	private readonly slowMoMs: number;
	/** Whether `setup` opens Chrome DevTools for the debug page, useful for inspecting a failure live. */
	private readonly devtools: boolean;
	/** A hook `setup` awaits right after opening the debug page, before waiting for workers to be ready. */
	private readonly onDebugPageOpen: ((page: Page) => Promise<void>) | undefined;
	/**
	 * The command line arguments of a worker process to start instead of a browser, when the task under test
	 * is carried out by a worker that is not a browser tab. Left undefined for every browser-worker test.
	 */
	private readonly nativeWorkerArgs: string[] | undefined;
	/** The signal handler `setup` registers so a Ctrl-C still tears down the started processes and browser. */
	private readonly signalHandler: () => void;

	/** Whether `teardown` has already run, so the signal handler does not run it a second time. */
	private tornDown = false;
	/** Why the last `consumer_cli status` command failed, or `undefined` while none of them has failed. */
	private lastWorkerStatusFailure: string | undefined;

	/**
	 * @param options - construction options
	 * @param options.debugPath - the gateway debug page path that sets up the worker browser tabs a test needs,
	 * for example `/debug_iframe_dev_formula` (the default) or `/debug_iframe_llm_qwen3_0_6b_sharded`
	 * @param options.expectedWorkerCount - how many ready worker tabs `setup` waits for, matching the debug
	 * page's own tab count (`2` by default, for `/debug_iframe_dev_formula`)
	 * @param options.waitTimeoutMs - how long `_waitFor` polls before giving up (`30_000` milliseconds by
	 * default), raised for debug pages whose worker tabs must download a large model before reporting ready
	 * @param options.headless - whether `setup` launches Chrome headless (`true`, the default) or as a visible
	 * window (`false`), useful for watching a test run locally
	 * @param options.slowMoMs - how many milliseconds Puppeteer delays each browser operation by (`0` by default),
	 * useful for slowing a visible run down to something a person can follow
	 * @param options.devtools - whether `setup` opens Chrome DevTools for the debug page (`false` by default),
	 * useful for inspecting network requests and console errors live; forces a visible window regardless of
	 * `headless`
	 * @param options.onDebugPageOpen - a hook `setup` awaits right after opening the debug page and before
	 * waiting for workers to be ready, for a debug page whose worker tab needs a step only a person would
	 * otherwise do, such as clicking a button that starts a download
	 * @param options.nativeWorkerArgs - the command line arguments of a worker process to start instead of a
	 * browser, for a task whose worker is not a browser tab, such as `@webai/worker-openai`. Giving this
	 * means no browser is launched, no debug page is opened, and the worker web page is not started at all,
	 * because none of the three has anything to do with such a worker
	 */
	constructor(options: {
		debugPath?: string;
		expectedWorkerCount?: number;
		waitTimeoutMs?: number;
		headless?: boolean;
		slowMoMs?: number;
		devtools?: boolean;
		onDebugPageOpen?: (page: Page) => Promise<void>;
		nativeWorkerArgs?: string[];
	} = {}) {
		this.debugUrl = `${this.gatewayUrl}${options.debugPath ?? '/debug_iframe_dev_formula'}`;
		this.expectedWorkerCount = options.expectedWorkerCount ?? 2;
		this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
		this.headless = options.headless ?? true;
		this.slowMoMs = options.slowMoMs ?? 0;
		this.devtools = options.devtools ?? false;
		this.onDebugPageOpen = options.onDebugPageOpen;
		this.nativeWorkerArgs = options.nativeWorkerArgs;
		this.signalHandler = () => {
			this.teardown().finally(() => process.exit(1));
		};
	}

	/**
	 * Builds the protocol and consumer CLI packages, starts the gateway and the OpenAI-compatible
	 * server, brings up the workers the test needs — a headless browser on a debug page, or a worker
	 * process for a task whose worker is not a browser tab — and waits for them to report ready.
	 */
	async setup(): Promise<void> {
		// Registered before anything is started so a Ctrl-C during setup still tears down whatever
		// processes and browser have been created so far, instead of leaking them.
		process.on('SIGINT', this.signalHandler);
		process.on('SIGTERM', this.signalHandler);

		// A worker that is not a browser tab needs no browser, no debug page, and no worker web
		// page: it is a process this helper starts directly.
		const usesBrowserWorker = this.nativeWorkerArgs === undefined;

		// Fail fast on a port conflict, before spending time on the build below.
		await this._assertPortAvailable(8787);
		await this._assertPortAvailable(8788);
		if (usesBrowserWorker) {
			await this._assertPortAvailable(8789);
		}

		const build = await this._runToCompletion('npm', [
			'run', 'build',
			'--workspace', '@webai/protocol',
			'--workspace', '@webai/consumer-cli',
		]);
		if (build.code !== 0) {
			throw new Error(`Building @webai/protocol and @webai/consumer-cli failed:\n${build.stderr}`);
		}

		// Started without awaiting each one, so they come up concurrently; readiness is
		// confirmed afterward by polling their health endpoints below.
		this._start('node', ['--import', 'tsx', 'packages/gateway/src/cli.ts']);
		if (usesBrowserWorker) {
			this._start('npm', [
				'run', 'dev',
				'--workspace', '@webai/worker-webpage',
				'--', '--host', '127.0.0.1', '--port', '8789',
			]);
		}
		// `--gateway-url` is passed rather than left to its default, because that default is the
		// hosted gateway, and this test drives the gateway it starts on localhost above.
		this._start('node', [
			'--import', 'tsx', 'packages/consumer_openai/src/cli.ts', 'server',
			'--gateway-url', 'ws://localhost:8787',
		]);
		await this._waitFor('the central gateway to answer', () => this._httpReady(`${this.gatewayUrl}/health`));
		if (usesBrowserWorker) {
			await this._waitFor('the worker web page to answer', () => this._httpReady(this.workerUrl));
		}
		await this._waitFor('the OpenAI-compatible server to answer', () => this._httpReady(`${this.openaiUrl}/health`));

		if (usesBrowserWorker === false) {
			// The worker is started only once the gateway is answering, because it asks the gateway
			// for the loaded pipelines before it registers, and it exits rather than retrying when
			// there is nothing to connect to.
			this._start('node', this.nativeWorkerArgs ?? []);
		} else {
			this.browser = await Puppeteer.launch({
				channel: 'chrome',
				headless: this.headless,
				devtools: this.devtools,
				slowMo: this.slowMoMs,
				defaultViewport: null,
				args: ['--window-size=800,600'],
				userDataDir: puppeteerUserDataDirectory,
			});
			const page = await this.browser.newPage();
			// The gateway's debug page opens its worker tabs itself.
			await page.goto(this.debugUrl);
			await this.onDebugPageOpen?.(page);
		}

		try {
			await this._waitFor(`${this.expectedWorkerCount} ready worker(s)`, async () => {
				const status = await this._workerStatus();
				return status !== false
					&& status.workerCount === this.expectedWorkerCount
					&& status.readyCount === this.expectedWorkerCount
					? status
					: false;
			});
		} catch (error: unknown) {
			// The wait polls `consumer_cli status`, so a status command that can never succeed times out
			// exactly like a worker that never becomes ready. The last failure is added to the timeout so
			// the two cases can be told apart.
			if (this.lastWorkerStatusFailure !== undefined) {
				throw new Error(`${String(error)}\nThe last worker status probe failed:\n${this.lastWorkerStatusFailure}`);
			}
			throw error;
		}

		// Extra settling time after the workers report ready. The exact reason is undocumented;
		// it was added alongside the switch to launching Chrome through Puppeteer.
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}

	/** Stops every process this helper started and closes the Puppeteer browser. */
	async teardown(): Promise<void> {
		// Guards against running twice: a test's own cleanup and the SIGINT/SIGTERM handler can
		// both call teardown for the same run.
		if (this.tornDown) {
			return;
		}
		this.tornDown = true;
		process.off('SIGINT', this.signalHandler);
		process.off('SIGTERM', this.signalHandler);

		for (const childProcess of this.children) {
			this._stop(childProcess);
		}
		await this.browser?.close();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one command to completion and reports its exit code and output.
	 * @param commandName - the executable to run
	 * @param args - the arguments to pass to the executable
	 * @returns the exit code, stdout, and stderr collected while the command ran
	 */
	private _runToCompletion(commandName: string, args: string[]): Promise<CompletionResult> {
		return new Promise((resolve, reject) => {
			const childProcess = ChildProcess.spawn(commandName, args, {
				cwd: repositoryDirectory,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			childProcess.stdout?.on('data', (chunk: Buffer) => { stdout += chunk; });
			childProcess.stderr?.on('data', (chunk: Buffer) => { stderr += chunk; });
			childProcess.once('error', reject);
			childProcess.once('exit', (code) => resolve({
				code,
				stdout,
				stderr,
			}));
		});
	}

	/**
	 * Starts a long-running process (a server or the browser), left running until `_stop` is called.
	 * @param commandName - the executable to run
	 * @param args - the arguments to pass to the executable
	 * @returns the started child process
	 */
	private _start(commandName: string, args: string[]): ChildProcess.ChildProcess {
		const childProcess = ChildProcess.spawn(commandName, args, {
			cwd: repositoryDirectory,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true,
		});
		this.children.add(childProcess);
		childProcess.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[${commandName}] ${chunk}`));
		childProcess.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[${commandName}] ${chunk}`));
		childProcess.once('exit', () => this.children.delete(childProcess));
		return childProcess;
	}

	/**
	 * Stops one process this helper started, by sending SIGTERM to its whole process group.
	 * @param childProcess - the process to stop, or `undefined` if none was started
	 */
	private _stop(childProcess: ChildProcess.ChildProcess | undefined): void {
		if (
			childProcess === undefined
			|| childProcess.pid === undefined
			|| childProcess.exitCode !== null
			|| childProcess.signalCode !== null
		) {
			return;
		}
		try {
			process.kill(-childProcess.pid, 'SIGTERM');
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
				throw error;
			}
		}
	}

	/**
	 * Polls `predicate` until it returns something other than `false`, or throws once `waitTimeoutMs` passes.
	 * @param description - what is being waited for, used in the timeout error message
	 * @param predicate - the check to poll; returns `false` while not yet satisfied, or the resolved value once it is
	 * @returns the value `predicate` resolved to once it stopped returning `false`
	 */
	private async _waitFor<T>(description: string, predicate: () => Promise<T | false>): Promise<T> {
		const deadline = Date.now() + this.waitTimeoutMs;
		let lastValue: T | false = false;
		while (Date.now() < deadline) {
			lastValue = await predicate();
			if (lastValue !== false) {
				return lastValue;
			}
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
		throw new Error(`Timed out waiting for ${description}`);
	}

	/**
	 * Reports whether an HTTP server is answering at `url`.
	 * @param url - the URL to probe
	 * @returns `true` if the server answered with an ok response, `false` otherwise
	 */
	private async _httpReady(url: string): Promise<boolean> {
		try {
			const response = await fetch(url);
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Throws if something is already listening on `port`, so this helper fails fast instead of talking to a stray process.
	 * @param port - the port to check
	 */
	private async _assertPortAvailable(port: number): Promise<void> {
		const occupied = await new Promise<boolean>((resolve) => {
			const socket = Net.createConnection({
				host: '127.0.0.1',
				port,
			});
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => resolve(false));
		});
		if (occupied) {
			throw new Error(`Port ${port} is already in use; stop the existing process before running this test`);
		}
	}

	/**
	 * Reads the worker cluster state from `consumer_cli status`, the same probe README.md's real test used.
	 * A failed status command is reported through `lastWorkerStatusFailure` and printed the first time it
	 * happens, so a command that can never succeed — a renamed option, a missing file — names itself instead
	 * of looking like a worker that is merely slow to become ready.
	 * @returns the worker cluster snapshot, or `false` if the status command failed
	 */
	private async _workerStatus(): Promise<WorkerStatusSnapshot | false> {
		const result = await this._runToCompletion('node', [
			'--import', 'tsx', 'packages/consumer_cli/src/cli.ts',
			'--gateway-url', 'ws://localhost:8787',
			'status', '--format', 'json',
		]);
		if (result.code !== 0) {
			this._recordWorkerStatusFailure(`exit code ${result.code}`, result.stdout, result.stderr);
			return false;
		}
		try {
			return JSON.parse(result.stdout) as WorkerStatusSnapshot;
		} catch (error: unknown) {
			this._recordWorkerStatusFailure(`unreadable JSON output (${String(error)})`, result.stdout, result.stderr);
			return false;
		}
	}

	/**
	 * Remembers why the last `consumer_cli status` command failed, and prints that reason the first time,
	 * rather than polling in silence until the timeout.
	 * @param reason - a short description of how the command failed
	 * @param stdout - everything the command wrote to standard output
	 * @param stderr - everything the command wrote to standard error
	 */
	private _recordWorkerStatusFailure(reason: string, stdout: string, stderr: string): void {
		const failure = [
			`\`consumer_cli status\` failed with ${reason}`,
			`stdout: ${stdout.trim() === '' ? '(empty)' : stdout.trim()}`,
			`stderr: ${stderr.trim() === '' ? '(empty)' : stderr.trim()}`,
		].join('\n');
		if (this.lastWorkerStatusFailure === undefined) {
			process.stderr.write(`[consumer_cli status] ${failure}\n`);
		}
		this.lastWorkerStatusFailure = failure;
	}
}
