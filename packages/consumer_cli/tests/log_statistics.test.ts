import Assert from 'node:assert/strict';
import Test from 'node:test';
import { LogEntryReader } from '../src/message_log/log_entry_reader.js';
import { LogStatistics } from '../src/message_log/log_statistics.js';
import { LogTaskTimeline } from '../src/message_log/log_task_timeline.js';
import { LogStatisticsFormatter } from '../src/message_log/log_statistics_formatter.js';
import type { LogFileContents } from '../src/message_log/log_entry_reader.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	Tests for measuring a .log_entry.jsonl message log file
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One task travelling through the gateway, written the way the gateway's own log writes it:
 * received from the consumer, assigned to a worker, answered, and recorded.
 *
 * The moments are chosen so every measured duration is a different round number, which makes
 * a measurement attributed to the wrong pair of moments fail loudly rather than coincidentally
 * agree with the right one.
 */
const gatewayLogLines: string[] = [
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.000Z',
		direction: 'received',
		counterpart: {
			role: 'consumer',
			deviceId: 'device-consumer',
		},
		messageType: 'task.submit',
		messagePayload: {
			type: 'task.submit',
			taskRequestId: 'request-1',
			input: {
				taskType: 'task_type_dev_formula',
				input: '[redacted]',
			},
		},
		messagePayloadBytes: 100,
		messageBytes: 120,
		messageId: 'message-1',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.010Z',
		direction: 'sent',
		counterpart: {
			role: 'consumer',
			deviceId: 'device-consumer',
		},
		messageType: 'task.accepted',
		messagePayload: {
			type: 'task.accepted',
			taskRequestId: 'request-1',
			task: {
				taskId: 'task-1',
				taskRequestId: 'request-1',
				consumerDeviceId: 'device-consumer',
				pipelineId: 'dev_formula',
				state: 'queued',
			},
		},
		messagePayloadBytes: 200,
		messageBytes: 220,
		messageId: 'message-2',
		inReplyToMessageId: 'message-1',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.030Z',
		direction: 'sent',
		counterpart: {
			role: 'worker',
			deviceId: 'device-worker',
		},
		messageType: 'stage.assign',
		messagePayload: {
			type: 'stage.assign',
			taskId: 'task-1',
			stageAssignmentId: 'stageAssignment-1',
			attempt: 1,
			stage: 'stage_dev_formula',
		},
		messagePayloadBytes: 150,
		messageBytes: 170,
		messageId: 'message-3',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.070Z',
		direction: 'received',
		counterpart: {
			role: 'worker',
			deviceId: 'device-worker',
		},
		messageType: 'stage.accepted',
		messagePayload: {
			type: 'stage.accepted',
			taskId: 'task-1',
			stageAssignmentId: 'stageAssignment-1',
			attempt: 1,
		},
		messagePayloadBytes: 90,
		messageBytes: 110,
		messageId: 'message-4',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.870Z',
		direction: 'received',
		counterpart: {
			role: 'worker',
			deviceId: 'device-worker',
		},
		messageType: 'stage.result',
		messagePayload: {
			type: 'stage.result',
			taskId: 'task-1',
			stageAssignmentId: 'stageAssignment-1',
			attempt: 1,
			stage: 'stage_dev_formula',
			value: '[redacted]',
		},
		messagePayloadBytes: 130,
		messageBytes: 150,
		messageId: 'message-5',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:00.920Z',
		direction: 'sent',
		counterpart: {
			role: 'worker',
			deviceId: 'device-worker',
		},
		messageType: 'stage.result.accepted',
		messagePayload: {
			type: 'stage.result.accepted',
			taskId: 'task-1',
			stageAssignmentId: 'stageAssignment-1',
			attempt: 1,
			taskRevision: 5,
			status: 'completed',
		},
		messagePayloadBytes: 110,
		messageBytes: 130,
		messageId: 'message-6',
		inReplyToMessageId: 'message-5',
		protocolVersion: 3,
	}),
	JSON.stringify({
		timestamp: '2026-08-02T03:00:01.000Z',
		direction: 'sent',
		counterpart: {
			role: 'consumer',
			deviceId: 'device-consumer',
		},
		messageType: 'task.updated',
		messagePayload: {
			type: 'task.updated',
			update: {
				taskId: 'task-1',
				taskRevision: 5,
				state: 'completed',
				completedStageCount: 1,
				currentStageAttempts: 0,
				result: '[redacted]',
			},
		},
		messagePayloadBytes: 140,
		messageBytes: 160,
		messageId: 'message-7',
		protocolVersion: 3,
	}),
];

/**
 * Measures the sample gateway log above, as though it had been read from a file.
 *
 * @param lines The log lines to measure. Defaults to the whole sample gateway log.
 * @returns The parsed contents, ready to hand to `LogStatistics.calculate`.
 */
function readSampleLog(lines: string[] = gatewayLogLines): LogFileContents {
	const parsed = LogEntryReader.parseJsonl(`${lines.join('\n')}\n`);
	return {
		filePath: 'sample.log_entry.jsonl',
		fileBytes: lines.join('\n').length,
		lineCount: parsed.lineCount,
		entries: parsed.entries,
		lineErrors: parsed.lineErrors,
		outOfOrderCount: parsed.outOfOrderCount,
	};
}

Test('reads every well-formed line and reports the ones it cannot read', () => {
	const parsed = LogEntryReader.parseJsonl(`${gatewayLogLines[0] ?? ''}\nnot json at all\n{"missing":"the log entry fields"}\n\n`);
	Assert.equal(parsed.lineCount, 3);
	Assert.equal(parsed.entries.length, 1);
	Assert.deepEqual(parsed.lineErrors, [
		{
			lineNumber: 2,
			reason: 'not valid JSON',
		},
		{
			lineNumber: 3,
			reason: 'does not have the fields a log entry must have',
		},
	]);
});

Test('sorts entries by their timestamp, and counts the ones written out of time order', () => {
	const reversed: string[] = [...gatewayLogLines].reverse();
	const parsed = LogEntryReader.parseJsonl(reversed.join('\n'));
	Assert.equal(parsed.entries.length, 7);
	Assert.equal(parsed.entries[0]?.messageType, 'task.submit');
	Assert.equal(parsed.entries[6]?.messageType, 'task.updated');
	// Every line but the first was written before the line above it.
	Assert.equal(parsed.outOfOrderCount, 6);
	Assert.equal(LogEntryReader.parseJsonl(gatewayLogLines.join('\n')).outOfOrderCount, 0);
});

Test('spreads a set of measurements out by nearest rank', () => {
	const distribution = LogStatistics.distribution([5, 1, 4, 2, 3]);
	Assert.equal(distribution.count, 5);
	Assert.equal(distribution.minimum, 1);
	Assert.equal(distribution.maximum, 5);
	Assert.equal(distribution.median, 3);
	Assert.equal(distribution.percentile90, 5);
	Assert.equal(distribution.percentile99, 5);
	Assert.equal(distribution.mean, 3);
	Assert.equal(distribution.total, 15);

	const empty = LogStatistics.distribution([]);
	Assert.equal(empty.count, 0);
	Assert.equal(empty.median, 0);
	Assert.equal(empty.total, 0);
});

Test('counts and sizes the traffic, each way and by message type', () => {
	const report = LogStatistics.calculate(readSampleLog());
	Assert.equal(report.file.entryCount, 7);
	Assert.deepEqual(report.file.protocolVersions, [3]);
	Assert.equal(report.traffic.messageCount, 7);
	Assert.equal(report.traffic.sentCount, 4);
	Assert.equal(report.traffic.receivedCount, 3);
	Assert.equal(report.traffic.messageBytes.total, 120 + 220 + 170 + 110 + 150 + 130 + 160);
	Assert.equal(report.traffic.sentBytes, 220 + 170 + 130 + 160);
	Assert.equal(report.traffic.receivedBytes, 120 + 110 + 150);
	// Every message here carries a 20-byte envelope on top of its body.
	Assert.equal(report.traffic.envelopeOverheadBytes, 7 * 20);
	Assert.equal(report.traffic.largestMessage?.messageType, 'task.accepted');
	Assert.equal(report.traffic.largestMessage?.messageBytes, 220);

	const taskAccepted = report.byMessageType.find((row) => row.messageType === 'task.accepted');
	Assert.equal(taskAccepted?.count, 1);
	Assert.equal(taskAccepted?.sentCount, 1);
	Assert.equal(taskAccepted?.receivedCount, 0);
	Assert.equal(taskAccepted?.messageBytes, 220);
});

Test('measures when the traffic happened and how much of it landed in one second', () => {
	const report = LogStatistics.calculate(readSampleLog());
	Assert.equal(report.timeSpan.firstTimestamp, '2026-08-02T03:00:00.000Z');
	Assert.equal(report.timeSpan.lastTimestamp, '2026-08-02T03:00:01.000Z');
	Assert.equal(report.timeSpan.durationMs, 1000);
	Assert.equal(report.timeSpan.messagesPerSecond, 7);
	// The seventh message falls a full second after the first, so it is the one left out.
	Assert.equal(report.timeSpan.busiestSecondMessageCount, 6);
	Assert.equal(report.timeSpan.longestSilenceMs, 800);
	Assert.equal(report.timeSpan.longestSilenceStartsAt, '2026-08-02T03:00:00.070Z');
});

Test('matches every reply to the request it answers, and times the round trip', () => {
	const report = LogStatistics.calculate(readSampleLog());
	Assert.equal(report.reply.matchedCount, 2);
	Assert.equal(report.reply.unmatchedReplyCount, 0);
	Assert.equal(report.reply.slowestExchange?.exchange, 'stage.result → stage.result.accepted');
	Assert.equal(report.reply.slowestExchange?.latencyMs, 50);
	Assert.deepEqual(
		report.reply.byExchange.map((row) => [row.exchange, row.count, row.latencyMs.median]),
		[
			['stage.result → stage.result.accepted', 1, 50],
			['task.submit → task.accepted', 1, 10],
		],
	);
});

Test('counts a reply whose request is not in the file, rather than timing it against nothing', () => {
	const orphan: string = JSON.stringify({
		timestamp: '2026-08-02T03:00:02.000Z',
		direction: 'sent',
		counterpart: {
			role: 'consumer',
			deviceId: 'device-consumer',
		},
		messageType: 'task.accepted',
		messagePayload: {
			type: 'task.accepted',
		},
		messageBytes: 100,
		messageId: 'message-8',
		inReplyToMessageId: 'message-written-to-an-earlier-file',
	});
	const report = LogStatistics.calculate(readSampleLog([...gatewayLogLines, orphan]));
	Assert.equal(report.reply.matchedCount, 2);
	Assert.equal(report.reply.unmatchedReplyCount, 1);
});

Test('ties a submission to the task the gateway opened for it', () => {
	const timeline = LogTaskTimeline.build(readSampleLog().entries);
	Assert.equal(timeline.tasks.length, 1);
	const task = timeline.tasks[0];
	Assert.equal(task?.taskId, 'task-1');
	// The submission itself names only the request identifier; `task.accepted` is what ties the
	// two together, and without that the submission could not be attributed to this task at all.
	Assert.equal(task?.taskRequestId, 'request-1');
	Assert.equal(task?.taskType, 'task_type_dev_formula');
	Assert.equal(task?.pipelineId, 'dev_formula');
	Assert.equal(task?.consumerDeviceId, 'device-consumer');
	Assert.deepEqual(task?.workerDeviceIds, ['device-worker']);
	Assert.deepEqual(task?.stageNames, ['stage_dev_formula']);
	Assert.equal(task?.finalState, 'completed');
	Assert.equal(task?.stageRunCount, 1);
	Assert.equal(task?.messageCount, 7);
});

Test('times each part of a task\'s life separately', () => {
	const report = LogStatistics.calculate(readSampleLog());
	Assert.equal(report.tasks.taskCount, 1);
	Assert.equal(report.tasks.completedCount, 1);
	Assert.equal(report.tasks.failedCount, 0);
	Assert.equal(report.tasks.unfinishedCount, 0);
	Assert.equal(report.tasks.retriedCount, 0);
	Assert.equal(report.tasks.maximumAttempt, 1);
	Assert.equal(report.tasks.admissionMs.median, 10);
	Assert.equal(report.tasks.queueWaitMs.median, 20);
	Assert.equal(report.tasks.endToEndMs.median, 1000);
	Assert.deepEqual(report.tasks.byFinalState, [
		{
			key: 'completed',
			count: 1,
		},
	]);
	Assert.deepEqual(report.tasks.byWorker, [
		{
			key: 'device-worker',
			count: 1,
		},
	]);
});

Test('times each run of a stage on a worker separately', () => {
	const report = LogStatistics.calculate(readSampleLog());
	Assert.equal(report.stageRuns.stageRunCount, 1);
	Assert.equal(report.stageRuns.unfinishedCount, 0);
	Assert.equal(report.stageRuns.pickupMs.median, 40);
	Assert.equal(report.stageRuns.computeMs.median, 800);
	Assert.equal(report.stageRuns.commitMs.median, 50);
	Assert.deepEqual(report.stageRuns.byStageName.map((row) => [row.key, row.count, row.computeMs.median]), [['stage_dev_formula', 1, 800]]);
	Assert.deepEqual(report.stageRuns.byWorker.map((row) => [row.key, row.count, row.computeMs.median]), [['device-worker', 1, 800]]);
});

Test('leaves a measurement out rather than guessing when the log does not contain both ends of it', () => {
	// A consumer's own log never sees a stage being assigned or answered, so the stage timings
	// have nothing to measure. They must report that, not report zero.
	const consumerSide: string[] = gatewayLogLines.filter((line) => line.includes('"stage.') === false);
	const report = LogStatistics.calculate(readSampleLog(consumerSide));
	Assert.equal(report.stageRuns.stageRunCount, 0);
	Assert.equal(report.stageRuns.computeMs.count, 0);
	Assert.equal(report.tasks.queueWaitMs.count, 0);
	Assert.equal(report.tasks.taskCount, 1);
	Assert.equal(report.tasks.admissionMs.median, 10);
	Assert.equal(report.tasks.endToEndMs.median, 1000);
});

Test('reports what is worth a second look, and stays quiet when there is nothing', () => {
	const clean = LogStatistics.calculate(readSampleLog());
	Assert.equal(clean.concerns.unreadableLineCount, 0);
	Assert.equal(clean.concerns.outOfOrderCount, 0);
	Assert.equal(clean.concerns.errorMessageCount, 0);
	Assert.equal(clean.concerns.oversizeBodyCount, 0);
	Assert.equal(clean.concerns.unidentifiedCounterpartCount, 0);

	const troubled: string = JSON.stringify({
		timestamp: '2026-08-02T03:00:03.000Z',
		direction: 'received',
		counterpart: {
			role: 'unknown',
		},
		messageType: 'task.failed',
		messagePayload: {
			type: 'task.failed',
			redacted: true,
			messagePayloadBytes: 99_999,
		},
		messageBytes: 80,
	});
	const report = LogStatistics.calculate(readSampleLog([...gatewayLogLines, troubled]));
	Assert.equal(report.concerns.errorMessageCount, 1);
	Assert.deepEqual(report.concerns.errorMessageTypes, [
		{
			key: 'task.failed',
			count: 1,
		},
	]);
	Assert.equal(report.concerns.oversizeBodyCount, 1);
	Assert.equal(report.concerns.unidentifiedCounterpartCount, 1);
});

Test('writes the same measurements out as text, markdown, and JSON', () => {
	const report = LogStatistics.calculate(readSampleLog());

	const text = LogStatisticsFormatter.format(report, 'text', 12);
	Assert.match(text, /Tasks\n─────/);
	Assert.match(text, /device-worker/);

	const markdown = LogStatisticsFormatter.format(report, 'markdown', 12);
	Assert.match(markdown, /^# Message log statistics for `sample\.log_entry\.jsonl`/);
	Assert.match(markdown, /^## Tasks$/m);
	Assert.match(markdown, /\| measure \| value \|/);
	Assert.match(markdown, /\| task\.submit → task\.accepted \|/);

	const json = LogStatisticsFormatter.format(report, 'json', 12);
	const parsed = JSON.parse(json);
	Assert.equal(parsed.tasks.taskCount, 1);
	Assert.equal(parsed.file.filePath, 'sample.log_entry.jsonl');
});

Test('accepts only the formats it knows about', () => {
	Assert.equal(LogStatisticsFormatter.isFormat('text'), true);
	Assert.equal(LogStatisticsFormatter.isFormat('markdown'), true);
	Assert.equal(LogStatisticsFormatter.isFormat('json'), true);
	Assert.equal(LogStatisticsFormatter.isFormat('yaml'), false);
});

Test('cuts a table down to the requested number of rows and counts the rest', () => {
	const report = LogStatistics.calculate(readSampleLog());
	const text = LogStatisticsFormatter.format(report, 'text', 1);
	Assert.match(text, /… and 1 more row/);
});
