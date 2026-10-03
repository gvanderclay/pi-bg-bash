// Opt-in diagnostics. With `PI_BG_BASH_DEBUG=1` the extension appends JSON Lines
// to `<state root>/debug.log`: errors it would otherwise swallow, and the
// events of a task's life. Nothing here may throw or change behaviour: a failed
// write is dropped. The variable is read on every call.
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { stateRoot } from "./launch.ts";
import { oneLine } from "./notify.ts";
import type { Task } from "./registry.ts";

/** The log is rotated at session start once it is larger than this. */
const ROTATE_ABOVE_BYTES = 5 * 1024 * 1024;
/** Gzipped generations kept: `debug.log.1.gz` (newest) to `debug.log.5.gz`. */
const GENERATIONS = 5;

export function debugOn(): boolean {
	return process.env.PI_BG_BASH_DEBUG === "1";
}

function debugPath(): string {
	return join(stateRoot(), "debug.log");
}

/** Append one JSON line `{t, event, ...fields}`; a `command` field is shown on one line. Never throws. */
export function debug(event: string, fields: Record<string, unknown> = {}): void {
	if (!debugOn()) return;
	try {
		const line: Record<string, unknown> = { t: new Date().toISOString(), event, ...fields };
		if (typeof line.command === "string") line.command = oneLine(line.command);
		mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
		appendFileSync(debugPath(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
	} catch {
		// a failed debug write is itself dropped
	}
}

/** Log an error the code is about to swallow (or downgrade), tagged with where it happened. */
export function debugError(where: string, error: unknown, fields: Record<string, unknown> = {}): void {
	const e = error as { message?: unknown; code?: unknown; stack?: unknown } | null | undefined;
	debug("error", {
		where,
		...fields,
		error: typeof e?.message === "string" ? e.message : String(error),
		code: e?.code,
		stack: e?.stack,
	});
}

/** The fields that identify a task in a log line. */
export function taskFields(task: Task): Record<string, unknown> {
	return {
		task: task.id,
		session: basename(dirname(task.logPath)),
		pid: task.pid,
		command: task.command,
	};
}

/** The fields that say how a task ended. */
export function exitFields(task: Task): Record<string, unknown> {
	return { ...taskFields(task), state: task.state, exitCode: task.exitCode, reason: task.reason };
}

const generation = (n: number): string => `${debugPath()}.${n}.gz`;

/**
 * At session start: when `debug.log` is over 5 MiB, shift the gzipped
 * generations up (dropping the oldest) and gzip it into `debug.log.1.gz`. The
 * first step renames it to a name only this process uses, so of two processes
 * starting at once only one rotates. Never throws.
 */
export function rotateDebugLog(): void {
	if (!debugOn()) return;
	try {
		const log = debugPath();
		if (!existsSync(log) || statSync(log).size <= ROTATE_ABOVE_BYTES) return;
		const claimed = join(dirname(log), `debug.log.${process.pid}.${Date.now()}.rotating`);
		try {
			renameSync(log, claimed);
		} catch {
			return; // another process claimed it first
		}
		if (existsSync(generation(GENERATIONS))) unlinkSync(generation(GENERATIONS));
		for (let n = GENERATIONS - 1; n >= 1; n--) {
			if (existsSync(generation(n))) renameSync(generation(n), generation(n + 1));
		}
		writeFileSync(generation(1), gzipSync(readFileSync(claimed)), { mode: 0o600 });
		unlinkSync(claimed);
		debug("rotate", { generations: GENERATIONS });
	} catch (error) {
		debugError("rotate", error);
	}
}
