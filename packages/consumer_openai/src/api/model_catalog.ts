import { TaskInputFactory, taskTypeNames, type TaskTypeName } from '@webai/consumer-cli';
import type { ModelDescription, ModelListResponse } from './openai_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelCatalog — the models this server offers, and the cluster task type behind each one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Who the list returned by `GET /v1/models` names as the owner of every model. */
const modelOwner = 'webai-at-home';

/**
 * The models this server offers, one for each kind of work the cluster can run.
 *
 * A model identifier is the cluster's task type name without the leading `task_type_`, which
 * is the same spelling the consumer command line option `-t/--task_type` accepts, as recorded in
 * `docs/naming_scheme.md`. The list comes from `taskTypeNames` in `@webai/consumer-cli`, so
 * the models offered here cannot drift away from the task types the cluster actually runs:
 * adding a task type adds a model without a change to this file.
 */
export class ModelCatalog {
	/** Every model identifier this server offers, in the order the task types are declared. */
	static readonly modelIds: readonly string[] = taskTypeNames;

	/**
	 * Turns a model identifier from a request into the cluster task type name behind it.
	 *
	 * @param modelId The `model` field of the request.
	 * @returns The task type name, or `undefined` when no model of that name is offered.
	 */
	static taskTypeNameOf(modelId: string): TaskTypeName | undefined {
		if (TaskInputFactory.isTaskTypeName(modelId) === false) {
			return undefined;
		}
		return modelId;
	}

	/**
	 * Builds the body of `GET /v1/models`.
	 *
	 * @param createdAtSeconds When to state each model was created, as a whole number of
	 * seconds since the start of 1970. This server has no creation date for a model, so it
	 * states the moment it started.
	 * @param modelIds Which models to list. Defaults to every model this server offers; the
	 * `/v1/models` route passes the ones the cluster can currently run, which is a shorter list
	 * whenever no worker is connected for a task type — see
	 * [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
	 * @returns The model list to answer with.
	 */
	static list(createdAtSeconds: number, modelIds: readonly string[] = ModelCatalog.modelIds): ModelListResponse {
		const data: ModelDescription[] = modelIds.map((modelId) => ({
			id: modelId,
			object: 'model',
			created: createdAtSeconds,
			owned_by: modelOwner,
		}));
		return {
			object: 'list',
			data,
		};
	}
}
