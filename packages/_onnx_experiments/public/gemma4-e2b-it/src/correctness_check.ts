import type { TextGenerationPipeline } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	CorrectnessCheck — asks questions whose answers are known, because WebGPU returns wrong numbers silently
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** How many tokens one check answer may hold. Short, because every question here has a short answer. */
const MAX_NEW_TOKENS = 64;

/** One question whose answer is known, and the text that answer has to hold. */
export type CorrectnessQuestion = {
	/** The question, written so that only one short answer is right. */
	prompt: string;
	/** The text the answer has to hold, compared without regard to letter case. */
	requiredText: string;
};

/** What one question produced when it was asked. */
export type CorrectnessResult = {
	/** The question that was asked. */
	question: CorrectnessQuestion;
	/** What the model answered, with the surrounding spaces removed. */
	answer: string;
	/** Whether {@link CorrectnessQuestion.requiredText} was found in the answer. */
	isPassed: boolean;
};

/**
 * The questions asked before any figure from this page is believed.
 *
 * Each answer is short, is the same in every runtime, and is not reached by chance by a model returning wrong
 * numbers. Generation is greedy on this page, so the same question always gives the same answer and a failure here
 * is repeatable rather than a matter of luck.
 */
const CORRECTNESS_QUESTIONS: readonly CorrectnessQuestion[] = [
	{
		prompt: 'What is the capital city of France? Answer with the name of the city only.',
		requiredText: 'Paris',
	},
	{
		prompt: 'What is 17 plus 25? Answer with the number only.',
		requiredText: '42',
	},
];

/**
 * Asks questions whose answers are known, and says whether the model got them right.
 *
 * A generation that runs to the end proves nothing on its own. WebGPU can return wrong numbers without reporting
 * an error, which is what killed
 * [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172), so a model that streams a fluent
 * paragraph may still be a model whose arithmetic is broken. This check is the smallest thing that tells the two
 * apart, and it is the same shape the hand-written WebGPU compute kernels page already uses in
 * `packages/_webgpu_experiments/public/gemma4-e2b-webgpu-kernels/`.
 *
 * This class never grades whether an answer is a good answer. It asks questions built so that the one fact under
 * test is visible in the answer, and it looks for that fact and nothing else.
 */
export class CorrectnessCheck {
	/** The questions this check asks, in the order it asks them. */
	static readonly questions = CORRECTNESS_QUESTIONS;

	/**
	 * Asks every question of {@link CorrectnessCheck.questions} and reports what came back.
	 *
	 * @param generator The loaded pipeline that answers the questions.
	 * @param onQuestionStarted Called with each question just before it is asked, so a page can say what it is doing.
	 * @returns One result per question, in the order the questions are written.
	 */
	static async run(
		generator: TextGenerationPipeline,
		onQuestionStarted?: (question: CorrectnessQuestion) => void,
	): Promise<readonly CorrectnessResult[]> {
		const results: CorrectnessResult[] = [];
		for (const question of CORRECTNESS_QUESTIONS) {
			onQuestionStarted?.(question);
			const answer = await CorrectnessCheck.answerOf(generator, question.prompt);
			results.push({
				question: question,
				answer: answer,
				isPassed: answer.toLowerCase().includes(question.requiredText.toLowerCase()),
			});
		}
		return results;
	}

	/**
	 * Whether every result passed.
	 *
	 * @param results What {@link CorrectnessCheck.run} produced.
	 * @returns `true` only when there is at least one result and every one of them passed.
	 */
	static isEveryCheckPassed(results: readonly CorrectnessResult[]): boolean {
		return results.length > 0 && results.every((result) => result.isPassed);
	}

	/**
	 * Asks one question and reads the answer back as text.
	 *
	 * @param generator The loaded pipeline that answers the question.
	 * @param prompt The question to ask.
	 * @returns The answer, with the surrounding spaces removed.
	 */
	private static async answerOf(generator: TextGenerationPipeline, prompt: string): Promise<string> {
		const result = await generator([{ role: 'user', content: prompt }], {
			max_new_tokens: MAX_NEW_TOKENS,
			do_sample: false,
			return_full_text: false,
			tokenizer_encode_kwargs: { enable_thinking: false },
		});
		return CorrectnessCheck.textOf(result).trim();
	}

	/**
	 * Reads the generated text out of whatever shape the pipeline returned.
	 *
	 * @param result What the pipeline returned.
	 * @returns The generated text, or an empty string when there is none to read.
	 */
	private static textOf(result: unknown): string {
		if (Array.isArray(result) === false) {
			return '';
		}
		const first = result[0];
		if (first === undefined || typeof first !== 'object' || 'generated_text' in first === false) {
			return '';
		}

		const generated = (first as { generated_text: unknown }).generated_text;
		if (Array.isArray(generated)) {
			const lastMessage = generated.at(-1);
			if (lastMessage !== undefined && typeof lastMessage === 'object' && 'content' in lastMessage) {
				const content = (lastMessage as { content: unknown }).content;
				return typeof content === 'string' ? content : '';
			}
			return '';
		}
		return typeof generated === 'string' ? generated : '';
	}
}
