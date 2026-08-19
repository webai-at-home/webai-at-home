import { env, pipeline, TextStreamer, type TextGenerationPipeline } from '@huggingface/transformers';
import { WebgpuRequirement, type AdapterReport } from './webgpu_requirement';
import { CorrectnessCheck, type CorrectnessResult } from './correctness_check';

type CacheEntry = {
	body: ArrayBuffer;
	headers: Record<string, string>;
	status: number;
};

type ProgressCallback = (progress: { loaded: number; total: number; progress: number }) => void;

type IndexedDbCache = {
	match: (key: string) => Promise<Response | undefined>;
	put: (key: string, response: Response, progressCallback?: ProgressCallback) => Promise<void>;
};

type Model = {
	shortName: string;
	fullName: string;
	id: string;
	dtype: 'q4' | 'q4f16';
	accent: 'amber' | 'blue';
	kind: 'text' | 'gemma4';
	prompt: string;
};

env.allowLocalModels = false;
// Qwen's graph produces expected provider-assignment warnings during startup.
// Keep actionable runtime errors visible without filling the browser console.
function configureOnnxLogging() {
	if (document.body.dataset.model === 'qwen') {
		env.backends.onnx.logLevel = 'error';
	}
}

configureOnnxLogging();

const indexedDbCache = createIndexedDbCache();
if (indexedDbCache) {
	env.useBrowserCache = false;
	env.useCustomCache = true;
	env.customCache = indexedDbCache;
} else {
	// Keep the existing persistent cache as a fallback for browsers where
	// IndexedDB is unavailable or disabled.
	env.useBrowserCache = true;
}

function createIndexedDbCache(): IndexedDbCache | null {
	if (typeof indexedDB === 'undefined' || typeof Response === 'undefined') return null;

	const databaseName = 'webai-onnx-experiments';
	const storeName = 'model-files';
	let databasePromise: Promise<IDBDatabase> | undefined;

	function openDatabase() {
		if (!databasePromise) {
			databasePromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(databaseName, 1);
				request.onupgradeneeded = () => request.result.createObjectStore(storeName);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}
		return databasePromise;
	}

	async function read(key: string): Promise<CacheEntry | undefined> {
		const database = await openDatabase();
		return new Promise((resolve, reject) => {
			const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(key);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async function write(key: string, value: CacheEntry): Promise<void> {
		const database = await openDatabase();
		return new Promise((resolve, reject) => {
			const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}

	return {
		async match(key: string): Promise<Response | undefined> {
			try {
				const entry = await read(key);
				if (!entry) return undefined;
				return new Response(entry.body, {
					status: entry.status,
					headers: entry.headers,
				});
			} catch (error) {
				console.warn('Unable to read the IndexedDB model cache:', error);
				return undefined;
			}
		},

		async put(key: string, response: Response, progressCallback?: ProgressCallback): Promise<void> {
			try {
				const body = await response.arrayBuffer();
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => {
					headers[key] = value;
				});
				await write(key, {
					body,
					headers,
					status: response.status,
				});
				progressCallback?.({ loaded: body.byteLength, total: body.byteLength, progress: 100 });
			} catch (error) {
				console.warn('Unable to write the IndexedDB model cache:', error);
			}
		},
	};
}

const models: Record<string, Model> = {
	qwen: {
		shortName: 'Qwen3',
		fullName: 'Qwen3-0.6B-ONNX',
		id: 'onnx-community/Qwen3-0.6B-ONNX',
		dtype: 'q4f16',
		accent: 'amber',
		kind: 'text',
		prompt: 'Explain in two short sentences why running a language model in the browser can be useful.',
	},
	smollm: {
		shortName: 'SmolLM2',
		fullName: 'SmolLM2-360M-Instruct',
		id: 'eduardoworrel/SmolLM2-360M-Instruct',
		dtype: 'q4',
		accent: 'blue',
		kind: 'text',
		prompt: 'Explain in two short sentences why running a language model in the browser can be useful.',
	},
	gemma: {
		shortName: 'Gemma 4',
		fullName: 'E2B-it-ONNX',
		id: 'onnx-community/gemma-4-E2B-it-ONNX',
		dtype: 'q4f16',
		accent: 'blue',
		kind: 'gemma4',
		prompt: 'Explain in two short sentences why running a language model in the browser can be useful.',
	},
};

const model = models[document.body.dataset.model ?? ''];
if (!model) throw new Error('The page must specify a supported model in the body data-model attribute.');

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('The page must contain an #app element.');

let generator: TextGenerationPipeline | undefined;
let loadStartedAt: number | undefined;
let modelLoadPromise: Promise<TextGenerationPipeline> | undefined;

app.innerHTML = `
  <main class="shell experiment-shell ${model.accent}">
    <header class="topbar">
      <a class="back-link" href="../">← All experiments</a>
      <span class="runtime-pill"><i></i><span id="runtime-label">Checking runtime</span></span>
    </header>
    <section class="hero">
      <p class="eyebrow">Browser inference / field test ${model.kind === 'gemma4' ? '03' : model.accent === 'amber' ? '01' : '02'}</p>
      <h1>${model.shortName}<br /><em>${model.fullName}</em></h1>
      <p class="intro">A compact ONNX language model running locally in this browser. Load it once, then measure a real generation on your device.</p>
    </section>
    <section class="test-panel" aria-labelledby="test-heading">
      <div class="panel-heading">
        <div><p class="section-label">Test prompt</p><h2 id="test-heading">A small question, a useful answer.</h2></div>
        <span class="model-tag">${model.id}</span>
      </div>
      <label class="sr-only" for="prompt">Prompt</label>
      <textarea id="prompt" rows="3">${model.prompt}</textarea>
      <div class="controls">
        <button id="run-button" class="primary-button" type="button">Load model &amp; run inference <span>↗</span></button>
		<span class="hint">Streaming · stops at the end token</span>
      </div>
    </section>
    <section class="results" aria-live="polite">
      <div class="result-copy"><p class="section-label">Output</p><p id="output" class="output-text placeholder">Run the experiment to see the model's answer.</p></div>
      <div class="metrics">
        <div class="metric"><span>Model load</span><strong id="load-time">—</strong></div>
        <div class="metric"><span>Generation</span><strong id="generation-time">—</strong></div>
        <div class="metric"><span>Output rate</span><strong id="speed">—</strong></div>
        <div class="metric"><span>Backend</span><strong id="backend">—</strong></div>
      </div>
    </section>
    <section class="test-panel" aria-labelledby="check-heading">
      <div class="panel-heading">
        <div><p class="section-label">Correctness</p><h2 id="check-heading">Questions whose answers are known.</h2></div>
      </div>
      <p class="intro">WebGPU can return wrong numbers without reporting an error, so a generation that runs to the end proves nothing on its own. These questions are asked before any figure on this page is believed.</p>
      <div class="controls">
        <button id="check-button" class="primary-button" type="button">Run the correctness check <span>↗</span></button>
        <span class="hint">Greedy decoding · the same answer every time</span>
      </div>
      <ul id="check-results" class="check-results"></ul>
      <p id="check-verdict" class="output-text placeholder">The check has not been run.</p>
    </section>
    <p id="status" class="status">Ready. The first run downloads the ONNX weights; later page loads use IndexedDB.</p>
    <footer><span>ONNX Runtime Web + Transformers.js</span><span>Local inference · no prompt upload</span></footer>
  </main>
`;

function getElement<T extends HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`The page must contain ${selector}.`);
	return element;
}

const button = getElement<HTMLButtonElement>('#run-button');
const checkButton = getElement<HTMLButtonElement>('#check-button');
const status = getElement<HTMLElement>('#status');
const output = getElement<HTMLElement>('#output');
const runtimeLabel = getElement<HTMLElement>('#runtime-label');
const backend = getElement<HTMLElement>('#backend');

// Gemma 4 E2B is required to run on WebGPU here, so this page never falls back to WebAssembly. A WebAssembly
// answer would look like a working experiment while proving nothing about the WebGPU path a worker browser tab
// takes, which is the false green that killed issue #172 once already.
let adapterReport: AdapterReport | undefined;
runtimeLabel.textContent = 'Checking WebGPU';
backend.textContent = 'WebGPU required';

// Read the console before the first session is built. ONNX Runtime Web states a dropped execution provider there
// and nowhere else, and it states it while the session is being created.
WebgpuRequirement.watchForADroppedProvider();

function setStatus(message: string): void {
	status.textContent = message;
}

function getText(result: unknown): string {
	if (!Array.isArray(result)) return '';
	const first = result[0];
	if (!first || typeof first !== 'object' || !('generated_text' in first)) return '';

	const generated = first.generated_text;
	if (Array.isArray(generated)) {
		const lastMessage = generated.at(-1);
		return lastMessage && typeof lastMessage === 'object' && 'content' in lastMessage && typeof lastMessage.content === 'string'
			? lastMessage.content
			: '';
	}
	return typeof generated === 'string' ? generated : '';
}

function loadModel(): Promise<TextGenerationPipeline> {
	if (generator) return Promise.resolve(generator);
	if (modelLoadPromise) return modelLoadPromise;

	// Reapply this immediately before session creation. ONNX Runtime reads the
	// setting when its WebAssembly runtime starts, not when the page is built.
	configureOnnxLogging();
	loadStartedAt = performance.now();
	modelLoadPromise = WebgpuRequirement.demandWebgpu().then((report) => {
		adapterReport = report;
		runtimeLabel.textContent = 'WebGPU required and present';
		setStatus(`Downloading ${model.fullName}. This can take a while on the first run…`);
		// Asked for without a fallback on purpose: a run that cannot use WebGPU must fail loudly here rather than
		// answer from WebAssembly and be read as a passing gate.
		return pipeline('text-generation', model.id, {
			device: 'webgpu',
			dtype: model.dtype,
			progress_callback: (progress) => {
				if (progress.status === 'progress' && progress.file) {
					const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress)}%` : '';
					setStatus(`Downloading ${progress.file}${percent}…`);
				}
			},
		});
	}).then(async (loadedGenerator) => {
		const verdict = await WebgpuRequirement.verdictAfterLoading();
		backend.textContent = verdict.isWebgpu ? 'WebGPU' : 'NOT WebGPU';
		runtimeLabel.textContent = verdict.explanation;
		if (verdict.isWebgpu === false) {
			throw new Error(verdict.explanation);
		}

		generator = loadedGenerator;
		getElement<HTMLElement>('#load-time').textContent = `${((performance.now() - (loadStartedAt ?? performance.now())) / 1000).toFixed(1)} s`;
		const adapterWords = [adapterReport?.vendor, adapterReport?.architecture, adapterReport?.description]
			.filter((word) => word !== undefined && word !== '')
			.join(' ');
		setStatus(`Model ready on WebGPU${adapterWords === '' ? '' : ` (${adapterWords})`}. Run the correctness check before believing any figure.`);
		button.disabled = false;
		button.innerHTML = 'Run inference <span>↗</span>';
		checkButton.disabled = false;
		return loadedGenerator;
	}).catch((error: unknown) => {
		modelLoadPromise = undefined;
		button.disabled = true;
		button.innerHTML = 'Cannot run without WebGPU';
		runtimeLabel.textContent = 'WebGPU missing';
		backend.textContent = 'none';
		throw error;
	});

	return modelLoadPromise;
}

button.addEventListener('click', async () => {
	button.disabled = true;
	button.innerHTML = 'Working… <span class="spinner"></span>';
	output.classList.remove('placeholder');
	output.textContent = '';
	const totalStartedAt = performance.now();
	try {
		const loadedGenerator = await loadModel();
		setStatus('Model is ready. Running inference…');

		const generationStartedAt = performance.now();
		const prompt = getElement<HTMLTextAreaElement>('#prompt').value;
		let streamedText = '';
		const streamer = new TextStreamer(loadedGenerator.tokenizer, {
			skip_prompt: true,
			skip_special_tokens: true,
			callback_function: (chunk: string) => {
				streamedText += chunk;
				output.textContent = streamedText;
			},
		});
		const result = await loadedGenerator([{ role: 'user', content: prompt }], {
			// Keep a high safety bound in case the model never emits its end token.
			max_new_tokens: 2048,
			do_sample: false,
			return_full_text: false,
			tokenizer_encode_kwargs: { enable_thinking: false },
			streamer,
		});
		const answer = getText(result).trim();
		const generationMs = performance.now() - generationStartedAt;
		const tokenCount = Math.max(1, answer.split(/\s+/).length);
		output.textContent = answer || streamedText || 'The model returned an empty answer.';
		getElement<HTMLElement>('#generation-time').textContent = `${(generationMs / 1000).toFixed(2)} s`;
		getElement<HTMLElement>('#speed').textContent = `${(tokenCount / (generationMs / 1000)).toFixed(1)} words/s`;
		setStatus(`Complete in ${((performance.now() - totalStartedAt) / 1000).toFixed(1)} s. Model files remain in IndexedDB for later page loads.`);
	} catch (error: unknown) {
		console.error(error);
		output.textContent = 'The experiment could not start. Check the browser console for details.';
		setStatus(`Error: ${error instanceof Error ? error.message : 'unknown error'}`);
	} finally {
		button.disabled = false;
		button.innerHTML = 'Run inference again <span>↗</span>';
	}
});

checkButton.addEventListener('click', async () => {
	checkButton.disabled = true;
	button.disabled = true;
	const resultList = getElement<HTMLElement>('#check-results');
	const verdictLine = getElement<HTMLElement>('#check-verdict');
	resultList.replaceChildren();
	verdictLine.classList.remove('placeholder');
	verdictLine.textContent = '';

	try {
		const loadedGenerator = await loadModel();
		const results = await CorrectnessCheck.run(loadedGenerator, (question) => {
			setStatus(`Checking: ${question.prompt}`);
		});
		for (const result of results) {
			resultList.appendChild(buildCheckResult(result));
		}

		const isEveryCheckPassed = CorrectnessCheck.isEveryCheckPassed(results);
		const backendVerdict = await WebgpuRequirement.verdictAfterLoading();
		verdictLine.textContent = isEveryCheckPassed
			? `Every correctness check passed, on WebGPU. ${backendVerdict.explanation}`
			: 'A correctness check failed. Do not believe any figure from this page: WebGPU is returning wrong numbers silently.';
		setStatus(isEveryCheckPassed ? 'Correctness check passed.' : 'Correctness check FAILED.');
	} catch (error: unknown) {
		console.error(error);
		verdictLine.textContent = `The correctness check could not finish: ${error instanceof Error ? error.message : 'unknown error'}`;
		setStatus('The correctness check could not finish.');
	} finally {
		checkButton.disabled = false;
		button.disabled = false;
	}
});

function buildCheckResult(result: CorrectnessResult): HTMLLIElement {
	const item = document.createElement('li');
	item.className = result.isPassed ? 'check-result passed' : 'check-result failed';
	const question = document.createElement('p');
	question.className = 'check-question';
	question.textContent = `${result.isPassed ? 'PASS' : 'FAIL'} · ${result.question.prompt}`;
	const answer = document.createElement('p');
	answer.className = 'check-answer';
	answer.textContent = `Answered: ${result.answer === '' ? '(nothing)' : result.answer}  ·  had to hold: ${result.question.requiredText}`;
	item.append(question, answer);
	return item;
}

button.disabled = true;
checkButton.disabled = true;
button.innerHTML = 'Loading model… <span class="spinner"></span>';
void loadModel().catch((error: unknown) => {
	console.error(error);
	setStatus(`Unable to load ${model.fullName}: ${error instanceof Error ? error.message : 'unknown error'}`);
});
