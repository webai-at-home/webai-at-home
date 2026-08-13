// node imports
import Fs from 'node:fs';
import Path from 'node:path';
import Url from 'node:url';

const __filename = Url.fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	BundledDependenciesToggle — adds or removes bundledDependencies around a pack
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Where this package's own `package.json` lives, one directory up from this script. */
const packageJsonPath = Path.join(__dirname, '..', 'package.json');

/** Where this package's own `node_modules/@webai` holds the symlink to each bundled workspace member. */
const webaiNodeModulesPath = Path.join(__dirname, '..', 'node_modules', '@webai');

/** Every package in this repository lives under this directory, one level above this package's own. */
const packagesDirectory = Path.join(__dirname, '..', '..');

/**
 * The workspace members `npm pack` and `npm publish` must vendor into the tarball whole, because
 * none of them is published to the npm registry on its own: `bundledDependencies` is npm's own
 * mechanism for that, telling it to copy a dependency's files into the tarball instead of
 * expecting an installer to fetch that dependency by name.
 *
 * Each one's directory under `packages/` is its unscoped name with every `-` written `_`, which
 * happens to be exact for all five of these — `gateway` and `protocol` need no change at all — but
 * is not a rule this class enforces for a name added later.
 */
const bundledDependencyNames = [
	'@webai/gateway',
	'@webai/consumer-openai',
	'@webai/worker-openai',
	'@webai/consumer-cli',
	'@webai/protocol',
];

/** The suffix a bundled workspace member's own `node_modules` is renamed to while it is set aside. */
const setAsideSuffix = '.webai_at_home_cli_pack_backup';

/**
 * Adds `bundledDependencies` to this package's own `package.json` before `npm pack` or
 * `npm publish` runs, and removes it again once packing has finished.
 *
 * `bundledDependencies` cannot be a permanent field of the committed `package.json`: every one of
 * `bundledDependencies`' entries is also an ordinary npm workspace member here, and npm's own
 * dependency resolution breaks `npm install` at the root of this repository outright when a
 * workspace package bundles a sibling workspace member — confirmed live while working on
 * [issue #170](https://github.com/webai-at-home/webai-at-home/issues/170): removing the field
 * fixed `npm install`, restoring it reproduced the failure. `prepack` and `postpack`, npm's own
 * lifecycle hooks around both `npm pack` and `npm publish`, add the field only for the moment
 * packing needs it and take it out again immediately after, so the field committed to this
 * repository, and the one every contributor's `npm install` sees, never carries it.
 *
 * `npm pack` only bundles a dependency it finds in this package's own local `node_modules`, not
 * npm workspaces' hoisted root `node_modules` — a plain `npm install` from a fresh checkout of
 * this repository normally leaves this package with no local `node_modules` of its own at all,
 * every one of its workspace dependencies hoisted to the root instead. Left unhandled, that is a
 * silent failure, not a loud one: `npm pack` does not complain that a named `bundledDependencies`
 * entry could not be found, it simply leaves it out, so a maintainer packing from a fresh checkout
 * would ship a tarball missing all five of the programs this package exists to run — confirmed
 * live: with these symlinks absent, the packed tarball fell from roughly 500 kB to under 5 kB,
 * with no error at all. `on` creates the symlink itself as needed, rather than depending on one
 * already being there.
 *
 * `bundledDependencies` also vendors a bundled package's own `node_modules` whole, ignoring that
 * package's `files` field, which restricts everything else about what gets packed. `packages/gateway`
 * keeps its own nested copy of `onnxruntime-web`, at a different version than the one this repository
 * hoists to its root `node_modules`, because `@huggingface/transformers` — a real dependency of
 * `packages/worker_webpage` and `packages/_onnx_experiments`, unrelated to this package — pins an
 * exact `onnxruntime-web` version of its own. A real install of the published `webai-at-home` needs
 * none of that: it fetches `onnxruntime-web` itself, at the version this package's own `dependencies`
 * name, direct at the top of its own `node_modules`, which every one of the bundled packages already
 * resolves against correctly (`packages/gateway/src/connection/http_routes.ts` resolves it through
 * Node's own module resolution rather than a hard-coded path for exactly this reason). Bundling a
 * nested copy on top of that would only bloat the tarball, so this class also sets aside each bundled
 * package's own `node_modules`, if it has one, for the moment packing needs it, and restores it after.
 */
export class BundledDependenciesToggle {
	/**
	 * Creates the local symlink each bundled workspace member needs to be found at all, adds
	 * `bundledDependencies` naming every one of them to this package's own `package.json`, and sets
	 * aside each of those workspace members' own `node_modules`, if they have one.
	 */
	static on(): void {
		Fs.mkdirSync(webaiNodeModulesPath, { recursive: true });
		for (const bundledDependencyName of bundledDependencyNames) {
			const symlinkPath = Path.join(webaiNodeModulesPath, BundledDependenciesToggle._unscopedNameOf(bundledDependencyName));
			if (Fs.existsSync(symlinkPath) === false) {
				const targetDirectory = Path.join(packagesDirectory, BundledDependenciesToggle._directoryNameOf(bundledDependencyName));
				Fs.symlinkSync(targetDirectory, symlinkPath, 'dir');
			}
		}

		const packageJson = BundledDependenciesToggle._read();
		packageJson.bundledDependencies = bundledDependencyNames;
		BundledDependenciesToggle._write(packageJson);

		for (const bundledDependencyDirectory of BundledDependenciesToggle._bundledDependencyDirectories()) {
			const nodeModulesPath = Path.join(bundledDependencyDirectory, 'node_modules');
			if (Fs.existsSync(nodeModulesPath)) {
				Fs.renameSync(nodeModulesPath, `${nodeModulesPath}${setAsideSuffix}`);
			}
		}
	}

	/**
	 * Removes `bundledDependencies` from this package's own `package.json`, if it is there, restores
	 * every bundled workspace member's own `node_modules` that `on` set aside, and removes the local
	 * symlink `on` created for each bundled workspace member.
	 */
	static off(): void {
		const packageJson = BundledDependenciesToggle._read();
		delete packageJson.bundledDependencies;
		BundledDependenciesToggle._write(packageJson);

		for (const bundledDependencyDirectory of BundledDependenciesToggle._bundledDependencyDirectories()) {
			const setAsidePath = Path.join(bundledDependencyDirectory, `node_modules${setAsideSuffix}`);
			if (Fs.existsSync(setAsidePath)) {
				Fs.renameSync(setAsidePath, Path.join(bundledDependencyDirectory, 'node_modules'));
			}
		}

		for (const bundledDependencyName of bundledDependencyNames) {
			Fs.rmSync(Path.join(webaiNodeModulesPath, BundledDependenciesToggle._unscopedNameOf(bundledDependencyName)), { force: true });
		}
		if (Fs.existsSync(webaiNodeModulesPath) && Fs.readdirSync(webaiNodeModulesPath).length === 0) {
			Fs.rmdirSync(webaiNodeModulesPath);
		}
	}

	/**
	 * @param packageName A bundled workspace member's own package name, such as `@webai/consumer-openai`.
	 * @returns Its name without the `@webai/` scope, such as `consumer-openai`.
	 */
	private static _unscopedNameOf(packageName: string): string {
		return packageName.replace('@webai/', '');
	}

	/**
	 * @param packageName A bundled workspace member's own package name, such as `@webai/consumer-openai`.
	 * @returns Its directory name under `packages/`, such as `consumer_openai`.
	 */
	private static _directoryNameOf(packageName: string): string {
		return BundledDependenciesToggle._unscopedNameOf(packageName).replaceAll('-', '_');
	}

	/**
	 * @returns The real directory of every bundled workspace member present under this package's
	 * own `node_modules/@webai`, resolving through the symlink `on` creates for it.
	 */
	private static _bundledDependencyDirectories(): string[] {
		if (Fs.existsSync(webaiNodeModulesPath) === false) {
			return [];
		}
		return Fs.readdirSync(webaiNodeModulesPath).map(
			(entryName) => Fs.realpathSync(Path.join(webaiNodeModulesPath, entryName)),
		);
	}

	/** @returns This package's own `package.json`, parsed. */
	private static _read(): Record<string, unknown> {
		return JSON.parse(Fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
	}

	/**
	 * Writes this package's own `package.json` back out, tab-indented to match every other
	 * `package.json` in this repository, with a trailing newline.
	 *
	 * @param packageJson What to write.
	 */
	private static _write(packageJson: Record<string, unknown>): void {
		Fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, '\t')}\n`);
	}
}

const [mode] = process.argv.slice(2);
if (mode === 'on') {
	BundledDependenciesToggle.on();
} else if (mode === 'off') {
	BundledDependenciesToggle.off();
} else {
	throw new Error(`Usage: bundled_dependencies_toggle.ts on|off (got ${JSON.stringify(mode)})`);
}
