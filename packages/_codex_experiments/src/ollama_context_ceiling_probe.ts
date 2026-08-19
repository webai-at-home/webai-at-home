import Fs from 'node:fs';
import Path from 'node:path';
import { CodexRun } from './codex_run.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	OllamaContextCeilingProbe — shows that the token count Ollama reports is a ceiling
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One prompt sent to Ollama, and what came back.
 */
export type OllamaContextCeilingProbeStep = {
	/** What was sent, in plain words. */
	label: string;
	/** The size of the request body, in bytes. */
	bytes: number;
	/** Whether the answer held a tool call. */
	madeAToolCall: boolean;
	/** The input token count Ollama reported, or null when it reported none. */
	reportedInputTokens: number | null;
};

/**
 * Sends the same question to Ollama at three prompt sizes, to separate two explanations of the 2051
 * input tokens Ollama reports for every prompt of the Codex command-line program: a truncated
 * prompt, or a reported number that means nothing.
 *
 * It reads the real request of the Codex command-line program out of the traffic recorded by
 * `exp_03_prompt_size_measure`, so that the tools and the instructions are the real ones, and it
 * shrinks that request rather than inventing a new one. The `get_weather` tool the question asks
 * for is offered in every step, next to the real tools, because a model cannot call a tool it was
 * never offered and the answer would say nothing about the size of the prompt.
 */
export class OllamaContextCeilingProbe {
	/** The address of the Ollama Responses API on this machine. */
	static readonly ollamaResponsesUrl = 'http://localhost:11434/v1/responses';

	/** The traffic recorded by `exp_03_prompt_size_measure` against Ollama, which this probe shrinks. */
	static readonly recordingFilePath = Path.join(
		CodexRun.packageDirectory,
		'recordings',
		'ollama',
		'exp_03_prompt_size_measure_traffic.jsonl',
	);

	/** The folder the result of the probe is written to, one file per model asked. */
	static readonly resultDirectory = Path.join(CodexRun.packageDirectory, 'data', 'ollama');

	/**
	 * Runs the three steps of the probe and writes the result next to the recorded runs.
	 *
	 * @param modelNameGiven The model to ask, or nothing to ask the one the recorded traffic used.
	 * @returns The three steps, in the order they were sent.
	 */
	static async run(modelNameGiven?: string): Promise<OllamaContextCeilingProbeStep[]> {
		const recorded = OllamaContextCeilingProbe._readRecordedRequest();
		const modelName = modelNameGiven ?? recorded.model;
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

		const steps: OllamaContextCeilingProbeStep[] = [];
		steps.push(await OllamaContextCeilingProbe._ask('that tool alone, short instructions', {
			model: modelName,
			stream: true,
			input: input,
			instructions: shortInstructions,
			tools: [oneTool],
		}));
		steps.push(await OllamaContextCeilingProbe._ask('that tool next to the ten of the Codex command-line program, short instructions', {
			model: modelName,
			stream: true,
			input: input,
			instructions: shortInstructions,
			tools: [oneTool, ...recorded.tools],
		}));
		steps.push(await OllamaContextCeilingProbe._ask('the same eleven tools and the whole instructions of the Codex command-line program', {
			model: modelName,
			stream: true,
			input: input,
			instructions: recorded.instructions,
			tools: [oneTool, ...recorded.tools],
		}));

		const resultText = [
			`ollama responses address: ${OllamaContextCeilingProbe.ollamaResponsesUrl}`,
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

		const resultFileName = `ollama_context_ceiling_probe_${modelName.replace(/[^a-z0-9]+/gi, '_')}_result.txt`;
		Fs.writeFileSync(Path.join(OllamaContextCeilingProbe.resultDirectory, resultFileName), resultText);
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
	 * command-line program.
	 *
	 * @returns The model, the tools, and the instructions that request carried.
	 */
	private static _readRecordedRequest(): { model: string, tools: unknown[], instructions: string, } {
		if (Fs.existsSync(OllamaContextCeilingProbe.recordingFilePath) === false) {
			throw new Error(`no recorded traffic at ${OllamaContextCeilingProbe.recordingFilePath}: run exp_03_prompt_size_measure against ollama first`);
		}

		const firstLine = Fs.readFileSync(OllamaContextCeilingProbe.recordingFilePath, 'utf8').split('\n')[0];
		const exchange = JSON.parse(firstLine);
		const requestBody = JSON.parse(exchange.requestBody);
		return {
			model: requestBody.model,
			tools: requestBody.tools,
			instructions: requestBody.instructions,
		};
	}

	/**
	 * Sends one request to Ollama and reads back whether it made a tool call and what it reported.
	 *
	 * @param label What was sent, in plain words.
	 * @param requestBody The whole request body.
	 * @returns What came back.
	 */
	private static async _ask(label: string, requestBody: unknown): Promise<OllamaContextCeilingProbeStep> {
		const bodyText = JSON.stringify(requestBody);
		const answer = await fetch(OllamaContextCeilingProbe.ollamaResponsesUrl, {
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

await OllamaContextCeilingProbe.run(process.argv[2]);
