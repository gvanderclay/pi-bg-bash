// The log reader behind `bash_output`: pages forward from a task's read
// position, never returns the exit marker (the log is read through `logview`,
// which cuts it out wherever it sits), and moves the position only past what it
// returned. A running task's half-written last line is withheld until
// its newline arrives.
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

import { openView, type View } from "./logview.ts";
import { stateText } from "./notify.ts";
import type { Task } from "./registry.ts";

const NEWLINE = 0x0a;

export type OutputOptions = { latest?: boolean; filter?: string };

/** Drop bytes from the end so the buffer does not finish inside a multi-byte character. */
function wholeCharacters(buffer: Buffer): Buffer {
	let end = buffer.length;
	let i = end;
	while (i > 0 && end - i < 3 && (buffer[i - 1] & 0xc0) === 0x80) i--; // continuation bytes
	if (i > 0 && buffer[i - 1] >= 0xc0) {
		const need = buffer[i - 1] >= 0xf0 ? 4 : buffer[i - 1] >= 0xe0 ? 3 : 2;
		if (end - (i - 1) < need) end = i - 1; // the last character is cut
	}
	return buffer.subarray(0, end);
}

/** Keep the lines of `text` that match `filter`; reports how many were kept of how many. */
function applyFilter(text: string, filter: RegExp | undefined): { text: string; note?: string } {
	if (filter === undefined || text === "") return { text };
	const all = text.split("\n");
	const kept = all.filter((line) => filter.test(line));
	return { text: kept.join("\n"), note: `[filter: ${kept.length} of ${all.length} lines matched]` };
}

/** One `bash_output` call: the text to return, with `task.readPosition` already advanced. */
export function readOutput(task: Task, options: OutputOptions): string {
	let filter: RegExp | undefined;
	try {
		filter = options.filter === undefined ? undefined : new RegExp(options.filter);
	} catch {
		throw new Error(`filter is not a valid regular expression: ${options.filter}`);
	}
	const view = openView(task);
	let body = "";
	let note: string | undefined;
	const code = view.marker?.code;
	try {
		const end = view.size;
		const finished = view.marker !== undefined || task.state !== "running";
		const position = Math.min(task.readPosition, end);
		const page = options.latest ? newest(view, position, end, finished) : oldest(view, position, end, finished);
		body = page.text;
		note = page.note;
		task.readPosition = page.next;
	} finally {
		view.close();
	}
	const filtered = applyFilter(body, filter);
	const parts = [`Task ${task.id}: ${stateText(task, code)}.`];
	parts.push(filtered.text === "" ? (filtered.note ? "(no lines matched)" : "(no new output)") : filtered.text);
	for (const extra of [filtered.note, note]) if (extra) parts.push(extra);
	return parts.join("\n");
}

type Page = { text: string; next: number; note?: string };

/**
 * Whole lines from the start of `buffer`, at most `DEFAULT_MAX_LINES` of them and
 * `DEFAULT_MAX_BYTES` once decoded. `used` counts raw bytes: a byte that is not
 * valid UTF-8 decodes to three, so the text's length says nothing about how far
 * the read position may advance. A first line over the cap is cut at a character.
 */
function takeLines(buffer: Buffer): { text: string; used: number } {
	let used = 0;
	let lines = 0;
	let decoded = 0;
	while (used < buffer.length && lines < DEFAULT_MAX_LINES) {
		const newline = buffer.indexOf(NEWLINE, used);
		const lineEnd = newline < 0 ? buffer.length : newline + 1;
		const size = Buffer.byteLength(buffer.subarray(used, lineEnd).toString("utf8"));
		if (decoded + size > DEFAULT_MAX_BYTES) {
			if (lines === 0) used = fitPrefix(buffer.subarray(0, lineEnd));
			break;
		}
		decoded += size;
		used = lineEnd;
		lines++;
	}
	const text = buffer.subarray(0, used).toString("utf8");
	return { text: text.endsWith("\n") ? text.slice(0, -1) : text, used };
}

/** The longest whole-character prefix of `line` that decodes to at most `DEFAULT_MAX_BYTES`. */
function fitPrefix(line: Buffer): number {
	let length = Math.min(line.length, DEFAULT_MAX_BYTES);
	for (;;) {
		length = wholeCharacters(line.subarray(0, length)).length;
		const decoded = Buffer.byteLength(line.subarray(0, length).toString("utf8"));
		if (decoded <= DEFAULT_MAX_BYTES || length <= 1) return Math.max(length, 1);
		length = Math.min(length - 1, Math.floor((length * DEFAULT_MAX_BYTES) / decoded));
	}
}

/** The oldest unread output: whole lines from `position`, capped by Pi's limits. */
function oldest(view: View, position: number, end: number, finished: boolean): Page {
	const windowEnd = Math.min(end, position + DEFAULT_MAX_BYTES + 1);
	const windowCut = windowEnd < end;
	let buffer = view.read(position, windowEnd);
	if (!(finished && !windowCut)) {
		// Only complete lines, unless a single line is longer than the cap.
		const lastNewline = buffer.lastIndexOf(NEWLINE);
		if (lastNewline >= 0) buffer = buffer.subarray(0, lastNewline + 1);
		else if (windowCut) buffer = wholeCharacters(buffer.subarray(0, DEFAULT_MAX_BYTES));
		else buffer = buffer.subarray(0, 0);
	}
	const taken = takeLines(buffer);
	const next = position + taken.used;
	const more = taken.used < buffer.length || windowCut;
	return {
		text: taken.text,
		next,
		note: more ? `[More remaining: ${end - next} bytes unread. Call bash_output again to continue.]` : undefined,
	};
}

/** The newest unread output: the last lines before `end`, never before `position`; the position moves to the end. */
function newest(view: View, position: number, end: number, finished: boolean): Page {
	const start = Math.max(position, end - DEFAULT_MAX_BYTES - 1);
	let buffer = view.read(start, end);
	let offset = start;
	// A window with no newline at all (a progress meter, a blob) has no whole line to
	// keep: cut it at a character boundary instead, like the oldest path.
	let blob = false;
	if (start > position) {
		// The first line may be cut: drop it.
		const firstNewline = buffer.indexOf(NEWLINE);
		// A newline only at the very end leaves no whole line either.
		if (firstNewline < 0 || firstNewline === buffer.length - 1) {
			blob = true;
			let skip = 0;
			while (skip < buffer.length && skip < 3 && (buffer[skip] & 0xc0) === 0x80) skip++; // start of a cut character
			offset += skip;
			buffer = buffer.subarray(skip);
		} else {
			offset += firstNewline + 1;
			buffer = buffer.subarray(firstNewline + 1);
		}
	}
	if (!finished) {
		const lastNewline = buffer.lastIndexOf(NEWLINE);
		if (blob) buffer = wholeCharacters(buffer);
		else if (lastNewline < 0) return { text: "", next: position };
		else buffer = buffer.subarray(0, lastNewline + 1);
	}
	const next = offset + buffer.length;
	const text = buffer.toString("utf8");
	const capped = truncateTail(text.endsWith("\n") ? text.slice(0, -1) : text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	const returnedStart = next - Buffer.byteLength(capped.content) - (text.endsWith("\n") ? 1 : 0);
	const skipped = Math.max(0, returnedStart - position);
	return {
		text: capped.content,
		next,
		note: skipped > 0 ? `[Skipped ${skipped} bytes of earlier unread output.]` : undefined,
	};
}
