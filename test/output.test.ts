// Behaviour tier: `bash_output` paging, `latest`, `filter` and the completion
// tail, over the fake process table: the test writes each task's output and ends it.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	resetRegistry,
	restoreProcesses,
	type Session,
	session,
	start,
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

/** The text of `seq from to`. */
const seq = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join("");
/** Run a task to its end: it writes `output`, exits with `code`, and the poller reports it. */
async function finished(s: Session, output: string | Buffer, code = 0): Promise<string> {
	const id = await start(s, "job");
	procs.of(id).write(output);
	procs.of(id).exit(code);
	await clock.until(() => s.sent.length > 0);
	return id;
}
const out = (s: Session, params: object) => s.toolCall("bash_output", params);
/** The output lines of a result: everything above the trailing bracketed notes. */
const lines = (text: string) => text.split("\n").filter((l) => /^\d+$/.test(l) || /^[a-z]+\d*$/.test(l));
const seqLines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

describe("bash_output", () => {
	it("returns consecutive, non-overlapping output from a task that is still printing", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write(seq(1, 3));
		const first = text(await out(s, { id }));
		assert.deepEqual(lines(first), ["1", "2", "3"]);
		assert.match(first, /^Task bg-1: running\./);
		proc.write(seq(4, 6));
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		const second = text(await out(s, { id }));
		assert.deepEqual(lines(second), ["4", "5", "6"]);
		assert.match(second, /^Task bg-1: exited \(code 0\)\./);
		assert.deepEqual(lines(text(await out(s, { id }))), []);
	});

	it("does not return a half-written line while the task runs", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write("ab\ncd");
		assert.deepEqual(lines(text(await out(s, { id }))), ["ab"]);
		proc.write("ef\n");
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.deepEqual(lines(text(await out(s, { id }))), ["cdef"]);
	});

	it("pages output larger than Pi's cap, each page noting what remains, and the pages equal the log minus the marker", async () => {
		const s = session();
		const id = await finished(s, seq(1, 4500));
		const pages: string[] = [];
		const texts: string[] = [];
		for (let i = 0; i < 10; i++) {
			const page = text(await out(s, { id }));
			texts.push(page);
			const got = lines(page);
			if (got.length === 0) break;
			pages.push(...got);
		}
		assert.deepEqual(pages, seqLines(1, 4500));
		assert.match(texts[0], /more remaining/i);
		assert.match(texts[1], /more remaining/i);
		assert.doesNotMatch(texts[2], /more remaining/i);
		assert.doesNotMatch(texts.join("\n"), /__PI_BG_EXIT__/);
	});

	it("pages a log that exceeds the byte cap even when it has few lines", async () => {
		const s = session();
		const id = await finished(s, Array.from({ length: 600 }, (_, i) => `${String(i).padStart(100, "0")}\n`).join(""));
		const first = text(await out(s, { id }));
		const second = text(await out(s, { id }));
		const count = (t: string) => t.split("\n").filter((l) => /^0{90,}\d+$/.test(l)).length;
		assert.equal(count(first), 506); // a 51200-byte cap holds 506 whole 101-byte lines
		assert.match(first, /more remaining/i);
		assert.equal(count(first) + count(second), 600);
	});

	it("latest: true returns the newest output, and the next plain call returns only what came after", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write(seq(1, 3000));
		const latest = lines(text(await out(s, { id, latest: true })));
		assert.equal(latest.at(-1), "3000");
		assert.ok(latest.length <= 2000);
		proc.write("tail1\ntail2\n");
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.deepEqual(lines(text(await out(s, { id }))), ["tail1", "tail2"]);
	});

	const blob = "x".repeat(100000);
	const xs = (t: string) => (t.match(/x{100,}/g) ?? [""]).join("").length;

	it("latest: true on a finished task whose newest 51 KB hold no newline returns a cut of it and reaches the end", async () => {
		const s = session();
		const id = await finished(s, blob);
		const latest = text(await out(s, { id, latest: true }));
		assert.doesNotMatch(latest, /\(no new output\)/);
		assert.ok(xs(latest) > 40000 && xs(latest) <= 51200, `returned ${xs(latest)} bytes`);
		assert.match(latest, /Skipped/);
		assert.match(text(await out(s, { id })), /\(no new output\)/);
	});

	it("latest: true on a finished task whose newest 51 KB are one line ending in a single newline returns a cut of it", async () => {
		const s = session();
		const id = await finished(s, `${blob}\n`);
		const latest = text(await out(s, { id, latest: true }));
		assert.doesNotMatch(latest, /\(no new output\)/);
		assert.ok(xs(latest) > 40000 && xs(latest) <= 51200, `returned ${xs(latest)} bytes`);
		assert.match(text(await out(s, { id })), /\(no new output\)/);
	});

	it("latest: true on a running task whose newest 51 KB hold no newline returns a cut of it and reaches the end", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write(blob);
		const latest = text(await out(s, { id, latest: true }));
		assert.doesNotMatch(latest, /\(no new output\)/);
		assert.ok(xs(latest) > 40000 && xs(latest) <= 51200, `returned ${xs(latest)} bytes`);
		proc.write("tail\n");
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.deepEqual(lines(text(await out(s, { id }))), ["tail"]); // nothing skipped, nothing repeated
	});

	it("latest: true with nothing unread returns no new output", async () => {
		const s = session();
		const id = await finished(s, seq(1, 10));
		assert.deepEqual(lines(text(await out(s, { id }))), seqLines(1, 10));
		const latest = text(await out(s, { id, latest: true }));
		assert.deepEqual(lines(latest), []);
		assert.match(latest, /\(no new output\)/);
	});

	it("latest: true returns only unread lines, never ones already read", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write(seq(1, 3000));
		const first = lines(text(await out(s, { id }))); // the oldest page, at most 2000 lines
		assert.equal(first[0], "1");
		const read = first.length;
		assert.ok(read < 3000);
		assert.deepEqual(lines(text(await out(s, { id, latest: true }))), seqLines(read + 1, 3000));
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.deepEqual(lines(text(await out(s, { id }))), []);
	});

	it("a filter keeps only matching lines of the unread range, and the position still moves past all of it", async () => {
		const s = session();
		const id = await finished(s, seq(1, 30));
		const filtered = text(await out(s, { id, filter: "^2" }));
		assert.deepEqual(lines(filtered), ["2", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]);
		assert.deepEqual(lines(text(await out(s, { id }))), []);
	});

	it("the completion message does not move the read position", async () => {
		const s = session();
		const id = await finished(s, seq(1, 5));
		assert.match(s.sent[0].message.content, /Last output:\n1\n2\n3\n4\n5$/);
		assert.deepEqual(lines(text(await out(s, { id }))), ["1", "2", "3", "4", "5"]);
	});

	it("reports a non-zero exit code and never returns the marker", async () => {
		const s = session();
		const id = await finished(s, "oops\n", 4);
		const result = text(await out(s, { id }));
		assert.match(result, /^Task bg-1: exited \(code 4\)\./);
		assert.match(result, /oops/);
		assert.doesNotMatch(result, /__PI_BG_EXIT__/);
	});

	it("refuses an unknown id", async () => {
		const s = session();
		await assert.rejects(out(s, { id: "bg-99" }), /unknown task.*bg-99/i);
	});

	it("refuses an invalid filter regex", async () => {
		const s = session();
		const id = await start(s, "echo x");
		await assert.rejects(out(s, { id, filter: "(" }), /filter/i);
	});
});

describe("binary output", () => {
	const fffd = (t: string) => t.split("\n").filter((l) => l === "\uFFFD").length;

	it("loses no lines when invalid UTF-8 lines are paged", async () => {
		const s = session();
		const id = await finished(s, Buffer.from("\xff\n".repeat(2500), "latin1"));
		let total = 0;
		for (let i = 0; i < 10; i++) total += fffd(text(await out(s, { id })));
		assert.equal(total, 2500);
	});

	it("advances through a long newline-free binary chunk", async () => {
		const s = session();
		const id = await finished(s, Buffer.alloc(60000, 0xff));
		let chars = 0;
		for (let i = 0; i < 20; i++) chars += (text(await out(s, { id })).match(/\uFFFD/g) ?? []).length;
		assert.equal(chars, 60000);
	});
});

describe("completion tail", () => {
	it("cuts a byte-capped tail at a character boundary", async () => {
		const s = session();
		await finished(s, `${"€".repeat(3000)}\n`);
		assert.doesNotMatch(s.sent[0].message.content, /\uFFFD/);
		assert.match(s.sent[0].message.content, /Last output:\n€+$/);
	});
});
