// local imports
import type { OpenaiPackageClient } from '../clients/openai_package_client.js';
import type { RawHttpClient } from '../clients/raw_http_client.js';
import type { GenerationControlProbeCache } from './probes/generation_control_probe_cache.js';
import type { ToolCallProbeCache } from './probes/tool_call_probe_cache.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	types — the shapes every test, client, and report shares
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The four statuses a conformance test can reach, exactly as section 32 of issue #181 defines
 * them:
 *
 * - `PASS`: the feature behaves correctly.
 * - `FAIL`: the feature is expected to work and does not.
 * - `SKIP`: the endpoint declared the feature unsupported, and the request was refused for that
 *   reason rather than answered incorrectly.
 * - `WARN`: the endpoint behaved correctly, but the outcome may still cause a compatibility
 *   problem — including a model choosing not to use a capability the endpoint genuinely accepted.
 */
export type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';

/** What one run of one conformance test found. */
export type TestResult = {
	/** The verdict this run reached. */
	readonly verdict: Verdict;
	/** What was seen, in words, so a `FAIL` or a `WARN` can be explained rather than only counted. */
	readonly detail: string;
};

/** Everything one conformance test needs to run once against one endpoint and one model. */
export type TestContext = {
	/** The transport for a test that inspects the raw protocol: the HTTP status, the response headers, the body. */
	readonly rawHttpClient: RawHttpClient;
	/** The transport for a test that asks whether the official `openai` Node.js package itself keeps working. */
	readonly openaiPackageClient: OpenaiPackageClient;
	/** The model identifier every request is sent with. */
	readonly modelId: string;
	/**
	 * The one `ToolCallProber` run the six tool call tests share, so that probing six abilities
	 * costs one run's requests rather than six.
	 */
	readonly toolCallProbeCache: ToolCallProbeCache;
	/**
	 * The one `GenerationControlProber` run the five generation control tests share, for the same
	 * reason `toolCallProbeCache` exists.
	 */
	readonly generationControlProbeCache: GenerationControlProbeCache;
};

/**
 * One conformance test, in the shape section 36 of issue #181 defines.
 *
 * A test declares which client it uses by which one its `run` method calls; nothing here forces
 * that choice, so the rule lives in `CONTEXT.md` instead: a test that inspects the raw protocol —
 * an HTTP status, a response header, an error body's exact shape — uses `rawHttpClient`, and a
 * test that asks whether the official `openai` Node.js package itself keeps working uses
 * `openaiPackageClient`. No test uses both.
 */
export type ConformanceTest = {
	/** A stable identifier, in the `group.name` shape section 26 of issue #181 asks for. */
	readonly id: string;
	/** The line printed for this test in the terminal report. */
	readonly name: string;
	/** Which group this test belongs to, and which heading it is printed under. */
	readonly group: string;
	/**
	 * Runs this test once.
	 *
	 * @param context The endpoint, the model, and both clients to run it with.
	 * @returns The verdict this run reached.
	 */
	readonly run: (context: TestContext) => Promise<TestResult>;
};
