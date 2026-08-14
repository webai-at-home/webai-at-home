import { ClusterCapacityReader, type TaskTypeName } from '@webai/consumer-cli';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelAvailability — which of the offered models the cluster can actually run right now
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What {@link ModelAvailability.availableModelIds} needs to reach the central gateway. */
export type ModelAvailabilityOptions = {
	/** The WebSocket URL of the central gateway. */
	gatewayUrl: string;
	/** The bearer token the central gateway requires. */
	authToken: string;
	/** How long to wait for the central gateway to answer, in milliseconds. */
	timeoutMs: number;
};

/**
 * Reads which of this server's models the connected workers can currently run.
 *
 * A model identifier is a cluster task type name, so the question "can this model be run" is the
 * question `consumer_cli capacity` answers, and it is answered by the same `ClusterCapacityReader`
 * rather than by a second estimate written here. Each read opens one observer connection, takes
 * one snapshot of the connected devices and the registered pipelines, and closes it again, so this
 * server never holds a copy of the cluster's device list. See
 * [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
 */
export class ModelAvailability {
	/**
	 * @param options Where to reach the central gateway, and how long to wait for it.
	 * @returns The model identifiers the cluster can run at least one concurrent request of, in
	 * the order the task types are declared.
	 * @throws {CliError} If the connection, the authentication, or the snapshot fails.
	 */
	static async availableModelIds(options: ModelAvailabilityOptions): Promise<TaskTypeName[]> {
		const capacities = await ClusterCapacityReader.read({
			url: options.gatewayUrl,
			authToken: options.authToken,
			timeoutMs: options.timeoutMs,
		});
		return capacities
			.filter((capacity) => capacity.capacity > 0)
			.map((capacity) => capacity.type);
	}
}
