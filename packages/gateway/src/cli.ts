// node imports
import Fs from 'node:fs';
import type Http from 'node:http';
import Path from 'node:path';
import Url from 'node:url';

// npm imports
import Express from 'express';
import { WebSocketServer } from 'ws';
import { MessageLogger } from '@webai/protocol/message_logger';

// local imports
import { AccountMessageHandler } from './accounting/account_message_handler.js';
import { AccountingQueryHandler } from './accounting/accounting_query_handler.js';
import { AccountingRecorder } from './accounting/accounting_recorder.js';
import { AccountingSummaryHandler } from './accounting/accounting_summary_handler.js';
import { AccountRegistry } from './accounting/account_registry.js';
import { ChallengeRegistry } from './accounting/challenge_registry.js';
import { LedgerStore } from './accounting/ledger_store.js';
import { ClientMessageHandler } from './task/client_message_handler.js';
import { ConnectionHub } from './connection/connection_hub.js';
import { DeviceAnnouncer } from './device/device_announcer.js';
import { DeviceRegistry } from './device/device_registry.js';
import { DiagnosticsRateLimiter } from './libs/diagnostics_rate_limiter.js';
import { GatewaySettings } from './libs/gateway_settings.js';
import { HttpRoutes, type PageDevServer } from './connection/http_routes.js';
import { PipelineRegistry, builtinPipelineSpecifications } from './task/pipeline_registry.js';
import { SessionRegistry } from './task/session_registry.js';
import { StagePolicyResolver } from './task/stage_policy_resolver.js';
import { TaskScheduler } from './task/task_scheduler.js';
import { TaskStore } from './task/task_store.js';
import { WebsocketHeartbeat } from './connection/websocket_heartbeat.js';
import { WebsocketRouter } from './connection/websocket_router.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cli — the central gateway command line program: builds every part and starts serving
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds every part of the central gateway and starts serving.
 *
 * Each part is constructed here and handed only the parts it actually needs, so what depends
 * on what is visible in one place. Nothing but this file knows the whole assembly.
 */
export class Cli {
	/** The open connections, kept so every one of them can be closed on shutdown. */
	private static hub: ConnectionHub | undefined;
	/** The running HTTP server, which the WebSocket server shares. */
	private static httpServer: Http.Server | undefined;
	private static websocketServer: WebSocketServer | undefined;
	/** Pings every open connection, so a reverse proxy's own idle timeout does not close it. */
	private static websocketHeartbeat: WebsocketHeartbeat | undefined;
	/** The repeating sweep that retries expired leases and places queued tasks. */
	private static recoveryTimer: NodeJS.Timeout | undefined;
	/** The announcer, whose pending activity message is cancelled on shutdown. */
	private static announcer: DeviceAnnouncer | undefined;
	/** The Vite development server, when the gateway is not in production. */
	private static pageDevServer: PageDevServer | undefined;

	/** Builds the gateway and starts listening. */
	static async run(): Promise<void> {
		const settings = new GatewaySettings();

		const deviceRegistry = new DeviceRegistry();
		const taskStore = new TaskStore(undefined, settings.submissionTimeoutMs, settings.leaseMs, settings.stateFile);
		const sessionRegistry = new SessionRegistry(settings.sessionMs);
		const accountRegistry = new AccountRegistry(settings.accountFile);
		const challengeRegistry = new ChallengeRegistry(settings.accountChallengeMs);
		// Built here so the ledger file is opened, checked, and its balances rebuilt before the gateway
		// accepts a single connection.
		const ledgerStore = new LedgerStore(settings.ledgerFile);
		console.log(`Accounting ledger at ${settings.ledgerFile}, holding ${ledgerStore.summaries().length} account(s)`);

		const pipelineRegistry = new PipelineRegistry(builtinPipelineSpecifications);
		if (settings.pipelineFile !== undefined) {
			const additions = JSON.parse(Fs.readFileSync(settings.pipelineFile, 'utf8')) as unknown[];
			for (const specification of additions) pipelineRegistry.add(specification);
		}
		const stagePolicyResolver = new StagePolicyResolver(pipelineRegistry, settings.leaseMs);

		/**
		 * Caps how many diagnostic entries each worker may report, so that reporting cannot grow
		 * without bound now that it has its own transport.
		 */
		const diagnosticsRateLimiter = new DiagnosticsRateLimiter();

		// Logs this gateway's own message traffic (one file per run), plus one log file per
		// connected worker, relayed to us since a browser page cannot write files itself.
		const logsDirectory = Path.join(Path.dirname(Url.fileURLToPath(import.meta.url)), '../logs');
		const runTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const gatewayMessageLogger = new MessageLogger(Path.join(logsDirectory, `gateway-${runTimestamp}.log_entry.jsonl`));

		const hub = new ConnectionHub(deviceRegistry, gatewayMessageLogger, logsDirectory);
		const announcer = new DeviceAnnouncer(deviceRegistry, hub, settings.deviceActivityCoalesceMs);
		const scheduler = new TaskScheduler(taskStore, deviceRegistry, stagePolicyResolver, hub, announcer, settings.maximumAttempts);
		const accountMessageHandler = new AccountMessageHandler(hub, accountRegistry, challengeRegistry, sessionRegistry);
		const accountingRecorder = new AccountingRecorder(ledgerStore, sessionRegistry);
		const accountingQueryHandler = new AccountingQueryHandler(hub, accountRegistry, ledgerStore, sessionRegistry);
		const accountingSummaryHandler = new AccountingSummaryHandler(hub, accountRegistry, ledgerStore);
		const messageHandler = new ClientMessageHandler(
			hub,
			deviceRegistry,
			taskStore,
			pipelineRegistry,
			sessionRegistry,
			stagePolicyResolver,
			scheduler,
			announcer,
			settings.authToken,
			settings.maximumTasksPerPrincipal,
			accountMessageHandler,
			accountingRecorder,
			accountingQueryHandler,
			accountingSummaryHandler,
		);
		const websocketRouter = new WebsocketRouter(
			hub,
			messageHandler,
			scheduler,
			announcer,
			deviceRegistry,
			sessionRegistry,
			diagnosticsRateLimiter,
			gatewayMessageLogger,
			challengeRegistry,
		);

		const isProduction = process.env.NODE_ENV === 'production';
		// The configuration file is named rather than left to Vite to discover, because Vite looks
		// for it in the root directory it is given — `web` — and this package keeps it one level
		// above that, next to `package.json`. Without naming it, a page would be served in
		// development without the `define` values the production build bakes in, and every page
		// script that reads one would fail with a ReferenceError. See issue #159.
		const pageDevServer: PageDevServer | undefined = isProduction
			? undefined
			: await (await import('vite')).createServer({
				configFile: Path.join(Path.dirname(Url.fileURLToPath(import.meta.url)), '../vite.config.ts'),
				root: Path.join(Path.dirname(Url.fileURLToPath(import.meta.url)), '../web'),
				server: { middlewareMode: true },
				appType: 'custom',
			});
		const httpRoutes = new HttpRoutes(hub, announcer, sessionRegistry, diagnosticsRateLimiter, settings.authToken, pageDevServer, settings.commitSha);

		const app = Express();
		app.disable('x-powered-by');
		app.use((request, response) => httpRoutes.handleRequest(request, response));
		const httpServer = app.listen(settings.port, () => {
			console.log(`Gateway listening on http://localhost:${settings.port}`);
		});
		const websocketServer = new WebSocketServer({ server: httpServer });
		websocketServer.on('connection', (socket) => websocketRouter.acceptConnection(socket));
		const websocketHeartbeat = new WebsocketHeartbeat(websocketServer, settings.heartbeatIntervalMs);

		// A stage may declare a lease shorter than the gateway's --lease-ms default, so the sweep
		// that notices an expired lease runs at least as often as the shortest lease any registered
		// stage states. Sweeping less often than that would leave a short lease unnoticed for longer
		// than it lasts.
		const shortestStageLeaseMs = Math.min(
			settings.leaseMs,
			...pipelineRegistry.list().flatMap((specification) => specification.stages.map((stage) => stage.leaseMs ?? settings.leaseMs)),
		);
		const recoveryTimer = setInterval(() => {
			scheduler.recoverAssignments();
			scheduler.scheduleQueuedTasks();
		}, Math.max(100, Math.min(shortestStageLeaseMs, settings.submissionTimeoutMs)));

		Cli.hub = hub;
		Cli.httpServer = httpServer;
		Cli.websocketServer = websocketServer;
		Cli.websocketHeartbeat = websocketHeartbeat;
		Cli.recoveryTimer = recoveryTimer;
		Cli.announcer = announcer;
		Cli.pageDevServer = pageDevServer;

		process.on('SIGINT', () => void Cli.shutdown());
		process.on('SIGTERM', () => void Cli.shutdown());
	}

	/**
	 * Closes every open connection and server on Ctrl+C (or a container/process manager
	 * stop), so the process exits promptly instead of `tsx watch` having to force-kill it
	 * after its own timeout.
	 */
	private static async shutdown(): Promise<void> {
		console.log('\nShutting down...');
		if (Cli.hub !== undefined) for (const socket of Cli.hub.socketMap.values()) socket.close();
		Cli.websocketHeartbeat?.stop();
		Cli.websocketServer?.close();
		Cli.httpServer?.close();
		if (Cli.recoveryTimer !== undefined) clearInterval(Cli.recoveryTimer);
		Cli.announcer?.stop();
		if (Cli.pageDevServer !== undefined) await Cli.pageDevServer.close();
		process.exit(0);
	}
}

await Cli.run();
