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
	// A gzipped log cannot be scanned as a plain one. The state is deliberately not
	// consulted: a settled task may still gain an exit marker written during the
	// kill's grace period, and that marker must be cut out of the view too.
	if (task.logPath.endsWith(".gz")) return undefined;
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
		return viewFor(task, physicalSize, (start, end) => {
			const buffer = Buffer.alloc(end - start);
			readSync(fd, buffer, 0, buffer.length, start);
			return buffer;
		}, () => closeSync(fd));
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

/** A region of the physical log the view removes. */
type Region = { start: number; end: number };

/** The regions the view cuts out, in file order: the exit marker and the log-limit marker. Both can be present. */
function cutRegions(task: Task): Region[] {
	const regions: Region[] = [];
	locateMarker(task);
	if (task.marker !== undefined) regions.push(task.marker);
	if (task.limitMarker !== undefined) regions.push(task.limitMarker);
	return regions.sort((a, b) => a.start - b.start);
}

/**
 * A view over kept segments of the physical log. Offsets the reader sees skip
 * every cut region, so read positions stay valid whether or not a marker has
 * appeared yet; two markers (a command that exited during the limit kill) are
 * both cut.
 */
function viewFor(task: Task, physicalSize: number, read: (start: number, end: number) => Buffer, close: () => void): View {
	const segments: { virtual: number; physical: number; length: number }[] = [];
	let physical = 0;
	let virtual = 0;
	for (const cut of cutRegions(task)) {
		if (cut.start > physical) {
			const length = cut.start - physical;
			segments.push({ virtual, physical, length });
			virtual += length;
		}
		physical = Math.max(physical, cut.end);
	}
	if (physicalSize > physical) segments.push({ virtual, physical, length: physicalSize - physical });
	return {
		size: virtual + Math.max(physicalSize - physical, 0),
		marker: task.marker,
		read(start, end) {
			const parts: Buffer[] = [];
			for (const segment of segments) {
				const from = Math.max(start, segment.virtual);
				const to = Math.min(end, segment.virtual + segment.length);
				if (to > from) parts.push(read(segment.physical + (from - segment.virtual), segment.physical + (to - segment.virtual)));
			}
			return parts.length === 1 ? parts[0] : Buffer.concat(parts);
		},
		close,
	};
}

/** A finished, gzipped log read whole into memory. The limit is checked per tick, so this can exceed 100 MiB. */
function openGzView(task: Task): View {
	const buffer = gunzipSync(readFileSync(task.logPath));
	return viewFor(task, buffer.length, (start, end) => Buffer.from(buffer.subarray(start, end)), () => {});
}
