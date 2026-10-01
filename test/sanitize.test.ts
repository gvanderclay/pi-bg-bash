// Behaviour tier: what the agent reads is free of ANSI escape codes and control
// characters other than newline and tab, as with Pi's own `!` bash; the log on
// disk keeps the command's raw bytes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
	cleanup,
	fakeClock,
	fakeProcesses,
	type FakeProcesses,
	gzipped,
	logText,
	resetRegistry,
	restoreProcesses,
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

/** Colour, a cleared line with a bell, a carriage-return progress meter, cursor moves, an OSC hyperlink and stray C0 bytes. */
const RAW =
	"\x1b[31mred\x1b[0m\tcol\n" +
	"\x1b[2Kcleared\x07bell\n" +
	"50%\r100%\r\n" +
	"\x1b[1A\x1b[?25lup\x00x\x0bv\x1b[K\n" +
	"\x1b]8;;http://example.com\x07link\x1b]8;;\x07\n";
const CLEAN = "red\tcol\nclearedbell\n50%100%\nupxv\nlink";

describe("agent-facing output is stripped", () => {
	it("bash_output returns the output without escape codes or control characters, and the log keeps the raw bytes", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write(RAW);
		assert.equal(text(await s.toolCall("bash_output", { id })), `Task ${id}: running.\n${CLEAN}`);
		assert.equal(logText(s, id), RAW);
	});

	it("bash_output pages on raw log bytes: the next call starts right after the stripped text it returned", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write(RAW);
		await s.toolCall("bash_output", { id });
		procs.of(id).write("\x1b[32mnext\x1b[0m\n");
		assert.equal(text(await s.toolCall("bash_output", { id })), `Task ${id}: running.\nnext`);
		procs.of(id).write("\x1b[33mnewest\x1b[0m\n");
		assert.equal(text(await s.toolCall("bash_output", { id, latest: true })), `Task ${id}: running.\nnewest`);
	});

	it("the completion message's tail is stripped, and the log keeps the raw bytes", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write(RAW);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(
			s.sent[0].message.content,
			`Background task ${id} finished: exited (code 0), ran 2.0s.\nCommand: job\nLast output:\n${CLEAN}`,
		);
		await clock.until(() => gzipped(s, id));
		assert.equal(gunzipSync(readFileSync(join(s.logDir(), `${id}.log.gz`))).toString("utf8"), `${RAW}\n__PI_BG_EXIT__:${procs.of(id).nonce}:0\n`);
	});

	it("a foreground call's result is stripped, and its log keeps the raw bytes while it runs", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "colourful" });
		await clock.until(() => procs.all.length > 0);
		const proc = procs.all[0];
		proc.write(RAW);
		assert.equal(readFileSync(proc.logPath, "utf8"), RAW);
		proc.exit(0);
		const result = await clock.settle(call);
		assert.equal(text(result), `${CLEAN}\n`);
		assert.equal((result as { structuredContent?: { output: string } }).structuredContent?.output, `${CLEAN}\n`);
	});

	it("a foreground call that fails is stripped too, in the error result and in the thrown error", async () => {
		const s = session();
		const failing = s.toolCall("bash", { command: "colourful" });
		await clock.until(() => procs.all.length > 0);
		procs.all[0].write(RAW);
		procs.all[0].exit(2);
		const result = await clock.settle(failing);
		assert.equal(text(result), `${CLEAN}\n\n\nCommand exited with code 2`);
		assert.equal(result.isError, true);
		const abort = new AbortController();
		const aborted = s.toolCall("bash", { command: "colourful" }, abort.signal);
		await clock.until(() => procs.all.length > 1);
		procs.all[1].write(RAW);
		await clock.advance(100);
		abort.abort();
		await assert.rejects(clock.settle(aborted), { message: `${CLEAN}\n\n\nCommand aborted` });
	});

	it("a filter matches the stripped lines, so escape codes do not break an anchored pattern", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).write(RAW);
		assert.equal(
			text(await s.toolCall("bash_output", { id, filter: "^(red\tcol|clearedbell)$" })),
			`Task ${id}: running.\nred\tcol\nclearedbell\n[filter: 2 of 5 lines matched]`,
		);
	});
});
