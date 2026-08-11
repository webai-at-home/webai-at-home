///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	@webai/consumer-cli — the public entry point for reusable consumer symbols
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What a package outside the command-line program may import from `@webai/consumer-cli`.
 *
 * `Cli`, the command-line program itself, is not exported here: it is the entry point of
 * this package's own `bin`, not a symbol another package reuses. `./libs/consumer_client`
 * and `./libs/task_input_factory` remain available as their own stable subpaths alongside
 * this entry point, matching how `@webai/protocol` exposes both a `.` entry point and named
 * subpaths such as `./envelope`.
 */
export { ConsumerClient, type ConsumerClientCallbacks, type TaskSocket } from './gateway_connection/consumer_client.js';
export {
	TaskInputFactory,
	taskTypeNames,
	taskTypeNamesAcceptingHistory,
	taskTypeNamesAcceptingTools,
	type TaskTypeName,
	type TaskTypeNameAcceptingHistory,
	type TaskTypeNameAcceptingTools,
} from './libs/task_input_factory.js';
