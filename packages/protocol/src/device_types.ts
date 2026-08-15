import { z } from 'zod';
import type { StageName } from './task/pipeline_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DeviceTypes — one connected device, as the gateway describes it
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What a connected device is here to do. */
export const DeviceRole = z.enum(['worker', 'consumer']);
/** What a connected device is here to do. */
export type DeviceRole = z.infer<typeof DeviceRole>;

/** One connected device, as the gateway describes it to the pages that display it. */
export type Device = {
	deviceId: string;
	name: string;
	deviceRole: DeviceRole;
	stageNames: StageName[];
	connectedAt: string;
	lastSeenAt: string;
	/**
	 * The address the gateway saw this device connect from, observed once when the connection
	 * opened and never afterwards. A device never declares it, so a device cannot choose what is
	 * recorded here. It is absent when the gateway could not observe an address at all.
	 */
	ipAddress?: string;
	workerState?: 'ready' | 'draining' | undefined;
	authIdentity?: string;
	ready?: boolean;
	maxConcurrentAssignments?: number;
	activeAssignments?: number;
	deviceListRevision?: number;
};

/**
 * The device fields that change as work is assigned to a device and returned by it, as
 * opposed to the fields that describe the device itself.
 *
 * These fields change far more often than the rest of a device record: a worker's
 * `activeAssignments` count moves up when a stage is assigned and down when the result
 * arrives, twice per stage. They are sent on their own, in `device.activity`, so a
 * counter moving from 0 to 1 does not re-transmit the device's name and stage list.
 */
export type DeviceActivity = {
	deviceId: string;
	lastSeenAt: string;
	workerState?: 'ready' | 'draining' | undefined;
	ready?: boolean | undefined;
	activeAssignments?: number | undefined;
};

/** The device fields carried by `DeviceActivity`, in the order a device record declares them. */
export const deviceActivityFieldNames = ['lastSeenAt', 'workerState', 'ready', 'activeAssignments'] as const;
