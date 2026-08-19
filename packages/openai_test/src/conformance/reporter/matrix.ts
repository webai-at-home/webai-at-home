// local imports
import type { ConformanceRun, SkippedModel, TestRunRecord } from '../runner.js';
import type { Verdict } from '../types.js';
import { ReportSummary } from './report_summary.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MatrixReporter — one table of every verdict of a sweep, a column per model
//
//	This is what a sweep across several models produces, and it is a different document from the
//	single-model report the other reporters write: a reader compares models by reading across a
//	row, which no stack of separate reports lets them do.
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Types
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** What `MatrixReporter` needs beyond the runs themselves. */
export type MatrixReportOptions = {
	/** The endpoint's base URL. */
	readonly endpoint: string;
	/** The models the sweep left out before measuring them, and why. */
	readonly skippedModels: readonly SkippedModel[];
	/** When this sweep was generated, written into the markdown report so a file found later says how old it is. */
	readonly generatedAt?: Date;
	/** The command line that produced this sweep, already carrying its redaction. */
	readonly commandLine?: string;
};

/** One row of the matrix: one test, and what each model made of it. */
type MatrixRow = {
	/** The test identifier, which is the row's label. */
	readonly testId: string;
	/** The group the test belongs to. */
	readonly group: string;
	/** The verdicts this test reached, keyed by model identifier and then by stream setting. */
	readonly verdictsByModel: Map<string, Map<string, Verdict>>;
};

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	MatrixReporter
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/** Renders a sweep across several models as one table of verdicts. */
export class MatrixReporter {
	/** The symbol each verdict is written as, in both the markdown and the text matrix. */
	private static readonly _symbols: Readonly<Record<Verdict, string>> = {
		PASS: '✅',
		FAIL: '❌',
		SKIP: '⏭️',
		WARN: '⚠️',
	};

	/** The word each verdict is written as where a symbol would not line up, as in the text matrix. */
	private static readonly _words: Readonly<Record<Verdict, string>> = {
		PASS: 'OK',
		FAIL: 'Failed',
		SKIP: 'Skipped',
		WARN: 'Warned',
	};

	/**
	 * Renders a sweep as the markdown document a reader pastes into an issue or commits beside the
	 * code: one column per model, one row per test.
	 *
	 * A cell holding two symbols is a test the stream setting reaches, written `stream off / stream on`. A cell
	 * holding one is a test no stream setting reaches, measured once.
	 *
	 * @param runs Every run of the sweep, in the order they were run.
	 * @param options The endpoint, the models left out, and what to stamp the report with.
	 * @returns The markdown document, ready to write.
	 */
	static renderMarkdown(runs: readonly ConformanceRun[], options: MatrixReportOptions): string {
		const modelIds = MatrixReporter._orderedModelIds(runs);
		const rows = MatrixReporter._rows(runs);
		const streamSettings = MatrixReporter._orderedModes(runs);

		const lines: string[] = ['# OpenAI API Conformance Test', ''];
		lines.push(`- Endpoint: ${options.endpoint}`);
		lines.push(`- Models measured: ${modelIds.length}`);
		lines.push(`- Tests: ${rows.length}`);
		lines.push(`- Generated: ${(options.generatedAt ?? new Date()).toISOString()}`);
		lines.push('');
		if (options.commandLine !== undefined) {
			lines.push('## Command line', '', '```', options.commandLine, '```', '');
		}

		lines.push('## Verdict matrix', '');
		lines.push(`Legend: ✅ PASS, ❌ FAIL, ⚠️ WARN, ⏭️ SKIP.`);
		if (streamSettings.length > 1) {
			lines.push('', `A cell holding two verdicts is a test the request streamSetting reaches, written \`${streamSettings.join(' / ')}\`. Every other test is measured once, because the streamSetting reaches the generation control and tool call probes and nothing else.`);
		}
		lines.push('');
		lines.push(`| Test | ${modelIds.map((modelId) => MatrixReporter._escape(modelId)).join(' | ')} |`);
		lines.push(`| --- | ${modelIds.map(() => '---').join(' | ')} |`);
		for (const row of rows) {
			const cells = modelIds.map((modelId) => MatrixReporter._cell(row, modelId, streamSettings, MatrixReporter._symbols));
			lines.push(`| \`${row.testId}\` | ${cells.join(' | ')} |`);
		}
		lines.push('');

		lines.push('## Summary', '');
		lines.push('| Model | StreamSetting | Passed | Failed | Warned | Skipped | Compatibility |');
		lines.push('| --- | --- | --- | --- | --- | --- | --- |');
		for (const run of runs) {
			const summary = ReportSummary.of(run.records);
			const streamSetting = run.streamSetting ?? 'not streamSetting-dependent';
			lines.push(
				`| ${MatrixReporter._escape(run.modelId)} | ${streamSetting} | ${summary.passedCount} | ${summary.failedCount} | ${summary.warnedCount} | ${summary.skippedCount} | ${summary.compatibilityPercent.toFixed(1)}% |`,
			);
		}
		lines.push('');

		if (options.skippedModels.length > 0) {
			lines.push('## Models left out', '');
			lines.push('These were named by the endpoint and never measured, because each failed to answer one chat completion under its own name.', '');
			lines.push('| Model | Why |');
			lines.push('| --- | --- |');
			for (const skipped of options.skippedModels) {
				lines.push(`| ${MatrixReporter._escape(skipped.modelId)} | ${MatrixReporter._escape(skipped.reason)} |`);
			}
			lines.push('');
		}

		return lines.join('\n');
	}

	/**
	 * Renders the same sweep as the plain text a person reads in the terminal they typed the command
	 * into.
	 *
	 * @param runs Every run of the sweep, in the order they were run.
	 * @param options The endpoint and the models left out.
	 * @returns The report, ready to print.
	 */
	static renderText(runs: readonly ConformanceRun[], options: MatrixReportOptions): string {
		const modelIds = MatrixReporter._orderedModelIds(runs);
		const rows = MatrixReporter._rows(runs);
		const streamSettings = MatrixReporter._orderedModes(runs);
		const testColumnWidth = Math.max(4, ...rows.map((row) => row.testId.length));
		const columnWidths = modelIds.map((modelId) => Math.max(modelId.length, streamSettings.length > 1 ? 17 : 7));

		const lines: string[] = ['OpenAI API Conformance Test', `Endpoint: ${options.endpoint}`, `Models measured: ${modelIds.length}`, ''];
		if (streamSettings.length > 1) {
			lines.push(`A cell holding two verdicts is a test the request streamSetting reaches, written ${streamSettings.join(' / ')}.`, '');
		}
		lines.push(`${'Test'.padEnd(testColumnWidth)}  ${modelIds.map((modelId, index) => modelId.padEnd(columnWidths[index] ?? modelId.length)).join('  ')}`);
		for (const row of rows) {
			const cells = modelIds.map((modelId, index) =>
				MatrixReporter._cell(row, modelId, streamSettings, MatrixReporter._words).padEnd(columnWidths[index] ?? 0),
			);
			lines.push(`${row.testId.padEnd(testColumnWidth)}  ${cells.join('  ')}`);
		}
		lines.push('');

		for (const run of runs) {
			const summary = ReportSummary.of(run.records);
			const streamSetting = run.streamSetting ?? 'not streamSetting-dependent';
			lines.push(
				`${run.modelId} (${streamSetting}): ${summary.passedCount} passed, ${summary.failedCount} failed, ${summary.warnedCount} warned, ${summary.skippedCount} skipped, ${summary.compatibilityPercent.toFixed(1)}%`,
			);
		}

		if (options.skippedModels.length > 0) {
			lines.push('', 'Models left out, never measured:');
			for (const skipped of options.skippedModels) {
				lines.push(`  ${skipped.modelId} — ${skipped.reason}`);
			}
		}

		return lines.join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Private Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Lists every model the sweep measured, in the order it first ran one.
	 *
	 * @param runs Every run of the sweep.
	 * @returns The model identifiers, first-seen order.
	 */
	private static _orderedModelIds(runs: readonly ConformanceRun[]): string[] {
		const modelIds: string[] = [];
		for (const run of runs) {
			if (modelIds.includes(run.modelId) === false) {
				modelIds.push(run.modelId);
			}
		}
		return modelIds;
	}

	/**
	 * Lists every stream setting the sweep sent its probes in, in the order it first used one.
	 *
	 * @param runs Every run of the sweep.
	 * @returns The stream setting names, first-seen order, leaving out the runs no stream setting reached.
	 */
	private static _orderedModes(runs: readonly ConformanceRun[]): string[] {
		const streamSettings: string[] = [];
		for (const run of runs) {
			if (run.streamSetting !== undefined && streamSettings.includes(run.streamSetting) === false) {
				streamSettings.push(run.streamSetting);
			}
		}
		return streamSettings;
	}

	/**
	 * Collects every test the sweep ran into one row each, keeping the order the tests were run in.
	 *
	 * @param runs Every run of the sweep.
	 * @returns One row per test identifier, first-seen order.
	 */
	private static _rows(runs: readonly ConformanceRun[]): MatrixRow[] {
		const rowsByTestId = new Map<string, MatrixRow>();
		const rows: MatrixRow[] = [];
		for (const run of runs) {
			for (const record of run.records) {
				const row = rowsByTestId.get(record.test.id) ?? MatrixReporter._newRow(record);
				if (rowsByTestId.has(record.test.id) === false) {
					rowsByTestId.set(record.test.id, row);
					rows.push(row);
				}
				const bySetting = row.verdictsByModel.get(run.modelId) ?? new Map<string, Verdict>();
				bySetting.set(run.streamSetting ?? '', record.result.verdict);
				row.verdictsByModel.set(run.modelId, bySetting);
			}
		}
		return rows;
	}

	/**
	 * Builds one empty row for one test.
	 *
	 * @param record Any record of that test, read for its identifier and group.
	 * @returns The row, with no verdicts in it yet.
	 */
	private static _newRow(record: TestRunRecord): MatrixRow {
		return {
			testId: record.test.id,
			group: record.test.group,
			verdictsByModel: new Map<string, Map<string, Verdict>>(),
		};
	}

	/**
	 * Renders one cell: what one model made of one test, in every stream setting that reached it.
	 *
	 * @param row The test's row.
	 * @param modelId The model whose column this cell is in.
	 * @param streamSettings Every stream setting the sweep used, in order.
	 * @param faces How to write each verdict, as symbols or as words.
	 * @returns The cell's text, empty when this model never ran this test.
	 */
	private static _cell(row: MatrixRow, modelId: string, streamSettings: readonly string[], faces: Readonly<Record<Verdict, string>>): string {
		const bySetting = row.verdictsByModel.get(modelId);
		if (bySetting === undefined) {
			return '';
		}
		const settingless = bySetting.get('');
		if (settingless !== undefined) {
			return faces[settingless];
		}
		return streamSettings.map((streamSetting) => {
			const verdict = bySetting.get(streamSetting);
			return verdict === undefined ? '' : faces[verdict];
		}).join(' / ');
	}

	/**
	 * Escapes the two characters a markdown table cell cannot carry as they stand.
	 *
	 * @param text The text to escape.
	 * @returns The escaped text.
	 */
	private static _escape(text: string): string {
		return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	}
}
