import type { Device, PipelineSpecification, TaskType } from '@webai/protocol';
import { GatewaySession } from '../gateway_connection/gateway_session.js';
import { taskTypeNames, type TaskTypeName } from '../libs/task_input_factory.js';
import { CapacityCalculator } from './capacity_calculator.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ClusterCapacityReader — takes one snapshot of the cluster and estimates capacity per task type
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What {@link ClusterCapacityReader.read} needs to connect, and which task types to estimate. */
export type ClusterCapacityReaderOptions = {
	/** The WebSocket URL of the central gateway. */
	url: string;
	/** The bearer token the central gateway requires. */
	authToken: string;
	/** How long to wait for the central gateway to answer, in milliseconds. */
	timeoutMs: number;
	/** Which task types to estimate capacity for. Defaults to every task type the cluster runs. */
	taskTypeNames?: readonly TaskTypeName[];
};

/**
 * How many concurrent runs of one task type the cluster can currently support.
 *
 * The field names are the ones `capacity --format json` has always printed, so that what this
 * type holds and what that subcommand writes out stay the same thing.
 */
export type TaskTypeCapacity = {
	/** The task type name, without the leading `task_type_`, as `-t/--task_type` spells it. */
	type: TaskTypeName;
	/** The pipeline the estimate was made against, absent when no pipeline serves this task type. */
	pipelineId?: string;
	/** The version of that pipeline, absent when no pipeline serves this task type. */
	pipelineVersion?: number;
	/** How many concurrent runs the cluster can currently support, zero when nobody can run this task type. */
	capacity: number;
	/** A one-line, human-readable statement of what is limiting that number. */
	reason: string;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Cluster Capacity Reader
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Estimates how many concurrent runs of each task type the cluster can currently support.
 *
 * One observer connection is opened, the connected devices and the registered pipelines are read
 * once, and the connection is closed again before anything is computed: `CapacityCalculator` is a
 * local computation over that one snapshot, so estimating every task type costs no more network
 * traffic than estimating one, and no caller has to hold a live copy of the device list.
 *
 * A task type no pipeline serves is reported with a capacity of zero rather than raising, so that
 * a caller listing every task type is not stopped by one of them being unserved. A caller that
 * asked for one particular task type decides for itself whether to treat that as a failure.
 */
export class ClusterCapacityReader {
	/**
	 * @param options Where to connect, and which task types to estimate.
	 * @returns One estimate per requested task type, in the order the task types were requested.
	 * @throws {CliError} If the connection, the authentication, or the device or pipeline
	 * snapshot fails.
	 */
	static async read(options: ClusterCapacityReaderOptions): Promise<TaskTypeCapacity[]> {
		const requestedTaskTypeNames = options.taskTypeNames ?? taskTypeNames;

		let devices: Device[] = [];
		let pipelines: PipelineSpecification[] = [];
		const session = await GatewaySession.connect({
			url: options.url,
			authToken: options.authToken,
			timeoutMs: options.timeoutMs,
			onDevices: (received): void => {
				devices = received;
			},
			onPipelines: (received): void => {
				pipelines = received;
			},
		});
		session.close();

		return ClusterCapacityReader.estimate(pipelines, devices, requestedTaskTypeNames);
	}

	/**
	 * Estimates capacity from a snapshot that has already been taken, without connecting to
	 * anything, which is what makes the estimate readable in a test and reusable by a caller that
	 * holds a snapshot for another reason.
	 *
	 * @param pipelines Every pipeline the central gateway holds.
	 * @param devices Every device connected to the central gateway.
	 * @param requestedTaskTypeNames Which task types to estimate. Defaults to every task type.
	 * @returns One estimate per requested task type, in the order they were requested.
	 */
	static estimate(
		pipelines: PipelineSpecification[],
		devices: Device[],
		requestedTaskTypeNames: readonly TaskTypeName[] = taskTypeNames,
	): TaskTypeCapacity[] {
		return requestedTaskTypeNames.map((taskTypeName) => ClusterCapacityReader._estimateOne(taskTypeName, pipelines, devices));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Estimating
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Estimates one task type's capacity from an already-taken snapshot.
	 *
	 * @param taskTypeName The task type to estimate, without the leading `task_type_`.
	 * @param pipelines Every pipeline the central gateway holds.
	 * @param devices Every device connected to the central gateway.
	 * @returns The estimate, with a capacity of zero when no pipeline serves this task type.
	 */
	private static _estimateOne(taskTypeName: TaskTypeName, pipelines: PipelineSpecification[], devices: Device[]): TaskTypeCapacity {
		const taskType = `task_type_${taskTypeName}` as TaskType;
		const pipeline = ClusterCapacityReader._selectPipeline(pipelines, taskType);
		if (pipeline === undefined) {
			return {
				type: taskTypeName,
				capacity: 0,
				reason: 'no pipeline is registered for this task type',
			};
		}

		const estimate = CapacityCalculator.calculate(pipeline, devices);
		return {
			type: taskTypeName,
			pipelineId: pipeline.pipelineId,
			pipelineVersion: pipeline.version,
			capacity: estimate.capacity,
			reason: estimate.reason,
		};
	}

	/**
	 * Picks the pipeline an estimate is made against, the same way the gateway's own
	 * `PipelineRegistry.select` picks one to run a submitted task through: the highest version,
	 * among pipelines that are not retired.
	 *
	 * @param pipelines Every pipeline the central gateway holds.
	 * @param taskType The task type to find a pipeline for.
	 * @returns The selected pipeline, or `undefined` when none matches.
	 */
	private static _selectPipeline(pipelines: PipelineSpecification[], taskType: TaskType): PipelineSpecification | undefined {
		return pipelines
			.filter((pipeline) => pipeline.taskType === taskType && pipeline.retired !== true)
			.sort((left, right) => right.version - left.version)[0];
	}
}
