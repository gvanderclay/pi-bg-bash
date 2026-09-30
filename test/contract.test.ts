// Contract tier: the real process port with real, short `sh` commands on real
// time. No mock timers. It covers what only a real process shows: quoting,
// Pi's shell and environment, the exit marker and its nonce, the group kill and
// the errno mapping, and spawn failures. The poller's 2 s tick is not waited on:
// these tests read state through `bash_output` and `bash_kill`, which look at the
// log and the process themselves.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { launch } from "../launch.ts";
import { realPort } from "../port.ts";
import { getRegistry } from "../registry.ts";
import { agentDir, cleanup, logHas, logText, realSleep, resetRegistry, root, session, type Session, start, text, waitFor } from "./harness.ts";

// A short grace period, so a task that ignores SIGTERM takes well under a second to kill.
process.env.PI_BG_BASH_GRACE_MS = "300";

afterEach(resetRegistry);
after(cleanup);

const out = async (s: Session, id: string) => text(await s.toolCall("bash_output", { id }));
/** Wait until the task's exit marker is in the log. */
const ended = (s: Session, id: string) => waitFor(() => /__PI_BG_EXIT__:[0-9a-f]{16}:\d+\n$/.test(logText(s, id)), `${id}'s marker`);
/** Run a command to its end and return what `bash_output` reports. */
async function run(s: Session, command: string): Promise<string> {
	const id = await start(s, command);
	await ended(s, id);
	return out(s, id);
}
let files = 0;
const scratch = (name: string) => join(root, `${name}-${process.pid}-${++files}`);
const fileHas = async (path: string) => {
	await waitFor(() => existsSync(path) && readFileSync(path, "utf8").endsWith("\n"), path);
	return readFileSync(path, "utf8").trim();
};
const alive = (pid: number) => realPort.pidAlive(pid);
/** Pids whose command line matches `pgrep -f <pattern>`; [] when none. */
const pids = (pattern: string): number[] => {
	try {
		return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
};

describe("the wrapper", () => {
	it("runs a command with quotes, #, $ and a heredoc exactly as written", async () => {
		const result = await run(session(), `X=5
echo "it's $X" # not a comment
cat <<'EOF'
literal $HOME "q" 'r' # h
EOF`);
		assert.match(result, /^Task bg-1: exited \(code 0\)\.\nit's 5\nliteral \$HOME "q" 'r' # h$/);
	});

	it("reports the command's exit code", async () => {
		assert.match(await run(session(), "echo boom; exit 7"), /^Task bg-1: exited \(code 7\)\.\nboom$/);
	});

	it("returns a task id without waiting for the command", { timeout: 5000 }, async () => {
		const s = session();
		const gate = scratch("gate");
		const result = await s.toolCall("bash", { command: `while [ ! -f ${gate} ]; do sleep 0.02; done`, background: true });
		assert.match(text(result), /^Started background task bg-\d+\./);
		writeFileSync(gate, "");
	});

	it("runs the command in Pi's shell, so bash-only syntax works", async () => {
		assert.match(await run(session(), "diff <(echo a) <(echo a); echo rc=$?"), /rc=0$/);
	});

	it("gives the command Pi's shell environment", async () => {
		assert.match(await run(session(), 'echo "first=${PATH%%:*}"'), new RegExp(`first=${join(agentDir, "bin")}$`));
	});

	it("gives the command Pi's session variables from the context", async () => {
		const s = session();
		const result = await run(s, 'echo "$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL"');
		assert.match(result, new RegExp(`${s.id}\\|${join(root, "sessions", `${s.id}.jsonl`)}\\|test-provider\\|test-model\\|high$`));
	});

	it("drops inherited session variables the context lacks", async () => {
		process.env.PI_MODEL = "ambient-model";
		process.env.PI_PROVIDER = "ambient-provider";
		process.env.PI_SESSION_FILE = "/ambient/session.jsonl";
		try {
			const s = session();
			s.ctx.model = undefined;
			s.ctx.thinkingLevel = undefined;
			s.ctx.sessionManager.getSessionFile = () => undefined as never;
			const result = await run(s, 'echo "[${PI_PROVIDER-unset}|${PI_MODEL-unset}|${PI_REASONING_LEVEL-unset}|${PI_SESSION_FILE-unset}]"');
			assert.match(result, /\[unset\|unset\|unset\|unset\]$/);
		} finally {
			delete process.env.PI_MODEL;
			delete process.env.PI_PROVIDER;
			delete process.env.PI_SESSION_FILE;
		}
	});
});

describe("bash without background", () => {
	it("returns what Pi's built-in bash returns", async () => {
		const s = session();
		const params = { command: "printf 'a\\nb'; echo err >&2" };
		const ours = await s.toolCall("bash", params);
		const theirs = await createBashToolDefinition(root).execute("x", params, undefined, undefined, s.ctx as never);
		// `wall_time_seconds` is a rounded clock reading: it differs between two runs.
		const withoutClock = (r: unknown) => JSON.parse(JSON.stringify(r).replace(/"wall_time_seconds":[\d.]+/g, '"wall_time_seconds":0'));
		assert.deepEqual(withoutClock(ours), withoutClock(theirs));
	});
});

describe("a foreground command", () => {
	/** A command that records its pid in `pidFile`, then blocks until `gate` exists. */
	const blocked = (pidFile: string, gate: string, after = "echo finished") =>
		`echo $$ > ${pidFile}; echo started; while [ ! -f ${gate} ]; do sleep 0.02; done; ${after}`;
	const pidOf = async (pidFile: string) => Number(await fileHas(pidFile));

	it("past the threshold becomes a task: the same process runs on, detached from the turn, and is reported once", { timeout: 15000 }, async (t) => {
		// A short threshold for this test only: any other foreground call here must finish, not be promoted.
		process.env.PI_BG_BASH_PROMOTE_MS = "300";
		t.after(() => delete process.env.PI_BG_BASH_PROMOTE_MS);
		const s = session();
		const [pidFile, gate] = [scratch("pid"), scratch("gate")];
		const turn = new AbortController();
		const result = await s.toolCall("bash", { command: blocked(pidFile, gate) }, turn.signal);
		assert.match(text(result), /^Command still running after 0\.3 s; moved to the background as task bg-1\./);
		assert.match(text(result), /Output so far:\nstarted\n$/);
		const pid = await pidOf(pidFile);
		const task = getRegistry().tasks.get("bg-1")!;
		// The task is the wrapper the call launched, and the running command is its child: nothing restarted.
		assert.equal(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim(), String(task.pid));
		turn.abort(); // the turn ends: the task must not
		await realSleep(100);
		assert.equal(alive(pid), true);
		assert.equal(alive(task.pid), true);
		assert.match(text(await s.toolCall("bash_tasks", {})), /^bg-1 \| running/);
		writeFileSync(gate, "");
		await waitFor(() => s.sent.length > 0, "the completion message", 8000);
		assert.match(s.sent[0].message.content, /finished: exited \(code 0\).*\nLast output:\nstarted\nfinished$/s);
		await waitFor(() => !alive(pid), "the command's end");
	});

	it("keeps output a short-lived background child writes after the exit marker", async () => {
		const s = session();
		const result = await s.toolCall("bash", { command: "echo main; (sleep 0.02; echo late-stderr >&2) &" });
		assert.equal(text(result), "main\nlate-stderr\n");
	});

	it("that ends before the threshold returns the output and exit as Pi's bash does, and leaves no task or log", async () => {
		const s = session();
		const params = { command: "printf 'one\\ntwo\\n'; exit 4" };
		const ours = await s.toolCall("bash", params);
		const theirs = await createBashToolDefinition(root).execute("x", params, undefined, undefined, s.ctx as never);
		assert.equal(text(ours), text(theirs as never));
		assert.equal(ours.isError, true);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
		assert.equal(existsSync(s.logDir()) ? readdirSync(s.logDir()).length : 0, 0);
	});

	it("with an explicit timeout is killed at it, group and all, and never promoted", async () => {
		const s = session();
		const [pidFile, gate] = [scratch("pid"), scratch("gate")];
		const failure = await s.toolCall("bash", { command: blocked(pidFile, gate), timeout: 0.6 }).catch((e: Error) => e);
		assert.ok(failure instanceof Error);
		assert.match(failure.message, /started\n\n\nCommand timed out after 0\.6 seconds$/);
		await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))), "the command's end");
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("aborted by the turn before the threshold is killed", async () => {
		const s = session();
		const [pidFile, gate] = [scratch("pid"), scratch("gate")];
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: blocked(pidFile, gate) }, turn.signal).catch((e: Error) => e);
		const pid = await pidOf(pidFile);
		turn.abort();
		const failure = await call;
		assert.ok(failure instanceof Error);
		assert.match(failure.message, /Command aborted$/);
		await waitFor(() => !alive(pid), "the command's end");
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("killed by its own signal reads as Pi's bash reads it: no shell job notice, the same result", async () => {
		const s = session();
		const params = { command: "echo before; kill -9 $$" };
		const ours = await s.toolCall("bash", params);
		const theirs = await createBashToolDefinition(root).execute("x", params, undefined, undefined, s.ctx as never);
		assert.equal(text(ours), text(theirs as never));
		assert.equal(text(ours), "before\n\n\nCommand exited with code 137");
	});

	it("starting with sleep is never promoted", async () => {
		const s = session();
		const result = await s.toolCall("bash", { command: "sleep 0.8; echo woke" });
		assert.equal(text(result), "woke\n");
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("runs in Pi's shell and environment, as a background task does", async () => {
		const s = session();
		const result = await s.toolCall("bash", {
			command: 'echo "first=${PATH%%:*} session=$PI_SESSION_ID model=$PI_MODEL"; diff <(echo a) <(echo a) && echo same',
		});
		assert.equal(text(result), `first=${join(agentDir, "bin")} session=${s.id} model=test-model\nsame\n`);
	});
});

describe("the exit marker", () => {
	it("finds the marker when a backgrounded grandchild writes after it", async () => {
		const s = session();
		const id = await start(s, "(sleep 0.3; echo late) & echo main");
		await logHas(s, id, "late\n"); // the marker is now in the middle of the file
		const result = await out(s, id);
		assert.match(result, /^Task bg-1: exited \(code 0\)\.\nmain\nlate$/);
		assert.doesNotMatch(result, /__PI_BG_EXIT__/);
	});

	it("is not fooled by a task that prints a marker-looking line", async () => {
		const s = session();
		const gate = scratch("gate");
		const id = await start(s, `printf '\\n__PI_BG_EXIT__:abc:0\\n__PI_BG_EXIT__=0\\n'; while [ ! -f ${gate} ]; do sleep 0.02; done; exit 5`);
		await logHas(s, id, "=0\n");
		const running = await out(s, id);
		assert.match(running, /^Task bg-1: running\./);
		assert.match(running, /__PI_BG_EXIT__=0/); // the task's own lines stay output
		writeFileSync(gate, "");
		await ended(s, id);
		assert.match(await out(s, id), /^Task bg-1: exited \(code 5\)\./);
	});

	it("finds a marker that begins just past the first 64 KiB window", async () => {
		assert.match(await run(session(), "head -c 65550 /dev/zero | tr '\\000' x; exit 143"), /^Task bg-1: exited \(code 143\)\./);
	});
});

describe("a task that cannot start", () => {
	it("refuses a missing working directory and leaves no log", async () => {
		const s = session();
		s.ctx.cwd = join(root, "missing-dir");
		await assert.rejects(s.toolCall("bash", { command: "true", background: true }), /Working directory does not exist: .*missing-dir/);
		assert.deepEqual(existsSync(s.logDir()) ? readdirSync(s.logDir()) : [], []);
		assert.equal(getRegistry().tasks.size, 0);
	});

	it("reports a spawn error, removes the log, and raises no uncaught error", async () => {
		const s = session();
		const locked = join(root, "locked-dir");
		mkdirSync(locked);
		chmodSync(locked, 0o000);
		s.ctx.cwd = locked;
		try {
			await assert.rejects(s.toolCall("bash", { command: "true", background: true }), /EACCES|could not start/);
			await realSleep(50); // an uncaught 'error' event would surface by now
		} finally {
			chmodSync(locked, 0o700);
		}
		assert.deepEqual(existsSync(s.logDir()) ? readdirSync(s.logDir()) : [], []);
		assert.equal(getRegistry().tasks.size, 0);
	});

	it("creates the log 0600 in a 0700 directory", async () => {
		const s = session();
		const id = await start(s, "echo hi");
		await ended(s, id);
		assert.equal(statSync(join(s.logDir(), `${id}.log`)).mode & 0o777, 0o600);
		assert.equal(statSync(s.logDir()).mode & 0o777, 0o700);
	});

	it("writes a background command's stderr to its log and bash_output", async () => {
		const s = session();
		const id = await start(s, "echo oops-on-stderr >&2");
		await ended(s, id);
		assert.match(logText(s, id), /oops-on-stderr/);
		assert.match(await out(s, id), /oops-on-stderr/);
	});

	it("rejects with EEXIST when the log path exists, and leaves the old log intact", async () => {
		const logPath = scratch("existing.log");
		writeFileSync(logPath, "old run\n");
		await assert.rejects(launch({ command: "echo new", cwd: root, logPath, nonce: "abcd" }), { code: "EEXIST" });
		assert.equal(readFileSync(logPath, "utf8"), "old run\n");
	});
});

describe("the group kill", () => {
	it("bash_kill leaves neither the task nor its child alive", async () => {
		const s = session();
		const childFile = scratch("child");
		const id = await start(s, `sleep 60 & echo $! > ${childFile}; wait`);
		const child = Number(await fileHas(childFile));
		const pid = getRegistry().tasks.get(id)!.pid;
		assert.ok(alive(child) && alive(pid));
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} killed; its process group is gone.`);
		await waitFor(() => !alive(child), "the child's end");
		assert.equal(realPort.groupAlive(pid), false);
	});

	it("bash_kill sends SIGKILL to a task that traps SIGTERM", async () => {
		const s = session();
		const id = await start(s, "trap '' TERM; echo ready; while :; do sleep 0.05; done");
		await logHas(s, id, "ready");
		const pid = getRegistry().tasks.get(id)!.pid;
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} killed; its process group is gone.`);
		assert.equal(realPort.groupAlive(pid), false);
	});

	it("bash_kill reports a task that ended by itself as already finished", async () => {
		const s = session();
		const id = await start(s, "exit 0");
		await ended(s, id);
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} has already finished: exited (code 0).`);
	});
});

describe("the process port", () => {
	it("signals the whole group, not just its leader", async () => {
		const childFile = scratch("pchild");
		const pid = await realPort.launch({ command: `sleep 60 & echo $! > ${childFile}; wait`, cwd: root, logPath: scratch("p.log"), nonce: "n" });
		const child = Number(await fileHas(childFile));
		assert.equal(realPort.groupAlive(pid), true);
		assert.equal(realPort.signalGroup(pid, "SIGTERM"), true);
		await waitFor(() => !alive(child) && !realPort.groupAlive(pid), "the group's end");
	});

	it("counts a group with nothing left (ESRCH) as gone", async () => {
		const pid = await realPort.launch({ command: "exit 0", cwd: root, logPath: scratch("g.log"), nonce: "n" });
		await waitFor(() => !realPort.groupAlive(pid), "the group's end");
		assert.equal(realPort.signalGroup(pid, "SIGKILL"), false);
		await waitFor(() => !realPort.pidAlive(pid), "the leader's end");
	});

	it("counts a pid it may not signal (EPERM) as gone", { skip: process.getuid?.() === 0 }, () => {
		assert.throws(() => process.kill(1, 0), { code: "EPERM" }); // pid 1 belongs to root
		assert.equal(realPort.pidAlive(1), false);
	});

	it("counts a group of only zombies (EPERM on macOS) as gone", { skip: process.platform !== "darwin" }, () => {
		const child = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		const pid = child.pid!;
		// Keep the event loop from reaping the exited child, so it stays a zombie.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
		assert.throws(() => process.kill(-pid, 0), { code: "EPERM" }, "the precondition: macOS answers EPERM for it");
		assert.equal(realPort.groupAlive(pid), false);
		assert.equal(realPort.signalGroup(pid, "SIGKILL"), false);
	});
});

describe("session lifetime", () => {
	/** A stand-in for Pi: a process the test can kill; resolves once it is really gone. */
	function standIn() {
		const child = spawn("sleep", ["60"], { stdio: "ignore" });
		const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		return { pid: child.pid!, kill: () => child.kill("SIGKILL"), gone };
	}
	const nonce = "0123456789abcdef";

	it("a task dies when Pi's pid is gone, and its log ends with the Pi-gone marker", async () => {
		const pi = standIn();
		const childFile = scratch("gone-child");
		const logPath = scratch("gone.log");
		const pid = await realPort.launch({ command: `sleep 61 & echo $! > ${childFile}; wait`, cwd: root, logPath, nonce, piPid: pi.pid });
		try {
			const child = Number(await fileHas(childFile));
			assert.ok(alive(pid) && alive(child)); // the watch does not fire while Pi lives
			pi.kill();
			await pi.gone;
			await waitFor(() => !alive(child) && !realPort.groupAlive(pid), "the group's end after Pi's");
			assert.match(readFileSync(logPath, "utf8"), new RegExp(`\\n__PI_BG_GONE__:${nonce}\\n$`));
		} finally {
			pi.kill();
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("a task whose Pi is still alive keeps running past one watch period", async () => {
		// The one fixed wait in the suite: it proves the watch does not fire while Pi
		// lives (a watch that killed every group after 1 s would leave this task dead).
		const pi = standIn();
		const childFile = scratch("alive-child");
		const logPath = scratch("alive.log");
		const pid = await realPort.launch({ command: `sleep 68 & echo $! > ${childFile}; wait`, cwd: root, logPath, nonce, piPid: pi.pid });
		try {
			const child = Number(await fileHas(childFile));
			await realSleep(1500);
			assert.ok(alive(pid) && alive(child), "the watch must not fire while Pi lives");
			assert.doesNotMatch(readFileSync(logPath, "utf8"), /__PI_BG_GONE__/);
		} finally {
			pi.kill();
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("a child a command left behind still dies when Pi is gone, and the log ends with the GONE marker", async () => {
		// The watcher is its own process outside the task's group, so it survives the
		// wrapper and kills a leftover `server &` after Pi's death (spec Q34).
		const pi = standIn();
		const childFile = scratch("left-child");
		const logPath = scratch("left.log");
		const pid = await realPort.launch({ command: `sleep 62 & echo $! > ${childFile}`, cwd: root, logPath, nonce, piPid: pi.pid });
		try {
			const child = Number(await fileHas(childFile));
			await waitFor(() => !alive(pid), "the wrapper's end");
			assert.match(readFileSync(logPath, "utf8"), new RegExp(`__PI_BG_EXIT__:${nonce}:0\\n$`));
			pi.kill();
			await pi.gone;
			// The ~1 s watch period bounds this: a 4 s watch would leave the child alive past this wait.
			await waitFor(() => !alive(child) && !realPort.groupAlive(pid), "the child's end after Pi's", 3000);
			assert.match(readFileSync(logPath, "utf8"), new RegExp(`\\n__PI_BG_GONE__:${nonce}\\n$`));
		} finally {
			pi.kill();
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("gives the watcher the real process pid by default", async () => {
		const s = session();
		const id = await start(s, "sleep 69");
		const pid = getRegistry().tasks.get(id)!.pid;
		try {
			await waitFor(() => pids(`pi-bg-watch ${process.pid} ${pid} `).length > 0, "the task's watcher carrying the default Pi pid");
		} finally {
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("the watcher exits once its group has emptied", async () => {
		const logPath = scratch("w.log");
		// `sleep` keeps the group alive, so the watcher stays observable until the group is killed.
		const pid = await realPort.launch({ command: "sleep 69", cwd: root, logPath, nonce: "watchexit" });
		const pattern = `pi-bg-watch ${process.pid} ${pid} `;
		try {
			await waitFor(() => pids(pattern).length > 0, "the task's watcher", 3000);
			const wpid = pids(pattern)[0];
			assert.notEqual(wpid, undefined, "the watcher must be found while its group is alive");
			realPort.signalGroup(pid, "SIGKILL"); // empty the group; the watcher must leave on its own
			await waitFor(() => !alive(wpid), "the watcher's end", 3000);
		} finally {
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("session end kills every task's group, a foreground command in flight and what a finished task left", async () => {
		const s = session();
		const files = { task: scratch("q-task"), left: scratch("q-left"), fg: scratch("q-fg") };
		const running = await start(s, `sleep 63 & echo $! > ${files.task}; wait`);
		const finished = await start(s, `sleep 64 & echo $! > ${files.left}`);
		const foreground = s.toolCall("bash", { command: `sleep 65 & echo $! > ${files.fg}; wait` }).catch((error: Error) => error);
		const pids = await Promise.all(Object.values(files).map(async (file) => Number(await fileHas(file))));
		await ended(s, finished);
		const groups = [...getRegistry().tasks.values()].map((task) => task.pid);
		const runningPid = getRegistry().tasks.get(running)!.pid;
		assert.ok(pids.every(alive) && alive(runningPid));
		await s.shutdown("quit");
		await waitFor(() => pids.every((pid) => !alive(pid)), "every child's end");
		assert.equal(groups.some((pid) => realPort.groupAlive(pid)), false);
		await foreground;
	});

	it("a reload leaves a real task running", async () => {
		const s = session();
		const id = await start(s, "sleep 66");
		const pid = getRegistry().tasks.get(id)!.pid;
		await s.shutdown("reload");
		try {
			assert.equal(alive(pid), true);
		} finally {
			realPort.signalGroup(pid, "SIGKILL");
		}
	});

	it("bash_kill on a finished task stops the child it left, and says so", async () => {
		const s = session();
		const childFile = scratch("k-child");
		const id = await start(s, `sleep 67 & echo $! > ${childFile}`);
		const child = Number(await fileHas(childFile));
		await ended(s, id);
		await waitFor(() => !alive(getRegistry().tasks.get(id)!.pid), "the wrapper's end");
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} had already finished: exited (code 0); stopped the processes it left running.`);
		await waitFor(() => !alive(child), "the child's end");
	});

	it("bash_kill on a finished task with nothing left says it already finished: no watch process lingers", async () => {
		const s = session();
		const id = await start(s, "exit 0");
		await ended(s, id);
		await waitFor(() => !realPort.groupAlive(getRegistry().tasks.get(id)!.pid), "the group's end");
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} has already finished: exited (code 0).`);
	});
});
