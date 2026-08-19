import type { StageName, StagePayload, ClientMessage, GenerationSettings, AccountLedgerSummary } from '@webai/protocol';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import { RandomUuid } from '@webai/protocol/random_uuid';
import { StageHelperDevFormula } from './stages/stage_helper_dev_formula';
import { StageHelperLlmQwen3_0_6bSharded } from './stages/stage_helper_llm_qwen3_0_6b_sharded';
import { StageHelperLlmGemmaNanoChromeFull } from './stages/stage_helper_llm_gemma_nano_chrome_full';
import { StageHelperLlmQwen3_5_0_8bFull } from './stages/stage_helper_llm_qwen3_5_0_8b_full';
import { StageHelperLlmLlama3_2_1bFull } from './stages/stage_helper_llm_llama3_2_1b_full';
import { StageHelperLlmGemma4E2bFull } from './stages/stage_helper_llm_gemma_4_e2b_full';
import type { ModelDownloadProgress } from './stages/model_download_progress.js';
import { GatewayConfig } from './connection/gateway_config';
import { GatewayLink } from './connection/gateway_link';
import { GatewayReconnection } from './connection/gateway_reconnection';
import { LeaseHeartbeat } from './connection/lease_heartbeat';
import { DiagnosticsReporter } from './connection/diagnostics_reporter';
import { GatewayDeparture } from './connection/gateway_departure';
import { PageElements } from './page/page_elements';
import { PageMarkup } from './page/page_markup';
import { WorkerEventLog } from './page/worker_event_log';
import { WorkerStageOffer } from './connection/worker_stage_offer';
import { WorkerAccount } from './connection/worker_account';
import { ThemeToggle } from './page/theme_toggle.js';
import { HelpTooltips } from './page/help_tooltips.js';
import { AboutPanel } from './page/about_panel.js';
import { StagesConfigPanel } from './page/stages_config_panel.js';
import { AudioKeepalive, type AudioKeepaliveState } from './page/audio_keepalive.js';
import { ScreenWakeLock, type ScreenWakeLockState } from './page/screen_wake_lock.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WorkerPage — the worker browser page: connects, registers, and runs assigned stages
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** A message received from the central gateway. */
type GatewayMessage = {
	/** The message category. */
	type: string;
	deviceId?: string;
	/** The task identifier for a stage message. */
	taskId?: string;
	/** The durable identifier for the current stage assignment. */
	stageAssignmentId?: string;
	/** The number of the current assignment attempt. */
	attempt?: number;
	/** The stage for a stage message. */
	stage?: StageName;
	/** The value for a stage message: a plain number for formula stages, or an LLM payload. */
	value?: StagePayload;
	/** When the assignment lease runs out, unless the worker extends it with `stage.heartbeat`. */
	leaseUntil?: string;
	/** Which computation the assigned stage needs, such as `dev_formula_multiply` or `llm_qwen3_0_6b_shard`. */
	computation?: string;
	/** The assigned stage's position in its pipeline, counted from zero. */
	stageIndex?: number;
	/** What the consumer asked for about how its answer is generated, carried unchanged from the submission. */
	generationSettings?: GenerationSettings;
	/** The pipeline specifications the gateway has loaded, in reply to `pipelines.get`. */
	pipelines?: { stages: { name: string; computation: string }[] }[];
	/** When the authenticated session expires, in reply to `authenticate`. */
	expiresAt?: string;
	/** The account profile, in reply to `account.register`. */
	account?: { accountId: string };
	/** Whether registering created the account, in reply to `account.register`. */
	isNewAccount?: boolean;
	/** The value to sign, in reply to `account.challenge.request`. */
	challenge?: string;
	/** The account now on this connection, in reply to `account.authenticate`. */
	accountId?: string;
	/** What this account's entries add up to, in reply to `account.balance.get`. */
	summary?: AccountLedgerSummary;
	/** The stable error code, on an error. */
	code?: string;
	/** What the gateway said, on an error. */
	message?: string;
};

/** The stages this browser could offer, as the loaded pipelines describe them. */
type OfferedStages = {
	stageNames: string[];
	llmShardIndexes: number[];
	builtInModelStageNames: string[];
	qwen3_5_0_8bFullModelStageNames: string[];
	llama3_2_1bFullModelStageNames: string[];
	gemma4E2bFullModelStageNames: string[];
};

/** How often the quiet tone's own state is checked for a change worth reflecting in the page. */
const AUDIO_STATE_POLL_INTERVAL_MS = 2000;
/** How often the screen wake lock's own state is checked for a change worth reflecting in the page. */
const SCREEN_WAKE_LOCK_STATE_POLL_INTERVAL_MS = 2000;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Worker Page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Runs the worker browser page.
 *
 * The page opens one connection to the central gateway, asks which pipelines the gateway has
 * loaded, gets itself ready to run the stages it recognises, registers as a worker, and then
 * runs each stage the gateway assigns to it. It holds that connection for as long as the tab
 * is displayed, renewing its session and extending the lease of the assignment it is working
 * on so neither expires underneath it.
 */
export class WorkerPage {
	private readonly statusEl: HTMLElement;
	private readonly nameInputEl: HTMLInputElement;
	private readonly connectButtonEl: HTMLButtonElement;
	private readonly disconnectButtonEl: HTMLButtonElement;
	private readonly workerNameEl: HTMLElement;
	private readonly deviceIdEl: HTMLElement;
	/** Shows which account the credits earned by this tab are recorded against. */
	private readonly accountIdEl: HTMLElement;
	/** Shows what that account holds, so a volunteer can watch credits accumulate. */
	private readonly accountCreditsEl: HTMLElement;
	private readonly stagesEl: HTMLElement;
	/** The message shown when the language model built into the browser is not ready to run. */
	private readonly builtInModelNoticeEl: HTMLElement;
	private readonly builtInModelMessageEl: HTMLElement;
	/** The button that asks the browser to download its own language model. */
	private readonly builtInModelDownloadButtonEl: HTMLButtonElement;
	/** Holds one row per file currently downloading, each showing that file's name and how much of it has arrived. */
	private readonly modelDownloadProgressEl: HTMLElement;
	/** The button that starts the quiet tone, keeping this browser's full generation speed while its tab is hidden. */
	private readonly quietToneButtonEl: HTMLButtonElement;
	/** Shows the quiet tone's current state. */
	private readonly quietToneStateEl: HTMLElement;
	/** Shows whether this tab is running at full power, or can be throttled once hidden. */
	private readonly powerStatusEl: HTMLElement;
	/** The button that asks the system to keep the screen on while this tab is visible. */
	private readonly screenWakeLockButtonEl: HTMLButtonElement;
	/** Shows the screen wake lock's current state. */
	private readonly screenWakeLockStateEl: HTMLElement;
	/** The navigation bar button that starts or stops both the quiet tone and the screen wake lock together. */
	private readonly fullPowerButtonEl: HTMLButtonElement;
	/** The large play button shown over the whole page until the reader starts full power. */
	private readonly startOverlayEl: HTMLButtonElement;

	private readonly eventLog = new WorkerEventLog();
	/** The stages the page URL restricts this worker browser to, if it names any. */
	private readonly urlRequestedStageNames: readonly string[];

	/** The active WebSocket connection, when the worker browser is connected. */
	private socket: WebSocket | undefined;
	/** Whether this browser has completed registration on the current connection. */
	private isRegistered = false;
	/** The pending timer that authenticates again before the current session expires. */
	private sessionRenewalTimer: number | undefined;
	/**
	 * Whether the connection should be opened again as soon as the current one has closed.
	 *
	 * Which stages this browser offers is decided once per connection, just before it
	 * registers. Downloading the browser's own language model therefore only takes effect on
	 * the next connection, and this asks for one.
	 */
	private isReconnectRequested = false;
	/**
	 * Whether a connection that closes should be opened again on its own after a wait.
	 *
	 * It is `true` for as long as the volunteer wants this browser to be contributing, and it is
	 * the one thing that tells a connection the page did not ask to lose — a gateway restarted, a
	 * network interruption — apart from a connection the page or the volunteer deliberately
	 * ended. The close code cannot be used for this: a gateway that goes away produces `1006` in
	 * one situation and `1001` in another, and neither says whether coming back is wanted.
	 */
	private isAutomaticReconnectionAllowed = true;
	/** Waits, counts the wait down on the page, and asks for the next attempt. */
	private readonly gatewayReconnection: GatewayReconnection;
	/**
	 * The stages this worker browser advertises, decided once the gateway has sent its
	 * pipelines. It stays empty until then, because which stage names exist is decided by the
	 * pipelines the gateway has loaded rather than by a list built into this page.
	 */
	private enabledStageNames: string[] = [];
	/** Prevents another connection attempt while enabled LLM shards are preloading. */
	private isPreparing = false;
	/**
	 * The account conversation of the current connection, once it has started.
	 *
	 * It is built per connection, because proving which account is on a connection is something each
	 * connection does for itself: a session belongs to one connection and so does the account on it.
	 */
	private workerAccount: WorkerAccount | undefined;
	/** Every file currently downloading, keyed by its full path, mapped to how much of it has arrived. */
	private readonly downloadingFiles = new Map<string, number>();

	/** Finds every element the page is built around. */
	constructor() {
		this.statusEl = PageElements.getElement('#status');
		this.nameInputEl = PageElements.getInput('#name');
		this.connectButtonEl = PageElements.getButton('#connect');
		this.disconnectButtonEl = PageElements.getButton('#disconnect');
		this.workerNameEl = PageElements.getElement('#worker-name');
		this.deviceIdEl = PageElements.getElement('#device-id');
		this.accountIdEl = PageElements.getElement('#account-id');
		this.accountCreditsEl = PageElements.getElement('#account-credits');
		this.stagesEl = PageElements.getElement('#stages');
		this.builtInModelNoticeEl = PageElements.getElement('#built-in-model-notice');
		this.builtInModelMessageEl = PageElements.getElement('#built-in-model-message');
		this.builtInModelDownloadButtonEl = PageElements.getButton('#built-in-model-download');
		this.modelDownloadProgressEl = PageElements.getElement('#model-download-progress');
		this.quietToneButtonEl = PageElements.getButton('#quiet-tone');
		this.quietToneStateEl = PageElements.getElement('#quiet-tone-state');
		this.powerStatusEl = PageElements.getElement('#power-status');
		this.screenWakeLockButtonEl = PageElements.getButton('#screen-wake-lock');
		this.screenWakeLockStateEl = PageElements.getElement('#screen-wake-lock-state');
		this.fullPowerButtonEl = PageElements.getButton('#full-power');
		this.startOverlayEl = PageElements.getButton('#start-overlay');
		this.urlRequestedStageNames = WorkerStageOffer.requestedStageNamesFromUrl(location.search);
		this.gatewayReconnection = new GatewayReconnection({
			onWaiting: (secondsRemaining: number, attemptNumber: number): void => {
				const secondsWord = secondsRemaining === 1 ? 'second' : 'seconds';
				this.statusEl.textContent = `Reconnecting in ${String(secondsRemaining)} ${secondsWord} (attempt ${String(attemptNumber)})`;
				this.statusEl.className = 'badge rounded-pill text-bg-warning';
			},
			onAttempt: (attemptNumber: number): void => {
				// A connection lost while this browser was still downloading and loading its model
				// files leaves the preparation running, and `connectToGateway` refuses to open a
				// connection while it is. Waiting again is what keeps such a browser coming back,
				// rather than having this one refused attempt be the last one ever made.
				if (this.isPreparing) {
					this.gatewayReconnection.scheduleAttempt();
					return;
				}
				this.eventLog.add({
					direction: 'local',
					type: 'worker.reconnect_attempt',
					timestamp: new Date().toISOString(),
					message: `Opening a connection to the central gateway again, attempt ${String(attemptNumber)}`,
				});
				this.connectToGateway();
			},
		});
	}

	/** Starts the worker browser user interface and opens the first connection. */
	start(): void {
		ThemeToggle.setup();
		HelpTooltips.setup();
		AboutPanel.setup(GatewayConfig.assetUrl('/health'));
		PageElements.getAnchor('#gateway-link-nav').href = GatewayConfig.assetUrl('/home');
		StagesConfigPanel.setup();

		// Use the URL-provided name for embedded worker pages, and generate a random
		// name for standalone pages so multiple workers can still be opened safely.
		const workerNameFromUrl: string | null = new URLSearchParams(location.search).get('workerName');
		const trimmedWorkerName = workerNameFromUrl?.trim() ?? '';
		this.nameInputEl.value = trimmedWorkerName === ''
			? `worker-webpage-${RandomUuid.generate().slice(0, 8)}`
			: (workerNameFromUrl ?? '');
		this.workerNameEl.textContent = this.nameInputEl.value;
		this.renderStages();
		this.eventLog.render();

		/**
		 * Opens a WebSocket connection when the connect button is clicked.
		 *
		 * Pressing it while the page is waiting to connect again means "try now": the wait is
		 * dropped and the attempt is made at once. Pressing it after the disconnect button was
		 * pressed is what lets this browser contribute again, so it allows the automatic
		 * reconnection as well.
		 */
		this.connectButtonEl.addEventListener('click', (): void => {
			this.isAutomaticReconnectionAllowed = true;
			this.gatewayReconnection.stopAndReset();
			this.connectToGateway();
		});

		// The browser only starts downloading its own language model when the person using the page
		// asks for it, so this download cannot be started while the page is loading. Once the model
		// is there, the connection is opened again, because the stages a browser offers are decided
		// as it registers.
		this.builtInModelDownloadButtonEl.addEventListener('click', (): void => {
			this.downloadBuiltInModel();
		});

		// Starting the tone must be the first statement of this branch, not something that runs
		// after an await, or the browser may create the AudioContext already suspended and
		// silently defeat the whole trick (see AudioKeepalive.start).
		this.quietToneButtonEl.addEventListener('click', (): void => {
			if (AudioKeepalive.state() === 'stopped') {
				this.startQuietTone();
				return;
			}
			this.stopQuietTone();
		});

		// A browser without the Screen Wake Lock interface, or one whose origin is not secure,
		// cannot hold a lock at all, so the button is disabled rather than left to fail silently
		// on every click.
		if (ScreenWakeLock.state() === 'unsupported') {
			this.screenWakeLockButtonEl.disabled = true;
			this.screenWakeLockStateEl.textContent = 'Not supported by this browser';
		} else {
			this.screenWakeLockButtonEl.addEventListener('click', (): void => {
				if (ScreenWakeLock.isEnabled() === false) {
					this.startScreenWakeLock();
					return;
				}
				this.stopScreenWakeLock();
			});
		}

		/**
		 * Starts or stops both the quiet tone and the screen wake lock together, whichever of
		 * the two is not already in the state the button is asking for.
		 */
		this.fullPowerButtonEl.addEventListener('click', (): void => {
			if (AudioKeepalive.state() !== 'stopped' && ScreenWakeLock.isEnabled()) {
				this.stopQuietTone();
				if (ScreenWakeLock.isEnabled()) {
					this.stopScreenWakeLock();
				}
				return;
			}
			if (AudioKeepalive.state() === 'stopped') {
				this.startQuietTone();
			}
			if (ScreenWakeLock.isEnabled() === false && ScreenWakeLock.state() !== 'unsupported') {
				this.startScreenWakeLock();
			}
		});

		/**
		 * Starts full power the same way the full power button does, then dismisses the overlay,
		 * since starting the quiet tone and the screen wake lock both need a click of their own to
		 * satisfy the browser and cannot be done as soon as the page loads.
		 */
		this.startOverlayEl.addEventListener('click', (): void => {
			this.fullPowerButtonEl.click();
			this.startOverlayEl.classList.add('d-none');
		});

		/**
		 * Closes the WebSocket connection when the disconnect button is clicked, and keeps this
		 * browser disconnected.
		 *
		 * This is the volunteer saying they no longer want this browser to be contributing, so it
		 * also stops the page from connecting again on its own. Pressing it while the page is
		 * waiting to connect again — when there is no connection to close — is what stops that
		 * waiting.
		 */
		this.disconnectButtonEl.addEventListener('click', (): void => {
			this.isAutomaticReconnectionAllowed = false;
			this.gatewayReconnection.stopAndReset();
			if (this.socket !== undefined) {
				this.socket.close(1000, 'Disconnected by worker');
				return;
			}
			this.showDisconnectedControls();
		});

		// Leaving a page does not always destroy it. A browser tab that navigates away keeps the
		// page it left, and every connection that page holds, in its back/forward cache, so that
		// going back can restore the page instead of loading it again. The central gateway learns
		// that a worker browser has gone only when that browser's connection closes, so a worker
		// page held in the back/forward cache stayed registered: opening one debug page after
		// another in the same browser tab left the first page's workers listed and still offered
		// work (see https://github.com/webai-at-home/webai-at-home/issues/58).
		//
		// Closing the connection while the page is being put away is what makes the departure
		// visible to the gateway. The connection is not reopened here, because the page may never
		// be displayed again.
		//
		// The connection is closed and the departure is announced over HTTP, because the two cover
		// different cases. A page merely put into the back/forward cache is still alive, and its
		// close frame is written normally; a tab that is being destroyed gives the browser no
		// promise that the close frame is written at all, and only `navigator.sendBeacon` is
		// delivered then (see https://github.com/webai-at-home/webai-at-home/issues/176).
		window.addEventListener('pagehide', (): void => {
			// A page put away while it was waiting to connect again must not make that attempt: it
			// may never be displayed again, and the attempt would register a worker nobody is
			// watching. A page that is displayed again connects from the `pageshow` handler below.
			this.gatewayReconnection.stop();
			if (this.socket === undefined) {
				return;
			}
			LeaseHeartbeat.stop();
			DiagnosticsReporter.stop();
			GatewayDeparture.announce();
			this.socket.close(1000, 'Worker page is no longer displayed');
			this.socket = undefined;
			this.isRegistered = false;
		});

		// Going back displays this page again, restored from the back/forward cache with the
		// connection closed above. The page is not loaded again in that case, so nothing else
		// would reconnect it, and the restored page would sit there offering no work at all.
		window.addEventListener('pageshow', (event: PageTransitionEvent): void => {
			if (event.persisted === false) {
				return;
			}
			// A page put away while its language-model shards were still loading left this set,
			// which would refuse the reconnection below.
			this.isPreparing = false;
			this.isAutomaticReconnectionAllowed = true;
			this.gatewayReconnection.stopAndReset();
			this.connectToGateway();
		});

		// A device that lost its network — a laptop whose lid was closed, a phone that left
		// coverage — chose its wait while there was no network at all. Sitting out the rest of a
		// wait that has grown to a minute would leave the volunteer offering no work for no
		// reason, so the network coming back makes the pending attempt at once.
		window.addEventListener('online', (): void => {
			this.gatewayReconnection.attemptNow();
		});

		// Connect automatically once the page controls and event handlers are ready.
		this.connectToGateway();
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	The Connection
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Opens a connection to the central gateway and registers this browser as a worker.
	 *
	 * The connect button calls this, and so does a page restored from the back/forward cache,
	 * whose earlier connection was closed as the page was put away.
	 */
	private connectToGateway(): void {
		// Do not open a new connection if one is already open or in the process of opening.
		if (this.isPreparing || (this.socket !== undefined && this.socket.readyState !== WebSocket.CLOSED)) {
			return;
		}

		// The shards this browser preloads depend on which stages it will offer, and that is
		// decided from the pipelines the gateway sends. So the connection opens first, and the
		// preload happens once the pipelines have arrived, just before registration.
		this.socket = new WebSocket(GatewayConfig.webSocketUrl());
		/**
		 * The connection this attempt opened.
		 *
		 * A connection that is closed while the page is not being displayed can deliver its
		 * close event after the page has already opened a replacement, so every handler below
		 * checks that it is still the current connection before changing shared page state.
		 */
		const openedSocket = this.socket;
		this.isRegistered = false;

		this.statusEl.textContent = 'Connecting';
		this.statusEl.className = 'badge rounded-pill text-bg-warning';
		this.connectButtonEl.disabled = true;
		this.hideModelDownloadProgress();

		/** Authenticates the worker browser after connection. */
		this.socket.addEventListener('open', (): void => {
			this.statusEl.textContent = 'Connected';
			this.statusEl.className = 'badge rounded-pill text-bg-success';
			this.connectButtonEl.classList.add('d-none');
			this.disconnectButtonEl.classList.remove('d-none');
			this.nameInputEl.disabled = true;
			const message: ClientMessage = {
				type: 'deviceAuthenticate',
				token: GatewayConfig.authToken,
			};
			if (this.socket !== undefined) {
				GatewayLink.send(this.socket, message);
			}
			this.eventLog.add({
				direction: 'sent',
				type: message.type,
				timestamp: new Date().toISOString(),
			});
		});

		/** Handles messages received from the central gateway. */
		this.socket.addEventListener('message', (event: MessageEvent): void => {
			this.handleGatewayMessage(event);
		});

		/** Restores the disconnected state when the WebSocket closes. */
		this.socket.addEventListener('close', (): void => {
			if (this.socket !== undefined && this.socket !== openedSocket) {
				return;
			}
			LeaseHeartbeat.stop();
			// An answer being read one piece at a time stays open between runs, and only a run
			// assigned over this connection can carry it on. With the connection gone, no run can
			// arrive, so the model is stopped now rather than left producing an answer for as long
			// as this page stays open. The gateway will place the task somewhere it can be started
			// again.
			StageHelperLlmGemmaNanoChromeFull.clearEveryGeneration();
			StageHelperLlmQwen3_5_0_8bFull.clearEveryGeneration();
			StageHelperLlmLlama3_2_1bFull.clearEveryGeneration();
			StageHelperLlmGemma4E2bFull.clearEveryGeneration();
			this.isRegistered = false;
			// The account belongs to the connection that proved it, so the next connection proves it
			// again. The key pair itself stays in this browser's storage and is the same account.
			this.workerAccount = undefined;
			if (this.sessionRenewalTimer !== undefined) {
				window.clearTimeout(this.sessionRenewalTimer);
			}
			this.sessionRenewalTimer = undefined;
			// Posts whatever is still buffered, so the last messages before a disconnection are
			// still recorded rather than lost with the page's state.
			DiagnosticsReporter.stop();
			// The connection this device identifier belonged to has already closed, so the gateway
			// needs no departure for it, and the next connection registers again and is issued its
			// own identifier.
			GatewayDeparture.stop();
			this.socket = undefined;
			// The page asked for this close so that the next connection offers a stage this one
			// could not, so it opens that connection at once rather than waiting.
			if (this.isReconnectRequested) {
				this.isReconnectRequested = false;
				this.connectToGateway();
				return;
			}
			// The volunteer pressed the disconnect button, or this browser found it can run none
			// of the stages the loaded pipelines define. Neither is fixed by trying again.
			if (this.isAutomaticReconnectionAllowed === false) {
				this.showDisconnectedControls();
				return;
			}
			this.eventLog.add({
				direction: 'local',
				type: 'worker.connection_lost',
				timestamp: new Date().toISOString(),
				message: 'The connection to the central gateway closed without this page asking for it',
			});
			this.showWaitingControls();
			this.gatewayReconnection.scheduleAttempt();
		});
	}

	/**
	 * Authenticates again before the current session runs out.
	 *
	 * This page holds its connection open for as long as the browser tab is open, which is
	 * longer than one session lasts, and the gateway refuses messages once a session has
	 * expired. Renewing keeps the connection usable without reconnecting.
	 *
	 * @param openSocket The connection whose session should be renewed.
	 * @param expiresAt When the current session expires, as the gateway stated it.
	 */
	private scheduleSessionRenewal(openSocket: WebSocket, expiresAt: string | undefined): void {
		if (this.sessionRenewalTimer !== undefined) {
			window.clearTimeout(this.sessionRenewalTimer);
		}
		if (expiresAt === undefined) {
			return;
		}
		this.sessionRenewalTimer = window.setTimeout((): void => {
			if (openSocket.readyState !== WebSocket.OPEN) {
				return;
			}
			GatewayLink.send(openSocket, {
				type: 'deviceAuthenticate',
				token: GatewayConfig.authToken,
			});
		}, SessionRenewal.renewAfterMs(expiresAt));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Account
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Builds the account conversation for one connection, and says what to do with what it reports.
	 *
	 * @param openSocket The connection the conversation runs on.
	 * @returns The conversation, not yet started.
	 */
	private buildWorkerAccount(openSocket: WebSocket): WorkerAccount {
		return new WorkerAccount((message: ClientMessage): void => {
			if (openSocket.readyState !== WebSocket.OPEN) {
				return;
			}
			GatewayLink.send(openSocket, message);
			this.eventLog.add({
				direction: 'sent',
				type: message.type,
				timestamp: new Date().toISOString(),
			});
		}, {
			onAccountKnown: (accountId: string): void => {
				this.accountIdEl.textContent = accountId;
			},
			onSettled: (accountId: string | undefined): void => {
				if (accountId === undefined) {
					this.accountIdEl.textContent = 'None: this tab contributes anonymously';
					this.accountCreditsEl.textContent = 'Not recorded for any account';
				}
				// Which stages this browser offers is decided from the pipelines the gateway has loaded, so
				// asking for them is what carries on towards registration.
				if (openSocket.readyState !== WebSocket.OPEN) {
					return;
				}
				const request: ClientMessage = {
					type: 'pipelines.get',
				};
				GatewayLink.send(openSocket, request);
				this.eventLog.add({
					direction: 'sent',
					type: request.type,
					timestamp: new Date().toISOString(),
				});
			},
			onBalance: (summary: AccountLedgerSummary): void => {
				const balance = `${summary.balance > 0 ? '+' : ''}${String(summary.balance)}`;
				this.accountCreditsEl.textContent = `${balance} (${String(summary.earnedStageCount)} stage(s) completed, ${String(summary.spentStageCount)} run)`;
			},
			onNote: (note: string): void => {
				this.eventLog.add({
					direction: 'received',
					type: `account: ${note}`,
					timestamp: new Date().toISOString(),
				});
			},
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Incoming Messages
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads one message from the central gateway and acts on it.
	 *
	 * @param event The message event delivered by the WebSocket connection.
	 */
	private handleGatewayMessage(event: MessageEvent): void {
		/** The wrapper the gateway message travelled in. */
		const frame = JSON.parse(event.data as string) as {
			v?: number;
			id?: string;
			inReplyToMessageId?: string;
			body?: GatewayMessage;
		};
		/** The decoded gateway message. */
		const message: GatewayMessage = frame.body ?? ({
			type: 'error',
		} as GatewayMessage);
		this.eventLog.add({
			direction: 'received',
			type: message.type,
			timestamp: new Date().toISOString(),
			...(message.taskId === undefined || message.taskId === '' ? {} : {
				taskId: message.taskId,
			}),
			...(message.stage === undefined ? {} : {
				stage: message.stage,
			}),
		});
		// Ask the gateway which pipelines it has loaded before registering, so this browser
		// can offer every stage whose computation it implements, including stages of a
		// pipeline added after this browser was built.
		if (message.type === 'deviceAuthenticated' && this.socket !== undefined) {
			// This page keeps its connection open indefinitely, and the gateway enforces the
			// expiry it just advertised, so the session has to be renewed before that moment
			// or the next message this page sends is refused.
			this.scheduleSessionRenewal(this.socket, message.expiresAt);
			// A renewal is answered with "deviceAuthenticated" too. Starting the sequence again
			// each time would restart the whole registration, so it is only started on the first one.
			if (this.isRegistered || this.workerAccount !== undefined) {
				return;
			}
			// Proving which account this browser is comes before asking for the pipelines, and therefore
			// before registering as a worker, so that no stage can ever complete before the gateway knows
			// whose account earned it. A browser or a gateway that cannot manage an account releases the
			// page to register anyway: contributing anonymously is far better than not contributing.
			this.workerAccount = this.buildWorkerAccount(this.socket);
			void this.workerAccount.begin();
			return;
		}
		if (this.workerAccount?.handleMessage(message) === true) {
			return;
		}
		// A completed stage is exactly when this account's balance changed, so that is when the page asks
		// for it again, rather than on a timer that would ask when nothing had happened.
		if (message.type === 'stage.result.accepted') {
			this.workerAccount?.requestBalance();
		}
		if (message.type === 'pipelines' && this.socket !== undefined) {
			this.registerOfferedStages(WorkerStageOffer.offeredStages(message.pipelines ?? [], this.requestedStageNames()));
			return;
		}
		if (message.type === 'deviceRegistered') {
			this.isRegistered = true;
			// This is the first moment the connection is known to be usable, rather than merely
			// open, so it is the moment the wait goes back to one second. Resetting it as soon as
			// the socket opened would let a gateway that accepts a connection and drops it again —
			// a container coming up — be asked once a second for as long as that lasts.
			this.gatewayReconnection.stopAndReset();
			this.deviceIdEl.textContent = message.deviceId ?? 'Not assigned';
			// Reporting can only start now: the gateway names the device the report is for,
			// and it issues that name here.
			if (message.deviceId !== undefined) {
				DiagnosticsReporter.start(message.deviceId, GatewayConfig.authToken);
				GatewayDeparture.start(message.deviceId);
			}
		}
		DiagnosticsReporter.record('received', message.type, frame.id);
		if (message.type === 'stage.cancel' && message.taskId !== undefined) {
			LeaseHeartbeat.stop(message.stageAssignmentId);
			StageHelperLlmQwen3_0_6bSharded.clearTask(message.taskId);
			// Both helpers hold what they hold against the task, but only the built-in model
			// helper is told which assignment is being cancelled. One tab can hold two runs of the
			// same task at once, when a lease expires and the gateway assigns the stage again to
			// the same tab, and only the superseded one is being cancelled here; naming it is what
			// stops this from ending an answer the replacement run is still reading.
			if (message.stageAssignmentId !== undefined) {
				StageHelperLlmGemmaNanoChromeFull.clearGeneration(message.taskId, message.stageAssignmentId);
				StageHelperLlmQwen3_5_0_8bFull.clearGeneration(message.taskId, message.stageAssignmentId);
				StageHelperLlmLlama3_2_1bFull.clearGeneration(message.taskId, message.stageAssignmentId);
				StageHelperLlmGemma4E2bFull.clearGeneration(message.taskId, message.stageAssignmentId);
			}
			return;
		}
		// The gateway answers each lease heartbeat with a later expiry. Nothing has to be
		// done with it: the assignment is still this browser's, which is the whole point.
		if (message.type === 'stage.lease.extended') {
			return;
		}
		const isCompleteAssignment = message.type === 'stage.assign'
			&& message.stage !== undefined
			&& message.value !== undefined
			&& message.taskId !== undefined
			&& message.stageAssignmentId !== undefined
			&& message.attempt !== undefined;
		if (isCompleteAssignment === false) {
			return;
		}
		this.runAssignedStage(message);
	}

	/**
	 * Decides which stages this browser asks to offer, for the connection now registering.
	 *
	 * The page URL's `enabledStages` query parameter wins when it names any stages, so an existing
	 * debug URL keeps working unchanged. Otherwise this returns the stages chosen in the settings
	 * panel, read fresh from local storage so a choice made after the page loaded still takes
	 * effect on the next connection.
	 *
	 * @returns The stages to restrict this browser's offer to. An empty result means this browser
	 * offers every stage it can run.
	 */
	private requestedStageNames(): readonly string[] {
		if (this.urlRequestedStageNames.length > 0) {
			return this.urlRequestedStageNames;
		}
		return StagesConfigPanel.getEnabledStageNames();
	}

	/**
	 * Gets this browser ready for the stages it could offer, then registers as a worker.
	 *
	 * @param offered The stages this browser could offer, from the loaded pipelines.
	 */
	private registerOfferedStages(offered: OfferedStages): void {
		this.isPreparing = true;
		this.prepareOfferedStages(offered)
			.then((stageNames) => {
				this.isPreparing = false;
				if (this.socket === undefined) {
					return;
				}
				this.enabledStageNames = stageNames;
				this.renderStages();
				if (stageNames.length === 0) {
					this.statusEl.textContent = 'No stage to run';
					this.statusEl.className = 'badge rounded-pill text-bg-danger';
					this.eventLog.add({
						direction: 'local',
						type: 'worker.error',
						timestamp: new Date().toISOString(),
						message: 'This browser can run none of the stages the loaded pipelines define',
					});
					// Opening this connection again would find the same pipelines and the same
					// browser, and close for the same reason once a minute for as long as the tab
					// stays open. The connect button is how a volunteer asks for another look.
					this.isAutomaticReconnectionAllowed = false;
					this.socket.close(1000, 'No stage to run');
					return;
				}
				this.statusEl.textContent = 'Connected';
				this.statusEl.className = 'badge rounded-pill text-bg-success';
				this.hideModelDownloadProgress();
				const register: ClientMessage = {
					type: 'deviceRegister',
					role: 'worker',
					name: this.nameInputEl.value,
					stageNames,
				};
				GatewayLink.send(this.socket, register);
				this.eventLog.add({
					direction: 'sent',
					type: register.type,
					timestamp: new Date().toISOString(),
				});
			})
			.catch((error: unknown) => {
				this.isPreparing = false;
				this.statusEl.textContent = 'Shard loading failed';
				this.statusEl.className = 'badge rounded-pill text-bg-danger';
				this.eventLog.add({
					direction: 'local',
					type: 'worker.error',
					timestamp: new Date().toISOString(),
					message: error instanceof Error ? error.message : String(error),
				});
				// Every attempt would start the same download again, so a browser that cannot load
				// its shards would download a large model once a minute for as long as the tab
				// stays open. The connect button is how a volunteer asks for another attempt.
				this.isAutomaticReconnectionAllowed = false;
				this.socket?.close(1000, 'Shard loading failed');
			});
	}

	/**
	 * Runs one assigned stage and reports its result, or its failure, to the gateway.
	 *
	 * @param message The `stage.assign` message, with its task, assignment, and value present.
	 */
	private runAssignedStage(message: GatewayMessage): void {
		/** The task identifier and stage captured for the async result below. */
		const { taskId, stageAssignmentId, attempt, stage, value } = message as Required<
			Pick<GatewayMessage, 'taskId' | 'stageAssignmentId' | 'attempt' | 'stage' | 'value'>
		>;
		const acceptedMessage: ClientMessage = {
			type: 'stage.accepted',
			taskId,
			stageAssignmentId,
			attempt,
		};
		if (this.socket !== undefined) {
			GatewayLink.send(this.socket, acceptedMessage);
		}
		if (this.socket !== undefined) {
			LeaseHeartbeat.start(this.socket, {
				taskId,
				stageAssignmentId,
				attempt,
				leaseUntil: message.leaseUntil,
			});
		}
		// The assignment says which computation to run and which position in its pipeline
		// the stage occupies. This browser never has to recognise the stage name.
		const computation = message.computation ?? '';
		/**
		 * Runs the assigned stage with whichever helper implements its computation.
		 *
		 * @returns The stage result, once the computation has produced it.
		 */
		const runComputation = (): Promise<StagePayload> => {
			if (StageHelperLlmQwen3_0_6bSharded.implementsComputation(computation)) {
				return StageHelperLlmQwen3_0_6bSharded.compute(
					message.stageIndex ?? 0,
					taskId,
					value as Exclude<StagePayload, number>,
					message.generationSettings,
				);
			}
			if (StageHelperLlmGemmaNanoChromeFull.implementsComputation(computation)) {
				return StageHelperLlmGemmaNanoChromeFull.compute(
					taskId,
					stageAssignmentId,
					value as Exclude<StagePayload, number>,
					message.generationSettings,
				);
			}
			if (StageHelperLlmQwen3_5_0_8bFull.implementsComputation(computation)) {
				return StageHelperLlmQwen3_5_0_8bFull.compute(
					taskId,
					stageAssignmentId,
					value as Exclude<StagePayload, number>,
					message.generationSettings,
				);
			}
			if (StageHelperLlmLlama3_2_1bFull.implementsComputation(computation)) {
				return StageHelperLlmLlama3_2_1bFull.compute(
					taskId,
					stageAssignmentId,
					value as Exclude<StagePayload, number>,
					message.generationSettings,
				);
			}
			if (StageHelperLlmGemma4E2bFull.implementsComputation(computation)) {
				return StageHelperLlmGemma4E2bFull.compute(
					taskId,
					stageAssignmentId,
					value as Exclude<StagePayload, number>,
					message.generationSettings,
				);
			}
			return Promise.resolve(StageHelperDevFormula.compute(computation, value as number));
		};
		runComputation()
			.then((computedValue) => {
				LeaseHeartbeat.stop(stageAssignmentId);
				const resultMessage: ClientMessage = {
					type: 'stage.result',
					taskId,
					stageAssignmentId,
					attempt,
					stage,
					value: computedValue,
				};
				if (this.socket !== undefined) {
					GatewayLink.send(this.socket, resultMessage);
				}
				this.eventLog.add({
					direction: 'sent',
					type: resultMessage.type,
					timestamp: new Date().toISOString(),
					taskId,
					stage,
				});
			})
			.catch((error: unknown) => {
				LeaseHeartbeat.stop(stageAssignmentId);
				// A failed stage abandons the task, so drop whatever this browser was keeping
				// for it: a shard's key-value cache, or an answer the browser's own language
				// model is still producing. Both are left alone when no such state exists.
				StageHelperLlmQwen3_0_6bSharded.clearTask(taskId);
				StageHelperLlmGemmaNanoChromeFull.clearGeneration(taskId, stageAssignmentId);
				StageHelperLlmQwen3_5_0_8bFull.clearGeneration(taskId, stageAssignmentId);
				StageHelperLlmLlama3_2_1bFull.clearGeneration(taskId, stageAssignmentId);
				StageHelperLlmGemma4E2bFull.clearGeneration(taskId, stageAssignmentId);
				const failedMessage: ClientMessage = {
					type: 'stage.failed',
					taskId,
					stageAssignmentId,
					attempt,
					stage,
					error: error instanceof Error ? error.message : String(error),
				};
				if (this.socket !== undefined) {
					GatewayLink.send(this.socket, failedMessage);
				}
				this.eventLog.add({
					direction: 'sent',
					type: failedMessage.type,
					timestamp: new Date().toISOString(),
					taskId,
					stage,
					message: failedMessage.error,
				});
			});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Getting Ready To Work
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Gets this browser ready to run the stages it could offer, and reports which of them it
	 * can actually offer.
	 *
	 * Four stages need something to be in place before work arrives. A language-model shard
	 * stage needs its shard downloaded, which is done here so that a shard is never downloaded
	 * while a task is waiting for it. A stage that runs the language model built into the
	 * browser needs that model to be ready, and this browser drops the stage rather than
	 * advertising work it would fail, because the browser may have no built-in model at all or
	 * may not have downloaded it yet. A stage that runs the complete Qwen3.5-0.8B model, and a
	 * stage that runs the complete Llama 3.2 1B Instruct model, each need a WebGPU adapter with
	 * 16-bit float support and enough free storage, checked the same way and for the same reason,
	 * and then need their own model downloaded and loaded — kept apart from one another so that a
	 * tab offering only one of the two checks the requirements of, and downloads, only that one.
	 *
	 * @param offered The stages this browser could offer, from the loaded pipelines.
	 * @returns The stage names this browser can offer, in the order they were found.
	 */
	private async prepareOfferedStages(offered: OfferedStages): Promise<string[]> {
		let stageNames = offered.stageNames;
		if (offered.builtInModelStageNames.length > 0) {
			this.statusEl.textContent = 'Checking the built-in language model';
			this.statusEl.className = 'badge rounded-pill text-bg-warning';
			const readiness = await StageHelperLlmGemmaNanoChromeFull.readiness();
			if (readiness.status === 'ready') {
				this.hideBuiltInModelNotice();
			} else {
				stageNames = stageNames.filter((stageName) => offered.builtInModelStageNames.includes(stageName) === false);
				this.showBuiltInModelNotice(readiness.message, readiness.status === 'user_gesture_required');
				this.eventLog.add({
					direction: 'local',
					type: 'worker.built_in_model',
					timestamp: new Date().toISOString(),
					message: readiness.message,
				});
			}
		}
		if (offered.llmShardIndexes.length > 0) {
			this.statusEl.textContent = 'Downloading model files';
			this.statusEl.className = 'badge rounded-pill text-bg-warning';
		}
		await StageHelperLlmQwen3_0_6bSharded.preload(
			offered.llmShardIndexes,
			(phase) => {
				this.statusEl.textContent = phase === 'downloading' ? 'Downloading model files' : 'Loading model in GPU';
			},
			(progress) => {
				this.applyModelDownloadProgress(progress);
			},
		);
		if (offered.qwen3_5_0_8bFullModelStageNames.length > 0) {
			this.statusEl.textContent = 'Checking Qwen3.5-0.8B requirements';
			this.statusEl.className = 'badge rounded-pill text-bg-warning';
			const readiness = await StageHelperLlmQwen3_5_0_8bFull.readiness();
			if (readiness.status !== 'ready') {
				stageNames = stageNames.filter((stageName) => offered.qwen3_5_0_8bFullModelStageNames.includes(stageName) === false);
				this.eventLog.add({
					direction: 'local',
					type: 'worker.full_model',
					timestamp: new Date().toISOString(),
					message: readiness.message,
				});
			} else {
				this.statusEl.textContent = 'Downloading model files';
				await StageHelperLlmQwen3_5_0_8bFull.preload((progress) => {
					this.applyModelDownloadProgress(progress);
				});
			}
		}
		if (offered.llama3_2_1bFullModelStageNames.length > 0) {
			this.statusEl.textContent = 'Checking Llama 3.2 1B Instruct requirements';
			this.statusEl.className = 'badge rounded-pill text-bg-warning';
			const readiness = await StageHelperLlmLlama3_2_1bFull.readiness();
			if (readiness.status !== 'ready') {
				stageNames = stageNames.filter((stageName) => offered.llama3_2_1bFullModelStageNames.includes(stageName) === false);
				this.eventLog.add({
					direction: 'local',
					type: 'worker.full_model',
					timestamp: new Date().toISOString(),
					message: readiness.message,
				});
			} else {
				this.statusEl.textContent = 'Downloading model files';
				await StageHelperLlmLlama3_2_1bFull.preload((progress) => {
					this.applyModelDownloadProgress(progress);
				});
			}
		}
		if (offered.gemma4E2bFullModelStageNames.length > 0) {
			this.statusEl.textContent = 'Checking Gemma 4 E2B requirements';
			this.statusEl.className = 'badge rounded-pill text-bg-warning';
			const readiness = await StageHelperLlmGemma4E2bFull.readiness();
			if (readiness.status !== 'ready') {
				stageNames = stageNames.filter((stageName) => offered.gemma4E2bFullModelStageNames.includes(stageName) === false);
				this.eventLog.add({
					direction: 'local',
					type: 'worker.full_model',
					timestamp: new Date().toISOString(),
					message: readiness.message,
				});
			} else {
				this.statusEl.textContent = 'Downloading model files';
				await StageHelperLlmGemma4E2bFull.preload((progress) => {
					this.applyModelDownloadProgress(progress);
				});
			}
		}
		return stageNames;
	}

	/**
	 * Downloads the language model built into the browser, at the reader's request, and offers
	 * the stage that needs it on the next connection.
	 */
	private downloadBuiltInModel(): void {
		this.builtInModelDownloadButtonEl.disabled = true;
		this.builtInModelMessageEl.textContent = "Downloading the browser's built-in language model.";
		StageHelperLlmGemmaNanoChromeFull.download((fraction) => {
			this.builtInModelMessageEl.textContent = `Downloading the browser's built-in language model: ${Math.round(fraction * 100)} per cent.`;
		})
			.then((readiness) => {
				this.builtInModelDownloadButtonEl.disabled = false;
				if (readiness.status !== 'ready') {
					this.showBuiltInModelNotice(readiness.message, readiness.status === 'user_gesture_required');
					return;
				}
				this.hideBuiltInModelNotice();
				this.eventLog.add({
					direction: 'local',
					type: 'worker.built_in_model',
					timestamp: new Date().toISOString(),
					message: "The browser's built-in language model is ready",
				});
				if (this.socket === undefined) {
					// The page may be waiting to connect again, and this browser now has something
					// more to offer than it had when that wait was chosen, so it connects at once
					// rather than sitting out the rest of the wait.
					this.gatewayReconnection.stopAndReset();
					this.connectToGateway();
					return;
				}
				this.isReconnectRequested = true;
				this.socket.close(1000, 'Offering the built-in language-model stage');
			})
			.catch((error: unknown) => {
				this.builtInModelDownloadButtonEl.disabled = false;
				this.showBuiltInModelNotice(error instanceof Error ? error.message : String(error), true);
			});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Drawing
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Shows that this browser is disconnected and is not going to connect again on its own.
	 *
	 * The connect button is the only way out of this state, so it is the only one shown, and the
	 * worker name can be changed before the volunteer presses it.
	 */
	private showDisconnectedControls(): void {
		this.statusEl.textContent = 'Disconnected';
		this.statusEl.className = 'badge rounded-pill text-bg-danger';
		this.connectButtonEl.classList.remove('d-none');
		this.connectButtonEl.disabled = false;
		this.disconnectButtonEl.classList.add('d-none');
		this.nameInputEl.disabled = false;
	}

	/**
	 * Shows that this browser lost its connection and is waiting to open another one.
	 *
	 * Both buttons are shown, because both mean something here: the connect button makes the
	 * pending attempt now, and the disconnect button stops the page trying at all. The status
	 * text itself is written by the countdown, which says how long is left.
	 */
	private showWaitingControls(): void {
		this.connectButtonEl.classList.remove('d-none');
		this.connectButtonEl.disabled = false;
		this.disconnectButtonEl.classList.remove('d-none');
		this.nameInputEl.disabled = true;
	}

	/** Shows the stages this worker browser currently offers. */
	private renderStages(): void {
		this.stagesEl.innerHTML = this.enabledStageNames.length === 0
			? '<span class="text-body-secondary">Waiting for the gateway\'s pipelines</span>'
			: this.enabledStageNames.map((stageName) => `<span class="badge text-bg-light border">${PageMarkup.escapeHtml(stageName)}</span>`).join('');
	}

	/**
	 * Reflects the quiet tone's current state in the page, and checks again after a delay.
	 *
	 * Runs for as long as the page is open once started by the quiet tone button, so a state
	 * the browser changes on its own — such as suspending the tone after the tab has been
	 * hidden for a long time — still reaches the page.
	 */
	private pollQuietToneState(): void {
		const state: AudioKeepaliveState = AudioKeepalive.state();
		this.quietToneStateEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
		this.updatePowerStatusBadge();
		this.updateFullPowerButtonLabel();
		window.setTimeout((): void => {
			this.pollQuietToneState();
		}, AUDIO_STATE_POLL_INTERVAL_MS);
	}

	/**
	 * Reflects the screen wake lock's current state in the page, and checks again after a delay.
	 *
	 * Runs for as long as the page is open once started by the screen wake lock button, so a
	 * state the system changes on its own — such as releasing the lock while the tab is
	 * hidden — still reaches the page once the lock is re-acquired or given up on.
	 */
	private pollScreenWakeLockState(): void {
		const state: ScreenWakeLockState = ScreenWakeLock.state();
		this.screenWakeLockStateEl.textContent = state.charAt(0).toUpperCase() + state.slice(1);
		this.updatePowerStatusBadge();
		this.updateFullPowerButtonLabel();
		window.setTimeout((): void => {
			this.pollScreenWakeLockState();
		}, SCREEN_WAKE_LOCK_STATE_POLL_INTERVAL_MS);
	}

	/**
	 * Reflects whether this tab is running at full power in the power status badge: full power
	 * once the quiet tone is playing and the screen wake lock is held, both needed to keep this
	 * tab's language model at full generation speed while the tab is hidden; throttleable
	 * otherwise.
	 */
	private updatePowerStatusBadge(): void {
		const isFullPower = AudioKeepalive.state() === 'running' && ScreenWakeLock.state() === 'held';
		if (isFullPower) {
			this.powerStatusEl.textContent = 'Full power';
			this.powerStatusEl.className = 'badge rounded-pill text-bg-success';
			return;
		}
		this.powerStatusEl.textContent = 'Throttleable';
		this.powerStatusEl.className = 'badge rounded-pill text-bg-danger';
	}

	/**
	 * Reflects whether the navigation bar's full power button is asking to start or to stop full
	 * power, based on whether the quiet tone and the screen wake lock are both currently enabled.
	 */
	private updateFullPowerButtonLabel(): void {
		const isFullPowerRequested = AudioKeepalive.state() !== 'stopped' && ScreenWakeLock.isEnabled();
		this.fullPowerButtonEl.textContent = isFullPowerRequested ? 'Stop full power' : 'Start full power';
	}

	/**
	 * Starts the quiet tone and updates the quiet tone button and the full power button to match.
	 */
	private startQuietTone(): void {
		AudioKeepalive.start();
		this.quietToneButtonEl.textContent = 'Stop quiet tone';
		this.pollQuietToneState();
		this.updateFullPowerButtonLabel();
	}

	/**
	 * Stops the quiet tone and updates the quiet tone button and the full power button to match.
	 */
	private stopQuietTone(): void {
		AudioKeepalive.stop();
		this.quietToneButtonEl.textContent = 'Start quiet tone';
		this.updateFullPowerButtonLabel();
	}

	/**
	 * Starts the screen wake lock and updates the screen wake lock button and the full power
	 * button to match.
	 */
	private startScreenWakeLock(): void {
		ScreenWakeLock.start();
		this.screenWakeLockButtonEl.textContent = 'Stop keeping screen awake';
		this.pollScreenWakeLockState();
		this.updateFullPowerButtonLabel();
	}

	/**
	 * Stops the screen wake lock and updates the screen wake lock button and the full power
	 * button to match.
	 */
	private stopScreenWakeLock(): void {
		ScreenWakeLock.stop();
		this.screenWakeLockButtonEl.textContent = 'Keep screen awake';
		this.updateFullPowerButtonLabel();
	}

	/**
	 * Shows why a stage that needs the browser's own language model is not being offered.
	 *
	 * @param text The reason to display.
	 * @param isDownloadOffered Whether the reader can fix it by starting the download.
	 */
	private showBuiltInModelNotice(text: string, isDownloadOffered: boolean): void {
		this.builtInModelMessageEl.textContent = text;
		this.builtInModelNoticeEl.classList.remove('d-none');
		this.builtInModelDownloadButtonEl.classList.toggle('d-none', isDownloadOffered === false);
	}

	/** Hides the notice about the browser's own language model. */
	private hideBuiltInModelNotice(): void {
		this.builtInModelNoticeEl.classList.add('d-none');
		this.builtInModelDownloadButtonEl.classList.add('d-none');
	}

	/**
	 * Reflects one step of model-download progress at the bottom of the connect card.
	 *
	 * A `message` step is not shown here: the status badge already carries the overall stage, so
	 * only the two steps naming a file change what this element shows.
	 *
	 * @param progress The progress step reported by the model helper currently downloading.
	 */
	private applyModelDownloadProgress(progress: ModelDownloadProgress): void {
		if (progress.kind === 'file_progress') {
			this.showModelDownloadProgress(progress.file, progress.percent);
		} else if (progress.kind === 'file_done') {
			this.hideModelDownloadProgress(progress.file);
		}
	}

	/**
	 * Shows how much of one model file has downloaded so far, its own line at the bottom of the
	 * connect card, so a file already there keeps its own line instead of sharing one with
	 * whichever file last reported progress.
	 *
	 * @param file The file's full path within the model repository, such as `onnx/model_q4f16.onnx_data`.
	 * @param percent How much of that file has arrived, from 0 to 100.
	 */
	private showModelDownloadProgress(file: string, percent: number): void {
		this.downloadingFiles.set(file, percent);
		this.renderModelDownloadProgress();
	}

	/**
	 * Removes one file's line from the model-download progress, once that file has finished
	 * downloading, or removes every line at once when a new connection attempt starts.
	 *
	 * @param file The file that finished. Left out to remove every line regardless of which files
	 * are still in view, such as when a new connection attempt starts.
	 */
	private hideModelDownloadProgress(file?: string): void {
		if (file !== undefined) {
			this.downloadingFiles.delete(file);
		} else {
			this.downloadingFiles.clear();
		}
		this.renderModelDownloadProgress();
	}

	/** Redraws the model-download progress from `downloadingFiles`, one line per file. */
	private renderModelDownloadProgress(): void {
		if (this.downloadingFiles.size === 0) {
			this.modelDownloadProgressEl.classList.add('d-none');
			this.modelDownloadProgressEl.innerHTML = '';
			return;
		}
		this.modelDownloadProgressEl.classList.remove('d-none');
		this.modelDownloadProgressEl.innerHTML = [...this.downloadingFiles.entries()].map(([file, percent]) => {
			const baseName = file.split('/').pop() ?? file;
			return `<div class="mb-2">
				<div class="d-flex justify-content-between small text-secondary mb-1">
					<span class="text-truncate" title="${PageMarkup.escapeHtml(file)}">${PageMarkup.escapeHtml(baseName)}</span>
					<span>${String(percent)}%</span>
				</div>
				<div class="progress" style="height: 6px;">
					<div class="progress-bar" role="progressbar" aria-label="Model file download progress"
						aria-valuenow="${String(percent)}" aria-valuemin="0" aria-valuemax="100"
						style="width: ${String(percent)}%;"></div>
				</div>
			</div>`;
		}).join('');
	}
}

new WorkerPage().start();
