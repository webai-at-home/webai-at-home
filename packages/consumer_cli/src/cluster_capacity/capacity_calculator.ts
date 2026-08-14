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
	stageName: string;
	capacity: number;
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
		const stageCapacities: StageCapacity[] = pipeline.stages.map((stage) => ({
			stageName: stage.name,
			capacity: workers
				.filter((worker) => worker.stageNames.includes(stage.name))
				.reduce((sum, worker) => sum + DeviceAvailability.availableCapacity(worker), 0),
		}));
		const bottleneck = stageCapacities.reduce((lowest, current) => (current.capacity < lowest.capacity ? current : lowest));
		const others = stageCapacities.filter((stageCapacity) => stageCapacity !== bottleneck);
		if (others.length === 0) {
			return { capacity: bottleneck.capacity, reason: `${bottleneck.stageName} (${bottleneck.capacity} available slot${bottleneck.capacity === 1 ? '' : 's'})` };
		}
		const highestOther = others.reduce((highest, current) => (current.capacity > highest.capacity ? current : highest));
		return {
			capacity: bottleneck.capacity,
			reason: `${bottleneck.stageName} (${bottleneck.capacity} available slot${bottleneck.capacity === 1 ? '' : 's'} vs ${highestOther.capacity} on ${highestOther.stageName})`,
		};
	}
}
