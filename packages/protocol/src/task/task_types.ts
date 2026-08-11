import { z } from 'zod';
import type { StagePayload } from '../stage/stage_payload_types.js';
import { HistoryInputSchema } from './history_types.js';
import type { StageName } from './pipeline_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	TaskTypes — what a task is, from the work submitted to the state the gateway holds
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Every state a task may be in, from submission to a terminal state. */
export const TaskState = z.enum(['queued', 'assigned', 'running', 'completed', 'failed', 'cancelled']);
/** Every state a task may be in, from submission to a terminal state. */
export type TaskState = z.infer<typeof TaskState>;

/** The kinds of work a consumer may submit. */
export const TaskType = z.enum([
	'task_type_dev_formula',
	'task_type_llm_qwen3_0_6b_sharded',
	'task_type_llm_gemma_nano_chrome_full',
	'task_type_llm_qwen3_5_0_8b_full',
	'task_type_llm_llama3_2_1b_full',
]);
/** The kinds of work a consumer may submit. */
export type TaskType = z.infer<typeof TaskType>;

/**
 * What a consumer asks for about how its answer is generated, rather than what the answer is
 * about.
 *
 * These settings are stated once, when the task is submitted, and the gateway carries them
 * unchanged to the worker on every `stage.assign` of that task. The gateway does not read
 * them: which of them a stage honours is decided by the code that runs the stage, because a
 * setting means different things to a stage that drives a browser's built-in model and to a
 * stage that runs one shard of a model this project ships.
 *
 * The object refuses a field it does not recognise, rather than dropping it. A setting that is
 * silently dropped changes the answer a consumer receives without telling it anything went
 * wrong, so a consumer that asks for a setting this protocol version does not define has its
 * submission refused and can decide for itself whether to submit again without it.
 *
 * That holds only where both sides know this block exists. A gateway built before it did has
 * no `generationSettings` field on its task input at all, and its task input members are not
 * strict, so it drops the whole block silently and answers as though nothing had been asked
 * for. That is what protocol version 6 exists to state: from that version onward a stage does
 * honour a setting other than `isStreaming`, so an answer produced by a peer that never
 * received the setting really does differ from the answer that was asked for, and the version
 * refusal at authentication time is what stops that answer from being produced at all. See
 * milestone 1 of [issue #151](https://github.com/webai-at-home/webai-at-home/issues/151).
 *
 * Every control below is carried exactly as the consumer asked for it, and is never translated
 * for the engine that will run the task. What `temperature` means to a stage that drives the
 * browser's built-in language model and what it means to a stage that runs one shard of a model
 * this project ships are that stage helper's business, not this block's. Which task type honours
 * which control is written down once, in `generation_control_support.ts`.
 */
export const GenerationSettingsSchema = z.object({
	/**
	 * Whether the consumer wants the answer in pieces as it is produced, rather than in one
	 * result once it is finished.
	 *
	 * Asking for pieces costs a scheduling round for every piece, so it is a per-task choice
	 * rather than how the cluster always behaves. A task that does not ask for it is answered
	 * with the fewest messages the pipeline can manage.
	 */
	isStreaming: z.boolean().optional(),
	/**
	 * How much the model is allowed to prefer a less likely next token, from `0` for none at all
	 * to `2` for a great deal.
	 *
	 * The range is the one the OpenAI Chat Completions interface states, because that is the range
	 * every consumer of this cluster already writes its numbers in. A task that asks for nothing
	 * here is generated the way that task type has always generated, which for two of the four
	 * language-model task types means no sampling whatsoever rather than sampling at a low
	 * temperature.
	 */
	temperature: z.number().min(0).max(2).optional(),
	/**
	 * The share of the probability mass the next token is drawn from, from just above `0` for the
	 * single most likely token to `1` for every token the model considered.
	 *
	 * Named `topP` here for the sampling method it selects, nucleus sampling, which the OpenAI
	 * Chat Completions interface spells `top_p`. A value of `0` is refused rather than accepted,
	 * because it names no tokens at all to draw from.
	 */
	topP: z.number().gt(0).max(1).optional(),
	/**
	 * The largest number of tokens the whole answer may be generated as.
	 *
	 * This is a budget for the answer, not for one run of a stage. A language-model pipeline
	 * repeats its stage once per piece of the answer, and each of those runs already has a
	 * per-run ceiling of its own that the worker sets and a consumer cannot; this number is
	 * counted across every run of the task instead, so that a consumer asking for at most 20
	 * tokens receives at most 20 tokens however many runs produced them.
	 */
	maximumOutputTokenCount: z.number().int().positive().optional(),
	/**
	 * The pieces of text that end the answer as soon as the model writes one of them, with the
	 * piece itself left out of the answer.
	 *
	 * A stop sequence is applied where the tokens are produced, and never by a consumer dropping
	 * pieces of the answer as it forwards them: a stop sequence can straddle two pieces, arriving
	 * one character in one piece and the rest in the next, so a consumer filtering whole pieces
	 * would never see it.
	 */
	stopSequences: z.array(z.string().min(1)).min(1).max(4).optional(),
	/**
	 * The number that decides every random choice made while the answer is generated, so that the
	 * same task submitted twice with the same seed is answered the same way twice.
	 *
	 * Reproducibility is an offer rather than a promise, exactly as it is on the OpenAI Chat
	 * Completions interface: a task type that honours the seed is answered the same way twice on
	 * the same worker with the same model, and nothing here says two different workers agree.
	 */
	randomSeed: z.number().int().optional(),
}).strict();
/** What a consumer asks for about how its answer is generated. */
export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

/**
 * The value a language-model task carries: either one prompt, or a whole history.
 *
 * Which of the two a consumer submits is its own choice, and both remain valid indefinitely. A
 * consumer with one prompt and nothing else to say submits a prompt, which is what
 * `@webai/consumer-cli` does; a consumer with several turns or a system message to pass on submits
 * a history.
 *
 * Only the task types whose stage helper can hand a message list to its model accept this. The
 * others take a prompt and nothing else, so a history is refused for them by this schema
 * rather than by a list kept somewhere else that could drift away from what the workers can
 * actually do. See `HistoryInputSchema` for what carrying a history is worth.
 */
const LlmTaskValueSchema = z.union([z.string(), HistoryInputSchema]);

/** The work submitted with a task: its kind, the value that kind carries, and how to generate it. */
export const TaskInput = z.discriminatedUnion('taskType', [
	z.object({ taskType: z.literal('task_type_dev_formula'), input: z.number().finite(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_qwen3_0_6b_sharded'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_gemma_nano_chrome_full'), input: z.string(), generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_qwen3_5_0_8b_full'), input: LlmTaskValueSchema, generationSettings: GenerationSettingsSchema.optional() }),
	z.object({ taskType: z.literal('task_type_llm_llama3_2_1b_full'), input: LlmTaskValueSchema, generationSettings: GenerationSettingsSchema.optional() }),
]);
/** The work submitted with a task: its kind, the value that kind carries, and how to generate it. */
export type TaskInput = z.infer<typeof TaskInput>;

/** One completed stage: which stage it was, and the value it produced. */
export type StageResult = {
	name: StageName;
	value: StagePayload;
};

/** The complete state of one task, as the gateway holds it. */
export type Task = {
	taskId: string;
	taskRequestId: string;
	consumerDeviceId: string;
	consumerAuthIdentity?: string;
	/**
	 * The account of the participant that submitted this task, when it had authenticated one.
	 *
	 * It is recorded on the task rather than looked up when a stage completes, because a consumer
	 * that submitted batch work is expected to be gone by then: the accounting ledger has to know
	 * whose credit a stage spends whether or not that consumer is still connected. A task submitted
	 * by a connection with no account carries none, and its stages are recorded against the shared
	 * development account instead.
	 */
	consumerAccountId?: string | undefined;
	input: TaskInput;
	state: TaskState;
	completedStages: StageResult[];
	/**
	 * The text produced by the revision this record is currently at, and by no earlier one.
	 *
	 * Unlike every other field here, this describes one revision rather than the task, so it is
	 * dropped by the next revision that does not set it again. It is filled only for a task
	 * that asked for its answer in pieces.
	 */
	newText?: string | undefined;
	/**
	 * Everything the task's answer has produced so far.
	 *
	 * Filled only for a task that asked for its answer in pieces. It is how anyone reading the
	 * whole task can see an answer part-way through, rather than having to have followed every
	 * revision from the start: it appears on a task snapshot, so a reader that missed the
	 * revisions carrying the pieces can read what it missed instead of losing it.
	 *
	 * The pieces are joined as they arrive, and the result that finishes the answer replaces
	 * that joining with the whole answer it carries. A piece is only the device's own account of
	 * how the answer grew, and one can restate what came before it rather than adding to it, so
	 * this is exact once the task is finished and an account of it before then.
	 *
	 * Reaching it after a dropped connection needs an observer grant made before the drop. A
	 * consumer that reconnects is issued a new device identifier and is a stranger to its own
	 * task, which is a limitation of the protocol rather than of this field.
	 */
	generatedText?: string;
	result?: StagePayload;
	error?: string;
	createdAt: string;
	updatedAt: string;
	stageAssignment?: StageAssignment | undefined;
	stageAssignmentAttempts: StageAssignment[];
	/** Number of assignments attempted for the stage that is currently pending. */
	currentStageAttempts: number;
	events: TaskEvent[];
	submissionDeadlineAt: string;
	/** Monotonic task-state revision. Clients ignore older snapshots and resynchronise after gaps. */
	taskRevision: number;
	/**
	 * The pipeline this task runs. Every task selects one when it is submitted, so the stage
	 * sequence is data the task carries rather than a sequence built into the gateway. The
	 * fields stay optional so a task stored by an earlier gateway can still be read back.
	 */
	pipelineId?: string;
	pipelineVersion?: number;
	pipelineStages?: StageName[];
	/**
	 * Whether this task's pipeline runs its stages again from the first once the last stage
	 * finishes, until a stage result reports `done: true`. Copied from the pipeline
	 * specification when the task is created, so advancing a task needs no registry lookup.
	 */
	pipelineRepeatsUntilDone?: boolean;
	/**
	 * Which worker device most recently completed each stage of this task, by stage name.
	 *
	 * A stage that keeps state in the memory of the device running it has to be placed back on
	 * the device that holds that state. Which device that is depends on which stage comes next,
	 * not on which device ran last: in a pipeline that repeats, the device that holds the state
	 * for the upcoming stage is the device that ran that same stage in the previous round.
	 *
	 * The field stays optional so a task stored by an earlier gateway can still be read back.
	 */
	stageWorkerDeviceIds?: Record<StageName, string>;
	acknowledgedStageAssignmentIds?: string[];
};

/** The worker-specific identity of the stage that may currently update a task. */
export type StageAssignment = {
	workerDeviceId: string;
	stageAssignmentId: string;
	attempt: number;
	stage: StageName;
	value: StagePayload;
	leaseUntil: string;
	acceptedAt?: string | undefined;
	retryReason?: StageAssignmentRetryReason | undefined;
};

/** Why an assignment was replaced by a later one. */
export const StageAssignmentRetryReason = z.enum(['lease_expired', 'worker_disconnected', 'worker_relinquished']);
/** Why an assignment was replaced by a later one. */
export type StageAssignmentRetryReason = z.infer<typeof StageAssignmentRetryReason>;

/** One entry in a task's change log. */
export type TaskEvent = {
	type: 'stage_assignment_created' | 'stage_assignment_accepted' | 'stage_assignment_retried' | 'task_cancelled';
	timestamp: string;
	reason?: string | undefined;
	stageAssignmentId?: string | undefined;
	attempt?: number | undefined;
};

/** How many of the most recent task events a `TaskSnapshot` carries. The full change log is available through the `task.history` message. */
export const maximumSnapshotEventCount = 20;

/**
 * The identity of the assignment a task is currently working on, without the stage input
 * value. The assigned worker already received that value in its own `stage.assign`
 * message, and no other recipient of a task update needs it.
 */
export type TaskUpdateAssignment = Omit<StageAssignment, 'value'>;

/**
 * The full current state of one task, as sent when a client asks for a task.
 *
 * This is the authoritative representation of a task. `recentEvents` is a diagnostic
 * change log of the same facts and is never the source of truth; it is truncated to the
 * most recent `maximumSnapshotEventCount` entries.
 *
 * The per-attempt assignment history is deliberately absent. The gateway keeps that
 * history internally to make retry decisions, but it is not part of the protocol,
 * because every attempt carries a full stage input value and the list only ever grows.
 */
export type TaskSnapshot = Omit<Task, 'stageAssignmentAttempts' | 'events' | 'stageAssignment' | 'newText'> & {
	stageAssignment?: TaskUpdateAssignment | undefined;
	recentEvents: TaskEvent[];
};

/**
 * The slim task projection sent on every task revision.
 *
 * It carries only what changes as a task advances, so its size does not grow with the
 * number of stages a task runs. No stage input value appears in it at all, and no value
 * appears twice. The single exception is `result`, which is present only in the final
 * revision of a completed task and is the output the consumer asked for.
 *
 * A client that needs the task input, the completed stage values, or the change log asks
 * for them with `task.get`, `task.resync`, or `task.history`.
 */
export type TaskUpdate = {
	taskId: string;
	taskRevision: number;
	state: TaskState;
	updatedAt: string;
	/** How many stages have completed. This doubles as the index of the stage now running. */
	completedStageCount: number;
	/** The stage the task is currently working on, when a stage is assigned. */
	currentStage?: StageName | undefined;
	/** How many assignments have been attempted for the stage that is currently pending. */
	currentStageAttempts: number;
	stageAssignment?: TaskUpdateAssignment | undefined;
	/**
	 * The text produced since the previous revision of this task.
	 *
	 * Present only on a task that asked for its answer in pieces, through the `isStreaming`
	 * generation setting, and only on a revision that produced text. Joining these in revision
	 * order gives the whole answer, so a consumer can show an answer as it is written instead
	 * of waiting for `result`.
	 *
	 * It is the piece and never the answer so far, so a task update does not grow as the answer
	 * does. A consumer that wants the answer as one piece of text ignores this and reads
	 * `result` when the task completes.
	 */
	newText?: string | undefined;
	/** The task output. Present only when the task reached the `completed` state. */
	result?: StagePayload | undefined;
	error?: string | undefined;
};
