// node imports
import Assert from 'node:assert/strict';
import Test from 'node:test';

// local imports
import { ResponseConstraint, type ResponseFormat } from '../index.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The three facts this project relies on from a package it does not control
//
//	`index.js` is a checked-in build of somebody else's source, refreshed by
//	`tools/vendor_refresh.mjs` when `upstream.json` names a newer commit. Nothing about that source
//	is this project's to keep working, and a refresh can change any of it.
//
//	So the facts this project builds on are asserted here rather than assumed. Each one was measured
//	live in the milestone 0 de-risk test of
//	[issue #221](https://github.com/webai-at-home/webai-at-home/issues/221), and each one is a thing
//	whose absence would otherwise only show up in a volunteer's browser tab, on a model that takes
//	several minutes to load.
//
//	No model is loaded here. Every assertion below is about the package's own interface, which is
//	why these tests run in a second.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The smallest tokenizer `extractTokenizer` accepts, in the direct form it takes when `tokens` is already an array
 * of byte arrays. Four one-byte tokens are enough to build a constraint, and building one is all these tests do.
 *
 * A real tokenizer is never needed for the questions asked here, and asking for one would mean loading a model.
 */
const smallestTokenizer = {
	tokens: [
		Uint8Array.of(0x7b),
		Uint8Array.of(0x7d),
		Uint8Array.of(0x22),
		Uint8Array.of(0x61),
	],
	eosTokenId: 0,
};

Test('offers the two entry points this project calls', () => {
	Assert.equal(typeof ResponseConstraint.warmup, 'function');
	Assert.equal(typeof ResponseConstraint.fromResponseFormat, 'function');
});

Test('builds a constraint with both halves, for json_object and for json_schema alike', () => {
	const responseFormats: ResponseFormat[] = [
		{ type: 'json_object' },
		{
			type: 'json_schema',
			json_schema: {
				type: 'object',
				properties: { city: { type: 'string' } },
				required: ['city'],
				additionalProperties: false,
			},
		},
	];
	for (const responseFormat of responseFormats) {
		const constraint = ResponseConstraint.fromResponseFormat(smallestTokenizer, responseFormat);
		Assert.equal(typeof constraint.logits_processor, 'function', 'the logits processor is a callable list');
		Assert.equal(typeof constraint.stopping_criteria, 'function', 'the stopping criterion is callable');
	}
});

Test('keeps the sampled-token method the released @huggingface/transformers never calls', () => {
	// The whole reason `SampledTokenForwarder` exists. `ConstraintLogitsProcessor` advances its grammar in
	// `onTokensSampled`, and released `@huggingface/transformers` 4.2.0 has no `LogitsProcessorList.onTokensSampled`
	// and makes no such call, so this project makes it. A refresh that renamed or removed this method would leave the
	// worker browser tab masking every step from the grammar's opening state — a run that looks constrained, reports
	// no error, and constrains nothing. That failure is invisible without this assertion.
	const constraint = ResponseConstraint.fromResponseFormat(smallestTokenizer, { type: 'json_object' });
	const processors = constraint.logits_processor.processors;
	Assert.equal(processors.length, 1, 'the list holds exactly the one processor the forwarder reaches into');
	Assert.equal(typeof processors[0].onTokensSampled, 'function');
});

Test('refuses a schema it cannot enforce while the constraint is built, and names what it could not keep', () => {
	// What lets a consumer refuse such a request at submission by asking the package, rather than by keeping a list
	// of its own that would drift from what the package really enforces.
	Assert.throws(
		() => ResponseConstraint.fromResponseFormat(smallestTokenizer, {
			type: 'json_schema',
			json_schema: {
				type: 'object',
				properties: { city: { $ref: 'https://example.invalid/city.schema.json' } },
				required: ['city'],
			},
		}),
		(error: unknown) => {
			Assert.ok(error instanceof TypeError);
			Assert.match(error.message, /https:\/\/example\.invalid\/city\.schema\.json/);
			return true;
		},
	);
});

Test('takes the whitespace control on the root schema, and refuses an option it does not know', () => {
	// Milestone 0 measured five of seven shapes running to the token limit writing whitespace, because the grammar
	// returns the same state for every whitespace byte and greedy decoding has a fixed point there. This option is
	// the way out, so a refresh that renamed it has to fail here rather than in a browser tab.
	const constraint = ResponseConstraint.fromResponseFormat(smallestTokenizer, {
		type: 'json_schema',
		json_schema: {
			'x-guidance': { whitespace_flexible: false },
			type: 'object',
			properties: { city: { type: 'string' } },
			required: ['city'],
			additionalProperties: false,
		},
	});
	Assert.equal(typeof constraint.logits_processor, 'function');

	Assert.throws(() => ResponseConstraint.fromResponseFormat(smallestTokenizer, {
		type: 'json_schema',
		json_schema: {
			'x-guidance': { whitespace_flexible_please: false },
			type: 'object',
		},
	}), TypeError);
});
