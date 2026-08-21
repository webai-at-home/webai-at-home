import { defineConfig } from 'vite';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const ortDist = resolve(import.meta.dirname, 'node_modules/onnxruntime-web/dist');
const ortAssets = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const qwenShardDirectory = resolve(import.meta.dirname, 'public/onnxruntime_qwen3-0.6b-with-shards/shards');
const qwenShardPrefix = '/onnxruntime_qwen3-0.6b-with-shards/shards/';
// The milestone 2 measurement page has to be installable as a Progressive Web Application, because one of the things
// it measures only has an answer once the page is installed. Chrome wants an icon and a service worker for that, and
// neither is imported by any module, so Vite would not emit either of them on its own.
const installableAssets = [
  'browser-storage-and-webgpu-buffer-measurements/icon.svg',
  'browser-storage-and-webgpu-buffer-measurements/service_worker.js',
  'expert-residency-layer/icon.svg',
  'expert-residency-layer/service_worker.js',
];
// The issue #169 milestone 5 page reads a converted OLMoE-1B-7B-0924: 1.78 gigabytes of graphs and 3.47 gigabytes of
// expert blocks, written by tools/model_graphs/build_moe_graphs.py and by
// tools/weight_conversion/convert_mixture_of_experts_to_expert_blocks.ts. They are generated artifacts and are far too large to sit
// under public/, so the development server serves them from wherever they were written, with the byte range support
// Hugging Face gives — which is what the page needs to pull one expert at a time out of a 3.47-gigabyte file.
const olmoeArtifactDirectories = {
  '/olmoe-artifacts/graphs/': process.env.OLMOE_GRAPHS_DIRECTORY ?? '/tmp/olmoe-1b-7b-0924-graphs',
  '/olmoe-artifacts/blocks/': process.env.OLMOE_BLOCKS_DIRECTORY ?? '/tmp/olmoe-1b-7b-0924-expert-blocks',
  '/moe-artifacts/OLMoE-1B-7B-0924/graphs/': process.env.OLMOE_GRAPHS_DIRECTORY ?? '/tmp/olmoe-1b-7b-0924-graphs',
  '/moe-artifacts/OLMoE-1B-7B-0924/blocks/':
    process.env.OLMOE_BLOCKS_DIRECTORY ?? '/tmp/olmoe-1b-7b-0924-expert-blocks',
  '/moe-artifacts/Qwen3-30B-A3B/graphs/': process.env.QWEN3_GRAPHS_DIRECTORY ?? '/tmp/qwen3-30b-a3b-graphs',
  '/moe-artifacts/Qwen3-30B-A3B/blocks/': process.env.QWEN3_BLOCKS_DIRECTORY ?? '/tmp/qwen3-30b-a3b-expert-blocks',
};

/**
 * Serves one generated OLMoE artifact, honouring a byte range request.
 *
 * @param {import('node:http').ServerResponse} response Where to write.
 * @param {string} filePath The file to serve.
 * @param {string | undefined} rangeHeader The request's Range header, if it sent one.
 * @returns {void}
 */
function serveOlmoeArtifact(response, filePath, rangeHeader) {
  const byteLength = statSync(filePath).size;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader ?? '');
  response.setHeader('Content-Type', 'application/octet-stream');
  response.setHeader('Accept-Ranges', 'bytes');

  if (match === null) {
    response.setHeader('Content-Length', String(byteLength));
    response.end(readFileSync(filePath));
    return;
  }

  const firstByte = Number(match[1]);
  const lastByte = match[2] === '' ? byteLength - 1 : Math.min(Number(match[2]), byteLength - 1);
  const wantedLength = lastByte - firstByte + 1;
  // The file is read at an offset rather than whole. expert_blocks.bin is 3.47 gigabytes and the page asks for a few
  // megabytes of it at a time, so reading it whole would be the slowest possible way to answer.
  const bytes = Buffer.alloc(wantedLength);
  const descriptor = openSync(filePath, 'r');
  try {
    readSync(descriptor, bytes, 0, wantedLength, firstByte);
  } finally {
    closeSync(descriptor);
  }
  response.statusCode = 206;
  response.setHeader('Content-Range', `bytes ${firstByte}-${lastByte}/${byteLength}`);
  response.setHeader('Content-Length', String(wantedLength));
  response.end(bytes);
}

export default defineConfig({
  root: resolve(import.meta.dirname, 'public'),
  publicDir: false,
  plugins: [{
    name: 'copy-onnx-runtime-web-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        for (const [prefix, directory] of Object.entries(olmoeArtifactDirectories)) {
          if (path.startsWith(prefix) === false) {
            continue;
          }
          // Only the base name is taken, so nothing outside the named directory can be reached.
          const filePath = resolve(directory, basename(path.slice(prefix.length)));
          try {
            serveOlmoeArtifact(response, filePath, request.headers.range);
          } catch (error) {
            response.statusCode = 404;
            response.end(
              `${filePath} is not there. The issue #169 milestone 5 artifacts are generated — see ` +
                `packages/_onnx_experiments/tools/README.md. (${error.message})`,
            );
          }
          return;
        }

        const fileName = path.slice(1);
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
      for (const fileName of installableAssets) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: readFileSync(resolve(import.meta.dirname, 'public', fileName)),
        });
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
        gemma4E2bToolCallsGate: resolve(import.meta.dirname, 'public/gemma4-e2b-tool-calls-gate/index.html'),
        gemma4E2bResponseConstraintMeasurement: resolve(
          import.meta.dirname,
          'public/gemma4-e2b-response-constraint-measurement/index.html',
        ),
        gemma4E2bGenerationControlsMeasurement: resolve(
          import.meta.dirname,
          'public/gemma4-e2b-generation-controls-measurement/index.html',
        ),
        matmulNBitsOwnedWebgpuBufferGate: resolve(
          import.meta.dirname,
          'public/matmulnbits-owned-webgpu-buffer-gate/index.html',
        ),
        browserStorageAndWebgpuBufferMeasurements: resolve(
          import.meta.dirname,
          'public/browser-storage-and-webgpu-buffer-measurements/index.html',
        ),
        expertResidencyLayer: resolve(import.meta.dirname, 'public/expert-residency-layer/index.html'),
        expertBlockGraphGate: resolve(import.meta.dirname, 'public/expert-block-graph-gate/index.html'),
        olmoeRunTwice: resolve(import.meta.dirname, 'public/olmoe-run-twice/index.html'),
        qwen3LayerGraphWebgpuGate: resolve(import.meta.dirname, 'public/qwen3-layer-graph-webgpu-gate/index.html'),
        moeExpertsOnDisk: resolve(import.meta.dirname, 'public/moe-experts-on-disk/index.html'),
      },
    },
  },
});
