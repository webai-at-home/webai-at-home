// local imports
import { JsonResponseReader } from '../../../readers/json_response_reader.js';
import type { ConformanceTest, TestContext, TestResult } from '../../types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	HistoryRecalledTest — the second turn's answer carries both facts the first turn stated
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Sends a two-turn exchange and checks that the second answer carries both facts the first turn
 * stated.
 *
 * This reads the answer's words, and it is a measurement rather than a grade. The first turn
 * states two facts and asks for nothing back; the second turn asks a question whose answer exists
 * nowhere except in that first turn. An answer naming Ada and Lisp can only have come from a model
 * that read the history, and an answer naming neither can only have come from one that did not.
 * Nothing here says whether the answer was a good answer, which is the line the refined content
 * rule of `../../CONTEXT.md` draws.
 *
 * A missing fact is `WARN` rather than `FAIL`, for the same reason a model that declines to ask
 * for a tool is `WARN`: the endpoint carried the history correctly — `history.accepted` is the
 * test that says so — and what the model then did with it is the model's own doing.
 *
 * The two turns are sent as many times as `-r/--repeats` asked for, stopping at the first second
 * answer that carries both facts, because whether a small model recalls them is a choice it makes
 * afresh each time. Measured against `llama-3.2-1b-instruct` on LM Studio 0.4.20, fifteen second
 * answers of twenty carried both facts and five denied knowing either — while still addressing the
 * reply to Ada, so the history had reached the model every time. One send therefore reported an
 * ability the endpoint and the model both had as missing about one run in four, which is the flake
 * [issue #208](https://github.com/webai-at-home/webai-at-home/issues/208) recorded. Sending three
 * times and taking the best is the same rule `ToolCallProber` already follows.
 */
class HistoryRecalledTest {
	/** The first turn, stating two facts and asking for nothing back. */
	private static readonly _firstMessage = 'My name is Ada and my favorite programming language is Lisp. Please just say hello back.';

	/** The second turn, asking a question that can only be answered by recalling what the first turn said. */
	private static readonly _secondMessage = 'What is my name, and what is my favorite programming language? Answer in one short sentence.';

	/** The two facts the first turn stated, each as the lower-cased word an answer that recalled it must carry. */
	private static readonly _facts = ['ada', 'lisp'] as const;

	/**
	 * Sends the two turns as many times as `-r/--repeats` asked for, and stops at the first second
	 * answer that carries both facts.
	 *
	 * @param context The endpoint, the model, both clients, and the repeat count to run this test
	 * with.
	 * @returns The verdict this run reached.
	 */
	static async run(context: TestContext): Promise<TestResult> {
		const secondAnswers: string[] = [];
		for (let runIndex = 0; runIndex < context.repeats; runIndex += 1) {
			const firstAnswer = await HistoryRecalledTest._ask(context, [
				{ role: 'user', content: HistoryRecalledTest._firstMessage },
			]);
			if (typeof firstAnswer !== 'string') {
				return firstAnswer;
			}

			const secondAnswer = await HistoryRecalledTest._ask(context, [
				{ role: 'user', content: HistoryRecalledTest._firstMessage },
				{ role: 'assistant', content: firstAnswer },
				{ role: 'user', content: HistoryRecalledTest._secondMessage },
			]);
			if (typeof secondAnswer !== 'string') {
				return secondAnswer;
			}
			secondAnswers.push(secondAnswer);

			const secondAnswerLower = secondAnswer.toLowerCase();
			const missing = HistoryRecalledTest._facts.filter((fact) => secondAnswerLower.includes(fact) === false);
			if (missing.length === 0) {
				return {
					verdict: 'PASS',
					detail: `the second answer carries both facts the first turn stated on try ${secondAnswers.length} of ${context.repeats}, answer=${JSON.stringify(secondAnswer)}`,
				};
			}
		}
		return {
			verdict: 'WARN',
			detail: `no second answer of ${secondAnswers.length} carries both ${HistoryRecalledTest._facts.join(' and ')}, answers=${JSON.stringify(secondAnswers)}`,
		};
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Sends one turn and reads its answer.
	 *
	 * @param context The endpoint, the model, and both clients to run this test with.
	 * @param messages The whole history to send, in the order it is sent.
	 * @returns The answer text, or the `FAIL` to report when the endpoint produced none.
	 */
	private static async _ask(context: TestContext, messages: readonly Record<string, unknown>[]): Promise<string | TestResult> {
		const { status, json } = await context.rawHttpClient.postChatCompletion({
			model: context.modelId,
			messages,
		});
		if (status !== 200) {
			return { verdict: 'FAIL', detail: `HTTP ${status}: ${JSON.stringify(json)}` };
		}
		const content = JsonResponseReader.messageContent(json);
		if (content === undefined || content.trim() === '') {
			return { verdict: 'FAIL', detail: `no message content: ${JSON.stringify(json)}` };
		}
		return content;
	}
}

export const historyRecalledTest: ConformanceTest = {
	id: 'history.recalled',
	name: 'the second turn recalls what the first turn said',
	group: 'history',
	run: HistoryRecalledTest.run,
};
