// Behaviour tier: log housekeeping — gzip after the completion message, reading
// gzipped logs through `bash_output`, and the 7-day cleanup at session start.
// Fake processes and fake time; the logs are real files whose ages are set with
// `utimes`. The log-limit kill is a contract test (real `sh`, real time) in
// contract.test.ts.
import assert from "node:assert/strict";
import {
	existsSync,
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

import { getRegistry } from "../registry.ts";
import {
	cleanup,
	fakeClock,
	fakeProcesses,
	type FakeProcesses,
	resetRegistry,
	restoreProcesses,
	session,
	type Session,
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
	return id;
}

describe("gzip after the completion message", () => {
	it("gzipps the log, deletes the plain file, and points the registry at the gz", async () => {
		const s = session();
		const id = await start(s, "echo one; echo two");
		procs.of(id).write("one\ntwo\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /Last output:\none\ntwo$/);
		assert.equal(existsSync(gzPath(s, id)), true);
		assert.equal(existsSync(plainPath(s, id)), false);
		assert.equal(statSync(gzPath(s, id)).mode & 0o777, 0o600);
		assert.equal(getRegistry().tasks.get(id)!.logPath, gzPath(s, id));
		assert.match(gunzipSync(readFileSync(gzPath(s, id))).toString("utf8"), /^one\ntwo\n\n__PI_BG_EXIT__:[0-9a-f]{16}:0\n$/);
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
});
