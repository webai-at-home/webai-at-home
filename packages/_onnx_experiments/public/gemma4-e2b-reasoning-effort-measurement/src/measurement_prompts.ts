///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MeasurementPrompts — the questions every phase of this measurement puts to the model
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The questions this measurement asks, kept in one place so that every phase asks the same thing and two phases can be
 * read against each other.
 *
 * One question has a settled answer and one has a step to work out. Thinking has nothing to do on a settled question,
 * so a model that thinks on both is thinking because the template told it to rather than because the question asked
 * for it, and that is the behaviour a worker browser tab would be handing to a consumer.
 */
export class MeasurementPrompts {
	/**
	 * A question with one settled answer and no step to work out.
	 *
	 * The same question the generation controls measurement of
	 * [issue #222](https://github.com/webai-at-home/webai-at-home/issues/222) used, which answered
	 * `"The capital of France is Paris."` in 8 tokens with thinking off, so this page has a recorded answer to compare
	 * against rather than only its own.
	 */
	static readonly SETTLED = 'What is the capital of France? Answer in one short sentence.';

	/** A question with a step to work out, which is where thinking has something to do. */
	static readonly REASONED =
		'A shop sells pens at 3 for 2 euros. How much do 9 pens cost? Answer in one short sentence.';

	/**
	 * One tool declaration, in the shape the chat template renders tool declarations from.
	 *
	 * Rendered by the phase that measures the chat template, because the template opens its system turn when tools are
	 * declared as well as when thinking is on, so the two settings could interact. The stage helper passes
	 * `enable_thinking` on this path too, in its own `renderedPrompt`.
	 */
	static readonly TOOL_DECLARATION = {
		type: 'function',
		function: {
			name: 'get_weather',
			description: 'Reports the weather in one city.',
			parameters: {
				type: 'object',
				properties: {
					city: {
						type: 'string',
						description: 'The city to report the weather of.',
					},
				},
				required: ['city'],
			},
		},
	};
}
