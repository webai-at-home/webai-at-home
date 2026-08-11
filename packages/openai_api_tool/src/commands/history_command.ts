// npm imports
import type OpenAI from 'openai';

// local imports
import { taskTypeNamesAcceptingHistory } from '@webai/consumer-cli';
import { CompletionSender } from '../completion_sender.js';
import { reportFormats, type CompletionMode, type SweepOutcome, type SweepTurn } from '../completion_types.js';
import { ModelSweeper } from '../model_sweeper.js';
import { ReportRenderer } from '../report_renderer.js';
import { SharedOptions, type RawSharedOptions } from '../shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryCommand — checks that a second turn recalls what the first turn said
//
//	Sends a two-turn history and checks that the second turn's answer recalls both facts the
//	first turn stated, across every model in `taskTypeNamesAcceptingHistory` — the only
//	models whose task type accepts a whole history rather than only one prompt.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The `history` subcommand's own options, exactly as commander parses them. */
export type RawHistoryOptions = RawSharedOptions;

/** Sends a two-turn history to a model that accepts one, and checks what the second turn recalls. */
export class HistoryCommand {
	/** The first turn, stating a fact and nothing else. */
	private static readonly _firstMessage = 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.';

	/** The second turn, asking a question that can only be answered by recalling what the first turn said. */
	private static readonly _secondMessage = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';

	/**
	 * Runs the `history` subcommand: sweeps every requested model and mode pair, one at a time,
	 * prints the two turns and one analysis line per pair, and finishes with a summary table.
	 *
	 * `-m/--model list` prints `taskTypeNamesAcceptingHistory` rather than every model on
	 * offer, since only those models accept a whole history.
	 *
	 * `-f/--format text`, the default, streams each turn live and prints its analysis line as it
	 * finishes. `-f/--format markdown` or `-f/--format json` runs the sweep silently and prints
	 * one report once every pair has finished.
	 *
	 * @param rawOptions The subcommand's own options, exactly as commander parsed them.
	 * @returns Nothing. Sets `process.exitCode` to `1` when any pair failed.
	 * @throws {Error} If `--format` names a format that cannot be written.
	 */
	static async run(rawOptions: RawHistoryOptions): Promise<void> {
		if (rawOptions.model === 'list') {
			SharedOptions.printModelIds(taskTypeNamesAcceptingHistory);
			return;
		}
		if (ReportRenderer.isReportFormat(rawOptions.format) === false) {
			throw new Error(`--format must be one of ${reportFormats.join(', ')}`);
		}

		const modelIds = ModelSweeper.resolveModelIds(rawOptions.model, taskTypeNamesAcceptingHistory, 'accept');
		const modes = SharedOptions.resolveModes(rawOptions);
		const client = CompletionSender.createClient(SharedOptions.buildTarget(rawOptions));
		const isText = rawOptions.format === 'text';

		const outcomes: SweepOutcome[] = [];
		for (const modelId of modelIds) {
			for (const mode of modes) {
				const outcome = await HistoryCommand._sweepOne(client, modelId, mode, isText);
				outcomes.push(outcome);
				if (isText === true) {
					ReportRenderer.printSweepOutcome(outcome);
				}
			}
		}

		if (isText === true) {
			ReportRenderer.printSweepSummary(outcomes);
		} else {
			console.log(ReportRenderer.formatSweepReport(outcomes, rawOptions.format));
		}
		if (outcomes.some((outcome) => outcome.status === 'failed')) {
			process.exitCode = 1;
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sweeps one model and one mode: sends the first turn, then sends the second turn with the
	 * first turn's own answer carried along with it, and checks that the second answer recalls
	 * both facts the first turn stated.
	 *
	 * @param client The OpenAI client pointed at the endpoint under test.
	 * @param modelId The model identifier to request.
	 * @param mode Whether to ask for each turn's answer as it is written, or in one piece.
	 * @param isText Whether to stream each turn's raw answer to standard output as it arrives.
	 * @returns What happened. The timings and character count are the second turn's own, since
	 * that is the request whose latency and recall this subcommand measures.
	 */
	private static async _sweepOne(client: OpenAI, modelId: string, mode: CompletionMode, isText: boolean): Promise<SweepOutcome> {
		const startedAt = performance.now();
		const turns: SweepTurn[] = [];
		try {
			turns.push({ role: 'user', content: HistoryCommand._firstMessage });
			if (isText === true) {
				process.stdout.write(`[user] ${HistoryCommand._firstMessage}\n`);
				process.stdout.write('[assistant] ');
			}
			const firstTurn = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: HistoryCommand._firstMessage,
					},
				],
				mode,
				...(isText === true ? { writePiece: (piece: string) => { process.stdout.write(piece); } } : {}),
			});
			turns.push({ role: 'assistant', content: firstTurn.answer });
			if (isText === true) {
				process.stdout.write('\n');
			}

			turns.push({ role: 'user', content: HistoryCommand._secondMessage });
			if (isText === true) {
				process.stdout.write(`[user] ${HistoryCommand._secondMessage}\n`);
				process.stdout.write('[assistant] ');
			}
			const secondTurn = await CompletionSender.send({
				client,
				modelId,
				messages: [
					{
						role: 'user',
						content: HistoryCommand._firstMessage,
					},
					{
						role: 'assistant',
						content: firstTurn.answer,
					},
					{
						role: 'user',
						content: HistoryCommand._secondMessage,
					},
				],
				mode,
				...(isText === true ? { writePiece: (piece: string) => { process.stdout.write(piece); } } : {}),
			});
			turns.push({ role: 'assistant', content: secondTurn.answer });
			if (isText === true) {
				process.stdout.write('\n');
			}

			const secondAnswerLower = secondTurn.answer.toLowerCase();
			const recalledName = secondAnswerLower.includes('ada');
			const recalledLanguage = secondAnswerLower.includes('lisp');
			if (recalledName === false || recalledLanguage === false) {
				throw new Error(`the second turn's answer did not recall both facts the first turn stated: "${secondTurn.answer}"`);
			}

			return {
				modelId,
				mode,
				status: 'ok',
				timeToFirstCharacterMs: secondTurn.timeToFirstCharacterMs,
				timeToLastCharacterMs: secondTurn.timeToLastCharacterMs,
				characterCount: secondTurn.answer.length,
				answer: secondTurn.answer,
				failureMessage: undefined,
				turns,
				clusterGenerationTimeMs: secondTurn.clusterGenerationTimeMs,
				clusterTimeToFirstPieceMs: secondTurn.clusterTimeToFirstPieceMs,
			};
		} catch (error: unknown) {
			if (isText === true) {
				process.stdout.write('\n');
			}
			const elapsedMs = performance.now() - startedAt;
			return {
				modelId,
				mode,
				status: 'failed',
				timeToFirstCharacterMs: elapsedMs,
				timeToLastCharacterMs: elapsedMs,
				characterCount: 0,
				answer: '',
				failureMessage: CompletionSender.describeFailure(error),
				turns,
			};
		}
	}
}
