import Assert from 'node:assert/strict';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Test from 'node:test';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	DocumentationLinkChecker — finds markdown links and repository paths that point at nothing
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

const __dirname = import.meta.dirname;

/** The repository root, one level above this tests directory. */
const REPOSITORY_ROOT_PATH = Path.resolve(__dirname, '..');

/**
 * Directories never walked when looking for markdown files, because nothing in them is ours to fix.
 *
 * `.claude` is skipped because it holds git worktrees of other branches, whose documentation is
 * checked by the tests of those branches rather than by this one.
 *
 * `codex_home` is skipped because it is the CODEX_HOME of packages/_codex_experiments, which the
 * Codex command-line program fills with its own sessions, logs, and downloaded documentation.
 */
const SKIPPED_DIRECTORY_NAMES = ['node_modules', 'dist', '.git', '.venv', 'data', '.claude', 'codex_home'];

/** One place a markdown file points at something, and where in the file it points from. */
type Mention = {
	/** The path of the markdown file the mention was found in, relative to the repository root. */
	markdownFilePath: string;
	/** The line number of the mention within that file, counting from one. */
	lineNumber: number;
	/** The target exactly as it was written in the markdown file. */
	target: string;
	/** The absolute path the target resolves to, which is what is checked for existence. */
	resolvedPath: string;
};

/**
 * Checks that the documentation does not point at files that are not there.
 *
 * Two kinds of mention are checked, because a path can go stale in either form:
 *
 * - A relative markdown link, written as `[label](../some/path.ts)`, resolved against the directory
 *   of the markdown file it appears in.
 * - A repository path named in backticks, written as `` `packages/gateway/src/cli.ts` ``, resolved
 *   against the repository root. These are not links, so no link checker would see them, and they
 *   are how most package names appear in prose.
 *
 * Web addresses and anchors are skipped: this checker only knows about the filesystem. It was added
 * after three paths in `docs/` were found pointing at files that had moved into subfolders of their
 * package. See issue #138.
 */
export class DocumentationLinkChecker {
	/**
	 * Finds every markdown file in a directory tree, skipping the directories in
	 * `SKIPPED_DIRECTORY_NAMES`.
	 *
	 * @param directoryPath The absolute path of the directory to walk.
	 * @returns The absolute paths of every markdown file found, in no particular order.
	 */
	static markdownFilePaths(directoryPath: string): string[] {
		const found: string[] = [];
		for (const entry of Fs.readdirSync(directoryPath, { withFileTypes: true })) {
			const entryPath = Path.join(directoryPath, entry.name);
			if (entry.isDirectory() === true) {
				if (SKIPPED_DIRECTORY_NAMES.includes(entry.name) === true) {
					continue;
				}
				found.push(...DocumentationLinkChecker.markdownFilePaths(entryPath));
				continue;
			}
			if (entry.name.endsWith('.md') === true) {
				found.push(entryPath);
			}
		}
		return found;
	}

	/**
	 * Collects every mention in one markdown file that names something expected to exist on disk.
	 *
	 * @param markdownFilePath The absolute path of the markdown file to read.
	 * @param reportBaseDirectoryPath The directory each reported path is written relative to, which is
	 * the directory being walked rather than the repository root, so a walk of a temporary directory
	 * reports short names.
	 * @returns One entry per relative link and per backticked repository path found in the file.
	 */
	static mentionsIn(markdownFilePath: string, reportBaseDirectoryPath: string): Mention[] {
		const markdownText = Fs.readFileSync(markdownFilePath, 'utf8');
		const relativeFilePath = Path.relative(reportBaseDirectoryPath, markdownFilePath);
		const markdownDirectoryPath = Path.dirname(markdownFilePath);
		const mentions: Mention[] = [];
		const lines = markdownText.split('\n');
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index] ?? '';
			const lineNumber = index + 1;
			for (const target of DocumentationLinkChecker._linkTargetsIn(line)) {
				mentions.push({
					markdownFilePath: relativeFilePath,
					lineNumber,
					target,
					resolvedPath: Path.resolve(markdownDirectoryPath, target),
				});
			}
			for (const target of DocumentationLinkChecker._repositoryPathsIn(line)) {
				mentions.push({
					markdownFilePath: relativeFilePath,
					lineNumber,
					target,
					resolvedPath: Path.resolve(REPOSITORY_ROOT_PATH, target),
				});
			}
		}
		return mentions;
	}

	/**
	 * Reports every mention in a directory tree whose target does not exist on disk.
	 *
	 * @param directoryPath The absolute path of the directory to walk.
	 * @returns The mentions that point at nothing, each as a line ready to be printed.
	 */
	static missingMentions(directoryPath: string): string[] {
		const missing: string[] = [];
		for (const markdownFilePath of DocumentationLinkChecker.markdownFilePaths(directoryPath)) {
			for (const mention of DocumentationLinkChecker.mentionsIn(markdownFilePath, directoryPath)) {
				if (Fs.existsSync(mention.resolvedPath) === false) {
					missing.push(`${mention.markdownFilePath}:${mention.lineNumber} points at ${mention.target}, which does not exist`);
				}
			}
		}
		return missing;
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Extracts the targets of the relative markdown links on one line.
	 *
	 * A relative target is any target that is not one of the following, all of which are skipped
	 * because none of them names a file in this repository:
	 *
	 * - Anything carrying a scheme, such as `https://example.com` or `mailto:nobody@example.com`.
	 * - An anchor within the same page, such as `#configuration`.
	 * - An absolute path, such as `/tmp/example`.
	 *
	 * A target written without a leading `./` counts, because the root `README.md` writes its links
	 * that way, as `docs/naming_scheme.md`. An anchor on the end of a path is removed before the path
	 * is returned.
	 *
	 * @param line One line of markdown.
	 * @returns The relative link targets on that line, with any anchor removed.
	 */
	private static _linkTargetsIn(line: string): string[] {
		const targets: string[] = [];
		for (const match of line.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
			const rawTarget = (match[1] ?? '').trim();
			// A link may carry a title after the path, as [label](path "title"), so keep the path only.
			const target = (rawTarget.split(/\s+/)[0] ?? '').replace(/^<|>$/g, '');
			if (target.startsWith('#') === true || target.startsWith('/') === true) {
				continue;
			}
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) === true) {
				continue;
			}
			const withoutAnchor = target.split('#')[0] ?? '';
			if (withoutAnchor === '') {
				continue;
			}
			targets.push(withoutAnchor);
		}
		return targets;
	}

	/**
	 * Extracts the repository paths named in backticks on one line, such as `` `packages/gateway` ``.
	 *
	 * A path containing `*` is skipped, because it is a pattern describing several paths rather than
	 * one path that has to exist.
	 *
	 * @param line One line of markdown.
	 * @returns The repository paths named on that line, each relative to the repository root.
	 */
	private static _repositoryPathsIn(line: string): string[] {
		const paths: string[] = [];
		for (const match of line.matchAll(/`((?:packages|docs)\/[^`\s]+)`/g)) {
			const target = (match[1] ?? '').replace(/\/$/, '');
			if (target.includes('*') === true) {
				continue;
			}
			paths.push(target);
		}
		return paths;
	}
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Documentation Of This Repository
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('every relative link and repository path in the documentation points at something that exists', () => {
	const missing = DocumentationLinkChecker.missingMentions(REPOSITORY_ROOT_PATH);
	Assert.deepEqual(missing, [], `Stale paths in the documentation:\n${missing.join('\n')}`);
});

Test('the documentation of every package is walked, not only the ones at the top', () => {
	const walked = DocumentationLinkChecker.markdownFilePaths(REPOSITORY_ROOT_PATH)
		.map((filePath) => Path.relative(REPOSITORY_ROOT_PATH, filePath));
	Assert.ok(walked.includes('README.md'), 'the root README.md is walked');
	Assert.ok(walked.includes(Path.join('docs', 'environment_variables.md')), 'the documents in docs are walked');
	Assert.ok(
		walked.includes(Path.join('packages', 'consumer_cli', 'README.md')),
		'the README of a package is walked',
	);
	Assert.ok(
		walked.some((filePath) => filePath.includes('node_modules')) === false,
		'nothing inside node_modules is walked',
	);
});

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	The Checker Itself
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

Test('a link and a repository path that point at nothing are both reported', () => {
	const temporaryDirectoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'documentation-links-'));
	try {
		Fs.writeFileSync(Path.join(temporaryDirectoryPath, 'present.ts'), '');
		Fs.writeFileSync(
			Path.join(temporaryDirectoryPath, 'sample.md'),
			[
				'A link to a file that is there: [present](./present.ts).',
				'A link to a file that is not: [absent](./absent.ts).',
				'A repository path that is there: `packages/gateway`.',
				'A repository path that is not: `packages/worker_openai_api`.',
				'A link written without a leading dot and slash, as the root README writes them: [absent](absent_too.ts).',
			].join('\n'),
		);
		const missing = DocumentationLinkChecker.missingMentions(temporaryDirectoryPath);
		Assert.equal(missing.length, 3, `expected exactly the three bad mentions, got:\n${missing.join('\n')}`);
		Assert.ok(missing.some((entry) => entry.includes('absent.ts')), 'the broken link is reported');
		Assert.ok(
			missing.some((entry) => entry.includes('absent_too.ts')),
			'a broken link written without a leading dot and slash is reported',
		);
		Assert.ok(
			missing.some((entry) => entry.includes('packages/worker_openai_api')),
			'the stale package name is reported',
		);
		Assert.ok(missing[0]?.startsWith('sample.md:2') === true, 'the report names the file and the line');
	} finally {
		Fs.rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});

Test('web addresses, anchors, and path patterns are not checked against the filesystem', () => {
	const temporaryDirectoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'documentation-links-'));
	try {
		Fs.writeFileSync(
			Path.join(temporaryDirectoryPath, 'sample.md'),
			[
				'A web address: [issue #138](https://github.com/webai-at-home/webai-at-home/issues/138).',
				'An anchor within this page: [configuration](#configuration).',
				'A mail address: [write](mailto:nobody@example.com).',
				'A pattern rather than one path: `packages/*/logs/`.',
			].join('\n'),
		);
		Assert.deepEqual(DocumentationLinkChecker.missingMentions(temporaryDirectoryPath), []);
	} finally {
		Fs.rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});

Test('an anchor on the end of a path is removed before the path is checked', () => {
	const temporaryDirectoryPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'documentation-links-'));
	try {
		Fs.writeFileSync(Path.join(temporaryDirectoryPath, 'present.md'), '# A heading\n');
		Fs.writeFileSync(
			Path.join(temporaryDirectoryPath, 'sample.md'),
			'A link into a section of another document: [a heading](./present.md#a-heading).\n',
		);
		Assert.deepEqual(DocumentationLinkChecker.missingMentions(temporaryDirectoryPath), []);
	} finally {
		Fs.rmSync(temporaryDirectoryPath, { recursive: true, force: true });
	}
});
