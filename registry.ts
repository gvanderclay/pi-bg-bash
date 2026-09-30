// The task registry, kept on `globalThis` because Pi loads extensions with
// `moduleCache: false`: module state does not survive `/reload`, this does.
// It also holds the one 2 s poller and the current `pi` and context, which
// each load refreshes.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { killGroup } from "./kill.ts";
import { sessionLogDir } from "./launch.ts";
import { locateMarker, type Marker } from "./logview.ts";
import { sendCompletion } from "./notify.ts";
import { processPort } from "./port.ts";

const KEY = Symbol.for("pi-bg-bash.registry");
/** How often the poller looks at running tasks. */
export const POLL_MS = 2000;
/** Failed log reads in a row, with the pid dead, after which the exit is called unknown. */
const READ_FAILURES_LIMIT = 5;

/** `killed` carries a `reason`; the rest end by themselves. */
export type TaskState = "running" | "exited" | "exit-unknown" | "killed";

/**
 * Why the registry killed a task. A kill takes the wrapper down with the group, so
 * no marker is written: the registry records the reason itself, and the log's
 * marker stays digits-only. Session end and Pi-gone kills (ticket 04) and the
 * log-limit kill (ticket 07) add their reasons here.
 */
export type KillReason = "killed by agent" | "killed by user" | "timed out";

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
};

/** The one registry of this Pi process. */
export function getRegistry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (holder[KEY] ??= { tasks: new Map(), nextId: 1 });
}

/** A fresh load: use this `pi` and context from now on, and replace the poller. */
export function attach(pi: ExtensionAPI): void {
	const registry = getRegistry();
	registry.pi = pi;
	stopPoller(registry);
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

/** Start `command` as a registered background task under `ctx`'s session. */
export async function startTask(command: string, ctx: ExtensionContext, options: { timeout?: number } = {}): Promise<Task> {
	const registry = getRegistry();
	registry.ctx = ctx;
	const sessionId = ctx.sessionManager.getSessionId();
	const dir = sessionLogDir(sessionId);
	// Ids restart per process but logs belong to the session: skip any id an earlier run of it used.
	let id: string;
	do id = `bg-${registry.nextId++}`;
	while (existsSync(join(dir, `${id}.log`)) || existsSync(join(dir, `${id}.log.gz`)));
	const logPath = join(dir, `${id}.log`);
	const nonce = randomBytes(8).toString("hex");
	const pid = await processPort().launch({ command, cwd: ctx.cwd, logPath, nonce, sessionEnv: sessionEnv(ctx) });
	const startedAt = Date.now();
	const task: Task = {
		id,
		command,
		cwd: ctx.cwd,
		logPath,
		pid,
		nonce,
		scanFrom: 0,
		startedAt,
		deadline: options.timeout !== undefined && options.timeout > 0 ? startedAt + options.timeout * 1000 : undefined,
		state: "running",
		readPosition: 0,
		notified: false,
		readFailures: 0,
	};
	registry.tasks.set(id, task);
	updateFooter(registry);
	startPollerIfNeeded(registry);
	return task;
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

function stopPoller(registry: Registry): void {
	if (registry.poller !== undefined) clearInterval(registry.poller);
	registry.poller = undefined;
}

function startPollerIfNeeded(registry: Registry): void {
	if (registry.poller !== undefined || !hasPending(registry)) return;
	registry.poller = setInterval(() => poll(registry), POLL_MS);
	registry.poller.unref();
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
	updateFooter(registry);
}

/** One task's tick: settle it, enforce its deadline, then report it if it ended and is unreported. */
function pollTask(registry: Registry, task: Task): void {
	if (task.killing !== undefined) return; // the kill reports it
	refresh(registry, task);
	if (task.state === "running") {
		if (task.deadline !== undefined && Date.now() >= task.deadline) {
			killTask(task, "timed out", { notify: true }).catch(() => {}); // still running: the next tick asks again
		}
		return;
	}
	notifyOnce(registry, task);
}

/**
 * Stop a task's process group and record why. Resolves `finished` when the task had
 * already ended (a marker the poller had not yet seen counts), `gone` when its group
 * was already gone with no marker, `killed` once it is gone, `stuck` when it
 * survived SIGKILL. With `notify` false (the agent
 * asked, so it knows) no completion message is sent; otherwise the normal one is,
 * once the group is gone.
 */
export async function killTask(task: Task, reason: KillReason, options: { notify: boolean }): Promise<"finished" | "gone" | "killed" | "stuck"> {
	const registry = getRegistry();
	if (task.killing === undefined) {
		refresh(registry, task);
		if (task.state !== "running") {
			if (!options.notify) task.notified = true;
			return "finished";
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

async function stopGroup(registry: Registry, task: Task, reason: KillReason, notify: boolean): Promise<"killed" | "gone" | "stuck"> {
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

/** One poller tick. A failure in one task never stops the others or the timer. */
function poll(registry: Registry): void {
	for (const task of registry.tasks.values()) {
		try {
			pollTask(registry, task);
		} catch {
			// try again next tick
		}
	}
	if (!hasPending(registry)) stopPoller(registry);
}

/** Report the task's end once: the flag is set before the send, and reset when the send throws so a later tick retries. */
function notifyOnce(registry: Registry, task: Task): void {
	if (task.notified || registry.pi === undefined) return;
	task.notified = true;
	try {
		sendCompletion(registry.pi, task);
	} catch (error) {
		task.notified = false;
		throw error;
	}
}
