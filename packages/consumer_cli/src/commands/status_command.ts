import type { Device } from '@webai/protocol';
import { GatewayHealthReader } from '../gateway_connection/gateway_health_reader.js';
import { GatewaySession } from '../gateway_connection/gateway_session.js';
import { DeviceAvailability } from '../cluster_capacity/device_availability.js';
import type { CliError } from '../libs/cli_errors.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	StatusCommand — prints the worker cluster's current state
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The ways `status` can write each snapshot out. */
export type StatusFormat = 'text' | 'markdown' | 'json';

/** Every format `status` accepts, in the order the help text lists them. */
export const statusFormats: StatusFormat[] = ['text', 'markdown', 'json'];

/** What `consumer_cli status` needs to connect and how to report what it sees. */
export type StatusCommandOptions = {
	url: string;
	authToken: string;
	timeoutMs: number;
	watch: boolean;
	format: StatusFormat;
};

/** One worker device, as `status` prints it. */
type StatusWorkerRow = {
	deviceId: string;
	name: string;
	/**
	 * The address the gateway saw this worker connect from, or an empty string when the gateway
	 * recorded no address for it.
	 */
	ipAddress: string;
	stageNames: string[];
	workerState: string;
	activeAssignments: number;
	maxConcurrentAssignments: number;
	lastSeenAt: string;
};

/** The worker cluster state `status` prints, either as a table or as JSON. */
type StatusSnapshot = {
	/** The address of the central gateway this snapshot was read from. */
	gatewayUrl: string;
	/**
	 * The git commit that central gateway was built from, or an empty string when the gateway did
	 * not name one.
	 */
	gatewayCommitSha: string;
	workerCount: number;
	readyCount: number;
	drainingCount: number;
	unavailableCount: number;
	totalCapacity: number;
	activeAssignments: number;
	availableCapacity: number;
	workers: StatusWorkerRow[];
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Status Command
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Connects to the central gateway as an observer and prints the current worker cluster
 * state: how many workers are connected, how much of their advertised capacity is free, and
 * one row per worker. Without `--watch`, it prints one snapshot and exits. With `--watch`, it
 * reprints on every subsequent change until interrupted or disconnected.
 */
export class StatusCommand {
	/**
	 * @param options Where to connect, how to report, and whether to keep watching.
	 * @throws {CliError} If the connection, authentication, or first snapshot fails.
	 */
	static async run(options: StatusCommandOptions): Promise<void> {
		// Read once, before the connection is opened, because the build a gateway is running does
		// not change while `status` watches it: a gateway that is rebuilt is a gateway that
		// restarted, which drops the connection this command is holding.
		const gatewayCommitSha = await GatewayHealthReader.readCommitSha(options.url, options.timeoutMs);
		const render = (devices: Device[]): void => {
			const snapshot = StatusCommand._buildSnapshot(devices, options.url, gatewayCommitSha);
			console.log(StatusCommand._format(snapshot, options.format));
		};

		const session = await GatewaySession.connect({
			url: options.url,
			authToken: options.authToken,
			timeoutMs: options.timeoutMs,
			onDevices: render,
			...(options.watch ? {
				onConnectionLost: (error: CliError): void => {
					console.error(error.message);
					process.exitCode = error.exitCode;
				},
			} : {}),
		});

		if (options.watch === false) {
			session.close();
			return;
		}

		// The connection stays open for `--watch`, so this only settles on a clean interrupt;
		// an unexpected disconnect is reported through `onConnectionLost` above instead.
		await new Promise<void>((resolve) => {
			process.once('SIGINT', (): void => {
				session.close();
				process.exitCode = 0;
				resolve();
			});
		});
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Formatting
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reports whether a string names a format this class can write.
	 *
	 * @param value The value to check, as typed on the command line.
	 * @returns `true` when the value names a format.
	 */
	static isFormat(value: string): value is StatusFormat {
		return (statusFormats as string[]).includes(value);
	}

	/**
	 * Writes a snapshot out in the requested format.
	 *
	 * @param snapshot The worker cluster state to print.
	 * @param format Which format to write.
	 * @returns The snapshot as one string, ready to print.
	 */
	private static _format(snapshot: StatusSnapshot, format: StatusFormat): string {
		if (format === 'json') {
			return JSON.stringify(snapshot, null, 2);
		}
		if (format === 'markdown') {
			return StatusCommand._formatMarkdown(snapshot);
		}
		return StatusCommand._formatHuman(snapshot);
	}

	/**
	 * Builds the snapshot `status` prints, from the live device list.
	 *
	 * @param devices Every currently connected device, worker and consumer alike.
	 * @param gatewayUrl The address of the central gateway the device list was read from.
	 * @param gatewayCommitSha The git commit that gateway was built from, when it named one.
	 * @returns The worker cluster state to print.
	 */
	private static _buildSnapshot(devices: Device[], gatewayUrl: string, gatewayCommitSha?: string): StatusSnapshot {
		const workers = devices.filter((device) => device.deviceRole === 'worker');
		const drainingCount = workers.filter((worker) => worker.workerState === 'draining').length;
		const readyCount = workers.filter((worker) => worker.workerState !== 'draining' && DeviceAvailability.isAvailable(worker)).length;
		const unavailableCount = workers.length - readyCount - drainingCount;
		return {
			gatewayUrl,
			gatewayCommitSha: gatewayCommitSha ?? '',
			workerCount: workers.length,
			readyCount,
			drainingCount,
			unavailableCount,
			totalCapacity: workers.reduce((sum, worker) => sum + (worker.maxConcurrentAssignments ?? 1), 0),
			activeAssignments: workers.reduce((sum, worker) => sum + (worker.activeAssignments ?? 0), 0),
			availableCapacity: workers.reduce((sum, worker) => sum + DeviceAvailability.availableCapacity(worker), 0),
			workers: workers.map((worker) => ({
				deviceId: worker.deviceId,
				name: worker.name,
				ipAddress: worker.ipAddress ?? '',
				stageNames: worker.stageNames,
				workerState: worker.workerState ?? 'ready',
				activeAssignments: worker.activeAssignments ?? 0,
				maxConcurrentAssignments: worker.maxConcurrentAssignments ?? 1,
				lastSeenAt: worker.lastSeenAt,
			})),
		};
	}

	/**
	 * Formats a snapshot as the human-readable table `status` prints by default.
	 *
	 * @param snapshot The worker cluster state to print.
	 * @returns The table text, ready to print with a single `console.log`.
	 */
	private static _formatHuman(snapshot: StatusSnapshot): string {
		const lines: string[] = [];
		lines.push(`gateway ${snapshot.gatewayUrl}${StatusCommand._displayedCommit(snapshot)}`);
		lines.push(
			`${snapshot.workerCount} worker${snapshot.workerCount === 1 ? '' : 's'} `
			+ `(${snapshot.readyCount} ready, ${snapshot.drainingCount} draining, ${snapshot.unavailableCount} unavailable) · `
			+ `capacity ${snapshot.availableCapacity}/${snapshot.totalCapacity} available, ${snapshot.activeAssignments} active`,
		);
		if (snapshot.workers.length === 0) {
			lines.push('No worker browsers are connected.');
			return lines.join('\n');
		}
		const nameWidth = Math.max(4, ...snapshot.workers.map((worker) => worker.name.length));
		const addressWidth = Math.max(10, ...snapshot.workers.map((worker) => StatusCommand._displayedAddress(worker).length));
		const stateWidth = Math.max(5, ...snapshot.workers.map((worker) => worker.workerState.length));
		lines.push('');
		lines.push(`${'NAME'.padEnd(nameWidth)}  ${'IP ADDRESS'.padEnd(addressWidth)}  ${'STATE'.padEnd(stateWidth)}  CAPACITY  STAGES`);
		for (const worker of snapshot.workers) {
			const capacity = `${worker.activeAssignments}/${worker.maxConcurrentAssignments}`.padEnd(8);
			const address = StatusCommand._displayedAddress(worker).padEnd(addressWidth);
			lines.push(`${worker.name.padEnd(nameWidth)}  ${address}  ${worker.workerState.padEnd(stateWidth)}  ${capacity}  ${worker.stageNames.join(', ') || '-'}`);
		}
		return lines.join('\n');
	}

	/**
	 * Formats a snapshot as a Markdown document.
	 *
	 * @param snapshot The worker cluster state to print.
	 * @returns The Markdown text, ready to print with a single `console.log`.
	 */
	private static _formatMarkdown(snapshot: StatusSnapshot): string {
		const lines: string[] = [];
		lines.push('# Worker cluster status');
		lines.push('');
		lines.push(`gateway ${snapshot.gatewayUrl}${StatusCommand._displayedCommit(snapshot)}`);
		lines.push('');
		lines.push(
			`${snapshot.workerCount} worker${snapshot.workerCount === 1 ? '' : 's'} `
			+ `(${snapshot.readyCount} ready, ${snapshot.drainingCount} draining, ${snapshot.unavailableCount} unavailable) — `
			+ `capacity ${snapshot.availableCapacity}/${snapshot.totalCapacity} available, ${snapshot.activeAssignments} active`,
		);
		if (snapshot.workers.length === 0) {
			lines.push('');
			lines.push('No worker browsers are connected.');
			return lines.join('\n');
		}
		lines.push('');
		lines.push('| NAME | IP ADDRESS | STATE | CAPACITY | STAGES |');
		lines.push('| --- | --- | --- | --- | --- |');
		for (const worker of snapshot.workers) {
			const capacity = `${worker.activeAssignments}/${worker.maxConcurrentAssignments}`;
			lines.push(`| ${worker.name} | ${StatusCommand._displayedAddress(worker)} | ${worker.workerState} | ${capacity} | ${worker.stageNames.join(', ') || '-'} |`);
		}
		return lines.join('\n');
	}

	/**
	 * Writes the git commit of the central gateway as the header line prints it.
	 *
	 * A gateway that named no commit adds nothing to the line, rather than a word saying the commit
	 * is missing: the header names where the snapshot came from, and a gateway reached over the
	 * WebSocket endpoint alone is still the gateway this snapshot came from.
	 *
	 * @param snapshot The worker cluster state to print.
	 * @returns The text to add to the header line, which is empty when the gateway named no commit.
	 */
	private static _displayedCommit(snapshot: StatusSnapshot): string {
		if (snapshot.gatewayCommitSha === '') {
			return '';
		}
		return ` commit ${snapshot.gatewayCommitSha}`;
	}

	/**
	 * Writes the address of one worker as a table prints it.
	 *
	 * @param worker The worker row to read the address from.
	 * @returns The address, or `-` when the gateway recorded no address for that worker.
	 */
	private static _displayedAddress(worker: StatusWorkerRow): string {
		if (worker.ipAddress === '') {
			return '-';
		}
		return worker.ipAddress;
	}
}
