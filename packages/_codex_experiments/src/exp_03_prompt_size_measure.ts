import Fs from 'node:fs';
import Path from 'node:path';
import { Command } from 'commander';
import { CodexRun } from './codex_run.js';
import { RecordingProxy } from './recording_proxy.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Exp03PromptSizeMeasure — the third experiment of issue #213, run against one target model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one request of the Codex command-line program held, measured from the traffic itself.
 */
export type Exp03RequestMeasurement = {
	/** Which request this was within the run, counting from one. */
	requestNumber: number;
	/** The path the request was made to, such as `/v1/responses`. */
	path: string;
	/** The size of the whole request body, in bytes. */
	bytes: number;
	/** The size of the whole request body, in characters. */
	characters: number;
	/** The size of the whole request body in tokens, estimated at four characters for one token. */
	estimatedTokens: number;
	/** Every field at the top level of the request body, in alphabetical order. */
	topLevelFields: string[];
	/** The size of the `instructions` field, in characters, which is the standing prompt. */
	instructionsCharacters: number;
	/** How many tools were offered in this request. */
	toolCount: number;
	/** The size of the `tools` field, in characters. */
	toolsCharacters: number;
	/** How many items the `input` field held, which is the history so far. */
	inputItemCount: number;
	/** The size of the `input` field, in characters. */
	inputCharacters: number;
	/** Whether the request asked for a streamed answer. */
	isStreamed: boolean;
	/** The status code the target model answered with. */
	responseStatusCode: number;
	/** The input token count the target model reported for this request, or null when it reported none. */
	reportedInputTokens: number | null;
};

/**
 * Everything `exp_03_prompt_size_measure` measured against one target model.
 */
export type Exp03PromptSizeMeasureResult = {
	/** The target model the run was made against: `lmstudio`, `ollama`, or `webai_at_home`. */
	targetModelName: string;
	/** The version of the Codex command-line program that made the run. */
	codexVersion: string;
	/** The exit code of the Codex command-line program, where zero means the turn completed. */
	exitCode: number;
	/** One entry per request the Codex command-line program made, in order. */
	requests: Exp03RequestMeasurement[];
	/** Every field seen at the top level of any request, in alphabetical order. */
	allTopLevelFields: string[];
};

/**
 * `exp_03_prompt_size_measure`, the third experiment of
 * [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213): record every request the
 * Codex command-line program sends, measure how large the prompt is, and list every request field
 * it uses.
 *
 * The measurement is read from the recorded traffic and never from what a target model reports,
 * because `exp_02_agent_loop_with_tool` showed one target model reporting the same input token
 * count for every prompt it was ever given.
 */
export class Exp03PromptSizeMeasure {
	/** The name of this experiment, which names every file it writes. */
	static readonly experimentName = 'exp_03_prompt_size_measure';

	/** The task given to the Codex command-line program, which is the task of the second experiment. */
	static readonly taskFilePath = Path.join(
		CodexRun.packageDirectory,
		'tasks',
		'exp_02_agent_loop_with_tool.task.md',
	);

	/** The four request fields the conformance report already records as failing on LM Studio. */
	static readonly knownFailingFields = ['max_completion_tokens', 'max_output_tokens', 'stop', 'seed', 'top_p'];

	/**
	 * Runs the Codex command-line program once against one target model, through the recording proxy,
	 * and measures every request it made.
	 *
	 * @param targetModelName The target model to run against: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @returns Every measurement, already written to disk.
	 */
	static async run(targetModelName: string): Promise<Exp03PromptSizeMeasureResult> {
		if (CodexRun.targetModelExists(targetModelName) === false) {
			throw new Error(`no such target model: ${targetModelName}, expected ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		const targetModelFile = Exp03PromptSizeMeasure._readTargetModelFile(targetModelName);
		const upstreamUrl = new URL(targetModelFile.baseUrl);

		const recordingDirectory = Path.join(CodexRun.packageDirectory, 'recordings', targetModelName);
		Fs.mkdirSync(recordingDirectory, {
			recursive: true,
		});
		const recordingFilePath = Path.join(recordingDirectory, `${Exp03PromptSizeMeasure.experimentName}_traffic.jsonl`);

		const workspaceDirectory = Path.join(
			CodexRun.packageDirectory,
			'workspaces',
			targetModelName,
			Exp03PromptSizeMeasure.experimentName,
		);
		Fs.rmSync(workspaceDirectory, {
			recursive: true,
			force: true,
		});
		Fs.mkdirSync(workspaceDirectory, {
			recursive: true,
		});

		const recordingProxy = new RecordingProxy(upstreamUrl.origin, recordingFilePath);
		const proxyPort = await recordingProxy.start();
		console.log(`the recording proxy is listening on port ${proxyPort} and passes to ${upstreamUrl.origin}`);

		let codexRunResult;
		try {
			codexRunResult = await CodexRun.executeWithoutBlocking([
				'--profile', targetModelName,
				'-c', `model_providers.${targetModelFile.modelProviderKey}.base_url="http://127.0.0.1:${proxyPort}${upstreamUrl.pathname}"`,
				'--cd', workspaceDirectory,
				'--sandbox', 'workspace-write',
				'--skip-git-repo-check',
				'--json',
				Fs.readFileSync(Exp03PromptSizeMeasure.taskFilePath, 'utf8').trim(),
			]);
		} finally {
			await recordingProxy.stop();
		}

		const outputDirectory = Path.join(CodexRun.packageDirectory, 'data', targetModelName);
		Fs.mkdirSync(outputDirectory, {
			recursive: true,
		});
		Fs.writeFileSync(
			Path.join(outputDirectory, `${Exp03PromptSizeMeasure.experimentName}_events.jsonl`),
			codexRunResult.eventsText,
		);

		const requests = Exp03PromptSizeMeasure._measureRecording(recordingFilePath);
		const allTopLevelFields = Exp03PromptSizeMeasure._collectTopLevelFields(requests);

		const result: Exp03PromptSizeMeasureResult = {
			targetModelName: targetModelName,
			codexVersion: CodexRun.readVersion(),
			exitCode: codexRunResult.exitCode,
			requests: requests,
			allTopLevelFields: allTopLevelFields,
		};

		Fs.writeFileSync(
			Path.join(outputDirectory, `${Exp03PromptSizeMeasure.experimentName}_measurements.json`),
			`${JSON.stringify(result, null, '\t')}\n`,
		);
		Fs.writeFileSync(
			Path.join(outputDirectory, `${Exp03PromptSizeMeasure.experimentName}_result.txt`),
			Exp03PromptSizeMeasure._describeResult(result),
		);

		return result;
	}

	/**
	 * Parses the command line, runs this experiment against the named target model, and prints the
	 * table of requests it measured.
	 *
	 * @returns Nothing.
	 */
	static main(): void {
		const command = new Command();
		command
			.name(Exp03PromptSizeMeasure.experimentName)
			.description('The third experiment of issue #213: measure the prompt from the recorded traffic')
			.argument('<target_model>', 'the target model to run against: lmstudio, ollama, or webai_at_home')
			.action(async (targetModelName: string) => {
				console.log(`target model: ${targetModelName}`);
				console.log('');

				const result = await Exp03PromptSizeMeasure.run(targetModelName);

				console.log('');
				console.log(Exp03PromptSizeMeasure._describeResult(result));
				process.exitCode = result.requests.length > 0 ? 0 : 1;
			});
		command.parse(process.argv);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the base address and the model provider key out of a committed target model file. The
	 * file is written by this package and always has that shape, so it is read with two patterns
	 * rather than with a whole TOML reader.
	 *
	 * @param targetModelName The target model whose file is read.
	 * @returns The base address the Codex command-line program would use, and the key of the model
	 *          provider whose base address has to be pointed at the recording proxy instead.
	 */
	private static _readTargetModelFile(targetModelName: string): { baseUrl: string, modelProviderKey: string, } {
		const fileText = Fs.readFileSync(CodexRun.targetModelFilePath(targetModelName), 'utf8');

		const baseUrlMatch = fileText.match(/^base_url\s*=\s*"([^"]+)"/m);
		if (baseUrlMatch === null) {
			throw new Error(`no base_url in ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		const modelProviderMatch = fileText.match(/^model_provider\s*=\s*"([^"]+)"/m);
		if (modelProviderMatch === null) {
			throw new Error(`no model_provider in ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		return {
			baseUrl: baseUrlMatch[1],
			modelProviderKey: modelProviderMatch[1],
		};
	}

	/**
	 * Measures every request in a recording file.
	 *
	 * @param recordingFilePath The file the recording proxy wrote, one exchange per line.
	 * @returns One measurement per request, in the order the requests were made.
	 */
	private static _measureRecording(recordingFilePath: string): Exp03RequestMeasurement[] {
		if (Fs.existsSync(recordingFilePath) === false) {
			return [];
		}

		const measurements: Exp03RequestMeasurement[] = [];
		for (const exchangeLine of Fs.readFileSync(recordingFilePath, 'utf8').split('\n')) {
			if (exchangeLine.trim() === '') {
				continue;
			}

			let exchange: {
				exchangeNumber: number;
				path: string;
				requestBody: string;
				responseStatusCode: number;
				responseBody: string;
			};
			try {
				exchange = JSON.parse(exchangeLine);
			} catch {
				continue;
			}

			let requestBody: Record<string, unknown> = {};
			try {
				requestBody = JSON.parse(exchange.requestBody);
			} catch {
				requestBody = {};
			}

			const instructions = requestBody.instructions;
			const tools = requestBody.tools;
			const input = requestBody.input;

			measurements.push({
				requestNumber: exchange.exchangeNumber,
				path: exchange.path,
				bytes: Buffer.byteLength(exchange.requestBody, 'utf8'),
				characters: exchange.requestBody.length,
				estimatedTokens: Math.round(exchange.requestBody.length / 4),
				topLevelFields: Object.keys(requestBody).sort(),
				instructionsCharacters: typeof instructions === 'string' ? instructions.length : 0,
				toolCount: Array.isArray(tools) === true ? (tools as unknown[]).length : 0,
				toolsCharacters: tools === undefined ? 0 : JSON.stringify(tools).length,
				inputItemCount: Array.isArray(input) === true ? (input as unknown[]).length : 0,
				inputCharacters: input === undefined ? 0 : JSON.stringify(input).length,
				isStreamed: requestBody.stream === true,
				responseStatusCode: exchange.responseStatusCode,
				reportedInputTokens: Exp03PromptSizeMeasure._readReportedInputTokens(exchange.responseBody),
			});
		}
		return measurements;
	}

	/**
	 * Reads the input token count a target model reported, out of its answer. A streamed answer holds
	 * it in the last event carrying a `usage` field.
	 *
	 * @param responseBody The whole answer body, streamed or not.
	 * @returns The reported count, or null when the answer reported none.
	 */
	private static _readReportedInputTokens(responseBody: string): number | null {
		let reported: number | null = null;
		for (const line of responseBody.split('\n')) {
			const trimmed = line.startsWith('data:') === true ? line.slice('data:'.length).trim() : line.trim();
			if (trimmed === '' || trimmed.includes('"usage"') === false) {
				continue;
			}

			try {
				const parsed = JSON.parse(trimmed);
				const usage = parsed?.response?.usage ?? parsed?.usage;
				if (usage !== undefined && usage !== null && typeof usage.input_tokens === 'number') {
					reported = usage.input_tokens;
				}
			} catch {
				continue;
			}
		}
		return reported;
	}

	/**
	 * Collects every field seen at the top level of any request.
	 *
	 * @param requests Every measured request.
	 * @returns The union of their top level fields, in alphabetical order.
	 */
	private static _collectTopLevelFields(requests: Exp03RequestMeasurement[]): string[] {
		const fields = new Set<string>();
		for (const request of requests) {
			for (const field of request.topLevelFields) {
				fields.add(field);
			}
		}
		return [...fields].sort();
	}

	/**
	 * Writes the measurements of one target model as a table, which is what is recorded under `data/`.
	 *
	 * @param result Every measurement against one target model.
	 * @returns The table, one line per request, with the fields seen and the ones known to fail.
	 */
	private static _describeResult(result: Exp03PromptSizeMeasureResult): string {
		const lines = [
			`target model: ${result.targetModelName}`,
			`codex version: ${result.codexVersion}`,
			`exit code: ${result.exitCode}`,
			`requests recorded: ${result.requests.length}`,
			'',
		];

		for (const request of result.requests) {
			lines.push([
				`request ${request.requestNumber}`,
				`${request.path}`,
				`status ${request.responseStatusCode}`,
				`${request.bytes} bytes`,
				`~${request.estimatedTokens} tokens estimated`,
				`instructions ${request.instructionsCharacters} characters`,
				`${request.toolCount} tools in ${request.toolsCharacters} characters`,
				`${request.inputItemCount} input items in ${request.inputCharacters} characters`,
				`streamed: ${request.isStreamed}`,
				`reported input tokens: ${request.reportedInputTokens === null ? 'none' : request.reportedInputTokens}`,
			].join(' | '));
		}

		lines.push('');
		lines.push(`fields sent: ${result.allTopLevelFields.join(', ')}`);

		const failingFieldsSent = result.allTopLevelFields.filter((field) => {
			return Exp03PromptSizeMeasure.knownFailingFields.includes(field) === true;
		});
		lines.push(`fields sent that are already recorded as failing: ${failingFieldsSent.length === 0 ? 'none' : failingFieldsSent.join(', ')}`);
		lines.push('');

		return lines.join('\n');
	}
}

Exp03PromptSizeMeasure.main();
