// Behaviour tier: a foreground `bash` call over the fake process table and fake
// time. The call runs Pi's own `bash` over a custom `exec`, so a finished command
// reads as Pi's does; one still running at 120 s becomes a background task.
// The commands here are names no shell knows, so a red run never starts
// anything real.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import { foregroundRuns } from "../foreground.ts";
import { getRegistry } from "../registry.ts";
import { cleanup, fakeClock, fakeProcesses, type FakeProcesses, resetRegistry, restoreProcesses, root, session, text } from "./harness.ts";

let clock: ReturnType<typeof fakeClock>;
let procs: FakeProcesses;
beforeEach(() => {
	procs = fakeProcesses();
	clock = fakeClock();
});
afterEach(() => {
	clock.restore();
	resetRegistry();
	restoreProcesses();
});
after(cleanup);

/** Let the call get as far as launching, and return its fake process. */
async function launched(index = 0) {
	await clock.until(() => procs.all.length > index);
	return procs.all[index];
}

/** Run pending microtasks after a manual clock tick. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Wrap the mocked timer globals to track which timer and interval ids are still pending. */
function trackTimers() {
	const pending = new Set<unknown>();
	const originals = {
		setInterval: globalThis.setInterval,
		clearInterval: globalThis.clearInterval,
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
	};
	globalThis.setInterval = ((callback: (...args: never[]) => void, ms?: number) => {
		const id = originals.setInterval(callback as never, ms as never);
		pending.add(id);
		return id;
	}) as typeof setInterval;
	globalThis.setTimeout = ((callback: (...args: never[]) => void, ms?: number) => {
		const id = originals.setTimeout(callback as never, ms as never);
		pending.add(id);
		return id;
	}) as typeof setTimeout;
	globalThis.clearInterval = ((id: unknown) => {
		pending.delete(id);
		originals.clearInterval(id as never);
	}) as typeof clearInterval;
	globalThis.clearTimeout = ((id: unknown) => {
		pending.delete(id);
		originals.clearTimeout(id as never);
	}) as typeof clearTimeout;
	return {
		pending,
		restore: () => {
			globalThis.setInterval = originals.setInterval;
			globalThis.clearInterval = originals.clearInterval;
			globalThis.setTimeout = originals.setTimeout;
			globalThis.clearTimeout = originals.clearTimeout;
		},
	};
}

describe("a foreground bash call that finishes", () => {
	it("returns the command's output, as Pi's bash does", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("one\ntwo\n");
		proc.exit(0);
		const result = await clock.settle(call);
		assert.equal(text(result), "one\ntwo\n");
		assert.equal(result.isError, undefined);
		assert.equal(s.sent.length, 0);
	});

	it("reports a non-zero exit as an error result with the code", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("boom\n");
		proc.exit(7);
		const result = await clock.settle(call);
		assert.equal(text(result), "boom\n\n\nCommand exited with code 7");
		assert.equal(result.isError, true);
	});

	it("says (no output) for a silent command", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		(await launched()).exit(0);
		assert.equal(text(await clock.settle(call)), "(no output)");
	});

	it("runs in the session's working directory with Pi's session variables, and registers no task", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		assert.equal(proc.cwd, root);
		assert.equal(proc.sessionEnv?.PI_SESSION_ID, s.id);
		assert.equal(proc.sessionEnv?.PI_MODEL, "test-model");
		proc.exit(0);
		await clock.settle(call);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("leaves no log behind, and the next background task is still bg-1", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		(await launched()).exit(0);
		await clock.settle(call);
		const started = text(await s.toolCall("bash", { command: "other-build", background: true }));
		assert.match(started, /^Started background task bg-1\./);
	});

	it("does not mistake output that looks like a marker for the end", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("a\n__PI_BG_EXIT__:0000000000000000:5\nb\n");
		await clock.advance(200);
		proc.exit(0);
		assert.equal(text(await clock.settle(call)), "a\n__PI_BG_EXIT__:0000000000000000:5\nb\n");
	});
});

describe("a foreground bash call whose end arrives oddly", () => {
	it("waits for a marker written in two parts, and shows neither part", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("out\n");
		proc.write(`\n__PI_BG_EXIT__:${proc.nonce}:`);
		await clock.advance(200);
		proc.write("0\n");
		proc.die();
		assert.equal(text(await clock.settle(call)), "out\n");
	});

	it("keeps output a short-lived child writes after the exit marker", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("main\n");
		proc.exit(0);
		proc.write("late\n"); // a background child's last write, after the marker
		assert.equal(text(await clock.settle(call)), "main\nlate\n");
	});

	it("keeps output written after a poll has seen the marker", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("main\n");
		proc.exit(0);
		// Let one log poll see the marker and arm the grace, then write late.
		mock.timers.tick(50);
		await flush();
		proc.write("late\n");
		assert.equal(text(await clock.settle(call)), "main\nlate\n");
	});

	it("resets the grace on each new chunk, keeping them all", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build" }).finally(() => (settled = true));
		const proc = await launched();
		proc.write("start\n");
		proc.exit(0);
		for (let i = 1; i <= 3; i++) {
			mock.timers.tick(60);
			await flush();
			proc.write(`chunk${i}\n`);
		}
		// Still running 100 ms after the last chunk: each write reset the grace.
		mock.timers.tick(100);
		await flush();
		assert.equal(settled, false, "the call must not finish before the last chunk + 100 ms");
		assert.equal(text(await clock.settle(call)), "start\nchunk1\nchunk2\nchunk3\n");
	});

	it("finishes once the log has been idle for the full grace", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build" }).finally(() => (settled = true));
		const proc = await launched();
		proc.write("done\n");
		proc.exit(0);
		// The grace is armed by a poll; the call must not have finished yet.
		mock.timers.tick(50);
		await flush();
		assert.equal(settled, false);
		// 100 ms of idle log later it ends on its own.
		mock.timers.tick(100);
		await flush();
		assert.equal(settled, true);
		assert.equal(text(await clock.settle(call)), "done\n");
	});

	it("reports a process that vanished without a marker, keeping its last output", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("x\n");
		proc.die();
		const error = await clock.settle(call).catch((e: Error) => e);
		assert.ok(error instanceof Error);
		assert.equal(error.message, "x\n\n\nCommand terminated without an exit code");
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("gives the task id back when the launch fails, so the next task is bg-1", async () => {
		const s = session();
		procs.failNextLaunch = new Error("Working directory does not exist");
		const error = await clock.settle(s.toolCall("bash", { command: "slow-build" })).catch((e: Error) => e);
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Working directory does not exist");
		assert.match(text(await s.toolCall("bash", { command: "other-build", background: true })), /^Started background task bg-1\./);
	});

	it("aborts a turn that ended while the process was being spawned: killed, never promoted", async () => {
		const s = session();
		const turn = new AbortController();
		procs.duringLaunch = () => turn.abort();
		const error = await clock.settle(s.toolCall("bash", { command: "slow-build" }, turn.signal)).catch((e: Error) => e);
		assert.ok(error instanceof Error);
		assert.equal(error.message, "Command aborted");
		assert.deepEqual(procs.all[0].signals, ["SIGKILL"]);
		assert.equal(procs.all[0].groupAlive(), false);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	for (const [timeout, message] of [
		[0, "Invalid timeout: must be a finite number of seconds"],
		[-1, "Invalid timeout: must be a finite number of seconds"],
		[3_000_000, "Invalid timeout: maximum is 2147483.647 seconds"],
	] as const) {
		it(`rejects timeout ${timeout} as Pi's bash does, before starting anything`, async () => {
			const s = session();
			const error = await clock.settle(s.toolCall("bash", { command: "slow-build", timeout })).catch((e: Error) => e);
			assert.ok(error instanceof Error);
			assert.equal(error.message, message);
			assert.equal(procs.all.length, 0);
		});
	}
});

describe("a foreground bash call past 120 s", () => {
	it("returns the task id and the output so far, and the same process keeps running", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("compiling\n");
		const result = await clock.settle(call);
		assert.match(text(result), /^Command still running after 120 s; moved to the background as task bg-1\./);
		assert.match(text(result), /Its completion is reported automatically; do not sleep or poll to wait for it\./);
		assert.match(text(result), /Output so far:\ncompiling\n$/);
		assert.equal(result.isError, undefined);
		assert.equal(procs.all.length, 1);
		assert.deepEqual(proc.signals, []);
		assert.equal(proc.pidAlive(), true);
		const list = text(await s.toolCall("bash_tasks", {}));
		assert.match(list, /^bg-1 \| running \| 2m 0s \| slow-build$/);
		assert.equal(s.sent.length, 0);
	});

	it("is promoted no sooner than 120 s", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build" }).finally(() => (settled = true));
		await launched();
		await clock.advance(119_000);
		assert.equal(settled, false);
		await clock.settle(call);
	});

	it("sends one completion message when the promoted command exits, with its runtime from the start", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.settle(call);
		await clock.advance(30_000);
		proc.write("done\n");
		proc.exit(3);
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3);
		assert.equal(s.sent.length, 1);
		// The command ran 150 s; the poller notices it on its next 2 s tick.
		assert.match(
			s.sent[0].message.content,
			/^Background task bg-1 finished: exited \(code 3\), ran 2m 32s\.\nCommand: slow-build\nLast output:\ndone$/,
		);
		assert.deepEqual(s.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
	});

	it("shows the footer count once it is a task", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		await launched();
		await clock.settle(call);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: "bg: 1" });
	});

	it("survives an abort of the turn after the promotion", async () => {
		const s = session();
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: "slow-build" }, turn.signal);
		const proc = await launched();
		await clock.settle(call);
		turn.abort();
		await clock.advance(5000);
		assert.deepEqual(proc.signals, []);
		assert.equal(proc.groupAlive(), true);
		assert.match(text(await s.toolCall("bash_tasks", {})), /running/);
	});

	it("still ends with the command when it exits before the promotion", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(119_000);
		proc.write("late\n");
		proc.exit(0);
		assert.equal(text(await clock.settle(call)), "late\n");
		assert.equal(s.sent.length, 0);
	});

	it("hands the registered task the launch's pid, command, working directory and no deadline", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.settle(call);
		const task = [...getRegistry().tasks.values()][0];
		assert.equal(task.pid, proc.pid);
		assert.equal(task.command, "slow-build");
		assert.equal(task.cwd, root);
		assert.equal(task.deadline, undefined);
	});

	it("promotes a silent command with an empty output section", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		await launched();
		assert.match(text(await clock.settle(call)), /moved to the background as task bg-1\..*\n\nOutput so far:\n$/s);
	});

	it("promotes a command that merely starts like sleep, such as sleepy", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "sleepy 5" });
		await launched();
		assert.match(text(await clock.settle(call)), /moved to the background as task bg-1/);
	});

	it("leaves bash_output to continue after the output the call showed", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("line1\nline2\n");
		assert.match(text(await clock.settle(call)), /Output so far:\nline1\nline2\n$/);
		proc.write("line3\n");
		const later = text(await s.toolCall("bash_output", { id: "bg-1" }));
		assert.match(later, /line3/);
		assert.doesNotMatch(later, /line1|line2/);
	});

	it("answers a truncated output with the task's log, not Pi's frozen temp file", async () => {
		const tmp = join(root, "tmp-truncated");
		mkdirSync(tmp, { recursive: true });
		const before = process.env.TMPDIR;
		process.env.TMPDIR = tmp; // Pi keeps its full-output file under the temp dir
		try {
			const s = session();
			const call = s.toolCall("bash", { command: "slow-build" });
			const proc = await launched();
			proc.write(Array.from({ length: 5000 }, (_, i) => `row ${i + 1}\n`).join(""));
			const result = await clock.settle(call, 125_000);
			const task = getRegistry().tasks.get("bg-1")!;
			assert.match(text(result), /\[Showing lines 3001-5000 of 5000\. .*\]$/);
			assert.ok(text(result).includes(task.logPath), "points at the task's log");
			assert.match(text(result), /Full output so far: /);
			assert.doesNotMatch(text(result), /pi-bash-/);
			assert.equal(result.details, undefined);
			assert.deepEqual(readdirSync(tmp), [], "Pi's temp file is deleted");
			// bash_output continues after the last row shown.
			proc.write("row 5001\n");
			assert.doesNotMatch(text(await s.toolCall("bash_output", { id: "bg-1" })), /row 5000\n/);
		} finally {
			if (before === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = before;
		}
	});
});

describe("the active foreground runs", () => {
	it("lists a running call, promotes it on demand after its real elapsed time, and forgets it", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("so far\n");
		await clock.advance(7000);
		assert.deepEqual([...foregroundRuns()].map((run) => run.command), ["slow-build"]);
		[...foregroundRuns()][0].promote();
		const result = await clock.settle(call);
		assert.match(text(result), /^Command still running after 7 s; moved to the background as task bg-1\./);
		assert.match(text(result), /Output so far:\nso far\n$/);
		assert.equal(foregroundRuns().size, 0);
		assert.equal(proc.pidAlive(), true);
	});

	it("ends a call normally when it exited but was not polled yet as promotion fires", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("just done\n");
		proc.exit(0);
		[...foregroundRuns()][0].promote(); // before the next log poll sees the marker
		assert.equal(text(await clock.settle(call)), "just done\n");
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("forgets a call that ended or failed to launch", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		(await launched()).exit(0);
		await clock.settle(call);
		assert.equal(foregroundRuns().size, 0);
		procs.failNextLaunch = new Error("no shell");
		await clock.settle(s.toolCall("bash", { command: "other-build" })).catch(() => {});
		assert.equal(foregroundRuns().size, 0);
	});

	it("forgets the foreground call's group when it ends", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		(await launched()).exit(0);
		await clock.settle(call);
		assert.equal(getRegistry().groups.size, 0);
	});

	it("forgets the foreground call's group when the turn aborts", async () => {
		const s = session();
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: "slow-build" }, turn.signal).catch((error: Error) => error);
		await launched();
		turn.abort();
		await clock.settle(call);
		assert.equal(getRegistry().groups.size, 0);
	});
});

describe("timer cleanup", () => {
	it("leaves no interval or timer running after a normal end", async () => {
		const s = session();
		const track = trackTimers();
		try {
			const call = s.toolCall("bash", { command: "slow-build" });
			(await launched()).exit(0);
			await clock.settle(call);
			assert.equal(track.pending.size, 0, "no poll interval or timer may outlive the call");
		} finally {
			track.restore();
		}
	});

	it("clears its explicit timeout when the command ends first", async () => {
		const s = session();
		const track = trackTimers();
		try {
			const call = s.toolCall("bash", { command: "slow-build", timeout: 5 });
			(await launched()).exit(0);
			await clock.settle(call);
			assert.equal(track.pending.size, 0, "the explicit timeout must be cleared");
		} finally {
			track.restore();
		}
	});
});

describe("a foreground bash call that is not promoted", () => {
	it("is killed at its explicit timeout and never promoted", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build", timeout: 5 });
		const proc = await launched();
		proc.write("partial\n");
		const result = await clock.settle(call, 10_000).catch((error: Error) => error);
		assert.ok(result instanceof Error);
		assert.equal(result.message, "partial\n\n\nCommand timed out after 5 seconds");
		assert.deepEqual(proc.signals, ["SIGKILL"]);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("is not promoted at 120 s when its timeout is longer", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build", timeout: 300 }).finally(() => (settled = true));
		const proc = await launched();
		await clock.advance(200_000);
		assert.equal(settled, false);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
		proc.exit(0);
		await clock.settle(call);
	});

	it("is never promoted when the command starts with sleep", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "  sleep 500; echo up" }).finally(() => (settled = true));
		const proc = await launched();
		await clock.advance(400_000);
		assert.equal(settled, false);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
		proc.write("up\n");
		proc.exit(0);
		assert.equal(text(await clock.settle(call)), "up\n");
	});

	it("does treat a command that merely mentions sleep as promotable", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build && sleep 1" });
		await launched();
		assert.match(text(await clock.settle(call)), /moved to the background as task bg-1/);
	});

	it("kills the process group when the turn aborts, and reports the abort", async () => {
		const s = session();
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: "slow-build" }, turn.signal);
		const proc = await launched();
		proc.write("half\n");
		turn.abort();
		const error = await clock.settle(call, 10_000).catch((e: Error) => e);
		assert.ok(error instanceof Error);
		assert.equal(error.message, "half\n\n\nCommand aborted");
		assert.deepEqual(proc.signals, ["SIGKILL"]);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("rejects at once when the turn was aborted before the call", async () => {
		const s = session();
		const turn = new AbortController();
		turn.abort();
		const error = await clock.settle(s.toolCall("bash", { command: "slow-build" }, turn.signal)).catch((e: Error) => e);
		assert.ok(error instanceof Error);
		assert.match(error.message, /aborted/);
		assert.equal(procs.all.length, 0);
	});
});

describe("the bash description", () => {
	it("says a slow foreground command moves to the background after 120 s", () => {
		const tool = session().tool("bash");
		assert.ok(tool.description.startsWith(createBashToolDefinition(root).description));
		assert.match(tool.description, /still running after 120 s.*moves to the background/);
	});
});
