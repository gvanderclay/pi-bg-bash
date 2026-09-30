// Contract tier: the real process port with real, short `sh` commands on real
// time. No mock timers. It covers what only a real process shows: quoting,
// Pi's shell and environment, the exit marker and its nonce, the group kill and
// the errno mapping, and spawn failures. The poller's 2 s tick is not waited on:
// these tests read state through `bash_output` and `bash_kill`, which look at the
// log and the process themselves.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
