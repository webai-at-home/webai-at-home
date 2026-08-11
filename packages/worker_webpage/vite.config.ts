import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import Fs from 'node:fs';
import Path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

const require = createRequire(import.meta.url);

/**
 * The git commit this build was made from, baked into the browser bundle as `__COMMIT_SHA__`
 * (see `web/src/global.d.ts`) so a deployed page can show which commit it was built from (see
 * issue #142). `COMMIT_SHA` is set by `packages/docker_server/docker/docker-entrypoint.sh` inside
 * the Docker image, from the `SOURCE_COMMIT` build argument; outside that image (a local `npm run
 * build` or `npm run dev`), it falls back to reading the checkout's own current commit directly.
 */
const commitSha = process.env.COMMIT_SHA ?? execSync('git rev-parse --short HEAD').toString().trim();

/**
 * The version number of `@webai/worker-webpage`, baked into the browser bundle as
 * `__PACKAGE_VERSION__` (see `web/src/global.d.ts`) so the About panel reports which build is
 * running (see issue #159). It is read from this package's own `package.json` at build time
 * rather than written into the markup by hand, so bumping the version in one place is enough.
 */
const packageVersion = (
	JSON.parse(Fs.readFileSync(Path.resolve(import.meta.dirname, 'package.json'), 'utf-8')) as { version: string }
).version;

/**
 * `stage_helper_llm_qwen3_0_6b_sharded.ts` sets `env.wasm.wasmPaths = "/assets/"`, a literal string prefix.
 * Once `wasmPaths` is a plain string, onnxruntime-web builds every runtime file's URL as
 * `wasmPaths + fileName` (see its `wasm-factory.ts`), bypassing the `import.meta.url`-relative
 * resolution that lets Vite auto-bundle assets referenced via `new URL(..., import.meta.url)`.
 * So in dev mode NEITHER file below is reachable through Vite's normal asset pipeline — both
 * must be served from this literal `/assets/` path by hand, or they 404 (the `.wasm` request
 * actually falls through to Vite's SPA index.html fallback, silently returning HTML instead
 * of a 404) and the WebGPU/wasm backends fail to initialize.
 *
 * The production build only needs the `.mjs` emitted explicitly: the `.wasm` file already
 * lands in `dist/assets` for free because Vite's static analysis does detect the `new
 * URL(..., import.meta.url)` reference to it inside onnxruntime-web's bundled code (unlike the
 * `.mjs`, which is loaded via a plain, non-analyzable dynamic `import()`); emitting it again
 * here would collide with that automatically-emitted file of the same name.
 *
 * `onnxruntime-web`'s own directory is resolved through `require.resolve` rather than a
 * hardcoded `node_modules/onnxruntime-web` path relative to this package, because npm
 * workspaces hoist it to the repository root's `node_modules` unless something forces it to
 * nest here instead — a plain `npm install` (as the Docker build runs) hoists it. The package's
 * `exports` map has no `./package.json` subpath, so its main entry is resolved instead — that
 * entry always lives directly under the package's `dist` directory.
 */
const ortDistDir = Path.dirname(require.resolve('onnxruntime-web'));
const ortDevServedFiles = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
const ortBuildEmittedFile = 'ort-wasm-simd-threaded.jsep.mjs';
const gatewayFaviconPath = Path.resolve(import.meta.dirname, '../gateway/web/images/favicons/webai-at-home-logo.svg');

export default defineConfig({
	root: Path.resolve(import.meta.dirname, 'web'),
	base: process.env.WORKER_BASE_PATH ?? '/',
	define: {
		__COMMIT_SHA__: JSON.stringify(commitSha),
		__PACKAGE_VERSION__: JSON.stringify(packageVersion),
	},
	plugins: [
		{
			name: 'serve-gateway-favicon',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					if (request.url?.split('?')[0] !== '/images/favicons/webai-at-home-logo.svg') {
						next();
						return;
					}
					response.setHeader('Content-Type', 'image/svg+xml');
					response.end(Fs.readFileSync(gatewayFaviconPath));
				});
			},
			generateBundle() {
				this.emitFile({ type: 'asset', fileName: 'images/favicons/webai-at-home-logo.svg', source: Fs.readFileSync(gatewayFaviconPath) });
			},
		},
		{
			name: 'serve-onnxruntime-web-assets',
			configureServer(server) {
				server.middlewares.use((request, response, next) => {
					const requestPath = request.url?.split('?')[0];
					const fileName = requestPath?.replace(/^\/assets\//, '');
					if (fileName === undefined || ortDevServedFiles.includes(fileName) === false) {
						next();
						return;
					}
					const contents = Fs.readFileSync(Path.resolve(ortDistDir, fileName));
					const etag = `"${createHash('sha256').update(contents).digest('hex')}"`;
					response.setHeader('Cache-Control', 'no-cache');
					response.setHeader('ETag', etag);
					if (request.headers['if-none-match'] === etag) {
						response.statusCode = 304;
						response.end();
						return;
					}
					response.setHeader('Content-Type', fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
					response.end(contents);
				});
			},
			generateBundle() {
				this.emitFile({
					type: 'asset',
					fileName: `assets/${ortBuildEmittedFile}`,
					source: Fs.readFileSync(Path.resolve(ortDistDir, ortBuildEmittedFile)),
				});
			},
		},
	],
	build: {
		outDir: Path.resolve(import.meta.dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			output: {
				assetFileNames: (assetInfo) => assetInfo.name?.endsWith('.wasm') ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]',
			},
		},
	},
	/**
	 * Matches `WORKER_PORT`'s default in the Docker image
	 * (see packages/docker_server/docker/docker-entrypoint.sh), so the worker page is reachable
	 * on the same port whether it is started locally or inside the container.
	 */
	server: {
		port: 8789,
		strictPort: true,
	},
	preview: {
		port: 8789,
		strictPort: true,
	},
});
