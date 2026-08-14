import type { Device, PipelineSpecification } from '@webai/protocol';
import { DeviceAvailability } from './device_availability.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCalculator — how many concurrent runs of a pipeline the cluster can support
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How many concurrent runs of one pipeline the connected workers can currently support. */
export type CapacityResult = {
	/** How many concurrent runs the cluster can currently support. */
	capacity: number;
	/** A one-line, human-readable statement of what is limiting that number. */
	reason: string;
};

/** How available one stage's advertising workers currently are, added up. */
type StageCapacity = {
	/** The name of the stage, as the pipeline specification spells it. */
	stageName: string;
	/** The free slots on every worker advertising this stage, added up. */
	capacity: number;
	/** How many connected workers advertise this stage, free or not. */
	advertisingWorkerCount: number;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Capacity Calculator
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Estimates how many concurrent runs of a pipeline the currently connected workers can
 * support, from the pipeline's own specification and the live device list.
 *
 * One run's stages may be spread across different workers, whatever the pipeline is, so the
 * capacity is set by whichever stage has the least free capacity behind it. `prefersSameWorkerOnRetry`
 * does not change that: it pins one stage to the worker that already ran that same stage, not
 * the whole pipeline to one worker, so a pipeline of three language-model shards runs on three
 * workers advertising one shard each, each shard going back to its own worker every round.
 */
export class CapacityCalculator {
	/**
	 * @param pipeline The pipeline specification to estimate capacity for.
	 * @param devices The currently connected devices, worker and consumer alike.
	 * @returns The estimated concurrent-run capacity, with a one-line reason.
	 */
	static calculate(pipeline: PipelineSpecification, devices: Device[]): CapacityResult {
		const workers = devices.filter((device) => device.deviceRole === 'worker');
		return CapacityCalculator._bottleneckStageCapacity(pipeline, workers);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Formula
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * The bottleneck-stage formula: each stage can run on a different worker, so capacity is
	 * set by whichever stage has the least free capacity behind it.
	 *
	 * @param pipeline The pipeline to estimate capacity for.
	 * @param workers The currently connected worker devices.
	 * @returns The estimated concurrent-run capacity, with a one-line reason.
	 */
	private static _bottleneckStageCapacity(pipeline: PipelineSpecification, workers: Device[]): CapacityResult {
		const stageCapacities: StageCapacity[] = pipeline.stages.map((stage) => {
			const advertisingWorkers = workers.filter((worker) => worker.stageNames.includes(stage.name));
			return {
				stageName: stage.name,
				capacity: advertisingWorkers.reduce((sum, worker) => sum + DeviceAvailability.availableCapacity(worker), 0),
				advertisingWorkerCount: advertisingWorkers.length,
			};
		});
		const bottleneck = stageCapacities.reduce((lowest, current) => (current.capacity < lowest.capacity ? current : lowest));
		return {
			capacity: bottleneck.capacity,
			reason: CapacityCalculator._reason(stageCapacities, bottleneck),
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Reasons
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Writes the one line that says what is holding the capacity down.
	 *
	 * A stage nobody advertises and a stage every advertising worker is too busy to take are
	 * two different problems with the same capacity of zero, so they are stated separately
	 * rather than both being called an absence of free slots. Every unadvertised stage is
	 * named at once, because naming only the first of them reads as though the rest were fine.
	 *
	 * @param stageCapacities How free every stage of the pipeline currently is.
	 * @param bottleneck The stage with the least free capacity behind it.
	 * @returns The one-line reason.
	 */
	private static _reason(stageCapacities: StageCapacity[], bottleneck: StageCapacity): string {
		const unadvertised = stageCapacities.filter((stageCapacity) => stageCapacity.advertisingWorkerCount === 0);
		if (unadvertised.length > 0) {
			const stageWord = unadvertised.length === 1 ? 'stage' : 'stages';
			const names = unadvertised.map((stageCapacity) => stageCapacity.stageName).join(', ');
			return `no connected worker runs ${stageWord} ${names}`;
		}
		if (bottleneck.capacity === 0) {
			return `every one of the ${CapacityCalculator._workerCount(bottleneck.advertisingWorkerCount)} running ${bottleneck.stageName} is busy, draining, or not ready`;
		}
		const free = `${bottleneck.capacity} free slot${bottleneck.capacity === 1 ? '' : 's'} across ${CapacityCalculator._workerCount(bottleneck.advertisingWorkerCount)}`;
		if (stageCapacities.length === 1) {
			return `${bottleneck.stageName} has ${free}`;
		}
		const tied = stageCapacities.filter((stageCapacity) => stageCapacity.capacity === bottleneck.capacity);
		if (tied.length === stageCapacities.length) {
			return `every one of the ${stageCapacities.length} stages of the pipeline has ${bottleneck.capacity} free slot${bottleneck.capacity === 1 ? '' : 's'} behind it`;
		}
		return `${bottleneck.stageName} is the narrowest stage of the pipeline, with ${free}`;
	}

	/**
	 * Writes a worker count with the right singular or plural noun after it.
	 *
	 * @param count How many workers.
	 * @returns The count and the noun, such as `1 worker` or `3 workers`.
	 */
	private static _workerCount(count: number): string {
		return `${count} worker${count === 1 ? '' : 's'}`;
	}
}
