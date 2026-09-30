// Behaviour tier: the poller and the registry's fault handling, id and log
// rules, over the fake process table and fake time.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { getRegistry } from "../registry.ts";
import {
	cleanup,
	fakeClock,
	fakeProcesses,
	type FakeProcesses,
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

/** Make the log unreadable for the duration of `body`. */
async function unreadable(logPath: string, body: () => Promise<void>): Promise<void> {
	chmodSync(logPath, 0o000);
	try {
		await body();
	} finally {
		chmodSync(logPath, 0o600);
	}
}

describe("a resumed session", () => {
	it("does not reuse the log of an earlier run that had the same session id", async () => {
		const first = session();
		const oldId = await start(first, "echo old-run");
		procs.of(oldId).write("old-run\n");
		procs.of(oldId).exit(0);
		await clock.until(() => first.sent.length > 0);
		resetRegistry(); // a new Pi process: ids restart at bg-1, the log directory stays
		const second = session({ id: first.id });
		const id = await start(second, "echo new-run");
		assert.notEqual(id, oldId);
		procs.of(id).write("new-run\n");
		assert.match(readFileSync(join(second.logDir(), `${oldId}.log`), "utf8"), /old-run/);
		await clock.tick(3);
		assert.equal(second.sent.length, 0); // the old run's marker did not end it
		procs.of(id).exit(0);
		await clock.until(() => second.sent.length > 0);
		const result = text(await second.toolCall("bash_output", { id }));
		assert.match(result, /new-run/);
		assert.doesNotMatch(result, /old-run/);
	});

	it("skips an id whose compressed log exists", async () => {
		const s = session();
		mkdirSync(s.logDir(), { recursive: true });
		writeFileSync(join(s.logDir(), "bg-1.log.gz"), "");
		assert.equal(await start(s, "true"), "bg-2");
	});
});

describe("the poller survives faults", () => {
	it("marks a task whose log was deleted exit unknown instead of throwing", async () => {
		const s = session();
		const id = await start(s, "echo hi");
		procs.of(id).write("hi\n");
		rmSync(join(s.logDir(), `${id}.log`));
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /finished: exit unknown/);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});

	it("retries the message on a later tick when sendMessage throws", async () => {
		const s = session();
		s.faults.failSend = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		assert.equal(s.sent.length, 0);
		s.faults.failSend = false;
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /exited \(code 0\)/);
	});

	it("retries a lost completion after a reload re-registers the extension", async () => {
		const s = session();
		s.faults.failSend = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.faults.sendAttempts >= 1);
		const reloaded = session({ id: s.id }); // attach(): a fresh pi, the old poller replaced
		await clock.tick(4);
		assert.equal(s.sent.length, 0);
		assert.equal(reloaded.sent.length, 1);
		assert.match(reloaded.sent[0].message.content, /exited \(code 0\)/);
	});

	it("never calls a task exit unknown while its pid lives and its log is unreadable, however many ticks pass", async () => {
		const s = session();
		const id = await start(s, "job");
		const proc = procs.of(id);
		proc.write("hi\n");
		await unreadable(join(s.logDir(), `${id}.log`), async () => {
			await clock.tick(50);
			assert.equal(s.sent.length, 0);
			assert.equal(getRegistry().tasks.get(id)?.state, "running");
		});
		proc.exit(4);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /exited \(code 4\)/);
	});

	it("settles a task exit unknown when its pid is dead and its log stays unreadable, but only on the fifth failed read", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).die();
		await unreadable(join(s.logDir(), `${id}.log`), async () => {
			await clock.tick(4);
			assert.equal(s.sent.length, 0);
			assert.equal(getRegistry().tasks.get(id)?.state, "running");
			await clock.tick(1);
		});
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /finished: exit unknown/);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});

	it("keeps a real exit when one read failure came after the pid died", async () => {
		const s = session();
		const id = await start(s, "job");
		procs.of(id).exit(4);
		await unreadable(join(s.logDir(), `${id}.log`), async () => {
			await clock.tick(1);
			assert.equal(s.sent.length, 0);
		});
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /exited \(code 4\)/);
	});

	it("still polls and notifies when the footer throws", async () => {
		const s = session();
		s.faults.failFooter = true;
		const id = await start(s, "echo done");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /exited \(code 0\)/);
	});

	it("reports exit unknown once, and clears the footer, when the process group is killed", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).die();
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /finished: exit unknown/);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});
});
