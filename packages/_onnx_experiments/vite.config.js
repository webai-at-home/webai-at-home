import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ortDist = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const ortAssets = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const qwenShardDirectory = resolve(import.meta.dirname, 'public/onnxruntime_qwen3-0.6b-with-shards/shards');
const qwenShardPrefix = '/onnxruntime_qwen3-0.6b-with-shards/shards/';

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  plugins: [{
    name: 'copy-onnx-runtime-web-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const fileName = request.url?.split('?')[0]?.slice(1);
        const shardName = request.url?.split('?')[0]?.startsWith(qwenShardPrefix)
          ? request.url.split('?')[0].slice(qwenShardPrefix.length)
          : undefined;
        if (shardName && /^shard-[123]\.onnx$/.test(shardName)) {
          response.setHeader('Content-Type', 'application/octet-stream');
          response.end(readFileSync(resolve(qwenShardDirectory, shardName)));
          return;
        }
        if (!fileName || !ortAssets.includes(fileName)) {
          next();
          return;
        }
        response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.end(readFileSync(resolve(ortDist, fileName)));
      });
    },
    generateBundle() {
      for (const fileName of ortAssets) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(resolve(ortDist, fileName)) });
      }
      for (const shardName of ['shard-1.onnx', 'shard-2.onnx', 'shard-3.onnx']) {
        const shardPath = resolve(qwenShardDirectory, shardName);
        try {
          this.emitFile({ type: 'asset', fileName: `${qwenShardPrefix.slice(1)}${shardName}`, source: readFileSync(shardPath) });
        } catch {
          // The shard exporter is an explicit setup step; keep builds useful
          // for the other experiments when the large generated files are absent.
        }
      }
    },
  }],
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'public/index.html'),
        qwen: resolve(import.meta.dirname, 'public/qwen3-0.6b/index.html'),
        onnxruntimeQwen: resolve(import.meta.dirname, 'public/onnxruntime_qwen3-0.6b-with-shards/index.html'),
        onnxruntimeQwenPlain: resolve(import.meta.dirname, 'public/onnxruntime_qwen3-0.6b-plain/index.html'),
        smollm: resolve(import.meta.dirname, 'public/smoll2-360m/index.html'),
        gemma: resolve(import.meta.dirname, 'public/gemma4-e2b-it/index.html'),
        qwen3_5Gate: resolve(import.meta.dirname, 'public/qwen3_5-0.8b-gate/index.html'),
        qwen3_5_2b: resolve(import.meta.dirname, 'public/qwen3_5-2b/index.html'),
        qwen3_5UsageMetadataGate: resolve(import.meta.dirname, 'public/qwen3_5-usage-metadata-gate/index.html'),
        llama3_2_1bGate: resolve(import.meta.dirname, 'public/llama3_2-1b-gate/index.html'),
        qwen3_5ToolCallsGate: resolve(import.meta.dirname, 'public/qwen3_5-tool-calls-gate/index.html'),
        matmulNBitsOwnedWebgpuBufferGate: resolve(
          import.meta.dirname,
          'public/matmulnbits-owned-webgpu-buffer-gate/index.html',
        ),
      },
    },
  },
});
