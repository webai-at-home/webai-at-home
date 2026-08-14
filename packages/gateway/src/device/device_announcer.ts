import type { Device, DeviceActivity } from '@webai/protocol';
import type { ConnectionHub } from '../connection/connection_hub.js';
import type { DeviceRegistry, DeviceRegistryChange } from './device_registry.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceAnnouncer — tells the connections that asked what changed about the connected devices
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Announces device arrivals, departures, description changes, and how busy each device is.
 *
 * A new device and a change to a device's own description are announced immediately, because
 * a dashboard showing a stale list is plainly wrong. How busy a device is changes far more
 * often — a worker's assignment counter moves twice per stage — so those changes are batched
 * into one combined message per short window.
 */
export class DeviceAnnouncer {
	/** The devices whose activity changed and has not been announced yet. */
	private readonly pendingActivityDeviceIds = new Set<string>();
	/** The pending timer that sends the next combined activity message. */
	private activityTimer: NodeJS.Timeout | undefined;

	/**
	 * @param deviceRegistry The registry the device records are read from.
	 * @param hub The connections to announce to.
	 * @param coalesceMs How long activity changes are batched before one combined message.
	 */
	constructor(
		private readonly deviceRegistry: DeviceRegistry,
		private readonly hub: ConnectionHub,
		private readonly coalesceMs: number,
	) { }

	/**
	 * Returns the connected devices that can work on task stages.
	 *
	 * @returns The currently connected worker devices.
	 */
	workerDevices(): Device[] {
		return this.deviceRegistry.list().filter((device) => device.deviceRole === 'worker');
	}

	/** Returns every registered device for gateway observers and status updates. */
	connectedDevices(): Device[] {
		return this.deviceRegistry.list();
	}

	/**
	 * Announces what storing a device changed.
	 *
	 * A change that moved nothing worth announcing is dropped.
	 *
	 * @param change What storing the device changed, or the removal of a device.
	 */
	publishDevice(change: DeviceRegistryChange | ReturnType<DeviceRegistry['remove']>): void {
		if (change === undefined) return;
		if ('deviceId' in change && 'device' in change === false) {
			this.pendingActivityDeviceIds.delete(change.deviceId);
			this.hub.sendToDeviceSubscribers({ type: 'device.left', deviceId: change.deviceId, deviceListRevision: change.deviceListRevision });
			return;
		}
		const deviceChange = change as DeviceRegistryChange;
		if (deviceChange.kind === 'unchanged') return;
		if (deviceChange.kind === 'activity_changed') {
			this.queueDeviceActivity(deviceChange.device.deviceId);
			return;
		}
		this.hub.sendToDeviceSubscribers({ type: deviceChange.kind === 'joined' ? 'device.joined' : 'device.updated', device: deviceChange.device, deviceListRevision: deviceChange.deviceListRevision });
	}

	/**
	 * Notes that a worker has finished one assignment, and announces the change.
	 *
	 * @param workerDeviceId The worker that finished an assignment.
	 */
	releaseWorkerAssignment(workerDeviceId: string): void {
		const device = this.deviceRegistry.get(workerDeviceId);
		if (device === undefined || device.deviceRole !== 'worker') return;
		this.publishDevice(this.deviceRegistry.add({ ...device, activeAssignments: Math.max(0, (device.activeAssignments ?? 0) - 1), lastSeenAt: new Date().toISOString() }));
	}

	/**
	 * Notes that a worker has taken on one more assignment, and announces the change.
	 *
	 * @param workerDeviceId The worker that took on an assignment.
	 */
	occupyWorkerAssignment(workerDeviceId: string): void {
		const device = this.deviceRegistry.get(workerDeviceId);
		if (device === undefined || device.deviceRole !== 'worker') return;
		this.publishDevice(this.deviceRegistry.add({ ...device, activeAssignments: (device.activeAssignments ?? 0) + 1, lastSeenAt: new Date().toISOString() }));
	}

	/**
	 * Notes that a device answered a WebSocket ping, and announces the refreshed liveness time.
	 *
	 * A device that is connected but has no work to do sends no protocol message at all, so
	 * without this its `lastSeenAt` would stay frozen at the moment it connected and a dashboard
	 * would show it as unheard from for as long as it stayed idle. Answering a ping is the one
	 * sign of life such a device gives, so it is announced on its own. `DeviceRegistry.add`
	 * reports a change that moved nothing but `lastSeenAt` as `unchanged`, so the announcement is
	 * queued here rather than left to `publishDevice`.
	 *
	 * @param deviceId The device whose connection answered a ping.
	 */
	noteDeviceAnsweredPing(deviceId: string): void {
		const device = this.deviceRegistry.get(deviceId);
		if (device === undefined) return;
		this.deviceRegistry.add({ ...device, lastSeenAt: new Date().toISOString() });
		this.queueDeviceActivity(deviceId);
	}

	/** Cancels any pending activity message, so the process can exit promptly. */
	stop(): void {
		if (this.activityTimer !== undefined) clearTimeout(this.activityTimer);
		this.activityTimer = undefined;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Activity Batching
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Adds a device to the batch whose activity is announced when the batching window closes,
	 * and starts that window when it is not already open.
	 *
	 * @param deviceId The device whose activity changed.
	 */
	private queueDeviceActivity(deviceId: string): void {
		if (this.hub.deviceSubscriberIds.size === 0) return;
		this.pendingActivityDeviceIds.add(deviceId);
		if (this.activityTimer === undefined) this.activityTimer = setTimeout((): void => this.flushDeviceActivity(), this.coalesceMs);
	}

	/**
	 * Sends one combined `device.activity` message for every device whose activity changed
	 * since the last flush, then clears the batch.
	 */
	private flushDeviceActivity(): void {
		this.activityTimer = undefined;
		const devices = [...this.pendingActivityDeviceIds]
			.map((deviceId) => this.deviceRegistry.get(deviceId))
			.filter((device): device is Device => device !== undefined)
			.map((device) => DeviceAnnouncer.deviceActivityOf(device));
		this.pendingActivityDeviceIds.clear();
		if (devices.length === 0 || this.hub.deviceSubscriberIds.size === 0) return;
		this.hub.sendToDeviceSubscribers({ type: 'device.activity', devices, deviceListRevision: this.deviceRegistry.currentDeviceListRevision() });
	}

	/**
	 * Reduces a device record to the fields that change as work is assigned to it.
	 *
	 * @param device The device to reduce.
	 * @returns The device's activity fields.
	 */
	private static deviceActivityOf(device: Device): DeviceActivity {
		return {
			deviceId: device.deviceId,
			lastSeenAt: device.lastSeenAt,
			...(device.workerState === undefined ? {} : { workerState: device.workerState }),
			...(device.ready === undefined ? {} : { ready: device.ready }),
			...(device.activeAssignments === undefined ? {} : { activeAssignments: device.activeAssignments }),
		};
	}
}
