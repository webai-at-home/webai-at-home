import type { Device, DeviceActivity, DeviceRole, TaskInput, TaskSnapshot, TaskUpdate } from '@webai/protocol';
import { Envelope } from '@webai/protocol/envelope';
import { SessionRenewal } from '@webai/protocol/session_renewal';
import { ThemeToggle } from '../../_shared/theme_toggle.js';
import { WorkerPageOrigin } from '../../_shared/worker_page_origin.js';
import { Dashboard } from '../../../src/dashboard.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MonitorPage — the gateway's monitor page: observes the gateway and draws what it reports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What this page displays about one connected device. */
type DeviceSummary = {
	deviceId: string;
	deviceRole: DeviceRole;
	name: string;
	stageNames: string[];
	connectedAt: string;
	lastSeenAt: string;
};

/** The fields this page reads from the messages the central gateway sends it. */
type GatewayMessage = {
	type: string;
	/** The full device list on a `devices` message, and the changed activity fields on a `device.activity` message. */
	devices?: Device[] | DeviceActivity[];
	device?: Device;
	deviceId?: string;
	task?: TaskSnapshot;
	update?: TaskUpdate;
	code?: string;
	message?: string;
	/** When the authenticated session expires, in reply to `authenticate`. */
	expiresAt?: string;
};

/** One line in the recent gateway events list. */
type DashboardEvent = {
	type: string;
	timestamp: string;
	details: string;
};

/**
 * What this page knows about the most recent task.
 *
 * The central gateway sends the full task state only when a client asks for a task, as
 * `task.accepted` or `task.snapshot`. Every revision afterwards arrives as the slim
 * `task.updated` projection, which carries no task input and no stage values. Keeping
 * the last full state here lets each revision redraw the panel with the input still
 * shown, instead of the panel emptying out as soon as the task advances.
 */
type TaskPanelState = {
	snapshot?: TaskSnapshot | undefined;
	update?: TaskUpdate | undefined;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Page Settings
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How many recent gateway events the page keeps on screen. */
const maximumDisplayedEvents = 10;

/** The gateway message types that carry a device list or a single device change. */
const deviceMessageTypes = ['devices', 'device.joined', 'device.updated', 'device.activity', 'device.left'];

/** Message types the task panel already reports on its own, so the event list does not repeat them. */
const taskPanelMessageTypes = ['task.accepted', 'task.snapshot', 'task.updated'];

/**
 * The bearer token this dashboard page presents to the central gateway. It matches the
 * gateway's own `--auth-token` default, the same way the worker browser page does.
 */
const gatewayAuthenticationToken = 'development-token';

/** What each task type is called on this page, so a task is recognisable without its identifier. */
const taskTypeDisplayNames: Record<TaskInput['taskType'], string> = {
	task_type_dev_formula: 'Development formula',
	task_type_llm_qwen3_0_6b_sharded: 'Qwen3-0.6B sharded language model',
	task_type_llm_gemma_nano_chrome_full: 'Chrome built-in Gemma Nano language model',
	task_type_llm_qwen3_5_0_8b_full: 'Qwen3.5-0.8B full language model',
	task_type_llm_llama3_2_1b_full: 'Llama 3.2 1B Instruct full language model',
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Monitor Page
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Connects to the central gateway as an observer and keeps the monitor page up to date.
 *
 * The page holds every device the gateway has told it about, so that each later change
 * message redraws the panels rather than leaving the counts standing still until the page
 * is reloaded.
 */
export class MonitorPage {
	/** Opens the connection and starts drawing the page. */
	static start(): void {
		ThemeToggle.setup();
		WorkerPageOrigin.wireLinks(['#worker-link-nav']);
		MonitorPage.configureFoldablePanels();
		const statusEl: HTMLElement = MonitorPage.getElement('#status');
		const statusBadgeEl: HTMLElement = MonitorPage.getElement('#status-badge');
		const workersEl: HTMLElement = MonitorPage.getElement('#workers');
		const consumersEl: HTMLElement = MonitorPage.getElement('#consumers');
		const tasksEl: HTMLElement = MonitorPage.getElement('#tasks');
		const workerCountEl: HTMLElement = MonitorPage.getElement('#worker-count');
		const consumerCountEl: HTMLElement = MonitorPage.getElement('#consumer-count');
		const stageCountEl: HTMLElement = MonitorPage.getElement('#stage-count');
		const stagesEl: HTMLElement = MonitorPage.getElement('#stages');
		const eventsEl: HTMLElement = MonitorPage.getElement('#events');
		const events: DashboardEvent[] = [];
		const addEvent = (event: DashboardEvent): void => {
			events.push(event);
			if (events.length > maximumDisplayedEvents) events.splice(0, events.length - maximumDisplayedEvents);
			eventsEl.innerHTML = events.slice().reverse().map((item) => `<article class="event-item"><div class="d-flex justify-content-between gap-3"><strong>${MonitorPage.escapeHtml(item.type)}</strong><time class="text-secondary">${MonitorPage.escapeHtml(MonitorPage.formatTime(item.timestamp))}</time></div><div class="small text-secondary">${MonitorPage.escapeHtml(item.details)}</div></article>`).join('');
		};
		const taskPanel: TaskPanelState = {};
		const renderTask = (): void => {
			const taskId = taskPanel.update?.taskId ?? taskPanel.snapshot?.taskId ?? '';
			const state = taskPanel.update?.state ?? taskPanel.snapshot?.state ?? 'unknown';
			const completedStageCount = taskPanel.update?.completedStageCount ?? taskPanel.snapshot?.completedStages.length ?? 0;
			const error = taskPanel.update?.error ?? taskPanel.snapshot?.error;
			tasksEl.innerHTML = `<div class="d-flex justify-content-between gap-3 mb-2"><strong>${MonitorPage.escapeHtml(taskId)}</strong><span class="badge text-bg-light border">${MonitorPage.escapeHtml(state)}</span></div><p class="mb-2">${MonitorPage.escapeHtml(MonitorPage.taskSummary(taskPanel))}</p><div class="small text-secondary">Completed stages: ${completedStageCount}</div>${error === undefined || error === '' ? '' : `<div class="alert alert-danger mt-3 mb-0 py-2">${MonitorPage.escapeHtml(error)}</div>`}`;
		};
		// This page is an observer connection, which the central gateway treats as a device
		// membership subscription. The gateway sends the full device list once, as the reply
		// to "observe", and afterwards only sends what changed: "device.joined" and
		// "device.left" for devices arriving and leaving, "device.updated" when a device's own
		// description changes, and "device.activity" for how busy a device is. Keeping the
		// devices here lets every one of those messages redraw the panels, instead of the
		// counts standing still until the page is reloaded.
		const deviceById = new Map<string, Device>();
		/**
		 * Returns the label to display for one connected device, which is its name on its own
		 * unless another connected device carries that same name.
		 *
		 * @param deviceId The device the label is wanted for.
		 * @returns The label to display, or the device identifier when the device is no longer
		 * connected.
		 */
		const displayLabelFor = (deviceId: string): string => {
			return Dashboard.displayLabelByDeviceId([...deviceById.values()]).get(deviceId) ?? deviceId;
		};
		const renderDevices = (): void => {
			const devices = Dashboard.splitDevices([...deviceById.values()]);
			const workers = devices.worker;
			const consumers = devices.consumer;
			const displayLabelByDeviceId = Dashboard.displayLabelByDeviceId([...deviceById.values()]);
			workerCountEl.textContent = String(workers.length);
			consumerCountEl.textContent = String(consumers.length);
			workersEl.innerHTML = workers.map((device: DeviceSummary) => MonitorPage.connectionMarkup(device, displayLabelByDeviceId.get(device.deviceId) ?? device.name, true)).join('') || '<p class="text-secondary mb-0">No worker browsers are connected.</p>';
			consumersEl.innerHTML = consumers.map((device: DeviceSummary) => MonitorPage.connectionMarkup(device, displayLabelByDeviceId.get(device.deviceId) ?? device.name, false)).join('') || '<p class="text-secondary mb-0">No consumers are connected.</p>';
			const statistics = Dashboard.stageStatistics(workers);
			stageCountEl.textContent = String(statistics.total);
			stagesEl.innerHTML = statistics.stages.map((stage) => `<div class="stage-stat"><div class="d-flex justify-content-between"><span>${MonitorPage.escapeHtml(stage.stageName)}</span><span class="text-secondary">${stage.count} worker${stage.count === 1 ? '' : 's'} · ${stage.percentage.toFixed(1)}%</span></div><div class="progress" role="progressbar" aria-label="${MonitorPage.escapeHtml(stage.stageName)} percentage" aria-valuenow="${stage.percentage}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width: ${stage.percentage}%"></div></div></div>`).join('') || '<p class="text-secondary mb-0">No worker stages are enabled.</p>';
		};
		const socketEl: WebSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
		/** Whether this dashboard has already asked to observe on the current connection. */
		let isObserving = false;
		/** The pending timer that authenticates again before the current session expires. */
		let sessionRenewalTimer: number | undefined;

		/**
		 * Authenticates again before the current session runs out, so this dashboard keeps
		 * working for as long as the page is open.
		 *
		 * @param expiresAt When the current session expires, as the gateway stated it.
		 */
		const scheduleSessionRenewal = (expiresAt: string | undefined): void => {
			if (sessionRenewalTimer !== undefined) window.clearTimeout(sessionRenewalTimer);
			if (expiresAt === undefined) return;
			sessionRenewalTimer = window.setTimeout((): void => {
				if (socketEl.readyState !== WebSocket.OPEN) return;
				socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'deviceAuthenticate', token: gatewayAuthenticationToken })));
			}, SessionRenewal.renewAfterMs(expiresAt));
		};

		socketEl.addEventListener('open', (): void => {
			const authenticateMessage = { type: 'deviceAuthenticate' as const, token: gatewayAuthenticationToken };
			socketEl.send(JSON.stringify(Envelope.fromClient(authenticateMessage)));
			statusEl.textContent = 'Authenticating with the central gateway.';
			statusBadgeEl.textContent = 'Authenticating';
			statusBadgeEl.className = 'badge rounded-pill text-bg-warning';
		});
		socketEl.addEventListener('message', (event: MessageEvent): void => {
			const frame = JSON.parse(event.data as string) as { body?: GatewayMessage };
			const message = frame.body;
			if (message === undefined) return;
			if (message.type === 'deviceAuthenticated') {
				statusEl.textContent = 'Connected to the central gateway.';
				statusBadgeEl.textContent = 'Connected';
				statusBadgeEl.className = 'badge rounded-pill text-bg-success';
				// This dashboard stays open indefinitely and the gateway enforces the expiry it
				// just advertised, so the session is renewed before that moment. A renewal is
				// answered with "deviceAuthenticated" too, and must not start observing a second time.
				scheduleSessionRenewal(message.expiresAt);
				if (isObserving === false) {
					isObserving = true;
					socketEl.send(JSON.stringify(Envelope.fromClient({ type: 'observe' })));
					addEvent({ type: 'Authenticated', timestamp: new Date().toISOString(), details: 'Now observing the central gateway' });
				}
				return;
			}
			if (message.type === 'devices' && message.devices !== undefined) {
				deviceById.clear();
				for (const device of message.devices as Device[]) deviceById.set(device.deviceId, device);
				renderDevices();
				addEvent({ type: 'Device list received', timestamp: new Date().toISOString(), details: MonitorPage.describeDeviceCount(deviceById) });
			}
			if ((message.type === 'device.joined' || message.type === 'device.updated') && message.device !== undefined) {
				deviceById.set(message.device.deviceId, message.device);
				renderDevices();
				addEvent({ type: message.type === 'device.joined' ? 'Device joined' : 'Device updated', timestamp: new Date().toISOString(), details: `${displayLabelFor(message.device.deviceId)} · ${MonitorPage.describeDeviceCount(deviceById)}` });
			}
			// The central gateway sends how busy each device is on its own, batched over a
			// short window, rather than re-sending whole device records every time a worker
			// picks up or finishes a stage. Merging the activity fields into the stored device
			// keeps the counts and the busy or idle state current without losing the device's
			// name and stage list, which activity messages do not carry.
			if (message.type === 'device.activity' && message.devices !== undefined) {
				for (const activity of message.devices as DeviceActivity[]) {
					const stored = deviceById.get(activity.deviceId);
					if (stored === undefined) continue;
					// Only the activity fields actually present are merged in. Spreading the whole
					// activity record would overwrite a known value with undefined for any field the
					// message left out, losing what the stored device already said about it.
					deviceById.set(activity.deviceId, {
						...stored,
						lastSeenAt: activity.lastSeenAt,
						...(activity.workerState === undefined ? {} : { workerState: activity.workerState }),
						...(activity.ready === undefined ? {} : { ready: activity.ready }),
						...(activity.activeAssignments === undefined ? {} : { activeAssignments: activity.activeAssignments }),
					});
				}
				renderDevices();
				addEvent({ type: 'Device activity', timestamp: new Date().toISOString(), details: `${message.devices.length} device${message.devices.length === 1 ? '' : 's'} · ${MonitorPage.describeDeviceCount(deviceById)}` });
			}
			if (message.type === 'device.left' && message.deviceId !== undefined) {
				// The label is read while the departing device is still in the list, so a name it
				// shared with another connected device is still shown with the identifier that
				// tells the two of them apart.
				const departedLabel = displayLabelFor(message.deviceId);
				deviceById.delete(message.deviceId);
				renderDevices();
				addEvent({ type: 'Device left', timestamp: new Date().toISOString(), details: `${departedLabel} · ${MonitorPage.describeDeviceCount(deviceById)}` });
			}
			if ((message.type === 'task.accepted' || message.type === 'task.snapshot') && message.task !== undefined) {
				taskPanel.snapshot = message.task;
				if (taskPanel.update?.taskId !== message.task.taskId) taskPanel.update = undefined;
				renderTask();
				addEvent({ type: message.type === 'task.accepted' ? 'Task accepted' : 'Task state received', timestamp: new Date().toISOString(), details: MonitorPage.taskSummary(taskPanel) });
			}
			if (message.type === 'task.updated' && message.update !== undefined) {
				if (taskPanel.snapshot?.taskId !== message.update.taskId) taskPanel.snapshot = undefined;
				taskPanel.update = message.update;
				renderTask();
				addEvent({ type: 'Task updated', timestamp: new Date().toISOString(), details: MonitorPage.taskSummary(taskPanel) });
			}
			if (deviceMessageTypes.includes(message.type) === false && taskPanelMessageTypes.includes(message.type) === false) addEvent({ type: message.type, timestamp: new Date().toISOString(), details: MonitorPage.describeMessage(message) });
		});
		socketEl.addEventListener('close', (): void => {
			statusEl.textContent = 'Disconnected from the central gateway.';
			statusBadgeEl.textContent = 'Disconnected';
			statusBadgeEl.className = 'badge rounded-pill text-bg-danger';
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Drawing
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Draws one connected device.
	 *
	 * @param device The device to draw.
	 * @param displayLabel The label to head the device with, which is its name on its own unless
	 * another connected device carries that same name.
	 * @param includeStages Whether to list the stages the device advertises, which only
	 * worker devices have.
	 * @returns The markup for the device.
	 */
	private static connectionMarkup(device: DeviceSummary, displayLabel: string, includeStages: boolean): string {
		const stages = includeStages ? `<dt class="col-4 text-secondary">Stages</dt><dd class="col-8"><div class="d-flex flex-wrap gap-1">${device.stageNames.map((stageName) => `<span class="badge text-bg-light border">${MonitorPage.escapeHtml(stageName)}</span>`).join('')}</div></dd>` : '';
		return `<article class="worker-item"><div class="d-flex justify-content-between align-items-center gap-3"><h3 class="h4 mb-1">${MonitorPage.escapeHtml(displayLabel)}</h3><span class="badge rounded-pill text-bg-success">Connected</span></div><dl class="row small mb-0"><dt class="col-4 text-secondary">Device ID</dt><dd class="col-8 text-break">${MonitorPage.escapeHtml(device.deviceId)}</dd>${stages}<dt class="col-4 text-secondary">Connected</dt><dd class="col-8">${MonitorPage.escapeHtml(MonitorPage.formatTime(device.connectedAt))}</dd><dt class="col-4 text-secondary">Last seen</dt><dd class="col-8">${MonitorPage.escapeHtml(MonitorPage.formatTime(device.lastSeenAt))}</dd></dl></article>`;
	}

	/**
	 * Escapes text so it can be placed inside markup.
	 *
	 * @param value The text to escape.
	 * @returns The text with every character that has meaning in markup replaced.
	 */
	private static escapeHtml(value: string): string {
		return value
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#039;');
	}

	/**
	 * Writes a timestamp as a local time of day.
	 *
	 * @param timestamp The moment, as ISO 8601 text.
	 * @returns The time of day in the reader's own locale.
	 */
	private static formatTime(timestamp: string): string {
		return new Date(timestamp).toLocaleTimeString();
	}

	/**
	 * Counts the currently known devices for the recent gateway events list.
	 *
	 * @param deviceById Every device the page currently knows about, keyed by device identifier.
	 * @returns A sentence such as "2 workers, 1 consumer".
	 */
	private static describeDeviceCount(deviceById: Map<string, Device>): string {
		const devices = Dashboard.splitDevices([...deviceById.values()]);
		const workerCount = devices.worker.length;
		const consumerCount = devices.consumer.length;
		return `${workerCount} worker${workerCount === 1 ? '' : 's'}, ${consumerCount} consumer${consumerCount === 1 ? '' : 's'}`;
	}

	/**
	 * Describes a gateway message for the recent gateway events list. An error message shows
	 * its own code and text, so the reason is readable on the page instead of being hidden
	 * behind a generic line.
	 *
	 * @param message The gateway message that was received.
	 * @returns The text to show underneath the message type.
	 */
	private static describeMessage(message: GatewayMessage): string {
		if (message.type !== 'error') return 'Gateway message received';
		return `${message.code ?? 'UNKNOWN'}: ${message.message ?? 'No description was provided'}`;
	}

	/**
	 * Describes the most recent task for the task panel.
	 *
	 * @param panel What the page knows about that task.
	 * @returns The task type, its state, and its input, as far as this connection may read them.
	 */
	private static taskSummary(panel: TaskPanelState): string {
		const state = panel.update?.state ?? panel.snapshot?.state ?? 'unknown';
		const taskInput = panel.snapshot?.input;
		if (taskInput === undefined) return `Task · ${state} · input: not known to this connection`;
		return `${taskTypeDisplayNames[taskInput.taskType]} · ${state} · input: ${String(taskInput.input).slice(0, 80)}`;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Page Furniture
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Finds one element the page needs.
	 *
	 * @param selector The element to find.
	 * @returns The matching element.
	 * @throws If the page holds no such element.
	 */
	private static getElement(selector: string): HTMLElement {
		const element: Element | null = document.querySelector(selector);
		if ((element instanceof HTMLElement) === false) throw new Error(`Element ${selector} was not found`);
		return element;
	}

	/** Remembers which panels the reader folded away, for the next visit to the page. */
	private static configureFoldablePanels(): void {
		document.querySelectorAll<HTMLDetailsElement>('details[data-foldable-key]').forEach((panel) => {
			const storageKey = `webai-gateway-panel:${panel.dataset.foldableKey ?? 'unknown'}`;
			try {
				panel.open = window.localStorage.getItem(storageKey) === 'open';
			} catch {
				panel.open = false;
			}
			panel.addEventListener('toggle', (): void => {
				try {
					window.localStorage.setItem(storageKey, panel.open ? 'open' : 'closed');
				} catch {
					// Local storage can be unavailable in privacy-restricted browsers.
				}
			});
		});
	}
}

MonitorPage.start();
