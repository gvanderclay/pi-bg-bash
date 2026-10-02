// Log housekeeping: the size limit that stops a runaway task, gzipping a
// finished log once the agent has been told, and removing old logs at session
// start. The size check runs on its own fast timer in the registry (about four
// times a second) and again in the 2 s poller, so it records the kill reason
// and sends the completion message through the same path as a deadline kill.
import {
	appendFileSync,
	createReadStream,
	createWriteStream,
	lstatSync,
	readdirSync,
	rmdirSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { OWNER_FILE, ownerPid, stateRoot } from "./launch.ts";
import { processPort } from "./port.ts";
import type { Task } from "./registry.ts";

const MIB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** A running task is killed once its log passes this many bytes. */
const LOG_LIMIT_BYTES = 100 * MIB;
/** Logs and emptied session directories older than this many days are removed at session start. */
const CLEANUP_DAYS = 7;
/** The extension's own log names: `<id>.log` and `<id>.log.gz`. */
const LOG_NAME = /^bg-\d+\.log(\.gz)?$/;

/** The log limit; the contract test lowers it with `PI_BG_BASH_LOG_LIMIT_BYTES`. */
export function logLimitBytes(): number {
	const set = Number(process.env.PI_BG_BASH_LOG_LIMIT_BYTES);
	return Number.isFinite(set) && set > 0 ? set : LOG_LIMIT_BYTES;
}

/** Whether a running task's plain log has passed the size limit. */
export function overLogLimit(task: Task): boolean {
	try {
		return statSync(task.logPath).size > logLimitBytes();
	} catch {
		return false; // a log that cannot be read cannot be over the limit
	}
}

/**
 * Append the `__PI_BG_LIMIT__:<nonce>` marker and remember where it sits, so the
 * view cuts it out like the exit marker. The caller has already stopped the
 * group; a group that survived SIGKILL (`stuck`) can still write after it, but
 * the cut is a region, so the view stays correct.
 */
export function appendLimitMarker(task: Task): void {
	const line = `\n__PI_BG_LIMIT__:${task.nonce}\n`;
	const before = statSync(task.logPath).size;
	appendFileSync(task.logPath, line);
	task.limitMarker = { start: before, end: before + Buffer.byteLength(line) };
}

/**
 * Compress the task's finished log to `<id>.log.gz` (0600), delete the plain
 * file, and point the task at the gzipped one. The gzip is streamed, so a large
 * log neither blocks the event loop nor hits the 2 GiB read ceiling. A missing
 * log (an exit that could no longer be known) is left as it is.
 */
export async function gzipLog(task: Task): Promise<void> {
	if (task.logPath.endsWith(".gz")) return;
	const plain = task.logPath;
	const gz = `${plain}.gz`;
	try {
		await pipeline(createReadStream(plain), createGzip(), createWriteStream(gz, { mode: 0o600 }));
	} catch (error) {
		try {
			rmSync(gz, { force: true, recursive: true });
		} catch {
			// removing a partial `.gz` must never replace the gzip error
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	task.logPath = gz;
	unlinkSync(plain);
}

/** A path's modification time, or `undefined` when it cannot be read. */
function mtimeMs(path: string): number | undefined {
	try {
		return lstatSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * Remove logs and emptied session directories under the state root that are
 * older than the retention. It only ever deletes regular files whose name is
 * the extension's own (`bg-<n>.log` or `.gz`), never a registered task's log,
 * and it never follows symlinks (a symlinked directory or log is left alone).
 * A session directory whose owner marker names a live process is skipped whole:
 * another Pi may still be writing there. `tasks` is the registry's current task
 * list, for the "never a running task's log" rule.
 */
export function cleanupOldLogs(tasks: Iterable<Task>): void {
	const cutoff = Date.now() - CLEANUP_DAYS * DAY;
	const keep = new Set<string>();
	for (const task of tasks) {
		keep.add(task.logPath);
		keep.add(task.logPath.endsWith(".gz") ? task.logPath.slice(0, -3) : `${task.logPath}.gz`);
	}
	let sessions;
	try {
		sessions = readdirSync(stateRoot(), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const session of sessions) {
		if (!session.isDirectory()) continue; // a symlinked directory is not descended into
		const dir = join(stateRoot(), session.name);
		// Another live Pi process owns this directory: its tasks may still be writing.
		// A liveness check that throws cannot name a live owner (the pid is bounded in `ownerPid`).
		const owner = ownerPid(dir);
		let ownerAlive = false;
		if (owner !== undefined) {
			try {
				ownerAlive = processPort().pidAlive(owner);
			} catch {
				ownerAlive = false;
			}
		}
		if (ownerAlive) continue;
		// Captured before any unlink: removing a file updates the directory's mtime.
		const dirMt = mtimeMs(dir);
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable: leave it
		}
		for (const entry of entries) {
			if (!entry.isFile() || !LOG_NAME.test(entry.name)) continue; // symlinks and foreign files stay
			const path = join(dir, entry.name);
			if (keep.has(path)) continue;
			const mt = mtimeMs(path);
			if (mt !== undefined && mt < cutoff) {
				try {
					unlinkSync(path);
				} catch {
					// housekeeping is best-effort: one unreadable file never fails session start
				}
			}
		}
		// No live owner (the marker missing, malformed, or naming a dead pid): drop it so the directory can empty and be removed.
		try {
			unlinkSync(join(dir, OWNER_FILE));
		} catch {
			// already gone, or not removable: leave it
		}
		if (dirMt !== undefined && dirMt < cutoff) {
			try {
				rmdirSync(dir);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error;
			}
		}
	}
}
