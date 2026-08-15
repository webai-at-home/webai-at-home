// node imports
import Fs from 'node:fs';
import Path from 'node:path';
import Url from 'node:url';

const __filename = Url.fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VendorWrappedPrograms — copies the wrapped programs' own build output into this package
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** This package's own directory, one level up from this script. */
const packageDirectory = Path.join(__dirname, '..');

/** This package's own compiled `src/cli.ts`, whose import specifiers this class rewrites in place. */
const cliJsPath = Path.join(packageDirectory, 'dist', 'cli.js');

/** Where a vendored copy of every wrapped program is placed, so `npm pack` and `npm publish` ship it. */
const vendorDirectory = Path.join(packageDirectory, 'dist', 'vendor');

/** Every package in this repository lives one level above this package's own directory. */
const packagesDirectory = Path.join(packageDirectory, '..');

/**
 * Copies the built output of `@webai/gateway`, `@webai/consumer-openai`, `@webai/worker-openai`,
 * `@webai/consumer-cli`, and `@webai/protocol` into this package's own `dist/vendor`, and rewrites
 * `dist/cli.js` to import each wrapped program from its vendored copy instead of by package name.
 *
 * None of the five is published to the npm registry on its own — confirmed live while working on
 * [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170): npm's own
 * `bundledDependencies` mechanism, tried first, requires a bundled package to also be an ordinary,
 * separately resolvable dependency, so `npm install webai-at-home` and `npx webai-at-home` both
 * tried to fetch `@webai/consumer-cli` from the registry and failed with a 404, even though the
 * packed tarball already carried it — `npm install <local-tarball-path>` alone had never caught
 * this, because installing a tarball by its own path skips that resolution step entirely. Copying
 * the built files in directly, with no npm dependency mechanism naming them at all, is not subject
 * to that resolution step, since Node's own module resolution walks `node_modules` directories on
 * disk and never consults `package.json`'s own `dependencies` field at all.
 *
 * `@webai/protocol` is the one workspace member every wrapped program imports by its scoped
 * package name (`@webai/gateway`, `@webai/consumer-openai` and `@webai/worker-openai` import it
 * directly; `@webai/consumer-openai` also imports `@webai/consumer-cli` the same way) rather than
 * by a relative path, because none of the four is part of the same TypeScript project as protocol.
 * Node resolves a bare `@webai/protocol` import by walking up from the importing file looking for
 * a `node_modules/@webai/protocol` directory, so this class places a real copy of protocol — its
 * `package.json`, for the `exports` map every subpath import such as `@webai/protocol/envelope`
 * needs, plus its own `dist` — under each vendored program's own `node_modules/@webai`, and does
 * the same with `@webai/consumer-cli` under `@webai/consumer-openai`'s vendored copy. Node's walk
 * upward from `@webai/consumer-cli`'s own vendored copy, nested inside `@webai/consumer-openai`'s
 * `node_modules`, still finds the `@webai/protocol` copy placed alongside it one directory up, so
 * only one copy of protocol is needed per top-level vendored program, not one per program plus one
 * more again for each of that program's own nested dependents.
 *
 * `@webai/gateway` also serves its own built browser pages from `web/dist`, a directory next to
 * its own `dist`, which it locates at run time relative to its own compiled file's position on
 * disk — `packages/gateway/src/connection/http_routes.ts` computes it as `../../web` from its own
 * location once compiled to `dist/connection/http_routes.js`. Vendoring `@webai/gateway`'s entire
 * `dist` directory unmodified, alongside a `web/dist` copy at the same relative depth, keeps that
 * computation correct without changing `@webai/gateway`'s own source at all.
 */
export class VendorWrappedPrograms {
	/** Copies every wrapped program into `dist/vendor` and rewrites `dist/cli.js` to import from it. */
	static run(): void {
		Fs.rmSync(vendorDirectory, { recursive: true, force: true });

		VendorWrappedPrograms._vendorProtocolInto('gateway');
		VendorWrappedPrograms._copyDirectory(
			Path.join(packagesDirectory, 'gateway', 'web', 'dist'),
			Path.join(vendorDirectory, 'gateway', 'web', 'dist'),
		);
		VendorWrappedPrograms._copyProgram('gateway');

		VendorWrappedPrograms._vendorProtocolInto('consumer_cli');
		VendorWrappedPrograms._copyProgram('consumer_cli');

		VendorWrappedPrograms._vendorProtocolInto('consumer_openai');
		VendorWrappedPrograms._vendorConsumerCliInto('consumer_openai');
		VendorWrappedPrograms._copyProgram('consumer_openai');

		VendorWrappedPrograms._vendorProtocolInto('worker_openai');
		VendorWrappedPrograms._copyProgram('worker_openai');

		// `openai_conformance_test` imports `@webai/openai-api-tool` through four subpath exports,
		// and that package in turn imports `@webai/consumer-cli`, which imports `@webai/protocol`.
		// All three go side by side in the host's own `node_modules/@webai`, because Node resolves a
		// bare import by walking up from the importing file until it finds a `node_modules`, and the
		// walk out of the nested `openai-api-tool` copy reaches exactly that directory.
		VendorWrappedPrograms._vendorProtocolInto('openai_conformance_test');
		VendorWrappedPrograms._vendorConsumerCliInto('openai_conformance_test');
		VendorWrappedPrograms._vendorPackageInto('openai_conformance_test', 'openai_api_tool', 'openai-api-tool');
		VendorWrappedPrograms._copyProgram('openai_conformance_test');

		let cliJs = Fs.readFileSync(cliJsPath, 'utf8');
		cliJs = cliJs.replace("'@webai/gateway/dist/cli.js'", "'./vendor/gateway/dist/cli.js'");
		cliJs = cliJs.replace("'@webai/consumer-openai/dist/cli.js'", "'./vendor/consumer_openai/dist/cli.js'");
		cliJs = cliJs.replace("'@webai/worker-openai/dist/cli.js'", "'./vendor/worker_openai/dist/cli.js'");
		cliJs = cliJs.replace("'@webai/consumer-cli/cli'", "'./vendor/consumer_cli/dist/cli.js'");
		cliJs = cliJs.replace("'@webai/openai-conformance-test/dist/cli.js'", "'./vendor/openai_conformance_test/dist/cli.js'");
		Fs.writeFileSync(cliJsPath, cliJs);
	}

	/**
	 * @param directoryName A wrapped program's own directory name under `packages/`, such as `gateway`.
	 */
	private static _copyProgram(directoryName: string): void {
		VendorWrappedPrograms._copyDirectory(
			Path.join(packagesDirectory, directoryName, 'dist'),
			Path.join(vendorDirectory, directoryName, 'dist'),
		);
	}

	/**
	 * @param directoryName A wrapped program's own directory name under `packages/`, whose vendored
	 * copy needs `@webai/protocol` to resolve the bare imports its own compiled code uses.
	 */
	private static _vendorProtocolInto(directoryName: string): void {
		const target = Path.join(vendorDirectory, directoryName, 'node_modules', '@webai', 'protocol');
		VendorWrappedPrograms._copyDirectory(Path.join(packagesDirectory, 'protocol', 'dist'), Path.join(target, 'dist'));
		Fs.mkdirSync(target, { recursive: true });
		Fs.copyFileSync(Path.join(packagesDirectory, 'protocol', 'package.json'), Path.join(target, 'package.json'));
	}

	/**
	 * @param directoryName A wrapped program's own directory name under `packages/`, whose vendored
	 * copy needs `@webai/consumer-cli` to resolve the bare imports its own compiled code uses.
	 */
	private static _vendorConsumerCliInto(directoryName: string): void {
		const target = Path.join(vendorDirectory, directoryName, 'node_modules', '@webai', 'consumer-cli');
		VendorWrappedPrograms._copyDirectory(Path.join(packagesDirectory, 'consumer_cli', 'dist'), Path.join(target, 'dist'));
		Fs.mkdirSync(target, { recursive: true });
		Fs.copyFileSync(Path.join(packagesDirectory, 'consumer_cli', 'package.json'), Path.join(target, 'package.json'));
	}

	/**
	 * Places one workspace member's built output inside another's vendored `node_modules/@webai`,
	 * so the bare imports the host's compiled code uses resolve on disk.
	 *
	 * @param hostDirectoryName The wrapped program whose vendored copy needs the package.
	 * @param packageDirectoryName The needed package's own directory name under `packages/`.
	 * @param scopedName The needed package's name after `@webai/`, which is the directory Node looks for.
	 */
	private static _vendorPackageInto(hostDirectoryName: string, packageDirectoryName: string, scopedName: string): void {
		const target = Path.join(vendorDirectory, hostDirectoryName, 'node_modules', '@webai', scopedName);
		VendorWrappedPrograms._copyDirectory(Path.join(packagesDirectory, packageDirectoryName, 'dist'), Path.join(target, 'dist'));
		Fs.mkdirSync(target, { recursive: true });
		Fs.copyFileSync(Path.join(packagesDirectory, packageDirectoryName, 'package.json'), Path.join(target, 'package.json'));
	}

	/**
	 * @param source A directory to copy, whole.
	 * @param target Where to copy it to, created along with any missing parent directory.
	 */
	private static _copyDirectory(source: string, target: string): void {
		Fs.mkdirSync(Path.dirname(target), { recursive: true });
		Fs.cpSync(source, target, { recursive: true });
	}
}

VendorWrappedPrograms.run();
