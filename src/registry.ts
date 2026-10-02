// The task registry, kept on `globalThis` because Pi loads extensions with
// `moduleCache: false`: module state does not survive `/reload`, this does.
// It holds the 2 s poller, the 250 ms log-limit check, and the current `pi` and
// context, which each load refreshes.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ForegroundRun } from "./foreground.ts";
import { killGroup, killGroupNow } from "./kill.ts";
import { type LaunchOptions, sessionLogDir } from "./launch.ts";
import { appendLimitMarker, gzipLog, overLogLimit } from "./logs.ts";
import { locateMarker, type Marker } from "./logview.ts";
import { sendCompletion } from "./notify.ts";
import { processPort } from "./port.ts";

const KEY = Symbol.for("pi-bg-bash.registry");
/** How often the poller looks at running tasks. */
export const POLL_MS = 2000;
/** How often the stat-only log-limit check runs: fast enough that a runaway writes little past the limit. */
const LOG_LIMIT_MS = 250;
/** Failed log reads in a row, with the pid dead, after which the exit is called unknown. */
const READ_FAILURES_LIMIT = 5;

/** `killed` carries a `reason`; the rest end by themselves. */
export type TaskState = "running" | "exited" | "exit-unknown" | "killed";

/**
 * Why the registry killed a task. A kill takes the wrapper down with the group, so
 * no marker is written: the registry records the reason itself, and the log's
 * marker stays digits-only.
 */
export type KillReason = "killed by agent" | "killed by user" | "timed out" | "log limit passed";

export type Task = {
	id: string;
	command: string;
	cwd: string;
	logPath: string;
	pid: number;
	/** Random per task; only the wrapper knows it, so only its marker line counts. */
	nonce: string;
	/** Where the marker was found, once it has been. */
	marker?: Marker;
	/** Where the poller wrote the log-limit marker, so the view can cut it out. */
	limitMarker?: { start: number; end: number };
	/** Where the next marker search starts in the log. */
	scanFrom: number;
	startedAt: number;
	endedAt?: number;
	state: TaskState;
	exitCode?: number;
	/** Set when `state` is `killed`. */
	reason?: KillReason;
	/** When the poller kills the task: `startedAt` plus the background call's `timeout`. */
	deadline?: number;
	/** The group kill in progress, so a second request joins it. */
	killing?: Promise<"killed" | "gone" | "stuck">;
	/** The kill of what an ended task left running, so a second request joins it. */
	clearing?: Promise<Leftovers>;
	/** Where `bash_output` will next read; the completion tail never moves it. */
	readPosition: number;
	notified: boolean;
	/** Consecutive polls that failed to read the log for a reason other than it being missing. */
	readFailures: number;
};

type Registry = {
	tasks: Map<string, Task>;
	nextId: number;
	pi?: ExtensionAPI;
	ctx?: ExtensionContext;
	poller?: ReturnType<typeof setInterval>;
	/** The fast log-limit check; separate from the poller so the limit barely overshoots. */
	limitTimer?: ReturnType<typeof setInterval>;
	/** Wrapper pids of every group launched here and not yet given up, for the session-end kill. */
	groups: Set<number>;
	/** Pids whose group the poller saw empty after the marker: never signal these again (the pid may be reused). */
	emptyGroups: Set<number>;
	/** One gate per spawn under way; it opens once the spawn's pid is in `groups`. */
	launching: Set<Promise<void>>;
	/** Foreground calls in flight. Here, not in `foreground.ts`, so a reloaded copy of it sees them. */
	foreground: Set<ForegroundRun>;
};

/** What became of the processes an ended task left in its group. */
export type Leftovers = "none" | "stopped" | "stuck";

/** The one registry of this Pi process. */
export function getRegistry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
	const registry = (holder[KEY] ??= {
		tasks: new Map(),
		nextId: 1,
		groups: new Set(),
		emptyGroups: new Set(),
		launching: new Set(),
		foreground: new Set(),
	});
	// A registry left by an older copy of the extension may lack later fields.
	registry.groups ??= new Set();
	registry.emptyGroups ??= new Set();
	registry.launching ??= new Set();
	registry.foreground ??= new Set();
	return registry;
}

/**
 * Start a task through the process port and remember its group for the session-end kill.
 * The gate lets `endSession` wait for a spawn under way and then kill it too.
 */
export async function launchGroup(options: LaunchOptions): Promise<number> {
	const registry = getRegistry();
	let open!: () => void;
	const gate = new Promise<void>((resolve) => (open = resolve));
	registry.launching.add(gate);
	try {
		const pid = await processPort().launch(options);
		registry.groups.add(pid);
		return pid;
	} finally {
		registry.launching.delete(gate);
		open();
	}
}

/** Stop remembering a group for the session-end kill: the foreground call it led ended (leftovers, if any, are no longer tracked, as with Pi's own bash). */
export function forgetGroup(pid: number): void {
	getRegistry().groups.delete(pid);
}

/**
 * The session is over (quit, new, resume, fork; not reload): kill the group of every task,
 * finished ones included since a `server &` outlives its command, and of every foreground
 * command in flight, after any spawn under way has resolved. The tasks are then forgotten:
 * they belonged to the session that ended, and their completion is never reported.
 */
export async function endSession(): Promise<void> {
	const registry = getRegistry();
	stopTimers(registry);
	while (registry.launching.size > 0) await Promise.all([...registry.launching]);
	const tasks = [...registry.tasks.values()];
	// No completion may leak into the next session from a kill still in flight
	// (a /bg pick or a deadline kill), so mark every task reported before clearing.
	for (const task of tasks) task.notified = true;
	const pids = new Set(
		[...registry.groups, ...tasks.map((task) => task.pid)].filter((pid) => !registry.emptyGroups.has(pid)),
	);
	registry.groups.clear();
	registry.emptyGroups.clear();
	registry.tasks.clear();
	updateFooter(registry);
	await Promise.allSettled([...pids].map((pid) => killGroup(pid)));
}

/** A fresh load: use this `pi` and context from now on, and replace the poller. */
export function attach(pi: ExtensionAPI): void {
	const registry = getRegistry();
	registry.pi = pi;
	stopTimers(registry);
	startPollerIfNeeded(registry);
}

/** The context the footer is drawn through. */
export function setContext(ctx: ExtensionContext): void {
	getRegistry().ctx = ctx;
}

export function runningCount(registry = getRegistry()): number {
	return [...registry.tasks.values()].filter((task) => task.state === "running").length;
}

/** Footer: `bg: N` while N > 0 tasks run, cleared at 0. A stale context must not break the caller. */
function updateFooter(registry: Registry): void {
	try {
		const running = runningCount(registry);
		registry.ctx?.ui.setStatus("bg", running > 0 ? `bg: ${running}` : undefined);
	} catch {
		// the context went stale (session replaced or reloaded); the next update redraws
	}
}

/** A log, id and nonce reserved for a command about to launch. */
export type Reservation = { id: string; logPath: string; nonce: string };

/** Reserve the next free task id and its log under `sessionId`. Ids restart per process but logs belong to the session: skip any id an earlier run of it used. */
export function reserve(sessionId: string): Reservation {
	const registry = getRegistry();
	const dir = sessionLogDir(sessionId);
	let id: string;
	do id = `bg-${registry.nextId++}`;
	while (existsSync(join(dir, `${id}.log`)) || existsSync(join(dir, `${id}.log.gz`)));
	return { id, logPath: join(dir, `${id}.log`), nonce: randomBytes(8).toString("hex") };
}

/** Give back the id of a reservation nothing came of, when it is the newest, so ids stay consecutive. */
export function release(reservation: Reservation): void {
	const registry = getRegistry();
	if (reservation.id === `bg-${registry.nextId - 1}`) registry.nextId--;
}

/** A running task for a launched process; `startedAt` is when it really began. Not registered yet: see `adopt`. */
export function makeTask(
	reservation: Reservation,
	launched: { command: string; cwd: string; pid: number; startedAt: number; timeout?: number },
): Task {
	const { id, logPath, nonce } = reservation;
	const { command, cwd, pid, startedAt } = launched;
	return {
		id,
		command,
		cwd,
		logPath,
		pid,
		nonce,
		scanFrom: 0,
		startedAt,
		deadline: launched.timeout !== undefined && launched.timeout > 0 ? startedAt + launched.timeout * 1000 : undefined,
		state: "running",
		readPosition: 0,
		notified: false,
		readFailures: 0,
	};
}

/** Register a running task: it shows in the footer and the list, and the poller reports its end. */
export function adopt(task: Task): Task {
	const registry = getRegistry();
	registry.tasks.set(task.id, task);
	updateFooter(registry);
	startPollerIfNeeded(registry);
	return task;
}

/** Start `command` as a registered background task under `ctx`'s session. */
export async function startTask(
	command: string,
	ctx: ExtensionContext,
	options: { timeout?: number } = {},
): Promise<Task> {
	getRegistry().ctx = ctx;
	const reservation = reserve(ctx.sessionManager.getSessionId());
	const { logPath, nonce } = reservation;
	const pid = await launchGroup({ command, cwd: ctx.cwd, logPath, nonce, sessionEnv: sessionEnv(ctx) });
	return adopt(makeTask(reservation, { command, cwd: ctx.cwd, pid, startedAt: Date.now(), timeout: options.timeout }));
}

/**
 * What Pi's `resolveSpawnContext` exports from the session, as far as `ctx`
 * reaches: id, session file, model provider and id, and the reasoning level.
 */
function sessionEnv(ctx: ExtensionContext): Record<string, string> {
	const env: Record<string, string> = { PI_SESSION_ID: ctx.sessionManager.getSessionId() };
	const file = ctx.sessionManager.getSessionFile();
	if (file) env.PI_SESSION_FILE = file;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function stopTimers(registry: Registry): void {
	if (registry.poller !== undefined) clearInterval(registry.poller);
	registry.poller = undefined;
	if (registry.limitTimer !== undefined) clearInterval(registry.limitTimer);
	registry.limitTimer = undefined;
}

function stopLimitTimer(registry: Registry): void {
	if (registry.limitTimer !== undefined) clearInterval(registry.limitTimer);
	registry.limitTimer = undefined;
}

function startPollerIfNeeded(registry: Registry): void {
	if (registry.poller === undefined && hasPending(registry)) {
		registry.poller = setInterval(() => poll(registry), POLL_MS);
		registry.poller.unref();
	}
	if (registry.limitTimer === undefined && runningCount(registry) > 0) {
		registry.limitTimer = setInterval(() => checkLogLimits(registry), LOG_LIMIT_MS);
		registry.limitTimer.unref();
	}
}

/** A stat-only check, faster than the poller, so a runaway is killed just past the limit instead of a whole tick past it. */
function checkLogLimits(registry: Registry): void {
	for (const task of registry.tasks.values()) {
		if (task.state !== "running" || task.killing !== undefined) continue;
		if (overLogLimit(task)) killForLogLimit(registry, task).catch(() => {});
	}
	if (runningCount(registry) === 0) stopLimitTimer(registry);
}

/** A task the poller still has work for: running, or ended and not yet reported. */
function hasPending(registry: Registry): boolean {
	return [...registry.tasks.values()].some((task) => task.state === "running" || !task.notified);
}

/** Settle a running task if its marker appeared or its pid is gone. Updates the footer; never reports. */
function refresh(registry: Registry, task: Task): void {
	if (task.state !== "running") return;
	// Liveness first: the wrapper writes the marker before it exits, so a
	// dead pid with no marker after this read really is an unknown exit.
	const alive = processPort().pidAlive(task.pid);
	let marker: Marker | undefined;
	let unreadable = false;
	try {
		marker = locateMarker(task);
		task.readFailures = 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			// A missing log means the exit can no longer be known. Any other failure may pass:
			// wait it out while the pid lives, and give up only after several in a row with it dead.
			task.readFailures++;
			if (alive || task.readFailures < READ_FAILURES_LIMIT) return;
		}
		unreadable = true;
	}
	if (marker === undefined && alive && !unreadable) return;
	task.endedAt = Date.now();
	task.state = marker === undefined ? "exit-unknown" : "exited";
	task.exitCode = marker?.code;
	// A group known empty can no longer hold the wrapper's pid: record it so a
	// later session-end kill or leftover kill never signals a pid the OS has reused. A
	// leftover group keeps the pid, so tasks with leftovers stay covered.
	if (marker !== undefined && !processPort().groupAlive(task.pid)) registry.emptyGroups.add(task.pid);
	updateFooter(registry);
}

/** One task's tick: settle it, enforce its deadline and the log limit, then report it if it ended and is unreported. */
function pollTask(registry: Registry, task: Task): void {
	if (task.killing !== undefined) return; // the kill reports it
	refresh(registry, task);
	if (task.state === "running") {
		if (overLogLimit(task)) {
			killForLogLimit(registry, task).catch(() => {}); // still running: the next tick asks again
			return;
		}
		if (task.deadline !== undefined && Date.now() >= task.deadline) {
			killTask(task, "timed out", { notify: true }).catch(() => {}); // still running: the next tick asks again
		}
		return;
	}
	notifyOnce(registry, task);
}

/**
 * Stop a task's process group and record why. Resolves `finished` when the task had
 * already ended and left nothing (a marker the poller had not yet seen counts),
 * `gone` when its group was already gone with no marker, `killed` once it is gone,
 * `stuck` when it survived SIGKILL, `cleared` when what an ended task left running
 * was stopped, and `leftover-stuck` when that survived SIGKILL. With `notify` false
 * (the agent asked, so it knows) no completion message is sent; otherwise the normal
 * one is, once the group is gone.
 */
export async function killTask(
	task: Task,
	reason: KillReason,
	options: { notify: boolean },
): Promise<"finished" | "gone" | "killed" | "stuck" | "cleared" | "leftover-stuck"> {
	const registry = getRegistry();
	if (task.killing === undefined) {
		refresh(registry, task);
		if (task.state !== "running") {
			if (!options.notify) task.notified = true;
			// An ended task's command may have left processes in its group.
			task.clearing ??= stopLeftovers(task).finally(() => {
				task.clearing = undefined;
			});
			const left = await task.clearing;
			return left === "none" ? "finished" : left === "stopped" ? "cleared" : "leftover-stuck";
		}
		const stopping = stopGroup(registry, task, reason, options.notify);
		task.killing = stopping;
		const clear = () => {
			task.killing = undefined;
		};
		stopping.then(clear, clear);
	}
	if (!options.notify) task.notified = true;
	return task.killing;
}

/** Stop what an ended task left in its process group. The task's own state is not touched: it did end when it says. */
async function stopLeftovers(task: Task): Promise<Leftovers> {
	// A group the poller already saw empty is skipped outright: its pid may have
	// been reused by an unrelated group, which must not be signalled.
	if (getRegistry().emptyGroups.has(task.pid) || !processPort().groupAlive(task.pid)) return "none";
	const how = await killGroup(task.pid);
	return how === "gone" ? "none" : how === "stopped" ? "stopped" : "stuck";
}

async function stopGroup(
	registry: Registry,
	task: Task,
	reason: KillReason,
	notify: boolean,
): Promise<"killed" | "gone" | "stuck"> {
	const how = await killGroup(task.pid);
	task.endedAt = Date.now();
	if (how === "gone") {
		task.state = "exit-unknown";
	} else {
		task.state = "killed";
		task.reason = reason;
	}
	updateFooter(registry);
	if (notify) {
		try {
			notifyOnce(registry, task);
		} catch {
			// a later tick retries the message
		}
	}
	return how === "stopped" ? "killed" : how;
}

/**
 * Stop a task whose log passed the size limit: kill the group at once (SIGKILL) so
 * the marker ends the log, write the `__PI_BG_LIMIT__` marker, record the reason,
 * and report it as `killed (log limit passed)`. If the command wrote its own exit
 * marker while the kill was in flight, it is reported as `exited` with that code
 * instead. The kill is remembered on `task.killing` so later ticks do not start a
 * second one.
 */
async function killForLogLimit(registry: Registry, task: Task): Promise<"killed" | "gone" | "stuck"> {
	const stopping = (async () => {
		const how = await killGroupNow(task.pid);
		// Kill first, so whatever the command writes while dying stays before the marker.
		try {
			appendLimitMarker(task);
		} catch {
			// the marker could not be written (EACCES, ENOSPC); the reason must survive without it
		}
		task.endedAt = Date.now();
		// The command may have written its exit marker while the kill was in flight.
		let marker: Marker | undefined;
		try {
			marker = locateMarker(task);
		} catch {
			marker = undefined; // an unreadable log cannot supply one
		}
		if (marker !== undefined) {
			task.state = "exited";
			task.exitCode = marker.code;
		} else if (how === "gone") {
			task.state = "exit-unknown";
		} else {
			task.state = "killed";
			task.reason = "log limit passed";
		}
		// A group known empty must never be signalled again: the pid may be reused.
		if (how !== "stuck") registry.emptyGroups.add(task.pid);
		updateFooter(registry);
		try {
			notifyOnce(registry, task);
		} catch {
			// a later tick retries the message
		}
		return how === "gone" ? "gone" : how === "stuck" ? "stuck" : "killed";
	})();
	task.killing = stopping;
	const clear = () => {
		task.killing = undefined;
	};
	stopping.then(clear, clear);
	return stopping;
}

/** One poller tick. A failure in one task never stops the others or the timer. */
function poll(registry: Registry): void {
	for (const task of registry.tasks.values()) {
		try {
			pollTask(registry, task);
		} catch {
			// try again next tick
		}
	}
	if (!hasPending(registry)) stopTimers(registry);
}

/** Report the task's end once: the flag is set before the send, and reset when the send throws so a later tick retries. The log is gzipped only after the message really went out (Q21); a gzip failure leaves the plain log and must not resend the message. */
function notifyOnce(registry: Registry, task: Task): void {
	if (task.notified || registry.pi === undefined) return;
	task.notified = true;
	try {
		sendCompletion(registry.pi, task);
	} catch (error) {
		task.notified = false;
		throw error;
	}
	// Gzip only after the message is out (Q21). A group that is still alive (a
	// `stuck` group, or a child the command left) may still write to the log, so
	// leave it plain; the 7-day cleanup handles it.
	if (!processPort().groupAlive(task.pid)) void gzipLog(task).catch(() => {});
}
