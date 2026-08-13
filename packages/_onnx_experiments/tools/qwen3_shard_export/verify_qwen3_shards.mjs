#!/usr/bin/env node

// onnxruntime-node versions that expose a native Float16Array can select a
// browser-only typed-array path. Qwen3's empty float16 cache is represented by
// Uint16Array, matching the browser implementation.
globalThis.Float16Array = undefined;

import * as ort from 'onnxruntime-node';

const shardPaths = [1, 2, 3].map((index) => `packages/onnx_experiments/public/onnxruntime_qwen3-0.6b-with-shards/shards/shard-${index}.onnx`);
const sessions = await Promise.all(shardPaths.map((path) => ort.InferenceSession.create(path)));
const referenceSession = process.argv[2] ? await ort.InferenceSession.create(process.argv[2]) : undefined;
const emptyCache = () => new ort.Tensor('float16', new Uint16Array(0), [1, 8, 0, 128]);
const makeFeeds = (session, token, position, boundary, cache) => {
	const feeds = {
		input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(token)]), [1, 1]),
		attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: position + 1 }, () => 1n), [1, position + 1]),
		position_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(position)]), [1, 1]),
	};
	if (boundary) Object.assign(feeds, boundary);
	for (const name of session.inputNames.filter((inputName) => inputName.startsWith('past_key_values.'))) feeds[name] = cache?.[name] ?? emptyCache();
	return feeds;
};

let token = 151644;
const caches = [undefined, undefined, undefined];
for (let step = 0; step < 3; step += 1) {
	let boundary;
	let logits;
	for (const [index, session] of sessions.entries()) {
		const outputs = await session.run(makeFeeds(session, token, step, boundary, caches[index]));
		caches[index] = Object.fromEntries(Object.entries(outputs)
			.filter(([name]) => name.startsWith('present.'))
			.map(([name, value]) => [name.replace('present', 'past_key_values'), value]));
		if (index < 2) {
			const prefix = index === 0 ? '9' : '19';
			boundary = {
				[`/model/layers.${prefix}/input_layernorm/output_0`]: outputs[`/model/layers.${prefix}/input_layernorm/output_0`],
				[`/model/layers.${prefix}/input_layernorm/output_3`]: outputs[`/model/layers.${prefix}/input_layernorm/output_3`],
			};
		} else {
			logits = outputs.logits;
		}
	}
	const values = logits.data;
	const vocabularySize = logits.dims.at(-1);
	if (referenceSession && step === 0) {
		const reference = await referenceSession.run(makeFeeds(referenceSession, token, step, undefined, undefined));
		const referenceLogits = reference.logits.data;
		let maxDifference = 0;
		for (let index = 0; index < referenceLogits.length; index += 1) maxDifference = Math.max(maxDifference, Math.abs(Number(values[index]) - Number(referenceLogits[index])));
		console.log(`reference comparison: max logit difference ${maxDifference}`);
		if (maxDifference > 0.01) throw new Error(`Shard logits differ from the monolithic model by ${maxDifference}.`);
	}
	let best = 0;
	for (let index = 1; index < vocabularySize; index += 1) if (values[index] > values[best]) best = index;
	console.log(`step ${step + 1}: shard 1 → shard 2 → shard 3; boundary [1,1,1024]; logits [1,1,${vocabularySize}]; next token ${best}`);
	token = best;
}

console.log('Three-shard inference verification passed.');
