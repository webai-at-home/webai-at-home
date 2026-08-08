import Path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
	root: Path.resolve(import.meta.dirname, 'web'),
	build: {
		rollupOptions: {
			input: {
				home: Path.resolve(import.meta.dirname, 'web/home/index.html'),
				monitor: Path.resolve(import.meta.dirname, 'web/monitor/index.html'),
				ledger: Path.resolve(import.meta.dirname, 'web/ledger/index.html'),
				debug: Path.resolve(import.meta.dirname, 'web/debug/index.html'),
				debugIframe: Path.resolve(import.meta.dirname, 'web/debug_iframe/index.html'),
				debugIframeAllStages: Path.resolve(import.meta.dirname, 'web/debug_iframe_all_stages/index.html'),
				debugIframeDevFormula: Path.resolve(import.meta.dirname, 'web/debug_iframe_dev_formula/index.html'),
				debugIframeLlmQwen3_0_6bSharded: Path.resolve(import.meta.dirname, 'web/debug_iframe_llm_qwen3_0_6b_sharded/index.html'),
				debugIframeLlmGemmaNanoChromeFull: Path.resolve(import.meta.dirname, 'web/debug_iframe_llm_gemma_nano_chrome_full/index.html'),
				debugIframeLlmQwen3_5_0_8bFull: Path.resolve(import.meta.dirname, 'web/debug_iframe_llm_qwen3_5_0_8b_full/index.html'),
				debugIframeLlmLlama3_2_1bFull: Path.resolve(import.meta.dirname, 'web/debug_iframe_llm_llama3_2_1b_full/index.html'),
			},
		},
	},
});
