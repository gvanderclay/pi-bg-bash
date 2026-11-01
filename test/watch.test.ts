// Behaviour tests: fake processes and fake time only.
import assert from "node:assert/strict";
import { rmSync, truncateSync } from "node:fs";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { getRegistry } from "../src/registry.ts";
import { closeWatch, scanWatch, WATCH_PENDING_BYTES, WATCH_PENDING_LINES } from "../src/watch.ts";
import { outputState } from "../src/watch-events.ts";
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
const outputs = (s: Session) => s.sent.filter((sent) => sent.message.customType === "pi-bg-bash-output");
const records = (content: string) =>
	content
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
const observe = (s: Session) =>
	s.emit("context_with_system", {
		messages: s.sent.map(({ message }) => ({ role: "custom", ...message })),
	});

describe("native output subscription", () => {
	it("a missing final log cannot turn a successful kill into a tool failure", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		rmSync(getRegistry().tasks.get(id)!.logPath);
		const result = await clock.settle(s.toolCall("bash_kill", { id }));
		assert.equal(result.isError, undefined);
		assert.equal(procs.of(id).groupAlive(), false);
		assert.equal(getRegistry().tasks.get(id)!.watch!.finalReadFailed, true);
		assert.equal(s.sent.length, 0);
	});
	it("discards unsent retry output on stop and terminal, without delaying completion", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		s.faults.failSend = true;
		procs.of(id).write("event\n");
		await clock.tick();
		assert.equal(outputState().outstanding?.sent, false);
		await s.toolCall("bash_watch", { id, action: "stop" });
		assert.equal(outputState().outstanding, undefined);
		s.faults.failSend = false;
		await clock.tick();
		assert.equal(outputs(s).length, 0);
		const other = await start(s, "other");
		await s.toolCall("bash_watch", { id: other });
		s.faults.failSend = true;
		procs.of(other).write("pending\n");
		await clock.tick();
		assert.equal(outputState().outstanding?.sent, false);
		procs.of(other).exit(0);
		s.faults.failSend = false;
		await clock.tick();
		assert.equal(outputs(s).length, 0);
		assert.equal(s.sent.at(-1)!.message.customType, "pi-bg-bash");
		assert.match(s.sent.at(-1)!.message.content, /1 event lines/);
	});

	it("services noisy watches fairly, bounds global new-byte scans and preserves invalid-byte offsets", async () => {
		const s = session();
		const ids = [];
		for (let n = 0; n < 6; n++) {
			const id = await start(s, "watcher");
			ids.push(id);
			await s.toolCall("bash_watch", { id });
			procs.of(id).write(Buffer.from("\xff\n".repeat(40_000), "latin1"));
		}
		await clock.tick();
		const total = ids.reduce((sum, id) => sum + getRegistry().tasks.get(id)!.watch!.cursor, 0);
		assert.ok(total <= 256 * 1024);
		for (let n = 0; n < 6; n++) {
			await observe(s);
			await clock.tick();
		}
		const seen = new Set(outputs(s).flatMap((m) => records(m.message.content).map((r) => r.task_id)));
		assert.equal(seen.size, 6);
		assert.ok(outputs(s).every((m) => Buffer.byteLength(m.message.content) <= WATCH_PENDING_BYTES));
	});
	it("JSON expansion cannot strand a record behind the bounded message header", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		procs.of(id).write(`${'"'.repeat(16 * 1024)}\n`);
		await clock.tick();
		assert.equal(getRegistry().tasks.get(id)!.watch!.droppedLines, 1);
		assert.equal(getRegistry().tasks.get(id)!.watch!.pending.length, 0);
		await observe(s);
		await clock.tick(2);
		assert.equal(outputs(s).length, 1, "one gap notice, not repeated empty batches");
	});
	it("is model-only and command-free, rejects foreign/unknown ids and invalid filters", async () => {
		const s = session();
		const tool = s.tool("bash_watch");
		assert.equal(tool.exposure, "model-only");
		assert.deepEqual(Object.keys((tool.parameters as { properties: object }).properties).sort(), [
			"action",
			"contains",
			"id",
		]);
		await assert.rejects(s.toolCall("bash_watch", { id: "bg-99" }), /Unknown task/);
		const id = await start(s, "watcher");
		for (const contains of [[], [""], ["€".repeat(86)], Array(17).fill("x")])
			await assert.rejects(s.toolCall("bash_watch", { id, contains }), /contains/);
		const foreign = session();
		await assert.rejects(foreign.toolCall("bash_watch", { id }), /this session/);
	});

	it("B1 emits one complete line within one poll while the producer stays silent and alive", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		procs.of(id).write('{"kind":"WAITING"}\n');
		await clock.tick();
		assert.equal(procs.of(id).pidAlive(), true);
		assert.deepEqual(
			records(outputs(s)[0].message.content).map((r) => r.text),
			['{"kind":"WAITING"}'],
		);
		await observe(s);
		await clock.tick(3);
		assert.equal(outputs(s).length, 1);
		procs.of(id).write("next\n");
		await clock.tick();
		assert.deepEqual(
			records(outputs(s)[1].message.content).map((r) => r.text),
			["next"],
		);
		await observe(s);
		procs.of(id).exit(0);
		await clock.tick();
		assert.equal(outputs(s).length, 2);
		assert.equal(s.sent.filter((m) => m.message.customType === "pi-bg-bash").length, 1);
	});

	it("emits nothing for silence, replays early output, keeps both read cursors independent", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		await clock.tick(2);
		assert.equal(outputs(s).length, 0);
		procs.of(id).write("early\n");
		await s.toolCall("bash_output", { id });
		await clock.tick();
		assert.equal(records(outputs(s)[0].message.content)[0].text, "early");
		assert.equal(getRegistry().tasks.get(id)?.readPosition, 6);
		await observe(s);
		procs.of(id).write("later\n");
		await clock.tick();
		assert.match(text(await s.toolCall("bash_output", { id })), /later/);
		assert.equal(records(outputs(s)[1].message.content)[0].text, "later");
	});

	it("frames split UTF8/ANSI, filters literally, repeats real duplicate lines, holds partial bytes", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id, contains: ["[x]"] });
		const bytes = Buffer.from("\x1b[32m[x] 🌱\x1b[0m\n");
		procs.of(id).write(bytes.subarray(0, 11));
		await clock.tick();
		assert.equal(outputs(s).length, 0);
		procs.of(id).write(bytes.subarray(11));
		await clock.tick();
		assert.equal(records(outputs(s)[0].message.content)[0].text, "[x] 🌱");
		await observe(s);
		procs.of(id).write("ignore\n[x] 🌱\n");
		await clock.tick();
		assert.equal(records(outputs(s)[1].message.content)[0].text, "[x] 🌱");
	});

	it("bounds backlog, drops oversized lines through LF, and reports truncation", async () => {
		const s = session();
		const id = await start(s, "watcher");
		procs.of(id).write("x".repeat(300_000));
		await s.toolCall("bash_watch", { id });
		await clock.tick(5);
		procs.of(id).write("\nvalid\n");
		await observe(s);
		await clock.tick(2);
		const task = getRegistry().tasks.get(id)!;
		assert.ok(task.watch!.skippedBytes >= 300_000);
		assert.equal(task.watch!.line.length, 0);
		const all = outputs(s).flatMap((m) => records(m.message.content));
		assert.ok(all.some((line) => line.text === "valid"));
		procs.of(id).write(`${"x".repeat(20_000)}\nlast\n`);
		await observe(s);
		await clock.tick();
		assert.equal(task.watch!.oversizedLines, 1);
		assert.match(outputs(s).at(-1)!.message.content, /oversized_lines=1/);
		truncateSync(task.logPath, 0);
		await clock.tick();
		assert.equal(task.watch!.state, "stopped");
	});

	it("caps local bytes/lines and sends only one outstanding batch behind a blocked tool", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		procs.of(id).write("first\n");
		await clock.tick();
		for (let n = 0; n < 8; n++) {
			procs.of(id).write(Array.from({ length: 500 }, (_, i) => `${n}:${i} ${"x".repeat(100)}\n`).join(""));
			await clock.tick();
		}
		const watch = getRegistry().tasks.get(id)!.watch!;
		assert.equal(outputs(s).length, 1);
		assert.ok(watch.pending.length <= WATCH_PENDING_LINES);
		assert.ok(watch.pendingBytes <= WATCH_PENDING_BYTES);
		assert.ok(watch.droppedLines > 0);
		assert.ok(Buffer.byteLength(outputs(s)[0].message.content) <= WATCH_PENDING_BYTES);
		await observe(s);
		await clock.tick();
		assert.equal(outputs(s).length, 2);
		procs.of(id).exit(0);
		await clock.tick();
		assert.equal(s.sent.at(-1)!.message.customType, "pi-bg-bash");
		assert.match(s.sent.at(-1)!.message.content, /were not delivered/);
	});

	it("retries immutable failed sends through reload and preserves scan positions", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		s.faults.failSend = true;
		procs.of(id).write("line\n");
		await clock.tick();
		const token = outputState().outstanding!.token;
		await s.shutdown("reload");
		const fresh = session({ id: s.id });
		await clock.tick();
		assert.equal((outputs(fresh)[0].message.details as { token: string }).token, token);
		assert.equal(outputs(s).length, 0);
		assert.deepEqual(
			records(outputs(fresh)[0].message.content).map((r) => r.text),
			["line"],
		);
	});

	it("pause after abort/error, resume only on non-bg-owned run; completion is unaffected", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		await s.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
		procs.of(id).write("data\n");
		await clock.tick();
		assert.equal(outputs(s).length, 0);
		await s.emit("before_agent_start", { messageType: "custom", message: { customType: "pi-bg-bash" } });
		await clock.tick();
		assert.equal(outputs(s).length, 0);
		await s.emit("before_agent_start", { messageType: "user" });
		await clock.tick();
		assert.equal(outputs(s).length, 1);
		procs.of(id).exit(0);
		await clock.tick();
		assert.equal(s.sent.at(-1)!.message.customType, "pi-bg-bash");
	});

	it("start is idempotent; stop cannot restart or kill; final partial scan hides markers", async () => {
		const s = session();
		const id = await start(s, "watcher");
		await s.toolCall("bash_watch", { id });
		const task = getRegistry().tasks.get(id)!;
		const watch = task.watch;
		await s.toolCall("bash_watch", { id });
		assert.equal(task.watch, watch);
		await assert.rejects(s.toolCall("bash_watch", { id, contains: ["different"] }), /different/);
		procs.of(id).write("partial");
		scanWatch(task, 100, true);
		assert.equal(task.watch!.pending[0].partial, true);
		assert.equal(task.readPosition, 0);
		closeWatch(task);
		assert.equal(task.watch!.state, "ended");
		const other = await start(s, "other");
		await s.toolCall("bash_watch", { id: other });
		await s.toolCall("bash_watch", { id: other, action: "stop" });
		await assert.rejects(s.toolCall("bash_watch", { id: other }), /stopped/);
		assert.deepEqual(procs.of(other).signals, []);
	});
});
