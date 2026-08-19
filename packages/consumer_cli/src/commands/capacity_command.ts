import Chalk from 'chalk';
import { ClusterCapacityReader, type TaskTypeCapacity } from '../cluster_capacity/cluster_capacity_reader.js';
import { TaskInputFactory, taskTypeNames, type TaskTypeName } from '../libs/task_input_factory.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CapacityCommand — estimates how many concurrent runs of a task type the cluster supports
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The ways `capacity` can write its estimate out. */
export type CapacityFormat = 'text' | 'markdown' | 'json';

/** Every format `capacity` accepts, in the order the help text lists them. */
export const capacityFormats: CapacityFormat[] = ['text', 'markdown', 'json'];

/** What `consumer_cli capacity` needs to connect and what to estimate capacity for. */
export type CapacityCommandOptions = {
	url: string;
	authToken: string;
	timeoutMs: number;
	/**
	 * A task type name, spelled the same way as `submit`'s `-t/--task_type` (without `task_type_`),
	 * or absent to estimate every task type the cluster runs. See
	 * [issue #177](https://github.com/webai-at-home/webai-at-home/issues/177).
	 */
	type?: string;
	format: CapacityFormat;
};

/**
 * Connects to the central gateway as an observer, fetches the connected devices and the
 * registered pipelines, and estimates how many concurrent runs the cluster can currently support
 * — of one task type when `type` names one, and of every task type when it does not.
 *
 * The estimating itself belongs to `ClusterCapacityReader`, which `consumer_openai` reads the
 * same way to decide which models it may offer; this command only writes out what that returns.
 */
export class CapacityCommand {
	/**
	 * @param options Where to connect and which task type to estimate capacity for.
	 * @throws {Error} If `type` names no task type, or no pipeline serves the named task type.
	 * @throws {CliError} If the connection, authentication, or the device or pipeline
	 * snapshot fails.
	 */
	static async run(options: CapacityCommandOptions): Promise<void> {
		const requestedTaskTypeName = CapacityCommand._readTaskTypeName(options.type);

		const results = await ClusterCapacityReader.read({
			url: options.url,
			authToken: options.authToken,
			timeoutMs: options.timeoutMs,
			...(requestedTaskTypeName === undefined ? {} : { taskTypeNames: [requestedTaskTypeName] }),
		});

		// A task type nobody serves is an estimate of zero to every other caller, but to a person
		// who named that one task type by hand it is the answer to their question, and it stays
		// the failure it has always been.
		if (options.type !== undefined) {
			const result = results[0];
			if (result === undefined || result.pipelineId === undefined) {
				throw new Error(`No pipeline is registered for task type ${options.type}`);
			}
			console.log(CapacityCommand._formatOne(result, options.format));
			return;
		}

		console.log(CapacityCommand._formatMany(results, options.format));
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
	static isFormat(value: string): value is CapacityFormat {
		return (capacityFormats as string[]).includes(value);
	}

	/**
	 * Reads the task type name that was typed on the command line, if one was typed at all.
	 *
	 * @param typedTaskTypeName What `-t/--task_type` was given, or `undefined` when it was left out.
	 * @returns The task type name, or `undefined` when the option was left out.
	 * @throws {Error} If a name was given that no task type answers to.
	 */
	private static _readTaskTypeName(typedTaskTypeName: string | undefined): TaskTypeName | undefined {
		if (typedTaskTypeName === undefined) {
			return undefined;
		}
		if (TaskInputFactory.isTaskTypeName(typedTaskTypeName) === false) {
			throw new Error(`Type must be one of ${taskTypeNames.join(', ')}`);
		}
		return typedTaskTypeName;
	}

	/**
	 * Writes out the estimate for the one task type that was named on the command line, in the
	 * shape this subcommand has always written a single estimate in.
	 *
	 * @param result The capacity estimate to print.
	 * @param format Which format to write.
	 * @returns The estimate as one string, ready to print.
	 */
	private static _formatOne(result: TaskTypeCapacity, format: CapacityFormat): string {
		if (format === 'json') {
			return JSON.stringify(result, null, 2);
		}
		if (format === 'markdown') {
			const lines: string[] = [];
			lines.push('# Capacity estimate');
			lines.push('');
			lines.push(`- **Task type:** ${result.type}`);
			lines.push(`- **Pipeline:** ${result.pipelineId} (version ${result.pipelineVersion})`);
			lines.push(`- **Capacity:** ${CapacityCommand._runCount(result.capacity)} supported`);
			lines.push(`- **Limited by:** ${result.reason}`);
			return lines.join('\n');
		}
		return CapacityCommand._formatHuman(result);
	}

	/**
	 * Writes out the estimate for every task type, which is what `capacity` prints when no
	 * `-t/--task_type` was given.
	 *
	 * @param results One capacity estimate per task type, in the order the task types are declared.
	 * @param format Which format to write.
	 * @returns The estimates as one string, ready to print with a single `console.log`.
	 */
	private static _formatMany(results: TaskTypeCapacity[], format: CapacityFormat): string {
		if (format === 'json') {
			return JSON.stringify(results, null, 2);
		}
		if (format === 'markdown') {
			return CapacityCommand._formatManyMarkdown(results);
		}
		return results.map((result) => CapacityCommand._formatHuman(result)).join('\n');
	}

	/**
	 * Formats one capacity estimate as the two human-readable lines `capacity` prints by default.
	 *
	 * The task type name is written in magenta, so that the five estimates printed when no task
	 * type was named can be told apart at a glance. Chalk writes no colour codes at all when the
	 * output is not a terminal, so a piped or redirected run stays plain text.
	 *
	 * @param result The capacity estimate to print.
	 * @returns The two lines, without a trailing newline.
	 */
	private static _formatHuman(result: TaskTypeCapacity): string {
		return `${Chalk.magenta(result.type)}: ${CapacityCommand._runCount(result.capacity)} supported\n`
			+ `  limited by: ${result.reason}`;
	}

	/**
	 * Formats every task type's capacity estimate as one Markdown table, which stays readable at
	 * six task types in a way six repeated bullet lists do not.
	 *
	 * @param results One capacity estimate per task type.
	 * @returns The Markdown text, ready to print with a single `console.log`.
	 */
	private static _formatManyMarkdown(results: TaskTypeCapacity[]): string {
		const lines: string[] = [];
		lines.push('# Capacity estimate');
		lines.push('');
		lines.push('| Task type | Pipeline | Capacity | Limited by |');
		lines.push('| --- | --- | --- | --- |');
		for (const result of results) {
			const pipeline = result.pipelineId === undefined ? 'none' : `${result.pipelineId} (version ${result.pipelineVersion})`;
			lines.push(`| ${result.type} | ${pipeline} | ${result.capacity} | ${result.reason} |`);
		}
		return lines.join('\n');
	}

	/**
	 * Writes a number of concurrent runs with the right singular or plural noun.
	 *
	 * @param capacity How many concurrent runs the cluster can support.
	 * @returns The phrase, such as `3 concurrent runs`.
	 */
	private static _runCount(capacity: number): string {
		return `${capacity} concurrent run${capacity === 1 ? '' : 's'}`;
	}
}
