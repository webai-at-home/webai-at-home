// node imports
import Fs from 'node:fs';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ReportWriter — puts a rendered report where `-o/--output` asked for it
//
//	One file for the two subcommands that write reports, so that `conformance` and `benchmark`
//	cannot disagree about what `-o/--output` does or about what is said when the file cannot be
//	written.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Writes a rendered report to a file, or to standard output when no file was named. */
export class ReportWriter {
	/**
	 * Writes the report to `-o/--output` when one was named, and to standard output otherwise.
	 *
	 * @param report The rendered report.
	 * @param outputPath The file to write to, `undefined` to print instead.
	 * @returns Nothing.
	 * @throws {Error} If the file cannot be written, which stops the run rather than being a result
	 * of the run.
	 */
	static write(report: string, outputPath: string | undefined): void {
		if (outputPath === undefined) {
			console.log(report);
			return;
		}
		try {
			Fs.writeFileSync(outputPath, `${report}\n`, 'utf8');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`-o/--output could not be written: ${message}`);
		}
		console.log(`Report written to ${outputPath}`);
	}
}
