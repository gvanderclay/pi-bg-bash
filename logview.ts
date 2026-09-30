// The log as the agent sees it: the file without the exit marker. The marker
// carries a per-task nonce, so output that merely looks like one is never
// mistaken for it, and it is found wherever it sits: a grandchild that outlives
// the command keeps writing after it. Offsets in this view ("virtual" offsets)
// skip the marker's bytes, so read positions stay valid whether or not the
// marker has appeared yet.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import type { Task } from "./registry.ts";

/** Where the marker sits in the file, and the exit code it carries. */
export type Marker = { start: number; end: number; code: number };

const CHUNK = 64 * 1024;
/** Longest marker after its needle: digits and the newline. */
const TAIL = 16;

/** The prefix every marker line starts with, including the separating newline. */
export function markerNeedle(nonce: string): Buffer {
	return Buffer.from(`\n__PI_BG_EXIT__:${nonce}:`);
}

/** Find the task's marker in the log, scanning only what earlier calls had not. Throws when the log cannot be read. */
export function locateMarker(task: Task): Marker | undefined {
	if (task.marker !== undefined) return task.marker;
	// A settled task (killed, exit unknown, or exited without a marker) can never
	// gain a valid exit marker afterwards; skipping the scan also keeps a gzipped
	// log from being opened as a plain one.
	if (task.state !== "running") return undefined;
	const needle = markerNeedle(task.nonce);
	const overlap = needle.length + TAIL;
	const fd = openSync(task.logPath, "r");
	try {
		const size = fstatSync(fd).size;
		let pos = task.scanFrom;
		while (pos < size) {
			const length = Math.min(CHUNK + overlap, size - pos);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, pos);
			const index = buffer.indexOf(needle);
			if (index >= 0) {
				const rest = /^(\d+)\n/.exec(buffer.toString("latin1", index + needle.length, index + needle.length + TAIL));
				if (rest !== null) {
					const start = pos + index;
					task.marker = { start, end: start + needle.length + rest[0].length, code: Number(rest[1]) };
					return task.marker;
				}
				if (pos + length >= size) {
					task.scanFrom = pos + index; // written but not finished: look again from here
					return undefined;
				}
				// The window ends inside the marker: the next window starts before it and holds all of it.
			}
			if (pos + CHUNK >= size) break;
			pos += CHUNK;
		}
		task.scanFrom = Math.max(task.scanFrom, size - overlap, 0);
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** An open log with the marker cut out. */
export type View = {
	/** Size of the log without the marker. */
	size: number;
	marker: Marker | undefined;
	/** Bytes `[start, end)` of the view. */
	read(start: number, end: number): Buffer;
	close(): void;
};

export function openView(task: Task): View {
	if (task.logPath.endsWith(".gz")) return openGzView(task);
	const fd = openSync(task.logPath, "r");
	try {
		// Size first, then the marker: a marker written in between lies past `physicalSize`.
		const physicalSize = fstatSync(fd).size;
		const cut = cutRegion(task);
		const cutLength = cut === undefined ? 0 : cut.end - cut.start;
		const size = cut === undefined ? physicalSize : Math.max(cut.start, physicalSize - cutLength);
		const physical = (offset: number) => (cut !== undefined && offset >= cut.start ? offset + cutLength : offset);
		const raw = (start: number, end: number) => {
			const buffer = Buffer.alloc(end - start);
			readSync(fd, buffer, 0, buffer.length, start);
			return buffer;
		};
		return {
			size,
			marker: task.marker,
			read(start, end) {
				if (cut === undefined || end <= cut.start || start >= cut.start) {
					return raw(physical(start), physical(start) + (end - start));
				}
				return Buffer.concat([raw(start, cut.start), raw(cut.end, end + cutLength)]);
			},
			close: () => closeSync(fd),
		};
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** The bytes the view cuts out: the exit marker, or the log-limit marker. */
function cutRegion(task: Task): { start: number; end: number } | undefined {
	const marker = locateMarker(task);
	if (marker !== undefined) return marker;
	return task.limitMarker;
}

/** A finished, gzipped log read whole into memory (the 100 MiB limit bounds it). */
function openGzView(task: Task): View {
	const buffer = gunzipSync(readFileSync(task.logPath));
	const cut = cutRegion(task);
	const cutLength = cut === undefined ? 0 : cut.end - cut.start;
	const size = cut === undefined ? buffer.length : Math.max(cut.start, buffer.length - cutLength);
	const physical = (offset: number) => (cut !== undefined && offset >= cut.start ? offset + cutLength : offset);
	const raw = (start: number, end: number) => Buffer.from(buffer.subarray(start, end));
	return {
		size,
		marker: task.marker,
		read(start, end) {
			if (cut === undefined || end <= cut.start || start >= cut.start) {
				return raw(physical(start), physical(start) + (end - start));
			}
			return Buffer.concat([raw(start, cut.start), raw(cut.end, end + cutLength)]);
		},
		close: () => {},
	};
}
