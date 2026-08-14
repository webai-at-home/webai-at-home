///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	@webai/consumer-cli — the public entry point for reusable consumer symbols
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What a package outside the command-line program may import from `@webai/consumer-cli`.
 *
 * `Cli`, the command-line program itself, is not exported here: reusing its individual pieces is
 * different from running the whole program, which is what its own `bin` is for. `webai-at-home`,
 * which dispatches to this program's own `Cli.run` wholesale rather than reusing a piece of it, is
 * the one sanctioned exception, and imports it through the dedicated `./cli` subpath instead —
 * see issue #170. `./libs/consumer_client` and `./libs/task_input_factory` remain available as
 * their own stable subpaths alongside this entry point, matching how `@webai/protocol` exposes
 * both a `.` entry point and named subpaths such as `./envelope`.
 */
export { ConsumerClient, type ConsumerClientCallbacks, type TaskSocket } from './gateway_connection/consumer_client.js';
export {
	ClusterCapacityReader,
	type ClusterCapacityReaderOptions,
	type TaskTypeCapacity,
} from './cluster_capacity/cluster_capacity_reader.js';
export {
	TaskInputFactory,
	taskTypeNames,
	taskTypeNamesAcceptingHistory,
	taskTypeNamesAcceptingTools,
	type TaskTypeName,
	type TaskTypeNameAcceptingHistory,
	type TaskTypeNameAcceptingTools,
} from './libs/task_input_factory.js';
