// Bounded, newline-framed output subscriptions. The log reader's cursor is never
// bash_output's cursor. A trailing LF emits its line now, retaining only cursor ambiguity.
import { debugError } from "./debug.ts";
import { openView, type View } from "./logview.ts";
import type { Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

export const WATCH_READ_BYTES = 64 * 1024;
export const WATCH_TICK_BYTES = 256 * 1024;
export const WATCH_BACKLOG_BYTES = 256 * 1024;
export const WATCH_LINE_BYTES = 16 * 1024;
export const WATCH_PENDING_BYTES = 32 * 1024;
export const WATCH_PENDING_LINES = 32;
export const WATCH_LIMIT = 16;

export type OutputLine = {
	task_id: string;
	seq: number;
	from_byte: number;
	to_byte: number;
	text: string;
	partial: boolean;
};
export type Watch = {
	state: "active" | "stopped" | "ended";
	contains: string[];
	cursor: number;
	lineStart: number;
	line: Buffer;
	dropping: boolean;
	ambiguousLf: boolean;
	seq: number;
	lastSentSeq: number;
	pending: OutputLine[];
	pendingBytes: number;
	skippedBytes: number;
	droppedLines: number;
	oversizedLines: number;
	reportedGaps: string;
	undelivered: number;
	finalReadFailed?: boolean;
};

export function validateContains(contains?: string[]): void {
	if (contains === undefined) return;
	if (
		contains.length === 0 ||
		contains.length > 16 ||
		contains.some((part) => typeof part !== "string" || part === "" || Buffer.byteLength(part) > 256)
	)
		throw new Error("contains requires 1–16 nonempty literal substrings, each at most 256 UTF-8 bytes.");
}

/** Lifetime subscription: stop is final; an identical start does not replay. */
export function startWatch(task: Task, contains: string[] = []): Watch | undefined {
	if (contains.length > 0) validateContains(contains);
	if (task.watch !== undefined) {
		if (task.watch.state === "stopped") throw new Error("Watch stopped; read bash_output for this task.");
		if (JSON.stringify(task.watch.contains) !== JSON.stringify(contains))
			throw new Error("This task already has a watch with different contains; read bash_output to filter its log.");
		return task.watch;
	}
	if (task.state !== "running" || task.logPath.endsWith(".gz")) return undefined;
	const view = openView(task);
	try {
		if (view.marker !== undefined) return undefined;
		const cursor = Math.max(0, view.size - WATCH_BACKLOG_BYTES);
		const watch: Watch = {
			state: "active",
			contains: [...contains],
			cursor,
			lineStart: cursor,
			line: Buffer.alloc(0),
			dropping: cursor > 0,
			ambiguousLf: false,
			seq: 0,
			lastSentSeq: 0,
			pending: [],
			pendingBytes: 0,
			skippedBytes: cursor,
			droppedLines: 0,
			oversizedLines: 0,
			reportedGaps: "skipped_bytes=0, dropped_lines=0, oversized_lines=0",
			undelivered: 0,
		};
		task.watch = watch;
		return watch;
	} finally {
		view.close();
	}
}

export function stopWatch(task: Task): void {
	if (task.watch === undefined || task.watch.state !== "active") return;
	task.watch.state = "stopped";
	discardPending(task.watch);
	task.watch.line = Buffer.alloc(0);
	task.watch.reportedGaps = watchGaps(task.watch);
}

/** Size of the actual JSON representation, not JS character count. */
export function lineBytes(line: OutputLine): number {
	return Buffer.byteLength(JSON.stringify(line));
}

function enqueue(watch: Watch, line: OutputLine): void {
	const size = lineBytes(line);
	// Leave room for the batch header even when JSON escaping expands a line.
	if (size > WATCH_PENDING_BYTES - 1024) {
		watch.droppedLines++;
		return;
	}
	watch.pending.push(line);
	watch.pendingBytes += size;
	while (watch.pending.length > WATCH_PENDING_LINES || watch.pendingBytes > WATCH_PENDING_BYTES) {
		const removed = watch.pending.shift();
		if (removed === undefined) break;
		watch.pendingBytes -= lineBytes(removed);
		watch.droppedLines++;
	}
}

function append(watch: Watch, data: Buffer): void {
	if (watch.dropping) {
		watch.skippedBytes += data.length;
		return;
	}
	if (watch.line.length + data.length > WATCH_LINE_BYTES) {
		watch.skippedBytes += watch.line.length + data.length;
		watch.line = Buffer.alloc(0);
		watch.dropping = true;
		watch.oversizedLines++;
		return;
	}
	watch.line = Buffer.concat([watch.line, data]);
}

function emitLine(task: Task, watch: Watch, end: number, partial: boolean): void {
	if (!watch.dropping) {
		const text = sanitize(watch.line.toString("utf8"));
		if (Buffer.byteLength(text) > WATCH_LINE_BYTES) {
			watch.oversizedLines++;
			watch.skippedBytes += watch.line.length;
		} else if (
			text !== "" &&
			!(partial && text.startsWith("__PI_BG_")) &&
			(watch.contains.length === 0 || watch.contains.some((part) => text.includes(part)))
		) {
			enqueue(watch, {
				task_id: task.id,
				seq: ++watch.seq,
				from_byte: watch.lineStart,
				to_byte: end,
				text,
				partial,
			});
		}
	}
	watch.line = Buffer.alloc(0);
	watch.dropping = false;
	watch.lineStart = end;
}

/** Was the ambiguous LF removed as the start of an internal marker? */
function cutAtCursor(task: Task, cursor: number): boolean {
	const cuts = [task.marker, task.limitMarker].filter((cut) => cut !== undefined).sort((a, b) => a.start - b.start);
	let removed = 0;
	for (const cut of cuts) {
		if (cut.start - removed === cursor) return true;
		removed += cut.end - cut.start;
	}
	return false;
}

function resolveLf(task: Task, watch: Watch, view: View): boolean {
	if (!watch.ambiguousLf) return true;
	if (!cutAtCursor(task, watch.cursor)) {
		if (view.size <= watch.cursor + 1 && view.marker === undefined && task.state === "running") return false;
		if (view.read(watch.cursor, Math.min(view.size, watch.cursor + 1))[0] === 0x0a) watch.cursor++;
	}
	watch.ambiguousLf = false;
	watch.lineStart = watch.cursor;
	return true;
}

function consume(task: Task, watch: Watch, buffer: Buffer, end: number, final: boolean): void {
	let offset = 0;
	while (offset < buffer.length) {
		const newline = buffer.indexOf(0x0a, offset);
		const until = newline < 0 ? buffer.length : newline;
		append(watch, buffer.subarray(offset, until));
		watch.cursor += until - offset;
		if (newline < 0) break;
		if (watch.dropping) watch.skippedBytes++;
		emitLine(task, watch, watch.cursor + 1, false);
		// Emit a complete LF line immediately, even when the producer goes silent.
		// Only the cursor stays at a possibly marker-leading LF until disambiguated.
		if (!final && watch.cursor + 1 === end) {
			watch.ambiguousLf = true;
			break;
		}
		watch.cursor++;
		offset = newline + 1;
	}
}

/** At most budget bytes of NEW plain-log output. Read errors are retried by the poller. */
export function scanWatch(task: Task, budget = WATCH_READ_BYTES, final = false): number {
	const watch = task.watch;
	if (watch?.state !== "active" || task.logPath.endsWith(".gz")) return 0;
	const view = openView(task);
	try {
		if (view.size < watch.cursor) {
			watch.skippedBytes += watch.cursor - view.size + watch.line.length;
			watch.line = Buffer.alloc(0);
			watch.state = "stopped";
			return 0;
		}
		const ambiguityRead = watch.ambiguousLf && !cutAtCursor(task, watch.cursor) ? 1 : 0;
		if (!resolveLf(task, watch, view)) return 0;
		const end = Math.min(view.size, watch.cursor + Math.max(0, budget - ambiguityRead));
		const buffer = view.read(watch.cursor, end);
		consume(task, watch, buffer, view.size, final || view.marker !== undefined);
		if (final) finishPartial(task, watch, view.size);
		return buffer.length + ambiguityRead;
	} finally {
		view.close();
	}
}

function finishPartial(task: Task, watch: Watch, size: number): void {
	if (watch.cursor < size) {
		watch.skippedBytes += size - watch.cursor + watch.line.length;
		watch.line = Buffer.alloc(0);
		watch.cursor = size;
	} else if (watch.line.length > 0 || watch.dropping) emitLine(task, watch, watch.cursor, true);
}

function discardPending(watch: Watch): void {
	watch.undelivered += watch.pending.length;
	watch.pending = [];
	watch.pendingBytes = 0;
}

/** Final bounded scan before completion/gzip. No buffered output is sent after terminal. */
export function closeWatch(task: Task): void {
	const watch = task.watch;
	if (watch === undefined || watch.state === "ended") return;
	if (watch.state === "active") {
		try {
			scanWatch(task, WATCH_READ_BYTES, true);
		} catch (error) {
			watch.finalReadFailed = true;
			debugError("watch-final-scan", error, { task: task.id });
		} finally {
			watch.state = "ended";
			discardPending(watch);
			watch.line = Buffer.alloc(0);
		}
	}
}

export function watchGaps(watch: Watch): string {
	return `skipped_bytes=${watch.skippedBytes}, dropped_lines=${watch.droppedLines}, oversized_lines=${watch.oversizedLines}`;
}
