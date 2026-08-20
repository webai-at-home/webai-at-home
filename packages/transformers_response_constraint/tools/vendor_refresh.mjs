import ChildProcess from 'node:child_process';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	VendorRefresh — rebuilds the checked-in files of this package from the upstream commit
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** The folder this package lives in, which is where the rebuilt files are written. */
const packageDirectory = Path.dirname(__dirname);

/**
 * @typedef {object} Upstream
 * @property {string} repository The git repository to fetch from.
 * @property {string} branch The branch the commit is on, recorded so a reader can find it again.
 * @property {string} commit The exact commit the checked-in files are built from.
 * @property {string} commitDate The date of that commit.
 * @property {string} packageDirectory Where the package sits inside that repository.
 * @property {string} esbuildVersion The esbuild version the bundle is built with.
 * @property {string} typescriptVersion The TypeScript version the declarations are built with.
 * @property {string} pullRequest The pull request proposing the package upstream.
 */

/**
 * Rebuilds `index.js`, the declarations, and `LICENSE` from the commit named in `upstream.json`.
 *
 * This script is never run by `npm install`. The built files are checked in precisely so that a volunteer needs no
 * network, no git, and no build step to run the worker web page. It exists so that moving to a newer upstream commit
 * is one edit to `upstream.json` and one command, rather than a sequence a person has to reconstruct from prose.
 */
class VendorRefresh {
	/**
	 * Runs the whole refresh.
	 *
	 * @returns {void}
	 */
	static run() {
		const upstream = VendorRefresh._upstream();
		const checkoutDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'transformers-response-constraint-'));
		console.log(`Fetching ${upstream.commit} from ${upstream.repository}`);
		try {
			VendorRefresh._fetchCommit(upstream, checkoutDirectory);
			const sourceDirectory = Path.join(checkoutDirectory, upstream.packageDirectory);
			VendorRefresh._buildBundle(upstream, sourceDirectory);
			VendorRefresh._buildDeclarations(upstream, sourceDirectory);
			VendorRefresh._copyIntoPackage(checkoutDirectory, sourceDirectory);
			console.log(`Rebuilt from ${upstream.commit}. Read the git difference before committing it.`);
		} finally {
			Fs.rmSync(checkoutDirectory, { recursive: true, force: true });
		}
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Steps
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Reads the pinned upstream commit.
	 *
	 * @returns {Upstream} What `upstream.json` says.
	 */
	static _upstream() {
		const text = Fs.readFileSync(Path.join(packageDirectory, 'upstream.json'), 'utf8');
		return /** @type {Upstream} */ (JSON.parse(text));
	}

	/**
	 * Fetches exactly the pinned commit, without the repository's history.
	 *
	 * A shallow clone of the branch is not enough, because the branch moves and a later commit would be fetched
	 * instead of the one this package is built from.
	 *
	 * @param {Upstream} upstream What `upstream.json` says.
	 * @param {string} checkoutDirectory Where to fetch into.
	 * @returns {void}
	 */
	static _fetchCommit(upstream, checkoutDirectory) {
		VendorRefresh._runCommand('git', ['init', '--quiet'], checkoutDirectory);
		VendorRefresh._runCommand('git', ['remote', 'add', 'origin', upstream.repository], checkoutDirectory);
		VendorRefresh._runCommand('git', ['fetch', '--quiet', '--depth', '1', 'origin', upstream.commit], checkoutDirectory);
		VendorRefresh._runCommand('git', ['checkout', '--quiet', 'FETCH_HEAD'], checkoutDirectory);
	}

	/**
	 * Builds `index.js`, with the same settings as the package's own `scripts/build.mjs`.
	 *
	 * `@huggingface/transformers` stays external, so the bundle carries none of it and the dependent package's own
	 * copy is the one used.
	 *
	 * @param {Upstream} upstream What `upstream.json` says.
	 * @param {string} sourceDirectory The package folder inside the fetched checkout.
	 * @returns {void}
	 */
	static _buildBundle(upstream, sourceDirectory) {
		VendorRefresh._runCommand('npx', [
			'--yes',
			`esbuild@${upstream.esbuildVersion}`,
			'src/index.ts',
			'--bundle',
			'--platform=neutral',
			'--target=es2022',
			'--format=esm',
			'--external:@huggingface/transformers',
			'--outfile=vendor_build/index.js',
		], sourceDirectory);
	}

	/**
	 * Builds the declarations, with the same settings as the package's own `typegen` script.
	 *
	 * The declarations are emitted through a written `tsconfig.json` rather than command-line file names, because
	 * TypeScript refuses command-line file names when a `tsconfig.json` is already present in the folder.
	 *
	 * TypeScript reports two `Cannot find module '@huggingface/transformers'` errors here, because the fetched
	 * checkout has no installed dependencies, and emits every declaration regardless. So the exit code is ignored and
	 * the emitted files are checked instead.
	 *
	 * The compiler is run through `npx` at the version `upstream.json` pins, rather than whichever TypeScript this
	 * repository happens to have installed, because a declaration file that changes with the local toolchain would
	 * make the checked-in files impossible to reproduce.
	 *
	 * @param {Upstream} upstream What `upstream.json` says.
	 * @param {string} sourceDirectory The package folder inside the fetched checkout.
	 * @returns {void}
	 * @throws When TypeScript emitted no `index.d.ts`.
	 */
	static _buildDeclarations(upstream, sourceDirectory) {
		const configPath = Path.join(sourceDirectory, 'vendor_typegen.tsconfig.json');
		Fs.writeFileSync(configPath, `${JSON.stringify({
			include: ['src/**/*'],
			compilerOptions: {
				target: 'esnext',
				module: 'esnext',
				moduleResolution: 'bundler',
				strict: true,
				skipLibCheck: true,
				esModuleInterop: true,
				declaration: true,
				emitDeclarationOnly: true,
				rootDir: 'src',
				outDir: 'vendor_build',
			},
		}, null, 2)}\n`);
		VendorRefresh._runCommand(
			'npx',
			['--yes', `--package=typescript@${upstream.typescriptVersion}`, 'tsc', '-p', configPath],
			sourceDirectory,
			true,
		);
		if (Fs.existsSync(Path.join(sourceDirectory, 'vendor_build', 'index.d.ts')) === false) {
			throw new Error('TypeScript emitted no index.d.ts, so the declarations could not be rebuilt.');
		}
	}

	/**
	 * Copies the built files and the licence into this package, replacing what was there.
	 *
	 * @param {string} checkoutDirectory The fetched checkout, whose root holds the licence.
	 * @param {string} sourceDirectory The package folder inside that checkout.
	 * @returns {void}
	 */
	static _copyIntoPackage(checkoutDirectory, sourceDirectory) {
		for (const name of ['engine', 'utils']) {
			Fs.rmSync(Path.join(packageDirectory, name), { recursive: true, force: true });
		}
		Fs.cpSync(Path.join(sourceDirectory, 'vendor_build'), packageDirectory, { recursive: true });
		Fs.copyFileSync(Path.join(checkoutDirectory, 'LICENSE'), Path.join(packageDirectory, 'LICENSE'));
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Runs one command and shows its output.
	 *
	 * @param {string} command The program to run.
	 * @param {string[]} commandArguments Its arguments.
	 * @param {string} workingDirectory Where to run it.
	 * @param {boolean} [isFailureAllowed] Whether a non-zero exit code is acceptable.
	 * @returns {void}
	 * @throws When the command failed and `isFailureAllowed` is not `true`.
	 */
	static _runCommand(command, commandArguments, workingDirectory, isFailureAllowed) {
		const result = ChildProcess.spawnSync(command, commandArguments, {
			cwd: workingDirectory,
			stdio: 'inherit',
		});
		if (result.error !== undefined) {
			throw result.error;
		}
		if (result.status !== 0 && isFailureAllowed !== true) {
			throw new Error(`${command} ${commandArguments.join(' ')} exited with ${String(result.status)}.`);
		}
	}
}

VendorRefresh.run();
