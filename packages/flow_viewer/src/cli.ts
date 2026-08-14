import Fs from 'node:fs';
import Path from 'node:path';
import Url from 'node:url';
import type Http from 'node:http';
import ChildProcess from 'node:child_process';
import * as Commander from 'commander';
import Express from 'express';
import { LogEntryParser } from '../web/src/log_entry_parser.js';
import type { InitialUiState, LogSource, SessionPayload } from '../web/src/types.js';
import { WebaiHomeDirectory } from '@webai/protocol/webai_home_directory';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

type CliOptions = {
	logsDir: string | undefined;
	from: string | undefined;
	to: string | undefined;
	chatter: boolean;
	signaling: boolean;
	speed: string;
	autoplay: boolean;
	port: string;
	open: boolean;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the flow_viewer command line program: merges log files and serves a ready-to-watch page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Loads one or more gateway message log files, merges them into a single session
 * (each file keeping its own gateway node so multiple runs stay visually separated),
 * and serves the flow_viewer page with that session already loaded — and, by default,
 * already playing — so watching a capture takes one command line and no clicking.
 */
export class Cli {
	/**
	 * Runs the command line program.
	 *
	 * @param args The command line arguments, without the program name. Defaults to the
	 * arguments this process was started with.
	 */
	static async run(args: string[] = process.argv.slice(2)): Promise<void> {
		const command = new Commander.Command()
			.name('flow_viewer')
			.argument('[files...]', `log files to merge (defaults to every gateway-*.log_entry.jsonl file in ${WebaiHomeDirectory.logsForProgram('gateway')})`)
			.option('--logs-dir <dir>', 'directory to scan for gateway-*.log_entry.jsonl files when no files are given')
			.option('--from <datetime>', 'start of the time range to show (defaults to the earliest message loaded)')
			.option('--to <datetime>', 'end of the time range to show (defaults to the latest message loaded)')
			.option('--chatter', 'show connection chatter (deviceRegister / deviceRegistered / devices) on load', false)
			.option('--signaling', 'show peer connection signaling on load', false)
			.option('--speed <multiplier>', 'initial playback speed', '1')
			.option('--no-autoplay', 'load paused instead of playing immediately')
			.option('--port <number>', 'port to serve on (0 picks a free port)', '0')
			.option('--no-open', 'do not open a browser window automatically');
		command.parse([process.argv[0]!, process.argv[1] ?? '', ...args]);

		const options = command.opts<CliOptions>();
		const filePaths: string[] = Cli._resolveFilePaths(command.args, options.logsDir);
		if (filePaths.length === 0) {
			console.error(`No log files found. Pass one or more .log_entry.jsonl files, or run the gateway first so ${WebaiHomeDirectory.logsForProgram('gateway')} has some.`);
			process.exitCode = 1;
			return;
		}

		const sources: LogSource[] = Cli._loadSources(filePaths);
		const fullRangeMs = Cli._computeFullRangeMs(sources);
		if (fullRangeMs === undefined) {
			console.error('None of the given files contained a valid log entry.');
			process.exitCode = 1;
			return;
		}

		const initialState: InitialUiState = {
			fromMs: options.from !== undefined ? Cli._parseDatetime(options.from, '--from') : fullRangeMs.fromMs,
			toMs: options.to !== undefined ? Cli._parseDatetime(options.to, '--to') : fullRangeMs.toMs,
			showChatter: options.chatter,
			showSignaling: options.signaling,
			speed: Number(options.speed),
			autoplay: options.autoplay,
		};
		const session: SessionPayload = { sources, initialState };

		const totalMessages: number = sources.reduce((sum: number, source: LogSource): number => sum + source.entries.length, 0);
		console.log(`Loaded ${sources.length} log source(s), ${totalMessages} message(s) total:`);
		for (const source of sources) console.log(`  - ${source.label}: ${source.entries.length} message(s)`);

		const url: string = await Cli._serve(session, Number(options.port));
		console.log(`\nServing flow_viewer at ${url}`);
		if (options.open) Cli._openBrowser(url);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	private static _resolveFilePaths(explicitFiles: string[], logsDirOption: string | undefined): string[] {
		if (explicitFiles.length > 0) return explicitFiles.map((filePath: string): string => Path.resolve(process.cwd(), filePath));

		const logsDir: string =
			logsDirOption !== undefined
				? Path.resolve(process.cwd(), logsDirOption)
				// Where the gateway writes its logs, which stopped being `packages/gateway/logs` in
				// issue #171. `WebaiHomeDirectory` is the one place that says so, rather than this
				// path being spelled out again here where it would quietly go stale.
				: WebaiHomeDirectory.logsForProgram('gateway');

		if (Fs.existsSync(logsDir) === false) return [];
		return Fs.readdirSync(logsDir)
			.filter((fileName: string): boolean => /^gateway-.*\.log_entry\.jsonl$/.test(fileName))
			.sort()
			.map((fileName: string): string => Path.join(logsDir, fileName));
	}

	private static _loadSources(filePaths: string[]): LogSource[] {
		const sources: LogSource[] = [];
		for (const filePath of filePaths) {
			const text: string = Fs.readFileSync(filePath, 'utf-8');
			const { entries, lineErrors } = LogEntryParser.parseJsonl(text);
			if (entries.length === 0) continue;
			for (const lineError of lineErrors) console.warn(`${Path.basename(filePath)}: ${lineError}`);

			sources.push({
				id: Path.basename(filePath).replace(/\.log_entry\.jsonl$/, ''),
				label: Cli._labelForFile(filePath),
				entries,
			});
		}
		return sources;
	}

	private static _labelForFile(filePath: string): string {
		const fileName: string = Path.basename(filePath);
		const runMatch = /^gateway-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log_entry\.jsonl$/.exec(fileName);
		if (runMatch === null) return fileName;
		const [, year, month, day, hour, minute, second] = runMatch;
		return `Gateway (${month}/${day} ${hour}:${minute}:${second})`;
	}

	private static _computeFullRangeMs(sources: LogSource[]): { fromMs: number; toMs: number } | undefined {
		const timestamps: number[] = sources.flatMap((source: LogSource): number[] => source.entries.map((entry): number => Date.parse(entry.timestamp)));
		if (timestamps.length === 0) return undefined;
		return { fromMs: Math.min(...timestamps), toMs: Math.max(...timestamps) };
	}

	private static _parseDatetime(value: string, flagName: string): number {
		const parsedMs: number = Date.parse(value);
		if (Number.isNaN(parsedMs)) throw new Error(`${flagName} is not a valid date/time: ${value}`);
		return parsedMs;
	}

	private static async _serve(session: SessionPayload, requestedPort: number): Promise<string> {
		const webDirectory: string = Url.fileURLToPath(new URL('../web', import.meta.url));
		const viteDevServer = await (await import('vite')).createServer({
			root: webDirectory,
			server: { middlewareMode: true, hmr: false },
			appType: 'spa',
		});

		const app = Express();
		app.disable('x-powered-by');
		app.use((request, response) => {
			const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
			if (pathname === '/api/session.json') {
				response.setHeader('content-type', 'application/json');
				response.end(JSON.stringify(session));
				return;
			}
			viteDevServer.middlewares(request, response, () => {
				response.statusCode = 404;
				response.end('Not found');
			});
		});

		const httpServer: Http.Server = await new Promise<Http.Server>((resolve) => {
			const server = app.listen(requestedPort, () => resolve(server));
		});
		const address = httpServer.address();
		const port: number = typeof address === 'object' && address !== null ? address.port : requestedPort;

		process.on('SIGINT', () => {
			httpServer.close();
			void viteDevServer.close().finally(() => process.exit(0));
		});

		return `http://localhost:${port}/`;
	}

	private static _openBrowser(url: string): void {
		const openCommandByPlatform: Record<string, string> = { darwin: 'open', win32: 'start' };
		const openCommand: string = openCommandByPlatform[process.platform] ?? 'xdg-open';
		ChildProcess.spawn(openCommand, process.platform === 'win32' ? ['', url] : [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

if (process.argv[1] && Url.fileURLToPath(import.meta.url) === process.argv[1]) {
	void Cli.run();
}
