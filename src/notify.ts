// The completion message: what the agent hears when a task ends.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { openView } from "./logview.ts";
import type { Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const MESSAGE_TYPE = "pi-bg-bash";
/** How many lines of the log's end the message carries. */
const TAIL_LINES = 20;
/** The byte cap on that tail. */
const TAIL_BYTES = 4096;
/** How much of the log's end is read to find those lines. */
const READ_WINDOW = 64 * 1024;

/** `1.2s`, or `2m 5s` from a minute on. */
export function formatRuntime(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

/** Drop leading continuation bytes so the buffer does not start inside a multi-byte character. */
function fromCharacterBoundary(buffer: Buffer): Buffer {
	let start = 0;
	while (start < buffer.length && start < 3 && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start);
}

/** The last lines of the log, marker removed, stripped for the agent (the log stays raw), capped in lines and bytes. Never moves the read position. */
export function logTail(task: Task): string {
	let buffer: Buffer;
	try {
		const view = openView(task);
		try {
			buffer = view.read(Math.max(0, view.size - READ_WINDOW), view.size);
		} finally {
			view.close();
		}
	} catch {
		return "(log unavailable)";
	}
	const lines = sanitize(fromCharacterBoundary(buffer).toString("utf8")).replace(/\n$/, "").split("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	const bytes = Buffer.from(tail, "utf8");
	return bytes.length <= TAIL_BYTES
		? tail
		: fromCharacterBoundary(bytes.subarray(bytes.length - TAIL_BYTES)).toString("utf8");
}

/**
 * The one wording of a task's state, for `bash_tasks`, `/bg`, `bash_output` and the
 * completion message: `running`, `exited (code 0)`, `killed (timed out)`, `exit unknown`.
 * `markerCode` is a marker the caller has read that the registry has not yet settled.
 */
export function stateText(task: Task, markerCode?: number): string {
	if (task.state === "killed") return `killed (${task.reason})`;
	if (task.state === "exited") return `exited (code ${task.exitCode})`;
	if (task.state === "running") return markerCode === undefined ? "running" : `exited (code ${markerCode})`;
	return "exit unknown";
}

/** How long the task has run, or ran: frozen at its end. */
export function runtimeText(task: Task): string {
	return formatRuntime((task.endedAt ?? Date.now()) - task.startedAt);
}

/** One line per task for `bash_tasks` and `/bg`: `id | state | runtime | command`, the command on one line. */
export function taskLine(task: Task): string {
	const command = task.command.replace(/\s*\n\s*/g, " ⏎ ");
	return `${task.id} | ${stateText(task)} | ${runtimeText(task)} | ${command.length > 200 ? `${command.slice(0, 200)}…` : command}`;
}

/** The completion text: id, command, state, runtime and the output's last lines. */
export function completionText(task: Task): string {
	const tail = logTail(task);
	return [
		`Background task ${task.id} finished: ${stateText(task)}, ran ${runtimeText(task)}.`,
		`Command: ${task.command}`,
		tail === "" ? "(no output)" : `Last output:\n${tail}`,
	].join("\n");
}

/** Send the completion as a follow-up custom message that starts a turn when the agent is idle. */
export function sendCompletion(pi: ExtensionAPI, task: Task): void {
	pi.sendMessage(
		{
			customType: MESSAGE_TYPE,
			content: completionText(task),
			display: true,
			details: { id: task.id, exitCode: task.exitCode, state: task.state },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}
