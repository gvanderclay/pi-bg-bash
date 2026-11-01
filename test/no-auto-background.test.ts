// Deliberate contract change: elapsed time alone never promotes bash.
// Fake processes + fake time only; no real long waits or model/provider calls.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { getRegistry } from "../src/registry.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
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

describe("ordinary bash never automatically backgrounds", () => {
	it("waits beyond the former 120s threshold, returns normal output/exit, and sends no completion notice", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build" }).finally(() => {
			settled = true;
		});
		await clock.until(() => procs.all.length === 1);
		procs.all[0].write("working\n");
		await clock.advance(125_000);
		assert.equal(settled, false);
		assert.equal(getRegistry().tasks.size, 0);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(procs.all[0].signals, []);
		procs.all[0].write("finished\n");
		procs.all[0].exit(0);
		const result = await clock.settle(call);
		assert.equal(text(result), "working\nfinished\n");
		const data = result.structuredContent as Record<string, unknown>;
		assert.equal(data.exit_code, 0);
		assert.equal("task_id" in data, false);
		assert.equal(getRegistry().tasks.size, 0);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});

	it("ignores the removed PI_BG_BASH_PROMOTE_MS switch", async () => {
		const previous = process.env.PI_BG_BASH_PROMOTE_MS;
		process.env.PI_BG_BASH_PROMOTE_MS = "1";
		try {
			const s = session();
			let settled = false;
			const call = s.toolCall("bash", { command: "slow-build" }).finally(() => {
				settled = true;
			});
			await clock.until(() => procs.all.length === 1);
			await clock.advance(125_000);
			assert.equal(settled, false);
			assert.equal(getRegistry().tasks.size, 0);
			procs.all[0].exit(0);
			await clock.settle(call);
		} finally {
			if (previous === undefined) delete process.env.PI_BG_BASH_PROMOTE_MS;
			else process.env.PI_BG_BASH_PROMOTE_MS = previous;
		}
	});

	it("still enforces an explicit timeout beyond 120s, killing the foreground group", async () => {
		const s = session();
		let settled = false;
		const call = s
			.toolCall("bash", { command: "slow-build", timeout: 125 })
			.catch((error: Error) => error)
			.finally(() => {
				settled = true;
			});
		await clock.until(() => procs.all.length === 1);
		await clock.advance(121_000);
		assert.equal(settled, false);
		assert.equal(getRegistry().tasks.size, 0);
		const result = await clock.settle(call, 10_000);
		assert.ok(result instanceof Error);
		assert.match(result.message, /Command timed out after 125 seconds/);
		assert.deepEqual(procs.all[0].signals, ["SIGKILL"]);
		assert.equal(procs.all[0].groupAlive(), false);
		assert.equal(s.sent.length, 0);
	});

	it("still aborts a foreground process after 120s instead of returning a surprise task", async () => {
		const s = session();
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: "slow-build" }, turn.signal).catch((error: Error) => error);
		await clock.until(() => procs.all.length === 1);
		await clock.advance(125_000);
		assert.equal(getRegistry().tasks.size, 0);
		turn.abort();
		const result = await clock.settle(call);
		assert.ok(result instanceof Error);
		assert.match(result.message, /Command aborted/);
		assert.deepEqual(procs.all[0].signals, ["SIGKILL"]);
		assert.equal(procs.all[0].groupAlive(), false);
		assert.equal(s.sent.length, 0);
	});

	it("retains explicit background:true task handles and automatic completion notices", async () => {
		const s = session();
		const id = await start(s, "slow-build");
		assert.equal(getRegistry().tasks.get(id)!.state, "running");
		await clock.advance(125_000);
		assert.equal(getRegistry().tasks.get(id)!.state, "running");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length === 1);
		assert.match(s.sent[0].message.content, /finished: exited \(code 0\)/);
	});

	it("retains opt-in waitFor, even when its match arrives after 120s", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "serve", waitFor: "ready", timeout: 300 }).finally(() => {
			settled = true;
		});
		await clock.until(() => procs.all.length === 1);
		await clock.advance(125_000);
		assert.equal(settled, false);
		assert.equal(getRegistry().tasks.size, 0);
		procs.all[0].write("ready\n");
		const result = await clock.settle(call);
		assert.match(text(result), /^"ready" appeared/);
		const task = getRegistry().tasks.get("bg-1")!;
		assert.equal(task.pid, procs.all[0].pid);
		assert.equal(task.deadline, task.startedAt + 300_000);
		assert.equal((result.structuredContent as Record<string, unknown>).task_id, "bg-1");
	});

	it("retains deliberate keyboard promotion after a long foreground wait", async () => {
		const s = session();
		let settled = false;
		const call = s.toolCall("bash", { command: "slow-build" }).finally(() => {
			settled = true;
		});
		await clock.until(() => procs.all.length === 1);
		await clock.advance(125_000);
		assert.equal(settled, false);
		assert.equal(getRegistry().tasks.size, 0);
		s.shortcut("ctrl+shift+b");
		const result = await clock.settle(call);
		assert.match(text(result), /^The user pressed ctrl\+shift\+b/);
		assert.equal((result.structuredContent as Record<string, unknown>).task_id, "bg-1");
		assert.equal(procs.all[0].pidAlive(), true);
	});
});
