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
import { rmSync } from "node:fs";

import {
	type BashOperations,
	createBashToolDefinition,
	type ExtensionContext,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import { debug, debugError, taskFields } from "./debug.ts";
import { killGroupNow } from "./kill.ts";
import { resolveShell, SESSION_ENV_KEYS } from "./launch.ts";
import { markerNeedle, openView, type View } from "./logview.ts";
import { processPort } from "./port.ts";
import { adopt, forgetGroup, getRegistry, launchGroup, makeTask, release, reserve, type Task } from "./registry.ts";
import { sanitize } from "./sanitize.ts";

/** How long a foreground command may run before it becomes a background task. */
export const PROMOTE_MS = 120_000;
/** How long before the hint below the editor teaches the shortcut. */
const HINT_MS = 2000;
/** The hint widget's key and text; cleared when the call ends or is promoted. */
const HINT_KEY = "pi-bg-bash-hint";
const HINT_TEXT = "(ctrl+shift+b to background)";
/** How often the log is read for new output and the marker. */
const LOG_POLL_MS = 50;
/** How long the log must stay idle after the exit marker before the call ends, so a late child's output is kept. */
const LATE_GRACE_MS = 100;
/** Pi's longest `timeout`, in milliseconds (`MAX_TIMEOUT_MS` in its bash tool). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** A foreground call in flight: what a trigger needs to see it and to promote it. */
export type ForegroundRun = {
	command: string;
	/** When the command started, in `Date.now()` terms. */
	startedAt: number;
	/** Turn the command into a background task and end the call. Does nothing once the call is over. `by` is only for the debug log. */
	promote(by?: "timer" | "shortcut"): void;
};

/** The foreground calls running now, not yet promoted or ended. Kept in the registry so a reloaded copy of this module sees them. */
export function foregroundRuns(): ReadonlySet<ForegroundRun> {
	return getRegistry().foreground;
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
				pid = await launchGroup({ command, cwd, logPath, nonce, shell, sessionEnv });
			} catch (error) {
				debugError("foreground-launch", error, { command });
				release(reservation);
				throw error;
			}
			const startedAt = Date.now();
			const task = makeTask(reservation, { command, cwd, pid, startedAt });
			let position = 0;
			/** Feed everything new in the log (the marker cut out) to `onData`; the marker's exit code once it has appeared. */
			const pump = (last = false): { code: number } | undefined => {
				let view: View;
				try {
					view = openView(task);
				} catch (error) {
					debugError("foreground-view", error, taskFields(task));
					return undefined; // a log that cannot be read yields no output and no marker now
				}
				try {
					if (view.size > position) {
						const data = view.read(position, view.size);
						const keep = view.marker === undefined ? heldBack(data, nonce, last) : 0;
						if (data.length > keep) onData(data.subarray(0, data.length - keep));
						position += data.length - keep;
					}
					return view.marker === undefined ? undefined : { code: view.marker.code };
				} finally {
					view.close();
				}
			};
			return new Promise((resolve, reject) => {
				let done = false;
				const handle: ForegroundRun = { command, startedAt, promote };
				let timer: ReturnType<typeof setTimeout> | undefined;
				let promoteTimer: ReturnType<typeof setTimeout> | undefined;
				let lateTimer: ReturnType<typeof setTimeout> | undefined;
				let hintTimer: ReturnType<typeof setTimeout> | undefined;
				let hintShown = false;
				let exitCode: number | null = null;
				const poll: ReturnType<typeof setInterval> = setInterval(check, LOG_POLL_MS);
				/** Drop the hint now: cancel its timer and clear a shown widget, without letting a stale context's UI getters escape. */
				const clearHint = () => {
					clearTimeout(hintTimer);
					hintTimer = undefined;
					if (!hintShown) return;
					hintShown = false;
					try {
						if (ctx.hasUI) ctx.ui.setWidget(HINT_KEY, undefined);
					} catch (error) {
						debugError("hint-clear", error);
						// the context went stale (session replaced or reloaded); the widget is gone with it
					}
				};
				const finish = (settle: () => void) => {
					if (done) return;
					done = true;
					clearInterval(poll);
					clearTimeout(timer);
					clearTimeout(promoteTimer);
					clearTimeout(lateTimer);
					clearHint();
					getRegistry().foreground.delete(handle);
					signal?.removeEventListener("abort", onAbort);
					settle();
				};
				/** The command is over: drop its log, give its id back, and settle. */
				const ended = (settle: () => void) =>
					finish(() => {
						forgetGroup(pid);
						rmSync(logPath, { force: true });
						release(reservation);
						settle();
					});
				function check() {
					if (done) return;
					try {
						// Liveness first: the wrapper writes the marker before it exits.
						const alive = port.pidAlive(pid);
						const before = position;
						const exit = pump();
						if (exit !== undefined) {
							// The command ended; keep reading for a late background child's last
							// writes until the log has been idle (Pi's bash does the same for
							// inherited pipes, resetting the grace on new output). The hint is
							// gone the moment the marker is seen, so a fast command never flashes
							// it during the grace, and a shown one is cleared at once.
							exitCode = exit.code;
							clearHint();
							if (position > before || lateTimer === undefined) {
								clearTimeout(lateTimer);
								lateTimer = setTimeout(() => ended(() => resolve({ exitCode })), LATE_GRACE_MS);
							}
						} else if (!alive) {
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
						forgetGroup(pid);
						killGroupNow(pid).then(
							() => {
								try {
									pump(true);
								} catch (error) {
									debugError("foreground-stop-pump", error, taskFields(task));
									// the log is gone: nothing more to show
								}
								rmSync(logPath, { force: true });
								release(reservation);
								reject(error);
							},
							(killError) => {
								debugError("foreground-stop-kill", killError, taskFields(task));
								reject(killError);
							},
						);
					});
				};
				function onAbort() {
					stop(new Error("aborted"));
				}
				/** The one promotion path: register the live process as a task and end `exec` so the delegate returns. */
				function promote(by: "timer" | "shortcut" = "shortcut") {
					if (done) return;
					check(); // a command that just ended ends normally
					if (done || exitCode !== null) return;
					debug("promote", { ...taskFields(task), by, elapsedMs: Date.now() - startedAt });
					finish(() => {
						pump(true);
						// The call shows the output up to here; `bash_output` goes on after it.
						task.readPosition = position;
						run.elapsedMs = Date.now() - startedAt;
						run.task = adopt(task);
						resolve({ exitCode: 0 });
					});
				}
				getRegistry().foreground.add(handle);
				if (timeout !== undefined) timer = setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeout * 1000);
				if (promotable(command, timeout)) promoteTimer = setTimeout(() => promote("timer"), promoteMs());
				if (ctx.hasUI)
					hintTimer = setTimeout(() => {
						try {
							if (!ctx.hasUI) return;
							hintShown = true;
							ctx.ui.setWidget(HINT_KEY, [HINT_TEXT], { placement: "belowEditor" });
						} catch (error) {
							debugError("hint-show", error);
							// the context went stale before the hint fired; no widget, and the run still ends
						}
					}, HINT_MS);
				// An abort that came while the process was being spawned is still an abort.
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	} satisfies BashOperations;
}

/** Pi's "Full output: <temp file>" footer names a file that stops growing at promotion; point at the task's log instead, noting that gzip renames it on completion. */
function retarget(text: string, piFile: string, task: Task): string {
	return text.replace(
		`Full output: ${piFile}]`,
		`Full output so far: ${task.logPath}; it is gzipped to ${task.logPath}.gz once the task ends. bash_output ${task.id} continues after this.]`,
	);
}

/** The text a promoted call answers with. */
function promotedText(task: Task, elapsedMs: number, output: string): string {
	return (
		`Command still running after ${Math.round(elapsedMs / 100) / 10} s; moved to the background as task ${task.id}. ` +
		"Its completion is reported automatically.\n\n" +
		`Output so far:\n${output === "(no output)" ? "" : output}`
	);
}

/** Run a foreground call: Pi's `bash` over the wrapper, promoted to a task when it outlasts the threshold. */
export async function runForeground(
	toolCallId: string,
	params: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[3],
	ctx: ExtensionToolContext,
) {
	const run: Run = { task: undefined, elapsedMs: 0 };
	const delegate = createBashToolDefinition(ctx.cwd, { operations: operations(ctx, run) });
	let result: Awaited<ReturnType<typeof delegate.execute>>;
	try {
		result = await delegate.execute(toolCallId, params, signal, onUpdate, ctx);
	} catch (error) {
		// Pi's bash throws its output with the status (aborted, timed out, no exit code).
		if (error instanceof Error) error.message = sanitize(error.message);
		throw error;
	}
	// Pi's bash hands the agent the output as the command wrote it; strip it as Pi does
	// for the user's `!` commands. Its own temp file and the task's log stay raw.
	result = {
		...result,
		content: result.content.map((part) => (part.type === "text" ? { ...part, text: sanitize(part.text) } : part)),
	};
	// The full output programmatic callers (codemode scripts) receive.
	const structured = (result as { structuredContent?: { output?: unknown } }).structuredContent;
	if (typeof structured?.output === "string")
		result = { ...result, structuredContent: { ...structured, output: sanitize(structured.output) } } as typeof result;
	if (run.task === undefined) return result;
	let output = result.content[0]?.type === "text" ? result.content[0].text : "";
	const piFile = result.details?.fullOutputPath;
	if (piFile !== undefined) {
		output = retarget(output, piFile, run.task);
		rmSync(piFile, { force: true }); // frozen at promotion; the task's log is the live copy
	}
	return {
		content: [{ type: "text" as const, text: promotedText(run.task, run.elapsedMs, output) }],
		details: undefined,
	};
}
