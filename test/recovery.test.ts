// R1/R2 regression tests: fake process port + fake time, real logs only.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { HOLDS_KEY, type HoldTable } from "../src/holds.ts";
import { getRegistry } from "../src/registry.ts";
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
} from "./harness.ts";

const shared = globalThis as unknown as Record<symbol, unknown>;
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
	delete shared[HOLDS_KEY];
});
after(cleanup);
function host(s: Session): void {
	const table: HoldTable = { version: 1, hosts: new Map([[s.id, new Map([["host", "runtime"]])]]), holds: new Map() };
	shared[HOLDS_KEY] = table;
}
const end = (s: Session, stopReason = "stop") => s.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
const settle = (s: Session, aborted = false) => s.emit("agent_settled", { aborted });
const observe = (s: Session) =>
	s.emit("context_with_system", { messages: s.sent.map(({ message }) => ({ role: "custom", ...message })) });
const ready = (s: Session) =>
	[...((shared[HOLDS_KEY] as HoldTable).holds.get(s.id)?.values() ?? [])].every((hold) => hold.ready);

describe("cleared custom-steer recovery", () => {
	it("rearms only the same unseen pre-agent_end output batch and preserves its payload/token", async () => {
		const s = session();
		s.ctx.hasPendingMessages = () => {
			throw new Error("custom steers are invisible here; never query this");
		};
		const id = await start(s, "producer");
		await s.toolCall("bash_watch", { id });
		procs.of(id).write("WAITING\n");
		await clock.tick();
		const sent = s.sent.shift()!;
		await end(s);
		await settle(s);
		assert.equal(s.sent.length, 1);
		assert.deepEqual(s.sent[0], sent);
		await observe(s);
		await end(s);
		await settle(s);
		await clock.tick(2);
		assert.equal(s.sent.length, 1);
		assert.equal(outputState().outstanding, undefined);
	});

	it("retains one immutable held completion, including across gzip, queue clear and stale-send reload", async () => {
		const s = session();
		host(s);
		const id = await start(s, "producer", { hold: true });
		const task = getRegistry().tasks.get(id)!;
		procs.of(id).exit(0);
		await clock.tick();
		const sent = s.sent.shift()!;
		const content = task.completion!.content;
		s.faults.failSend = true;
		await end(s);
		await settle(s);
		assert.equal(task.notified, true, "queue acceptance is separate from seen/committed");
		assert.equal(task.completion!.sent, false);
		assert.equal(ready(s), false);
		assert.notEqual(getRegistry().poller, undefined, "recovery restarts a stopped poller");
		const fresh = session({ id: s.id });
		await clock.tick();
		assert.equal(fresh.sent.length, 1);
		assert.deepEqual(fresh.sent[0], sent);
		assert.equal(task.completion!.content, content);
		await observe(fresh);
		await end(fresh);
		await settle(fresh);
		assert.equal(ready(fresh), true);
		await clock.tick(3);
		assert.equal(fresh.sent.length, 1);
	});

	for (const reason of ["aborted", "error"]) {
		it(`lost output + held completion remain bounded and paused after ${reason}, then resume together`, async () => {
			const s = session();
			host(s);
			const id = await start(s, "producer", { hold: true });
			await s.toolCall("bash_watch", { id });
			procs.of(id).write("WAITING\n");
			await clock.tick();
			procs.of(id).exit(0);
			await clock.tick();
			const sent = s.sent.splice(0);
			assert.equal(sent.length, 2);
			await end(s, reason);
			await settle(s, reason === "aborted");
			await clock.tick(3);
			assert.equal(s.sent.length, 0);
			assert.equal(ready(s), false);
			await s.emit("before_agent_start", { messageType: "custom", message: { customType: "pi-bg-bash" } });
			await clock.tick();
			assert.equal(s.sent.length, 0, "bg-owned runs do not lift the pause");
			await s.emit("before_agent_start", { messageType: "user" });
			await clock.tick();
			assert.deepEqual(s.sent, sent, "same output first, then same held terminal");
			await observe(s);
			await end(s);
			await settle(s);
			assert.equal(ready(s), true);
		});
	}

	it("a seen-but-aborted terminal is retained in context without duplicate sends, then committed normally", async () => {
		const s = session();
		host(s);
		const id = await start(s, "producer", { hold: true });
		procs.of(id).exit(0);
		await clock.tick();
		await observe(s);
		await end(s, "aborted");
		await settle(s, true);
		const task = getRegistry().tasks.get(id)!;
		assert.equal(task.terminalSeen, true);
		assert.equal(task.completion, undefined, "seen snapshots no longer retain their payload");
		assert.equal(task.terminalObserved, false);
		assert.equal(ready(s), false);
		await s.emit("before_agent_start", { messageType: "user" });
		await clock.tick(2);
		assert.equal(s.sent.length, 1);
		await observe(s);
		await end(s);
		await settle(s);
		assert.equal(ready(s), true);
		assert.equal(s.sent.length, 1);
	});

	it("does not rearm a completion sent after the last agent_end snapshot", async () => {
		const s = session();
		host(s);
		const id = await start(s, "producer", { hold: true });
		await end(s);
		procs.of(id).exit(0);
		await clock.tick();
		await settle(s);
		assert.equal(s.sent.length, 1);
		assert.equal(ready(s), false);
		await observe(s);
		await end(s);
		await settle(s);
		assert.equal(s.sent.length, 1);
		assert.equal(ready(s), true);
	});

	it("an abort after agent_end still pauses output", async () => {
		const s = session();
		const id = await start(s, "producer");
		await s.toolCall("bash_watch", { id });
		await end(s);
		await settle(s, true);
		procs.of(id).write("WAITING\n");
		await clock.tick(2);
		assert.equal(s.sent.length, 0);
		assert.equal(outputState().paused, true);
	});

	it("does not broaden unheld completion retries", async () => {
		const s = session();
		const id = await start(s, "producer");
		procs.of(id).exit(0);
		await clock.tick();
		assert.equal(getRegistry().tasks.get(id)!.completion, undefined);
		await end(s);
		await settle(s);
		await clock.tick(3);
		assert.equal(s.sent.length, 1, "unheld queue acceptance retains its existing behavior");
	});

	it("an output retry that keeps throwing cannot block held completion recovery", async () => {
		const s = session();
		host(s);
		const id = await start(s, "producer", { hold: true });
		await s.toolCall("bash_watch", { id });
		procs.of(id).write("WAITING\n");
		await clock.tick();
		procs.of(id).exit(0);
		await clock.tick();
		s.sent.splice(0);
		await end(s, "aborted");
		await settle(s, true);
		const pi = getRegistry().pi!;
		const send = pi.sendMessage;
		pi.sendMessage = (message, options) => {
			if (message.customType === "pi-bg-bash-output") throw new Error("output send failed");
			send(message, options);
		};
		await s.emit("before_agent_start", { messageType: "user" });
		await clock.tick();
		assert.equal(s.sent.length, 1);
		assert.equal(s.sent[0].message.customType, "pi-bg-bash");
		assert.equal(outputState().outstanding!.sent, false);
	});
});

describe("recorded successful kill observation", () => {
	it("counts a top-level isError tool result but still requires normal agent_end", async () => {
		const s = session();
		host(s);
		const id = await start(s, "producer", { hold: true });
		await clock.settle(s.tool("bash_kill").execute("code/1", { id } as never, undefined, undefined, s.ctx));
		const context = { messages: [{ role: "toolResult", toolCallId: "code", isError: true }] };
		await s.emit("context_with_system", context);
		await end(s, "error");
		await settle(s);
		assert.equal(ready(s), false);
		assert.equal(getRegistry().tasks.get(id)!.terminalSeen, true);
		await s.emit("context_with_system", context);
		await end(s);
		await settle(s);
		assert.equal(ready(s), true);
	});

	it("does not count stuck/leftover-stuck, including an isError result", async () => {
		const s = session();
		host(s);
		for (const leftover of [false, true]) {
			const id = await start(s, "producer", { hold: true });
			const proc = procs.of(id);
			proc.ignoresTerm = true;
			proc.unkillable = true;
			if (leftover) proc.exit(0, { child: true });
			await clock.settle(s.tool("bash_kill").execute(`stuck-${id}/1`, { id } as never, undefined, undefined, s.ctx));
			await s.emit("context_with_system", {
				messages: [{ role: "toolResult", toolCallId: `stuck-${id}`, isError: true }],
			});
			await end(s);
			await settle(s);
			assert.equal(getRegistry().tasks.get(id)!.killCallId, undefined);
			assert.equal(ready(s), false);
		}
	});
});
