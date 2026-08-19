// node imports
import Assert from 'node:assert/strict';
import Http from 'node:http';
import Test from 'node:test';

// local imports
import { RawHttpClient } from '../src/clients/raw_http_client.js';
import type { CompletionTarget } from '../src/completion_types.js';
import { EndpointReachability } from '../src/endpoint_reachability.js';
import { ModelResolver } from '../src/model_resolver.js';
import { SharedOptions, type RawSharedOptions } from '../src/shared_options.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The options every subcommand shares
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

//	The Shared Options
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('SharedOptions builds the endpoint out of the command line options', () => {
	const target = SharedOptions.buildTarget({
		base_url: 'http://localhost:1234/v1',
		api_key: 'no-key-required',
		timeout_ms: '600000',
	});
	Assert.deepEqual(target, {
		baseUrl: 'http://localhost:1234/v1',
		apiKey: 'no-key-required',
		timeoutMs: 600_000,
	});
});

Test('SharedOptions names the option at fault when a numeric option cannot be read', () => {
	Assert.throws(() => SharedOptions.positiveInteger('not-a-number', '--timeout_ms'), /--timeout_ms/);
});

/**
 * Builds the shared options every `--stream` test below starts from.
 *
 * @param stream What `--stream` was given, or `undefined` when the option was left out.
 * @returns The options, ready to hand to `SharedOptions.resolveStreamSettings`.
 */
function sharedOptionsWithStream(stream: string | undefined): RawSharedOptions {
	return {
		model: 'a-model',
		base_url: 'http://localhost:1234/v1',
		api_key: 'no-key-required',
		timeout_ms: '600000',
		format: 'text',
		...(stream === undefined ? {} : { stream }),
	};
}

Test('SharedOptions measures both stream settings when --stream was left out', () => {
	Assert.deepEqual(SharedOptions.resolveStreamSettings(sharedOptionsWithStream(undefined)), ['off', 'on']);
});

Test('SharedOptions measures only the setting --stream names, whichever of the two it is', () => {
	Assert.deepEqual(SharedOptions.resolveStreamSettings(sharedOptionsWithStream('on')), ['on']);
	Assert.deepEqual(SharedOptions.resolveStreamSettings(sharedOptionsWithStream('off')), ['off']);
	Assert.deepEqual(SharedOptions.resolveStreamSettings(sharedOptionsWithStream(' ON ')), ['on']);
});

Test('SharedOptions refuses a --stream value that is neither on nor off, rather than measuring both', () => {
	Assert.throws(() => SharedOptions.resolveStreamSettings(sharedOptionsWithStream('true')), /--stream must be one of off, on, got "true"/);
	Assert.throws(() => SharedOptions.resolveStreamSettings(sharedOptionsWithStream('')), /--stream must be one of off, on/);
});

///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The model resolver, and the proof a listed model can answer under its own name
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The model identifiers the listing server below names, an embedding model among them. */
const listedModelIds = ['llama-3.2-1b-instruct', 'llm_qwen3_0_6b_sharded', 'llm_llama3_2_1b_full', 'text-embedding-nomic-embed-text-v1.5'];

/**
 * Starts a local HTTP server that answers `GET /models` with the listing above.
 *
 * @returns The client to hand the resolver, and how to stop the server again.
 */
async function startListingServer(): Promise<{ target: CompletionTarget; rawHttpClient: RawHttpClient; stop: () => Promise<void> }> {
	const server = Http.createServer((request, response) => {
		response.writeHead(200, {
			'content-type': 'application/json',
		});
		response.end(JSON.stringify({
			data: listedModelIds.map((modelId) => ({
				id: modelId,
				object: 'model',
			})),
		}));
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the test server did not report a port');
	}
	const target: CompletionTarget = {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		apiKey: 'no-key-required',
		timeoutMs: 5_000,
	};
	return {
		target,
		rawHttpClient: new RawHttpClient(target),
		stop: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

Test('the model resolver reads a listing in the order the endpoint named it', async () => {
	const server = await startListingServer();
	try {
		Assert.deepEqual(await ModelResolver.listModelIds(server.rawHttpClient), listedModelIds);
	} finally {
		await server.stop();
	}
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Whether anything is listening at all, before a run starts measuring
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('an endpoint that answers any status at all is reachable, 404 included', async () => {
	const server = Http.createServer((request, response) => {
		response.writeHead(404, {
			'content-type': 'application/json',
		});
		response.end('{"error":"this server has no GET /models"}');
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('the test server did not report a port');
	}
	const target: CompletionTarget = {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		apiKey: 'no-key-required',
		timeoutMs: 5_000,
	};
	try {
		await EndpointReachability.assertReachable(new RawHttpClient(target), target.baseUrl);
	} finally {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}
});

Test('an endpoint nothing is listening on is refused before the first test, and named in the message', async () => {
	const target: CompletionTarget = {
		baseUrl: 'http://127.0.0.1:1/v1',
		apiKey: 'no-key-required',
		timeoutMs: 2_000,
	};
	await Assert.rejects(
		async () => await EndpointReachability.assertReachable(new RawHttpClient(target), target.baseUrl),
		/http:\/\/127\.0\.0\.1:1\/v1 could not be reached[\s\S]*--base_url/,
	);
});

Test('the reason a connection was refused is unwrapped out of the causes Node.js hides it inside', () => {
	const refusal = new Error('connect ECONNREFUSED 127.0.0.1:1');
	const aggregated = new AggregateError([refusal]);
	const thrown = new Error('fetch failed', { cause: aggregated });
	Assert.equal(EndpointReachability.describeError(thrown), 'fetch failed: connect ECONNREFUSED 127.0.0.1:1');
	Assert.equal(EndpointReachability.describeError('not an error at all'), 'not an error at all');
});
