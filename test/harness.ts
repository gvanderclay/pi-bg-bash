// The shared test harness: a temporary state directory, one fake Pi session
// that records tools, event handlers, sent messages and statuses, and the two
// tiers' tools. Behaviour tests run the extension over `fakeProcesses()` (a
// scripted process table behind the process port) and `fakeClock()` (mock
// timers); the logs stay real files. Contract tests use the real port on real
// time and never touch the clock. A test file uses one tier: fake time and real
// processes never meet.
import { appendFileSync, existsSync, mkdtempSync, openSync, closeSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";

import register from "../index.ts";
import type { LaunchOptions } from "../launch.ts";
import { processPort, realPort, setProcessPort, type ProcessPort } from "../port.ts";
import { getRegistry, POLL_MS } from "../registry.ts";

/** A throwaway root for this test file; `XDG_STATE_HOME` points inside it. */
export const root = mkdtempSync(join(tmpdir(), "pi-bg-bash-test-"));
export const stateHome = join(root, "state");
process.env.XDG_STATE_HOME = stateHome;
/** Pi's agent dir, so `<agent dir>/bin` is a known, test-owned directory. */
export const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
// Pi puts `<agent dir>/bin` first on PATH unless it is already there: keep it
// out of the ambient PATH so a test sees whether the extension added it.
process.env.PATH = (process.env.PATH ?? "")
	.split(":")
	.filter((entry) => entry !== join(agentDir, "bin"))
	.join(":");
export const cleanup = () => rmSync(root, { recursive: true, force: true });

/** One tool result, the shape `execute` returns. */
export type ToolResult = { content: { type: string; text: string }[]; details: unknown };
type Tool = {
	name: string;
	description: string;
	parameters: unknown;
	execute: (id: string, params: never, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};
type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void };
type Sent = { message: { customType: string; content: string; display?: boolean }; options: unknown };

let counter = 0;

/** One fake Pi session running the extension. */
export function session(options: { id?: string } = {}) {
	const id = options.id ?? `session-${process.pid}-${++counter}`;
	const tools: Record<string, Tool> = {};
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, Command> = {};
	const sent: Sent[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	/** What the user sees: `ui.select` prompts and `ui.notify` texts, and the script that answers `select`. */
	const dialogs = {
		selects: [] as { title: string; options: string[] }[],
		notices: [] as string[],
		answer: (_options: string[]) => undefined as string | undefined,
	};
	/** Switches for a stale context: `sendMessage` or `setStatus` throwing. */
	const faults = { failSend: false, failFooter: false, sendAttempts: 0 };
	const pi = {
		on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
		registerCommand: (name: string, command: Command) => {
			commands[name] = command;
		},
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		sendMessage: (message: Sent["message"], opts: unknown) => {
			faults.sendAttempts++;
			if (faults.failSend) throw new Error("Extension runtime not initialized");
			sent.push({ message, options: opts });
		},
	};
	const ctx = {
		cwd: root,
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" } as { provider: string; id: string } | undefined,
		thinkingLevel: "high" as string | undefined,
		sessionManager: { getSessionId: () => id, getSessionFile: () => join(root, "sessions", `${id}.jsonl`) },
		ui: {
			select: async (title: string, options: string[]) => {
				dialogs.selects.push({ title, options });
				return dialogs.answer(options);
			},
			notify: (message: string) => {
				dialogs.notices.push(message);
			},
			setStatus: (key: string, text: string | undefined) => {
				if (faults.failFooter) throw new Error("This extension ctx is stale");
				statuses.push({ key, text });
			},
		},
	};
	register(pi as never);
	let calls = 0;
	return {
		id,
		faults,
		dialogs,
		/** Run a slash command the way Pi does, with this session's context. */
		command: async (name: string, args = "") => commands[name].handler(args, ctx),
		hasCommand: (name: string) => name in commands,
		/** The context Pi passes to tools, for calling another tool the same way. */
		ctx,
		sent,
		statuses,
		/** One registered tool's definition. */
		tool: (name: string) => tools[name],
		/** Call a tool the way Pi does, with this session's context. */
		toolCall: (name: string, params: unknown): Promise<ToolResult> =>
			tools[name].execute(`call-${++calls}`, params as never, undefined, undefined, ctx),
		/** The session's log directory under the temporary state home. */
		logDir: () => join(stateHome, "pi-bg", id),
	};
}

const realSetTimeout = globalThis.setTimeout;
/** Real time, for contract tests only. */
export const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
/** Wait, in real time, until `done` holds: for a real event, never a fixed guess. */
export async function waitFor(done: () => boolean, what: string, ms = 5000): Promise<void> {
	for (let waited = 0; waited < ms && !done(); waited += 10) await realSleep(10);
	if (!done()) throw new Error(`${what} did not happen within ${ms} ms`);
}

// --- helpers shared by every test file ---

/** The id in "Started background task <id>." */
export const taskId = (text: string) => /task (bg-\d+)/.exec(text)?.[1] as string;
export const text = (r: { content: { text: string }[] }) => r.content[0].text;
export type Session = ReturnType<typeof session>;
/** Start a background command and return its id. */
export async function start(s: Session, command: string, extra: object = {}): Promise<string> {
	return taskId(text(await s.toolCall("bash", { command, background: true, ...extra })));
}
const logPath = (s: Session, id: string) => join(s.logDir(), `${id}.log`);
/** The task's log as it is on disk, marker included. */
export const logText = (s: Session, id: string) => readFileSync(logPath(s, id), "utf8");
/** Wait, in real time, until the task's log holds `needle` (contract tests). */
export const logHas = (s: Session, id: string, needle: string) =>
	waitFor(() => existsSync(logPath(s, id)) && logText(s, id).includes(needle), `log ${id} holding ${JSON.stringify(needle)}`);

// --- behaviour tier: fake processes and fake time ---

/** One task the fake process table runs. The test scripts what it does. */
export type FakeProc = {
	pid: number;
	command: string;
	cwd: string;
	logPath: string;
	nonce: string;
	sessionEnv: Record<string, string> | undefined;
	/** Every signal the group received (probes with signal 0 are not recorded). */
	signals: string[];
	/** The command traps SIGTERM: the wrapper dies of it, but the command lingers in the group. */
	ignoresTerm: boolean;
	/** Even SIGKILL leaves the group in place. */
	unkillable: boolean;
	/** Append output to the log. */
	write(data: string | Buffer): void;
	/** The command exits: the wrapper appends the marker with this task's nonce. `child` leaves a group member behind. */
	exit(code: number, options?: { child?: boolean }): void;
	/** The whole group vanishes with no marker (`kill -9`, a crash). */
	die(): void;
	/** A background child of the command is running in the group. */
	spawnChild(): void;
	/** Only zombies are left: the leader still exists but signalling the group answers EPERM. */
	zombie(): void;
	groupAlive(): boolean;
	pidAlive(): boolean;
};

/** The scripted process table behind the process port. Fake pids start at 1000. */
export type FakeProcesses = {
	/** The next pid `launch` hands out. */
	nextPid: number;
	/** The process a task runs as. */
	of(id: string): FakeProc;
	all: FakeProc[];
};

/** Install a fake process port; `restoreProcesses` puts the real one back. */
export function fakeProcesses(): FakeProcesses {
	const table = new Map<number, FakeProc>();
	const receivers = new Map<number, (signal: string) => void>();
	const fake: FakeProcesses = {
		nextPid: 1000,
		all: [],
		of: (id) => {
			const proc = table.get(getRegistry().tasks.get(id)!.pid);
			if (proc === undefined) throw new Error(`no fake process for ${id}`);
			return proc;
		},
	};
	const port: ProcessPort = {
		async launch(options: LaunchOptions) {
			// Exclusive, as the real launch: a log that exists belongs to an earlier run.
			closeSync(openSync(options.logPath, "wx", 0o600));
			let leader = true;
			let child = false;
			let zombie = false;
			const pid = fake.nextPid++;
			const proc: FakeProc = {
				pid,
				command: options.command,
				cwd: options.cwd,
				logPath: options.logPath,
				nonce: options.nonce,
				sessionEnv: options.sessionEnv,
				signals: [],
				ignoresTerm: false,
				unkillable: false,
				write: (data) => appendFileSync(options.logPath, data),
				exit(code, opts = {}) {
					appendFileSync(options.logPath, `\n__PI_BG_EXIT__:${options.nonce}:${code}\n`);
					leader = false;
					child = child || opts.child === true;
				},
				die() {
					leader = false;
					child = false;
				},
				spawnChild: () => {
					child = true;
				},
				zombie: () => {
					zombie = true;
				},
				groupAlive: () => !zombie && (leader || child),
				pidAlive: () => leader,
			};
			receivers.set(pid, (signal) => {
				proc.signals.push(signal);
				if (signal === "SIGTERM") {
					leader = false;
					child = proc.ignoresTerm;
				} else if (signal === "SIGKILL" && !proc.unkillable) {
					leader = false;
					child = false;
				}
			});
			table.set(pid, proc);
			fake.all.push(proc);
			return pid;
		},
		signalGroup(pid, signal) {
			const proc = table.get(pid);
			if (proc === undefined || !proc.groupAlive()) return false;
			receivers.get(pid)!(signal);
			return true;
		},
		groupAlive: (pid) => table.get(pid)?.groupAlive() ?? false,
		pidAlive: (pid) => table.get(pid)?.pidAlive() ?? false,
	};
	setProcessPort(port);
	return fake;
}

/** Put the real process port back. */
export function restoreProcesses(): void {
	setProcessPort(realPort);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Fake time: `setInterval`, `setTimeout` and `Date` are mocked, starting at the real
 * now so file ages compare with real mtimes. Nothing waits on a real event here.
 */
export function fakeClock() {
	if (processPort() === realPort) throw new Error("fakeClock() needs fakeProcesses() installed first: fake time must never meet a real process");
	mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
	/** Move the clock `ms` forward in 100 ms steps, letting timer-driven work run after each. */
	const advance = async (ms: number) => {
		for (let t = 0; t < ms; t += 100) {
			mock.timers.tick(100);
			await flush();
		}
	};
	return {
		advance,
		/** Run `count` poller ticks. */
		tick: (count = 1) => advance(count * POLL_MS),
		/** Advance until `done` holds; throws when it has not within `maxMs` of fake time. */
		until: async (done: () => boolean, maxMs = 120_000) => {
			for (let t = 0; t < maxMs && !done(); t += 100) await advance(100);
			if (!done()) throw new Error(`condition not reached in ${maxMs} ms of fake time`);
		},
		/** Advance until the call settles and return its result; a call that never settles fails the test. */
		settle: async <T>(call: Promise<T>, maxMs = 120_000): Promise<T> => {
			let state: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
			call.then(
				(value) => (state = { ok: true, value }),
				(error) => (state = { ok: false, error }),
			);
			for (let t = 0; t < maxMs && state === undefined; t += 100) await advance(100);
			if (state === undefined) throw new Error(`call did not settle in ${maxMs} ms of fake time`);
			if (!state.ok) throw state.error;
			return state.value;
		},
		restore: () => mock.timers.reset(),
	};
}

/** Forget every task and the poller between tests, signalling any group left. */
export function resetRegistry(): void {
	const registry = getRegistry();
	if (registry.poller !== undefined) clearInterval(registry.poller);
	registry.poller = undefined;
	// The port maps ESRCH and the macOS zombie-only-group EPERM to "gone".
	for (const task of registry.tasks.values()) processPort().signalGroup(task.pid, "SIGKILL");
	registry.tasks.clear();
	registry.nextId = 1;
	registry.ctx = undefined;
}
