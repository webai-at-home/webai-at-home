import Fs from 'node:fs';
import Path from 'node:path';
import { CodexRun } from './codex_run.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ContextCeilingProbe — shows whether the token count a target model reports is a ceiling
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One prompt sent to a target model, and what came back.
 */
export type ContextCeilingProbeStep = {
	/** What was sent, in plain words. */
	label: string;
	/** The size of the request body, in bytes. */
	bytes: number;
	/** Whether the answer held a tool call. */
	madeAToolCall: boolean;
	/** The input token count the target model reported, or null when it reported none. */
	reportedInputTokens: number | null;
};

/**
 * Sends the same question to one target model at three prompt sizes, to separate two explanations
 * of an input token count that does not grow with the prompt: a truncated prompt, or a reported
 * number that means nothing. A target model that truncates throws the tool definitions away, and a
 * model never shown a tool cannot call one.
 *
 * It reads the real request of the Codex command-line program out of the traffic recorded by
 * `exp_03_prompt_size_measure`, so that the tools and the instructions are the real ones, and it
 * shrinks that request rather than inventing a new one. The `get_weather` tool the question asks
 * for is offered in every step, next to the real tools, because a model cannot call a tool it was
 * never offered and the answer would say nothing about the size of the prompt.
 */
export class ContextCeilingProbe {
	/** The folder holding the traffic recorded by `exp_03_prompt_size_measure`, which this probe shrinks. */
	static readonly recordingsDirectory = Path.join(CodexRun.packageDirectory, 'recordings');

	/**
	 * Runs the three steps of the probe against one target model and writes the result next to the
	 * recorded runs of that target model.
	 *
	 * @param targetModelName The target model to ask: any name under `target_models/`.
	 * @returns The three steps, in the order they were sent.
	 */
	static async run(targetModelName: string): Promise<ContextCeilingProbeStep[]> {
		if (CodexRun.targetModelExists(targetModelName) === false) {
			throw new Error(`no such target model: ${targetModelName}, expected ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		const targetModelFileText = Fs.readFileSync(CodexRun.targetModelFilePath(targetModelName), 'utf8');
		const baseUrlMatch = targetModelFileText.match(/^base_url\s*=\s*"([^"]+)"/m);
		const modelMatch = targetModelFileText.match(/^model\s*=\s*"([^"]+)"/m);
		if (baseUrlMatch === null || modelMatch === null) {
			throw new Error(`no base_url or model in ${CodexRun.targetModelFilePath(targetModelName)}`);
		}
		const responsesUrl = `${baseUrlMatch[1]}/responses`;
		const modelName = modelMatch[1];

		const recorded = ContextCeilingProbe._readRecordedRequest(targetModelName);
		const question = 'What is the weather in Paris? Call the get_weather tool.';
		const oneTool = {
			type: 'function',
			name: 'get_weather',
			description: 'Get the weather of one city',
			parameters: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
					},
				},
				required: ['city'],
			},
		};
		const shortInstructions = 'You are a helpful assistant. Use a tool when one fits.';
		const input = [
			{
				type: 'message',
				role: 'user',
				content: [
					{
						type: 'input_text',
						text: question,
					},
				],
			},
		];

		const steps: ContextCeilingProbeStep[] = [];
		steps.push(await ContextCeilingProbe._ask(responsesUrl, 'that tool alone, short instructions', {
			model: modelName,
			stream: true,
			input: input,
			instructions: shortInstructions,
			tools: [oneTool],
		}));
		steps.push(await ContextCeilingProbe._ask(responsesUrl, 'that tool next to the ten of the Codex command-line program, short instructions', {
			model: modelName,
			stream: true,
			input: input,
			instructions: shortInstructions,
			tools: [oneTool, ...recorded.tools],
		}));
		steps.push(await ContextCeilingProbe._ask(responsesUrl, 'the same eleven tools and the whole instructions of the Codex command-line program', {
			model: modelName,
			stream: true,
			input: input,
			instructions: recorded.instructions,
			tools: [oneTool, ...recorded.tools],
		}));

		const resultText = [
			`target model: ${targetModelName}`,
			`responses address: ${responsesUrl}`,
			`model: ${modelName}`,
			'',
			...steps.map((step) => {
				return [
					step.label,
					`${step.bytes} bytes`,
					`made a tool call: ${step.madeAToolCall}`,
					`reported input tokens: ${step.reportedInputTokens === null ? 'none' : step.reportedInputTokens}`,
				].join(' | ');
			}),
			'',
		].join('\n');

		const resultDirectory = Path.join(CodexRun.packageDirectory, 'data', targetModelName);
		Fs.mkdirSync(resultDirectory, {
			recursive: true,
		});
		Fs.writeFileSync(Path.join(resultDirectory, 'context_ceiling_probe_result.txt'), resultText);
		console.log(resultText);
		return steps;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the first request of the recorded traffic, which is a real request of the Codex
	 * command-line program. The traffic recorded against any target model carries the same tools and
	 * the same instructions, so the traffic of another one is used when this target model has none of
	 * its own yet.
	 *
	 * @param targetModelName The target model whose recorded traffic is read first.
	 * @returns The tools and the instructions that request carried.
	 */
	private static _readRecordedRequest(targetModelName: string): { tools: unknown[], instructions: string, } {
		const candidateNames = [targetModelName, ...Fs.readdirSync(ContextCeilingProbe.recordingsDirectory)];
		for (const candidateName of candidateNames) {
			const recordingFilePath = Path.join(
				ContextCeilingProbe.recordingsDirectory,
				candidateName,
				'exp_03_prompt_size_measure_traffic.jsonl',
			);
			if (Fs.existsSync(recordingFilePath) === false) {
				continue;
			}

			const firstLine = Fs.readFileSync(recordingFilePath, 'utf8').split('\n')[0];
			if (firstLine.trim() === '') {
				continue;
			}

			const requestBody = JSON.parse(JSON.parse(firstLine).requestBody);
			return {
				tools: requestBody.tools,
				instructions: requestBody.instructions,
			};
		}

		throw new Error(`no recorded traffic under ${ContextCeilingProbe.recordingsDirectory}: run exp_03_prompt_size_measure first`);
	}

	/**
	 * Sends one request to a target model and reads back whether it made a tool call and what it
	 * reported.
	 *
	 * @param responsesUrl The address of the Responses API of that target model.
	 * @param label What was sent, in plain words.
	 * @param requestBody The whole request body.
	 * @returns What came back.
	 */
	private static async _ask(responsesUrl: string, label: string, requestBody: unknown): Promise<ContextCeilingProbeStep> {
		const bodyText = JSON.stringify(requestBody);
		const answer = await fetch(responsesUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: bodyText,
		});
		const answerText = await answer.text();

		let reportedInputTokens: number | null = null;
		for (const line of answerText.split('\n')) {
			if (line.includes('"usage"') === false) {
				continue;
			}
			const trimmed = line.startsWith('data:') === true ? line.slice('data:'.length).trim() : line.trim();
			try {
				const parsed = JSON.parse(trimmed);
				const usage = parsed?.response?.usage ?? parsed?.usage;
				if (usage !== undefined && usage !== null && typeof usage.input_tokens === 'number') {
					reportedInputTokens = usage.input_tokens;
				}
			} catch {
				continue;
			}
		}

		return {
			label: label,
			bytes: Buffer.byteLength(bodyText, 'utf8'),
			madeAToolCall: answerText.includes('function_call') === true,
			reportedInputTokens: reportedInputTokens,
		};
	}
}

await ContextCeilingProbe.run(process.argv[2]);
