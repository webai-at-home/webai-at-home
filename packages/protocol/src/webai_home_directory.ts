// node imports
import Os from 'node:os';
import Path from 'node:path';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	WebaiHomeDirectory — the one place that says where a program keeps what it writes
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Where every `webai-at-home` program keeps the files it writes: under `~/.webai-at-home/`, in a
 * folder of its own named after the program.
 *
 * This exists so the rule is written once rather than in each program that follows it. Four
 * programs need it — `@webai/gateway`, `@webai/consumer-cli`, `@webai/consumer-openai` and
 * `@webai/flow-viewer`, the last of which reads what the first one writes — and a copy of the rule
 * in each of the four is a copy that will disagree with the others.
 *
 * The rule itself comes from two issues. Nothing may be written into a program's own package
 * folder, because a program installed through `npx` has that folder in a cache directory `npx` may
 * clear ([issue #170](https://github.com/webai-at-home/webai-at-home/issues/170)). Nothing may be
 * written into the directory the program happened to be started from either, because
 * `npx webai-at-home <command>` would then leave files wherever the person was standing
 * ([issue #171](https://github.com/webai-at-home/webai-at-home/issues/171)).
 *
 * The account key pair directories predate this and keep their own `<program>_config` names, which
 * `--config_dir` names in each program: an account key pair *is* an account, so moving one silently
 * would lose the identity it stands for.
 */
export class WebaiHomeDirectory {
	/**
	 * Gives the folder one program keeps everything it writes in.
	 *
	 * @param programName The program's own name, as this repository writes it — `gateway`,
	 * `consumer_cli`, `consumer_openai`.
	 * @returns The absolute path of that program's folder, which may not exist yet.
	 */
	static forProgram(programName: string): string {
		return Path.join(Os.homedir(), '.webai-at-home', programName);
	}

	/**
	 * Gives the folder one program writes its message logs into.
	 *
	 * @param programName The program's own name, as this repository writes it.
	 * @returns The absolute path of that program's log folder, which may not exist yet.
	 */
	static logsForProgram(programName: string): string {
		return Path.join(WebaiHomeDirectory.forProgram(programName), 'logs');
	}
}
