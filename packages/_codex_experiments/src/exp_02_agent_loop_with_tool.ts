import Fs from 'node:fs';
import Path from 'node:path';
import { Command } from 'commander';
import { CodexRun } from './codex_run.js';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Exp02AgentLoopWithTool — the second experiment of issue #213, run against one target model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * What one run of `exp_02_agent_loop_with_tool` did, measured against the four things the agent loop
 * has to get right.
 */
export type Exp02AgentLoopWithToolRun = {
	/** Which run this was, counting from one. */
	runNumber: number;
	/** The exit code of the Codex command-line program, where zero means the turn completed. */
	exitCode: number;
	/** How long the run took, in seconds. */
	seconds: number;
	/** How many tool calls the model made, of any kind. */
	toolCallCount: number;
	/** The kind of every tool call it made, in order, such as `command_execution` or `file_change`. */
	toolCallKinds: string[];
	/** Whether the model wrote anything at all after its last tool call, which is reading the result back. */
	readTheToolResultBack: boolean;
	/** Whether the turn ended on its own, meaning a `turn.completed` event and exit code zero. */
	stoppedOnItsOwn: boolean;
	/** Whether the file the task asks for exists in the workspace of the run. */
	fileExists: boolean;
	/** Whether that file holds exactly the one line the task asks for. */
	fileContentIsCorrect: boolean;
	/** The last message the model wrote, which the task asks to be the single word `done`. */
	lastMessage: string;
};

/**
 * Every run of `exp_02_agent_loop_with_tool` against one target model.
 */
export type Exp02AgentLoopWithToolResult = {
	/** The target model the runs were made against: `lmstudio`, `ollama`, or `webai_at_home`. */
	targetModelName: string;
	/** The version of the Codex command-line program that made the runs. */
	codexVersion: string;
	/** One entry per run, in the order the runs were made. */
	runs: Exp02AgentLoopWithToolRun[];
};

/**
 * `exp_02_agent_loop_with_tool`, the second experiment of
 * [issue #213](https://github.com/webai-at-home/webai-at-home/issues/213): give the Codex
 * command-line program one small task with a checkable result, and measure whether the model emits
 * a well-formed tool call, reads the tool result back, and stops when the task is finished.
 *
 * The task text is fixed in `tasks/exp_02_agent_loop_with_tool.task.md`, so every target model is
 * given exactly the same task, word for word. Each run gets an empty workspace of its own, because
 * a run that finds the file already there proves nothing.
 */
export class Exp02AgentLoopWithTool {
	/** The name of this experiment, which names every file it writes. */
	static readonly experimentName = 'exp_02_agent_loop_with_tool';

	/** The file holding the task text, which is fixed so that every run is given the same task. */
	static readonly taskFilePath = Path.join(
		CodexRun.packageDirectory,
		'tasks',
		`${Exp02AgentLoopWithTool.experimentName}.task.md`,
	);

	/** The file the task asks the model to create. */
	static readonly expectedFileName = 'agent_loop.txt';

	/** The one line the task asks that file to hold. */
	static readonly expectedFileContent = 'agent loop ready';

	/** The item kinds that count as a tool call, as the Codex command-line program names them. */
	static readonly toolCallItemKinds = ['command_execution', 'file_change', 'patch_apply', 'mcp_tool_call', 'web_search'];

	/**
	 * Runs this experiment against one target model, several times over, and writes every recorded
	 * run under `data/<target model>/`.
	 *
	 * @param targetModelName The target model to run against: `lmstudio`, `ollama`, or `webai_at_home`.
	 * @param repeatCount How many times to run the same task, because no run is reproducible.
	 * @returns Every run, already written to disk.
	 */
	static run(targetModelName: string, repeatCount: number): Exp02AgentLoopWithToolResult {
		if (CodexRun.targetModelExists(targetModelName) === false) {
			throw new Error(`no such target model: ${targetModelName}, expected ${CodexRun.targetModelFilePath(targetModelName)}`);
		}

		const taskText = Fs.readFileSync(Exp02AgentLoopWithTool.taskFilePath, 'utf8').trim();
		const outputDirectory = Path.join(CodexRun.packageDirectory, 'data', targetModelName);
		Fs.mkdirSync(outputDirectory, {
			recursive: true,
		});

		const runs: Exp02AgentLoopWithToolRun[] = [];
		for (let runNumber = 1; runNumber <= repeatCount; runNumber++) {
			const run = Exp02AgentLoopWithTool._runOnce(targetModelName, runNumber, taskText, outputDirectory);
			runs.push(run);
			console.log(Exp02AgentLoopWithTool._describeRun(run));
		}

		const result: Exp02AgentLoopWithToolResult = {
			targetModelName: targetModelName,
			codexVersion: CodexRun.readVersion(),
			runs: runs,
		};

		Fs.writeFileSync(
			Path.join(outputDirectory, `${Exp02AgentLoopWithTool.experimentName}_result.txt`),
			Exp02AgentLoopWithTool._describeResult(result),
		);

		return result;
	}

	/**
	 * Parses the command line, runs this experiment against the named target model, and prints one
	 * line per run followed by the count of runs that got everything right.
	 *
	 * @returns Nothing.
	 */
	static main(): void {
		const command = new Command();
		command
			.name(Exp02AgentLoopWithTool.experimentName)
			.description('The second experiment of issue #213: one small task with a checkable result')
			.argument('<target_model>', 'the target model to run against: lmstudio, ollama, or webai_at_home')
			.option('-r, --repeats <count>', 'how many times to run the same task', '3')
			.action((targetModelName: string, options: { repeats: string, }) => {
				const repeatCount = Number.parseInt(options.repeats, 10);
				if (Number.isNaN(repeatCount) === true || repeatCount < 1) {
					throw new Error(`--repeats must be a whole number of one or more, not ${options.repeats}`);
				}

				console.log(`target model: ${targetModelName}`);
				console.log(`repeats: ${repeatCount}`);
				console.log('');

				const result = Exp02AgentLoopWithTool.run(targetModelName, repeatCount);

				console.log('');
				console.log(Exp02AgentLoopWithTool._describeResult(result));
			});
		command.parse(process.argv);
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs the task once in an empty workspace of its own, records the run, and measures it.
	 *
	 * @param targetModelName The target model to run against.
	 * @param runNumber Which run this is, counting from one.
	 * @param taskText The fixed task text, the same for every run and every target model.
	 * @param outputDirectory The folder under `data/` the recorded run is written to.
	 * @returns What the run did.
	 */
	private static _runOnce(
		targetModelName: string,
		runNumber: number,
		taskText: string,
		outputDirectory: string,
	): Exp02AgentLoopWithToolRun {
		const workspaceDirectory = Path.join(
			CodexRun.packageDirectory,
			'workspaces',
			targetModelName,
			`run_${runNumber}`,
		);
		Fs.rmSync(workspaceDirectory, {
			recursive: true,
			force: true,
		});
		Fs.mkdirSync(workspaceDirectory, {
			recursive: true,
		});

		const filePrefix = `${Exp02AgentLoopWithTool.experimentName}_run_${runNumber}`;
		const lastMessagePath = Path.join(outputDirectory, `${filePrefix}_last_message.txt`);
		Fs.rmSync(lastMessagePath, {
			force: true,
		});

		const codexRunResult = CodexRun.execute([
			'--profile', targetModelName,
			'--cd', workspaceDirectory,
			'--sandbox', 'workspace-write',
			'--skip-git-repo-check',
			'--json',
			'--output-last-message', lastMessagePath,
			taskText,
		]);

		Fs.writeFileSync(Path.join(outputDirectory, `${filePrefix}_events.jsonl`), codexRunResult.eventsText);
		Fs.writeFileSync(Path.join(outputDirectory, `${filePrefix}_stderr.txt`), codexRunResult.standardErrorText);

		const expectedFilePath = Path.join(workspaceDirectory, Exp02AgentLoopWithTool.expectedFileName);
		const fileExists = Fs.existsSync(expectedFilePath);
		const fileContent = fileExists === true ? Fs.readFileSync(expectedFilePath, 'utf8').trim() : '';

		const measured = Exp02AgentLoopWithTool._measureEvents(codexRunResult.eventsText);

		return {
			runNumber: runNumber,
			exitCode: codexRunResult.exitCode,
			seconds: codexRunResult.seconds,
			toolCallCount: measured.toolCallKinds.length,
			toolCallKinds: measured.toolCallKinds,
			readTheToolResultBack: measured.readTheToolResultBack,
			stoppedOnItsOwn: measured.turnCompleted === true && codexRunResult.exitCode === 0,
			fileExists: fileExists,
			fileContentIsCorrect: fileContent === Exp02AgentLoopWithTool.expectedFileContent,
			lastMessage: Exp02AgentLoopWithTool._readTextFile(lastMessagePath),
		};
	}

	/**
	 * Reads the recorded events of one run and measures what the agent loop did.
	 *
	 * @param eventsText The recorded events, one JSON object per line.
	 * @returns The kinds of tool call made, whether anything was written after the last one, and
	 *          whether the turn completed.
	 */
	private static _measureEvents(eventsText: string): {
		toolCallKinds: string[];
		readTheToolResultBack: boolean;
		turnCompleted: boolean;
	} {
		const toolCallKinds: string[] = [];
		let turnCompleted = false;
		let modelWroteAfterLastToolCall = false;

		for (const eventLine of eventsText.split('\n')) {
			if (eventLine.trim() === '') {
				continue;
			}

			let event: { type?: string, item?: { type?: string, }, };
			try {
				event = JSON.parse(eventLine);
			} catch {
				continue;
			}

			if (event.type === 'turn.completed') {
				turnCompleted = true;
				continue;
			}
			if (event.type !== 'item.completed') {
				continue;
			}

			const itemKind = event.item?.type ?? '';
			if (Exp02AgentLoopWithTool.toolCallItemKinds.includes(itemKind) === true) {
				toolCallKinds.push(itemKind);
				modelWroteAfterLastToolCall = false;
				continue;
			}
			if (itemKind === 'agent_message' || itemKind === 'reasoning') {
				modelWroteAfterLastToolCall = true;
			}
		}

		return {
			toolCallKinds: toolCallKinds,
			readTheToolResultBack: toolCallKinds.length > 0 && modelWroteAfterLastToolCall === true,
			turnCompleted: turnCompleted,
		};
	}

	/**
	 * Writes one run as a single line, which is what is printed while the experiment runs.
	 *
	 * @param run The run to describe.
	 * @returns One line naming every measurement of that run.
	 */
	private static _describeRun(run: Exp02AgentLoopWithToolRun): string {
		const parts = [
			`run ${run.runNumber}`,
			`exit code ${run.exitCode}`,
			`${run.seconds} seconds`,
			`${run.toolCallCount} tool calls`,
			`read the tool result back: ${run.readTheToolResultBack}`,
			`stopped on its own: ${run.stoppedOnItsOwn}`,
			`file exists: ${run.fileExists}`,
			`file content is correct: ${run.fileContentIsCorrect}`,
			`last message: ${JSON.stringify(run.lastMessage)}`,
		];
		return parts.join(' | ');
	}

	/**
	 * Writes every run of one target model as a table, which is what is recorded under `data/`.
	 *
	 * @param result Every run against one target model.
	 * @returns The table, one line per run, with a heading and a count of the runs that did the whole
	 *          task correctly.
	 */
	private static _describeResult(result: Exp02AgentLoopWithToolResult): string {
		const lines = [
			`target model: ${result.targetModelName}`,
			`codex version: ${result.codexVersion}`,
			`task: tasks/${Exp02AgentLoopWithTool.experimentName}.task.md`,
			'',
		];
		for (const run of result.runs) {
			lines.push(Exp02AgentLoopWithTool._describeRun(run));
		}

		const wholeTaskCount = result.runs.filter((run) => {
			return run.fileContentIsCorrect === true && run.stoppedOnItsOwn === true;
		}).length;
		lines.push('');
		lines.push(`runs that wrote the correct file and stopped on their own: ${wholeTaskCount} of ${result.runs.length}`);
		lines.push('');

		return lines.join('\n');
	}

	/**
	 * Reads a text file written by the run, tolerating a file the run never created.
	 *
	 * @param filePath The file to read.
	 * @returns The contents of the file, trimmed, or an empty string when the file is missing.
	 */
	private static _readTextFile(filePath: string): string {
		if (Fs.existsSync(filePath) === false) {
			return '';
		}
		return Fs.readFileSync(filePath, 'utf8').trim();
	}
}

Exp02AgentLoopWithTool.main();
