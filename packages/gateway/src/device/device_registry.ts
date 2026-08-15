import type { Device, StageName } from '@webai/protocol';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceRegistry — holds the connected devices and finds a worker for a stage
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What storing a device changed, so the caller can tell a new device and a change to a
 * device's own description apart from a change to how busy the device is.
 *
 * `unchanged` means nothing worth announcing moved. The most common cause is a refreshed
 * `lastSeenAt` on its own, which happens on every message a device sends.
 */
export type DeviceRegistryChange = {
	kind: 'joined' | 'stable_changed' | 'activity_changed' | 'unchanged';
	device: Device;
	deviceListRevision: number;
};

/** The device fields that describe the device itself, rather than how busy it is. */
const stableFieldNames = ['name', 'deviceRole', 'connectedAt', 'ipAddress', 'authIdentity', 'maxConcurrentAssignments'] as const;

/** The device fields that change as work is assigned to a device and returned by it. */
const activityFieldNames = ['workerState', 'ready', 'activeAssignments'] as const;

/** Maintains the devices connected to the gateway. */
export class DeviceRegistry {
	private readonly devices = new Map<string, Device>();
	private deviceListRevision = 0;

	/**
	 * Adds a device or replaces the device with the same identifier.
	 *
	 * A replacement that moves nothing but `lastSeenAt` is stored without spending a
	 * membership revision, and is reported as `unchanged`. A liveness timestamp that
	 * nobody displays to the millisecond does not justify announcing a change.
	 *
	 * @param device - The device to store.
	 * @returns What the stored device changed.
	 */
	add(device: Device): DeviceRegistryChange {
		const previous = this.devices.get(device.deviceId);
		if (previous === undefined) return { kind: 'joined', device: this._store(device, ++this.deviceListRevision), deviceListRevision: this.deviceListRevision };

		const isStableChanged = stableFieldNames.some((fieldName) => previous[fieldName] !== device[fieldName])
			|| DeviceRegistry._isStageListChanged(previous.stageNames, device.stageNames);
		const isActivityChanged = activityFieldNames.some((fieldName) => previous[fieldName] !== device[fieldName]);
		if (isStableChanged === false && isActivityChanged === false) {
			return { kind: 'unchanged', device: this._store(device, previous.deviceListRevision), deviceListRevision: this.deviceListRevision };
		}

		const stored = this._store(device, ++this.deviceListRevision);
		return { kind: isStableChanged ? 'stable_changed' : 'activity_changed', device: stored, deviceListRevision: this.deviceListRevision };
	}

	/**
	 * Removes a device by its identifier.
	 *
	 * @param deviceId - The device identifier to remove.
	 */
	remove(deviceId: string): { deviceId: string; deviceListRevision: number } | undefined {
		if (this.devices.delete(deviceId) === false) return undefined;
		return { deviceId, deviceListRevision: ++this.deviceListRevision };
	}

	/**
	 * Looks up a device by its identifier.
	 *
	 * @param deviceId - The device identifier to look up.
	 * @returns The matching device, or `undefined` when no device exists.
	 */
	get(deviceId: string): Device | undefined {
		return this.devices.get(deviceId);
	}

	/**
	 * Returns all currently registered devices.
	 *
	 * @returns A new array containing the registered devices.
	 */
	list(): Device[] {
		return [...this.devices.values()];
	}

	/** Returns the revision the device list is currently at, which rises on every change. */
	currentDeviceListRevision(): number { return this.deviceListRevision; }

	/**
	 * Finds a worker device that supports a stage and is not excluded.
	 *
	 * @param stage - The stage for which a worker device is needed.
	 * @param excluded - Device identifiers that must not be selected.
	 * @returns A suitable worker device, or `undefined` when none is available.
	 */
	findWorker(stage: StageName, excluded: string[] = []): Device | undefined {
		return this.list().find(
			(device) =>
				device.deviceRole === 'worker' &&
				device.workerState !== 'draining' && device.ready !== false &&
				(device.activeAssignments ?? 0) < (device.maxConcurrentAssignments ?? 1) &&
				device.stageNames.includes(stage) &&
				excluded.includes(device.deviceId) === false,
		);
	}

	/**
	 * Reports whether any connected worker device advertises a stage, regardless of whether it
	 * currently has free capacity to run it.
	 *
	 * @param stage - The stage to check for.
	 * @returns `true` when at least one connected worker device offers the stage.
	 */
	hasWorkerForStage(stage: StageName): boolean {
		return this.list().some((device) => device.deviceRole === 'worker' && device.stageNames.includes(stage));
	}

	/**
	 * Reports whether two stage lists differ, in contents or in order.
	 *
	 * @param previous - The stage list the device previously advertised.
	 * @param current - The stage list the device now advertises.
	 * @returns `true` when the two lists are not the same.
	 */
	private static _isStageListChanged(previous: StageName[], current: StageName[]): boolean {
		if (previous.length !== current.length) return true;
		return previous.some((stageName, index) => stageName !== current[index]);
	}

	/**
	 * Stores a device under a device-list revision.
	 *
	 * @param device - The device to store.
	 * @param deviceListRevision - The revision to stamp on the stored device.
	 * @returns The stored device.
	 */
	private _store(device: Device, deviceListRevision: number | undefined): Device {
		const stored = { ...device, ...(deviceListRevision === undefined ? {} : { deviceListRevision }) };
		this.devices.set(device.deviceId, stored);
		return stored;
	}
}
