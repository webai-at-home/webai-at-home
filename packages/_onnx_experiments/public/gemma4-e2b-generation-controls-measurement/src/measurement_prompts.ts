///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MeasurementPrompts — the three questions this page puts to the model, and why each one
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The prompts every phase of this measurement generates from.
 *
 * A generation control is measured by holding everything still except the control, and the prompt is the largest of
 * the things held still. Each one is here rather than written into a phase so that two phases comparing their
 * answers are known to have asked the same question, character for character.
 */
export class MeasurementPrompts {
	/**
	 * The prompt the sampling phases use, for `temperature` and for `top_p`.
	 *
	 * It has to be a question with many acceptable answers. A question with one right answer, such as the capital of
	 * a country, is answered the same way at every temperature by a model that is sure enough, so three identical
	 * answers would say nothing about whether the temperature was read. Asking for one sentence keeps every run
	 * short enough to repeat six times.
	 */
	static readonly OPEN_ENDED = 'Write one sentence about the sea.';

	/**
	 * The prompt the token limit phase and the stop sequence phase use.
	 *
	 * Counting is asked for because the answer's shape is known before it is generated, so a cut answer and a
	 * stopped answer can both be read at a glance, and because a stop sequence can be pointed at a character the
	 * model is certain to write.
	 */
	static readonly COUNTING = 'Count from 1 to 9, separated by spaces. Answer with the numbers only.';

	/**
	 * The prompt the baseline phase uses, the one asking whether an answer that asked for nothing still generates
	 * byte for byte what it generates today.
	 *
	 * It has one right answer and a short one, which is what makes two greedy runs of it comparable character for
	 * character at a cost of a few tokens.
	 */
	static readonly SETTLED = 'What is the capital of France? Answer in one short sentence.';
}
