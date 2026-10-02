// Behaviour tier: log housekeeping — gzip after the completion message, reading
// gzipped logs through `bash_output`, and the 7-day cleanup at session start.
// Fake processes and fake time; the logs are real files whose ages are set with
// `utimes`. The log-limit kill is a contract test (real `sh`, real time) in
// contract.test.ts.
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lutimesSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { ownerPid } from "../src/launch.ts";
import { openView } from "../src/logview.ts";
import { processPort, setProcessPort } from "../src/port.ts";
import { getRegistry, POLL_MS } from "../src/registry.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	gzipped,
	resetRegistry,
	restoreProcesses,
	type Session,
	session,
	start,
	stateHome,
	text,
} from "./harness.ts";

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

const DAY = 24 * 60 * 60 * 1000;
const gzPath = (s: Session, id: string) => join(s.logDir(), `${id}.log.gz`);
const plainPath = (s: Session, id: string) => join(s.logDir(), `${id}.log`);
const out = (s: Session, params: object) => s.toolCall("bash_output", params);

/** Set a path's access and modification times to `days` days ago. */
function aged(path: string, days: number): void {
	const then = new Date(Date.now() - days * DAY);
	utimesSync(path, then, then);
}

const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join("");
const lines = (t: string) => t.split("\n").filter((l) => /^\d+$/.test(l));
const seqLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

/** Run a task to its end: it writes `output`, exits with `code`, and the poller reports it (and gzips the log). */
async function finished(s: Session, output: string | Buffer, code = 0): Promise<string> {
	const id = await start(s, "job");
	procs.of(id).write(output);
	procs.of(id).exit(code);
	await clock.until(() => s.sent.length > 0);
	await clock.until(() => gzipped(s, id));
	return id;
}

describe("gzip after the completion message", () => {
	it("gzipps the log, deletes the plain file, and points the registry at the gz", async () => {
		const s = session();
		const id = await start(s, "echo one; echo two");
		procs.of(id).write("one\ntwo\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => gzipped(s, id));
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /Last output:\none\ntwo$/);
		assert.equal(existsSync(gzPath(s, id)), true);
		assert.equal(existsSync(plainPath(s, id)), false);
		assert.equal(statSync(gzPath(s, id)).mode & 0o777, 0o600);
		assert.equal(getRegistry().tasks.get(id)!.logPath, gzPath(s, id));
		assert.match(
			gunzipSync(readFileSync(gzPath(s, id))).toString("utf8"),
			/^one\ntwo\n\n__PI_BG_EXIT__:[0-9a-f]{16}:0\n$/,
		);
	});

	it("does not gzip a task the agent killed, since no completion message is sent", async () => {
		const s = session();
		const id = await start(s, "long");
		procs.of(id).write("partial\n");
		await clock.settle(s.toolCall("bash_kill", { id }));
		assert.equal(existsSync(gzPath(s, id)), false);
		assert.equal(existsSync(plainPath(s, id)), true);
		assert.equal(s.sent.length, 0);
	});

	it("bash_output pages a finished, gzipped task exactly as a plain log", async () => {
		const s = session();
		const id = await finished(s, seq(1, 4500));
		assert.equal(existsSync(gzPath(s, id)), true);
		const pages: string[] = [];
		for (let i = 0; i < 10; i++) {
			const got = lines(text(await out(s, { id })));
			if (got.length === 0) break;
			pages.push(...got);
		}
		assert.deepEqual(pages, seqLines(1, 4500));
		assert.doesNotMatch(pages.join("\n"), /__PI_BG_EXIT__/);
		assert.match(text(await out(s, { id, latest: true })), /\(no new output\)/);
	});

	it("latest and filter work on a gzipped log", async () => {
		const s = session();
		const id = await finished(s, seq(1, 30));
		// A filter over the whole gzipped log keeps only the matching lines.
		const filtered = text(await out(s, { id, filter: "^2" }));
		assert.deepEqual(lines(filtered), ["2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]);
		// The position moved past everything, so `latest` has nothing new.
		assert.match(text(await out(s, { id, latest: true })), /\(no new output\)/);
	});

	it("reads a gzipped exit-unknown log (no marker) transparently", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write("data\n");
		procs.of(id).die(); // gone with no marker
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => gzipped(s, id));
		assert.match(s.sent[0].message.content, /finished: exit unknown/);
		assert.equal(existsSync(gzPath(s, id)), true);
		const result = text(await out(s, { id }));
		assert.match(result, /^Task bg-1: exit unknown\./);
		assert.match(result, /data/);
		assert.doesNotMatch(result, /__PI_BG_/);
	});
});

describe("cleanup at session start", () => {
	const sessionDir = (name: string) => join(stateHome, "pi-bg", name);

	it("removes a log and an emptied session directory older than 7 days, and keeps a 6-day-old log", async () => {
		const s = session();
		const oldDir = sessionDir("old-session");
		const youngDir = sessionDir("young-session");
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(youngDir, { recursive: true });
		writeFileSync(join(oldDir, "bg-1.log"), "old\n");
		writeFileSync(join(youngDir, "bg-2.log"), "young\n");
		aged(join(oldDir, "bg-1.log"), 8);
		aged(join(youngDir, "bg-2.log"), 6);
		aged(oldDir, 8);
		aged(youngDir, 6);
		await s.sessionStart();
		assert.equal(existsSync(join(oldDir, "bg-1.log")), false);
		assert.equal(existsSync(oldDir), false);
		assert.equal(existsSync(join(youngDir, "bg-2.log")), true);
		assert.equal(existsSync(youngDir), true);
	});

	it("never removes a running task's log, however old", async () => {
		const s = session();
		const id = await start(s, "long-running");
		procs.of(id).write("started\n");
		aged(plainPath(s, id), 8);
		await s.sessionStart();
		assert.equal(existsSync(plainPath(s, id)), true);
	});

	it("removes only its own logs and leaves other files and directories alone", async () => {
		const s = session();
		const dir = sessionDir("mixed");
		mkdirSync(dir, { recursive: true });
		const others = ["notes.txt", "bg-1.log.bak", "bg-x.log", "bg-1.jsonl"];
		for (const name of others) writeFileSync(join(dir, name), "keep me");
		writeFileSync(join(dir, "bg-1.log"), "old log\n");
		mkdirSync(join(dir, "subdir"));
		for (const name of [...others, "bg-1.log"]) aged(join(dir, name), 8);
		aged(join(dir, "subdir"), 8);
		aged(dir, 8);
		await s.sessionStart();
		for (const name of others) assert.equal(existsSync(join(dir, name)), true, name);
		assert.equal(existsSync(join(dir, "subdir")), true);
		assert.equal(existsSync(join(dir, "bg-1.log")), false);
		assert.equal(existsSync(dir), true); // the others keep the directory
	});

	it("never follows a symlink out of the directory", async () => {
		const s = session();
		const outside = join(stateHome, "outside-target");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "bg-1.log"), "precious");
		const dir = sessionDir("linky");
		mkdirSync(dir, { recursive: true });
		symlinkSync(outside, sessionDir("linked-session")); // a symlinked session dir must not be descended into
		symlinkSync(join(outside, "bg-1.log"), join(dir, "bg-2.log")); // a symlinked log must not be followed
		writeFileSync(join(dir, "bg-3.log"), "old log\n");
		aged(join(dir, "bg-3.log"), 8);
		aged(dir, 8);
		await s.sessionStart();
		assert.equal(readFileSync(join(outside, "bg-1.log"), "utf8"), "precious");
		assert.equal(existsSync(join(dir, "bg-2.log")), true); // the symlink stays
		assert.equal(existsSync(join(dir, "bg-3.log")), false);
	});

	it("leaves an aged symlink named like a log alone (only regular files are removed)", async () => {
		const s = session();
		const outside = join(stateHome, "aged-link-target");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "precious"), "precious");
		const dir = sessionDir("aged-link");
		mkdirSync(dir, { recursive: true });
		const link = join(dir, "bg-9.log");
		symlinkSync(join(outside, "precious"), link);
		const then = new Date(Date.now() - 8 * DAY);
		lutimesSync(link, then, then); // the link's own mtime, not the target's
		aged(dir, 8);
		await s.sessionStart();
		assert.equal(existsSync(link), true);
		assert.equal(readFileSync(join(outside, "precious"), "utf8"), "precious");
	});

	it("unlinks a malformed owner.pid so an aged empty directory can be removed", async () => {
		const s = session();
		for (const [name, contents] of [
			["junk", "not-a-pid"],
			["empty", ""],
			["one", "1"],
			["zero", "0"],
		] as const) {
			const dir = sessionDir(name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "owner.pid"), contents);
			aged(join(dir, "owner.pid"), 8);
			aged(dir, 8);
			await s.sessionStart();
			assert.equal(existsSync(join(dir, "owner.pid")), false, `${name} marker`);
			assert.equal(existsSync(dir), false, `${name} dir`);
		}
	});

	it("keeps housekeeping going when a log cannot be unlinked", { skip: process.getuid?.() === 0 }, async () => {
		const s = session();
		const dir = sessionDir("locked");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "bg-1.log"), "old\n");
		writeFileSync(join(dir, "bg-2.log"), "older\n");
		for (const name of ["bg-1.log", "bg-2.log"]) aged(join(dir, name), 8);
		aged(dir, 8);
		chmodSync(dir, 0o500); // write permission removed: every unlink fails with EACCES
		try {
			await s.sessionStart(); // one failing unlink must not escape
			assert.equal(existsSync(join(dir, "bg-1.log")), true);
			assert.equal(existsSync(join(dir, "bg-2.log")), true);
		} finally {
			chmodSync(dir, 0o700);
		}
	});
});

describe("the log limit marker", () => {
	beforeEach(() => {
		process.env.PI_BG_BASH_LOG_LIMIT_BYTES = "1024";
	});
	afterEach(() => {
		delete process.env.PI_BG_BASH_LOG_LIMIT_BYTES;
	});

	/** Start a task that prints well past the lowered limit and wait for its completion. */
	async function overLimit(s: Session): Promise<string> {
		const id = await start(s, "runaway");
		procs.of(id).write("x".repeat(4096));
		await clock.until(() => s.sent.length > 0);
		return id;
	}

	it("hides the limit marker from bash_output and from the completion message", async () => {
		const s = session();
		const id = await overLimit(s);
		assert.match(s.sent[0].message.content, /finished: killed \(log limit passed\)/);
		assert.doesNotMatch(s.sent[0].message.content, /__PI_BG_LIMIT__/);
		const result = text(await out(s, { id }));
		assert.doesNotMatch(result, /__PI_BG_LIMIT__/);
		// the raw log really does carry the marker the view cut
		await clock.until(() => gzipped(s, id));
		assert.match(gunzipSync(readFileSync(gzPath(s, id))).toString("utf8"), /__PI_BG_LIMIT__:[0-9a-f]{16}\n$/);
	});

	it("hides both markers and reports the exit code when the command exits while the limit kill is in flight", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const proc = procs.of(id);
		proc.write("x".repeat(4096));
		proc.exit(0); // the exit marker lands before the fast limit check fires
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /finished: exited \(code 0\)/);
		assert.doesNotMatch(s.sent[0].message.content, /__PI_BG_LIMIT__|__PI_BG_EXIT__/);
		const result = text(await out(s, { id }));
		assert.doesNotMatch(result, /__PI_BG_LIMIT__|__PI_BG_EXIT__/);
		await clock.until(() => gzipped(s, id));
		const full = gunzipSync(readFileSync(gzPath(s, id))).toString("utf8");
		assert.match(full, /__PI_BG_EXIT__:[0-9a-f]{16}:0\n/);
		assert.match(full, /__PI_BG_LIMIT__:[0-9a-f]{16}\n/);
	});

	it("writes the limit marker after the kill, so output the command emits while dying stays before it", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const proc = procs.of(id);
		proc.write("y".repeat(4096));
		proc.unkillable = true; // the group survives, so the log is not gzipped and the marker stays put
		proc.onSignal = (signal) => {
			if (signal === "SIGKILL") proc.write("dying\n");
		};
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /finished: killed \(log limit passed\)/);
		const full = readFileSync(plainPath(s, id), "utf8");
		assert.match(full, /dying\n\n__PI_BG_LIMIT__:[0-9a-f]{16}\n$/);
	});

	it("still reports killed (log limit passed) once when the marker cannot be appended", async () => {
		const s = session();
		const id = await start(s, "runaway");
		procs.of(id).write("z".repeat(4096));
		const plain = plainPath(s, id);
		chmodSync(plain, 0o000); // stat works, append and read fail with EACCES
		try {
			await clock.until(() => s.sent.length > 0);
			assert.equal(s.sent.length, 1);
			assert.match(s.sent[0].message.content, /finished: killed \(log limit passed\)/);
			assert.equal(getRegistry().tasks.get(id)!.state, "killed");
		} finally {
			chmodSync(plain, 0o600);
		}
	});

	it("hides an exit marker written after the limit marker, and cuts the view byte-exactly", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const proc = procs.of(id);
		const output = "x".repeat(4096);
		proc.write(output);
		proc.unkillable = true; // survives SIGKILL, so the limit marker is written and the log stays plain
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /finished: killed \(log limit passed\)/);
		// The wrapper finally exits on its own, writing its exit marker after the limit marker.
		proc.exit(3);
		const task = getRegistry().tasks.get(id)!;
		assert.equal(existsSync(plainPath(s, id)), true);
		const view = openView(task);
		try {
			assert.equal(view.size, Buffer.byteLength(output));
			assert.equal(view.read(0, view.size).toString("utf8"), output);
		} finally {
			view.close();
		}
		const result = text(await out(s, { id }));
		assert.doesNotMatch(result, /__PI_BG_LIMIT__|__PI_BG_EXIT__/);
	});

	it("sends exactly one kill and one limit marker for a stuck group under the fast timer", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const proc = procs.of(id);
		proc.write("x".repeat(4096));
		proc.unkillable = true; // SIGKILL does not clear the group, so the kill stays in flight across fast ticks
		await clock.until(() => s.sent.length > 0);
		await clock.tick(2); // let any overlapping kill that a mutant started finish and write
		assert.equal(proc.signals.filter((signal) => signal === "SIGKILL").length, 1);
		assert.equal((readFileSync(plainPath(s, id), "utf8").match(/__PI_BG_LIMIT__:[0-9a-f]{16}\n/g) ?? []).length, 1);
		assert.equal(s.sent.length, 1);
	});

	it("does not gzip a stuck group's log once the async gzip would have landed", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const proc = procs.of(id);
		proc.write("x".repeat(4096));
		proc.unkillable = true;
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3); // plenty of event-loop turns in which an always-gzip mutant would finish
		assert.equal(existsSync(plainPath(s, id)), true);
		assert.equal(existsSync(gzPath(s, id)), false);
		assert.equal(getRegistry().tasks.get(id)!.logPath, plainPath(s, id));
	});

	it("records the pid as empty after a limit kill so it is never signalled again", async () => {
		const s = session();
		const id = await overLimit(s);
		const task = getRegistry().tasks.get(id)!;
		assert.equal(getRegistry().emptyGroups.has(task.pid), true);
	});

	it("reports exit unknown when the group is already gone as the limit kill runs", async () => {
		const s = session();
		const id = await start(s, "runaway");
		procs.of(id).write("x".repeat(4096));
		procs.of(id).die(); // gone with no marker before the fast tick
		await clock.until(() => s.sent.length > 0);
		assert.equal(getRegistry().tasks.get(id)!.state, "exit-unknown");
		assert.match(s.sent[0].message.content, /finished: exit unknown/);
	});

	it("stops the fast limit timer once no task runs, before the 2 s poller does", async () => {
		const s = session();
		const id = await start(s, "runaway");
		procs.of(id).write("x".repeat(4096));
		await clock.until(() => s.sent.length > 0);
		await clock.tickMs(300); // past the next 250 ms fast tick, well before the 2 s poller
		assert.equal(getRegistry().limitTimer, undefined);
	});

	it("kills a runaway within 500 ms of fake time after its log crosses the limit", async () => {
		const s = session();
		const id = await start(s, "runaway");
		const crossed = Date.now();
		procs.of(id).write("x".repeat(4096));
		await clock.until(() => s.sent.length > 0);
		assert.ok(Date.now() - crossed <= 500, `limit kill took ${Date.now() - crossed} ms`);
		assert.match(s.sent[0].message.content, /finished: killed \(log limit passed\)/);
	});
});

describe("gzip timing", () => {
	it("does not gzip until the completion message has really been sent", async () => {
		const s = session();
		s.faults.failSend = true;
		const id = await start(s, "job");
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		await clock.tick(5); // ample time for a gzip that should not have started
		assert.equal(existsSync(plainPath(s, id)), true);
		assert.equal(existsSync(gzPath(s, id)), false);
		s.faults.failSend = false;
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => gzipped(s, id));
		assert.equal(existsSync(plainPath(s, id)), false);
	});

	it("pages continuously across the plain-to-gzip switch", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write(seq(1, 3000));
		const before = lines(text(await out(s, { id })));
		assert.equal(before[0], "1");
		assert.ok(before.length > 0 && before.length < 3000, `read ${before.length} lines before switching`);
		proc.write(seq(3001, 4000));
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => gzipped(s, id));
		const after: string[] = [];
		for (let i = 0; i < 10; i++) {
			const got = lines(text(await out(s, { id })));
			if (got.length === 0) break;
			after.push(...got);
		}
		assert.deepEqual([...before, ...after], seqLines(1, 4000));
		assert.doesNotMatch([...before, ...after].join("\n"), /__PI_BG_EXIT__/);
	});

	it("leaves no partial .gz when the gzip write fails, and keeps the plain log", async () => {
		const s = session();
		const id = await start(s, "job");
		mkdirSync(gzPath(s, id), { recursive: true }); // a directory in the .gz's place makes the gzip write fail
		procs.of(id).write("done\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => !existsSync(gzPath(s, id)), 3 * POLL_MS); // the async gzip fails
		assert.equal(existsSync(plainPath(s, id)), true);
		assert.equal(existsSync(gzPath(s, id)), false);
		assert.equal(getRegistry().tasks.get(id)!.logPath, plainPath(s, id));
	});
});

describe("cleanup across processes", () => {
	it("keeps a session directory whose owning Pi is still alive, however old", async () => {
		const s = session();
		const live = await start(s, "server");
		const ownerPid = getRegistry().tasks.get(live)!.pid;
		const dir = join(stateHome, "pi-bg", "other-live");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "owner.pid"), String(ownerPid));
		writeFileSync(join(dir, "bg-1.log"), "live task output\n");
		aged(join(dir, "bg-1.log"), 8);
		aged(join(dir, "owner.pid"), 8);
		aged(dir, 8);
		await s.sessionStart();
		assert.equal(existsSync(join(dir, "bg-1.log")), true);
		assert.equal(existsSync(dir), true);
	});

	it("removes a session directory whose owning Pi is gone", async () => {
		const s = session();
		const dir = join(stateHome, "pi-bg", "dead-owner");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "owner.pid"), "999999");
		writeFileSync(join(dir, "bg-1.log"), "orphan\n");
		aged(join(dir, "bg-1.log"), 8);
		aged(join(dir, "owner.pid"), 8);
		aged(dir, 8);
		await s.sessionStart();
		assert.equal(existsSync(join(dir, "bg-1.log")), false);
		assert.equal(existsSync(dir), false);
	});

	it("bounds an oversized owner.pid and still removes the directory", async () => {
		const s = session();
		const dir = join(stateHome, "pi-bg", "huge-owner");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "owner.pid"), "999999999999999999999999");
		writeFileSync(join(dir, "bg-1.log"), "orphan\n");
		aged(join(dir, "bg-1.log"), 8);
		aged(join(dir, "owner.pid"), 8);
		aged(dir, 8);
		assert.equal(ownerPid(dir), undefined);
		// The real port throws for a pid above 2^31-1; make that visible here.
		const port = processPort();
		setProcessPort({
			...port,
			pidAlive: (pid) => {
				if (pid > 0x7fffffff) throw new TypeError('The "pid" argument must be of type number');
				return port.pidAlive(pid);
			},
		});
		await s.sessionStart();
		assert.equal(existsSync(join(dir, "bg-1.log")), false);
		assert.equal(existsSync(join(dir, "owner.pid")), false);
		assert.equal(existsSync(dir), false);
	});

	it("keeps going when the owner's liveness check throws", async () => {
		const s = session();
		const dir = join(stateHome, "pi-bg", "throwing-owner");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "owner.pid"), "4242");
		writeFileSync(join(dir, "bg-1.log"), "orphan\n");
		aged(join(dir, "bg-1.log"), 8);
		aged(join(dir, "owner.pid"), 8);
		aged(dir, 8);
		const port = processPort();
		setProcessPort({
			...port,
			pidAlive: () => {
				throw new Error("liveness exploded");
			},
		});
		await s.sessionStart();
		assert.equal(existsSync(join(dir, "bg-1.log")), false);
		assert.equal(existsSync(dir), false);
	});
});
