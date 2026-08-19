import { env } from '@huggingface/transformers';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebgpuRequirement — refuses to run Gemma 4 E2B on anything but WebGPU, and proves which one ran
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * The warning ONNX Runtime Web prints when it drops an execution provider it was asked for. Catching this exact
 * text is the one signal that says the WebGPU execution provider was requested and then not used, which is the
 * silent fallback this whole file exists to make impossible.
 */
const EXECUTION_PROVIDER_REMOVED_WARNING = 'removing requested execution provider';

/**
 * The WebGPU feature the `q4f16` quantization needs. The repository's `transformers.js_config` names `float16` as
 * the key-value cache type for that quantization, so an adapter without 16-bit floating point shaders cannot run
 * this model even though it can run WebGPU.
 */
const REQUIRED_ADAPTER_FEATURE = 'shader-f16';

/** What the adapter this page will run on says about itself, for the record kept beside a measurement. */
export type AdapterReport = {
	/** The adapter's vendor, such as `apple`, empty when the browser does not say. */
	vendor: string;
	/** The adapter's architecture, such as `metal-3`, empty when the browser does not say. */
	architecture: string;
	/** The adapter's own description, empty when the browser does not say. */
	description: string;
	/** Whether the adapter supports {@link REQUIRED_ADAPTER_FEATURE}. */
	isRequiredFeatureSupported: boolean;
};

/** What is known about the backend after the model has loaded and run. */
export type BackendVerdict = {
	/** Whether the run really happened on WebGPU, which is the only acceptable answer on this page. */
	isWebgpu: boolean;
	/** One sentence saying what was found, written for a person reading the page. */
	explanation: string;
	/** Every execution provider warning ONNX Runtime Web printed while the model loaded. */
	droppedProviderWarnings: readonly string[];
};

/**
 * Makes WebGPU a requirement of this page rather than a preference.
 *
 * Gemma 4 E2B must run on WebGPU in a worker browser tab, so this experiment must not quietly answer from
 * WebAssembly instead. A page that falls back reports a working model and proves nothing about the path a worker
 * will take, which is the false green that
 * [issue #311](https://github.com/jeromeetienne/warmly_private/issues/311) describes and that
 * [issue #172](https://github.com/webai-at-home/webai-at-home/issues/172) already paid for once.
 *
 * There are two ways to fall back and this class closes both. The first is the page choosing WebAssembly itself,
 * which {@link demandWebgpu} refuses before the model is asked for. The second is ONNX Runtime Web accepting
 * `webgpu`, failing to start it, and continuing on the WebAssembly execution provider with only a console warning
 * — which {@link watchForADroppedProvider} catches by reading that warning.
 */
export class WebgpuRequirement {
	/** Every execution provider warning seen since {@link watchForADroppedProvider} was called. */
	private static droppedProviderWarnings: string[] = [];

	/** Whether {@link watchForADroppedProvider} has already replaced the console functions. */
	private static isWatching = false;

	/**
	 * Refuses to go any further when this browser has no WebGPU, or when its adapter cannot do what `q4f16` needs.
	 *
	 * Called before the model is requested, so that a browser which cannot run this experiment says so in one
	 * sentence instead of downloading about 3111 megabytes and then answering from the wrong backend.
	 *
	 * @returns What the adapter says about itself, once it is known to be usable.
	 * @throws When the browser has no WebGPU, when no adapter is granted, or when the adapter lacks
	 *   {@link REQUIRED_ADAPTER_FEATURE}.
	 */
	static async demandWebgpu(): Promise<AdapterReport> {
		// Read the value rather than asking whether the key is there. `gpu` is defined on `Navigator.prototype`, so
		// `'gpu' in navigator` stays true in a browser that carries the property and leaves it undefined, which is
		// what a page served over plain HTTP and a browser with WebGPU turned off both look like.
		const gpu: GPU | undefined = navigator.gpu;
		if (gpu === undefined || gpu === null) {
			throw new Error(
				'This browser exposes no WebGPU, which a page served outside a secure context or a browser with '
				+ 'WebGPU turned off both look like. Gemma 4 E2B is not run on WebAssembly here: WebAssembly is far '
				+ 'too slow to carry a default model, and a WebAssembly answer would prove nothing about the WebGPU '
				+ 'path a worker browser tab takes.',
			);
		}

		const adapter = await gpu.requestAdapter();
		if (adapter === null) {
			throw new Error(
				'This browser has the WebGPU interface but granted no adapter, so there is no graphics processor to '
				+ 'run on. Gemma 4 E2B is not run on WebAssembly here.',
			);
		}

		const isRequiredFeatureSupported = adapter.features.has(REQUIRED_ADAPTER_FEATURE);
		if (isRequiredFeatureSupported === false) {
			throw new Error(
				`This adapter does not support ${REQUIRED_ADAPTER_FEATURE}, which the q4f16 quantization needs for its `
				+ 'float16 key-value cache. Running anyway would answer from a quantization this experiment is not about.',
			);
		}

		const adapterInfo: Partial<GPUAdapterInfo> = adapter.info ?? {};
		return {
			vendor: adapterInfo.vendor ?? '',
			architecture: adapterInfo.architecture ?? '',
			description: adapterInfo.description ?? '',
			isRequiredFeatureSupported: isRequiredFeatureSupported,
		};
	}

	/**
	 * Starts reading the console for the warning ONNX Runtime Web prints when it drops an execution provider.
	 *
	 * Must be called before the first session is created, because the warning is printed once, while the session is
	 * being built. Reading the console is not elegant, and it is used because it is the only place ONNX Runtime Web
	 * states this: the session object it returns carries no list of the execution providers it really ended up with.
	 *
	 * @returns Nothing. Calling this a second time does nothing.
	 */
	static watchForADroppedProvider(): void {
		if (WebgpuRequirement.isWatching === true) {
			return;
		}
		WebgpuRequirement.isWatching = true;

		const originalWarn = console.warn.bind(console);
		const originalError = console.error.bind(console);
		const record = (parameters: readonly unknown[]): void => {
			const line = parameters.map((parameter) => String(parameter)).join(' ');
			if (line.includes(EXECUTION_PROVIDER_REMOVED_WARNING)) {
				WebgpuRequirement.droppedProviderWarnings.push(line);
			}
		};

		console.warn = (...parameters: unknown[]): void => {
			record(parameters);
			originalWarn(...parameters);
		};
		console.error = (...parameters: unknown[]): void => {
			record(parameters);
			originalError(...parameters);
		};
	}

	/**
	 * Says whether the model that has just loaded is really running on WebGPU.
	 *
	 * Call this only after the pipeline has resolved. Reading the ONNX Runtime Web device before a session exists
	 * creates a fresh graphics device rather than reporting the one in use, which would answer `true` on a page that
	 * had in fact fallen back — the exact mistake this verdict is meant to catch.
	 *
	 * @returns What was found, and whether it is acceptable.
	 */
	static async verdictAfterLoading(): Promise<BackendVerdict> {
		const droppedProviderWarnings = [...WebgpuRequirement.droppedProviderWarnings];
		if (droppedProviderWarnings.length > 0) {
			return {
				isWebgpu: false,
				explanation:
					'ONNX Runtime Web dropped the WebGPU execution provider and answered from another one. '
					+ 'This run says nothing about Gemma 4 E2B on WebGPU.',
				droppedProviderWarnings: droppedProviderWarnings,
			};
		}

		const device = await WebgpuRequirement.deviceInUse();
		if (device === undefined) {
			return {
				isWebgpu: false,
				explanation:
					'ONNX Runtime Web holds no WebGPU device after loading the model, so the run did not happen on WebGPU.',
				droppedProviderWarnings: droppedProviderWarnings,
			};
		}

		const adapterInfo: Partial<GPUAdapterInfo> = device.adapterInfo ?? {};
		const adapterWords = [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description]
			.filter((word) => word !== undefined && word !== '')
			.join(' ');
		return {
			isWebgpu: true,
			explanation:
				'The model loaded on the WebGPU execution provider, and ONNX Runtime Web holds the graphics device it '
				+ `used${adapterWords === '' ? '' : `: ${adapterWords}`}. No execution provider was dropped.`,
			droppedProviderWarnings: droppedProviderWarnings,
		};
	}

	/**
	 * The graphics device ONNX Runtime Web is holding, or `undefined` when it holds none.
	 *
	 * @returns The device in use, or `undefined` when there is none or the runtime does not expose one.
	 */
	private static async deviceInUse(): Promise<GPUDevice | undefined> {
		const webgpuFlags = env.backends.onnx?.webgpu;
		if (webgpuFlags === undefined) {
			return undefined;
		}
		try {
			return await webgpuFlags.device;
		} catch {
			return undefined;
		}
	}
}
