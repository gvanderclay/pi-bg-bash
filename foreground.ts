// A foreground `bash` call. Pi's own `bash` runs unchanged, over a custom
// `exec` (its `BashOperations`) that starts the command through the same
// detached wrapper background tasks use and feeds the log back through `onData`.
// A command still running after 120 s, with no explicit `timeout` and not
// starting with `sleep`, is promoted: the same live process becomes a registered
// task, and `exec` ends as if the command had finished, so the delegate closes
// its own output and returns what it has. The call then answers with that output
// and the task id. Nothing in the delegate is left pending or leaked, the turn's
// abort signal stops reaching the process, and no more output flows to the call.
// Every running call is in `foregroundRuns()` with a `promote` handle: that is
// the one promotion path, for the timer here and for any other trigger.
import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";

import { type BashOperations, createBashToolDefinition, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { killGroupNow } from "./kill.ts";
import { resolveShell, SESSION_ENV_KEYS } from "./launch.ts";
import { locateMarker, markerNeedle } from "./logview.ts";
import { processPort } from "./port.ts";
import { adopt, makeTask, release, reserve, type Task } from "./registry.ts";

/** How long a foreground command may run before it becomes a background task. */
const PROMOTE_MS = 120_000;
/** How often the log is read for new output and the marker. */
const LOG_POLL_MS = 50;
/** Pi's longest `timeout`, in milliseconds (`MAX_TIMEOUT_MS` in its bash tool). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** A foreground call in flight: what a trigger needs to see it and to promote it. */
export type ForegroundRun = {
	command: string;
	/** When the command started, in `Date.now()` terms. */
	startedAt: number;
	/** Turn the command into a background task and end the call. Does nothing once the call is over. */
	promote(): void;
};

const active = new Set<ForegroundRun>();

/** The foreground calls running now, not yet promoted or ended. */
export function foregroundRuns(): ReadonlySet<ForegroundRun> {
	return active;
}

/** Pi's `resolveTimeoutMs`: the same bounds and the same error text. */
function checkTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	if (timeout * 1000 > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
}

/** The promotion threshold; the contract test shortens it with `PI_BG_BASH_PROMOTE_MS`. */
function promoteMs(): number {
	const set = Number(process.env.PI_BG_BASH_PROMOTE_MS);
	return Number.isFinite(set) && set > 0 ? set : PROMOTE_MS;
}

/** Whether auto-promotion applies: no explicit timeout, and not a deliberate wait. */
function promotable(command: string, timeout: number | undefined): boolean {
	return timeout === undefined && !/^\s*sleep(\s|$)/.test(command);
}

/**
 * The bytes of `data` that cannot yet be told from the start of the exit marker: a
 * trailing partial `\n__PI_BG_EXIT__:<nonce>:<digits>`. A lone newline waits for the next
 * read while the command runs, but is output once no more is coming (`last`).
 */
function heldBack(data: Buffer, nonce: string, last: boolean): number {
	const needle = markerNeedle(nonce).toString("latin1");
	const from = data.lastIndexOf(0x0a);
	if (from < 0 || (last && from === data.length - 1)) return 0;
	const tail = data.toString("latin1", from);
	return needle.startsWith(tail) || tail.startsWith(needle) ? data.length - from : 0;
}

/** What a promotion leaves for the call's answer: the task and how long the command had run. */
type Run = { task: Task | undefined; elapsedMs: number };

/** The `exec` of one foreground call. `run.task` is set when the command was promoted. */
function operations(ctx: ExtensionContext, run: Run) {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			checkTimeout(timeout);
			if (signal?.aborted) throw new Error("aborted");
			const port = processPort();
			const reservation = reserve(ctx.sessionManager.getSessionId());
			const { logPath, nonce } = reservation;
			// Pi's environment as the delegate resolved it, PI_* variables included.
			const sessionEnv: Record<string, string> = {};
			for (const key of SESSION_ENV_KEYS) if (env?.[key] !== undefined) sessionEnv[key] = env[key];
			const shell = env === undefined ? undefined : { ...resolveShell(), env };
			let pid: number;
			try {
				pid = await port.launch({ command, cwd, logPath, nonce, shell, sessionEnv });
			} catch (error) {
				release(reservation);
				throw error;
			}
			const startedAt = Date.now();
			const task = makeTask(reservation, { command, cwd, pid, startedAt });
			let position = 0;
			/** Feed everything new in the log, up to the marker, to `onData`; the marker's exit code once it has appeared. */
			const pump = (last = false): { code: number } | undefined => {
				let marker;
				try {
					marker = locateMarker(task);
				} catch {
					marker = undefined;
				}
				const size = marker?.start ?? (() => { try { return statSync(logPath).size; } catch { return position; } })();
				if (size > position) {
					const data = Buffer.alloc(size - position);
					const fd = openSync(logPath, "r");
					try {
						readSync(fd, data, 0, data.length, position);
					} finally {
						closeSync(fd);
					}
					const keep = marker === undefined ? heldBack(data, nonce, last) : 0;
					if (data.length > keep) onData(data.subarray(0, data.length - keep));
					position += data.length - keep;
				}
				return marker === undefined ? undefined : { code: marker.code };
			};
			return new Promise((resolve, reject) => {
				let done = false;
				const handle: ForegroundRun = { command, startedAt, promote };
				let timer: ReturnType<typeof setTimeout> | undefined;
				let promoteTimer: ReturnType<typeof setTimeout> | undefined;
				const poll: ReturnType<typeof setInterval> = setInterval(check, LOG_POLL_MS);
				const finish = (settle: () => void) => {
					if (done) return;
					done = true;
					clearInterval(poll);
					clearTimeout(timer);
					clearTimeout(promoteTimer);
					active.delete(handle);
					signal?.removeEventListener("abort", onAbort);
					settle();
				};
				/** The command is over: drop its log, give its id back, and settle. */
				const ended = (settle: () => void) =>
					finish(() => {
						rmSync(logPath, { force: true });
						release(reservation);
						settle();
					});
				function check() {
					if (done) return;
					try {
						// Liveness first: the wrapper writes the marker before it exits.
						const alive = port.pidAlive(pid);
						const exit = pump();
						if (exit !== undefined) ended(() => resolve({ exitCode: exit.code }));
						else if (!alive) {
							// Gone without a marker: whatever it wrote last is still output.
							const last = pump(true);
							ended(() => resolve({ exitCode: last?.code ?? null }));
						}
					} catch (error) {
						ended(() => reject(error));
					}
				}
				/** Stop the command's group at once, as Pi's own bash does, then settle with `error`. */
				const stop = (error: Error) => {
					if (done) return;
					finish(() => {
						killGroupNow(pid).then(
							() => {
								try {
									pump(true);
								} catch {
									// the log is gone: nothing more to show
								}
								rmSync(logPath, { force: true });
								release(reservation);
								reject(error);
							},
							(killError) => reject(killError),
						);
					});
				};
				function onAbort() {
					stop(new Error("aborted"));
				}
				/** The one promotion path: register the live process as a task and end `exec` so the delegate returns. */
				function promote() {
					if (done) return;
					check(); // a command that just ended ends normally
					if (done) return;
					finish(() => {
						pump(true);
						// The call shows the output up to here; `bash_output` goes on after it.
						task.readPosition = position;
						run.elapsedMs = Date.now() - startedAt;
						run.task = adopt(task);
						resolve({ exitCode: 0 });
					});
				}
				active.add(handle);
				if (timeout !== undefined) timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);
				if (promotable(command, timeout)) promoteTimer = setTimeout(promote, promoteMs());
				// An abort that came while the process was being spawned is still an abort.
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	} satisfies BashOperations;
}

/** Pi's "Full output: <temp file>" footer names a file that stops growing at promotion; point at the task's log instead. */
function retarget(text: string, piFile: string, task: Task): string {
	return text.replace(`Full output: ${piFile}]`, `Full output so far: ${task.logPath}. bash_output ${task.id} continues after this.]`);
}

/** The text a promoted call answers with. */
function promotedText(task: Task, elapsedMs: number, output: string): string {
	return (
		`Command still running after ${Math.round(elapsedMs / 100) / 10} s; moved to the background as task ${task.id}. ` +
		"Its completion is reported automatically; do not sleep or poll to wait for it.\n\n" +
		`Output so far:\n${output === "(no output)" ? "" : output}`
	);
}

/** Run a foreground call: Pi's `bash` over the wrapper, promoted to a task when it outlasts the threshold. */
export async function runForeground(
	toolCallId: string,
	params: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
	ctx: ExtensionContext,
) {
	const run: Run = { task: undefined, elapsedMs: 0 };
	const delegate = createBashToolDefinition(ctx.cwd, { operations: operations(ctx, run) });
	const result = await delegate.execute(toolCallId, params, signal, onUpdate, ctx);
	if (run.task === undefined) return result;
	let output = result.content[0]?.type === "text" ? result.content[0].text : "";
	const piFile = result.details?.fullOutputPath;
	if (piFile !== undefined) {
		output = retarget(output, piFile, run.task);
		rmSync(piFile, { force: true }); // frozen at promotion; the task's log is the live copy
	}
	return { content: [{ type: "text" as const, text: promotedText(run.task, run.elapsedMs, output) }], details: undefined };
}
