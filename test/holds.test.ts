// Fake process/time behaviour, no runtime credentials or real children.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { HOLDS_KEY, type HoldTable } from "../src/holds.ts";
import { getRegistry } from "../src/registry.ts";
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
	delete shared[HOLDS_KEY];
});
afterEach(() => {
	clock.restore();
	resetRegistry();
	restoreProcesses();
	delete shared[HOLDS_KEY];
});
after(cleanup);

function host(s: Session): HoldTable {
	const table: HoldTable = {
		version: 1,
		hosts: new Map([[s.id, new Map([["test-host", "live-runtime"]])]]),
		holds: new Map(),
	};
	shared[HOLDS_KEY] = table;
	return table;
}
function ready(s: Session): boolean {
	const table = shared[HOLDS_KEY] as HoldTable;
	return [...(table.holds.get(s.id)?.values() ?? [])].every((entry) => entry.ready);
}
async function context(s: Session, messages = s.sent.map(({ message }) => ({ role: "custom", ...message }))) {
	assert.deepEqual(await s.emit("context_with_system", { messages }), [undefined], "observer never transforms request");
}
async function end(s: Session, stopReason = "stop") {
	await s.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
}

describe("atomic completion holds", () => {
	it("rejects no host, wrong session, reload gap and malformed tables before any spawn or reservation", async () => {
		const s = session();
		await assert.rejects(start(s, "watcher", { hold: true }), /host/);
		assert.equal(getRegistry().nextId, 1);
		const table = host(s);
		table.hosts = new Map([["other", new Map([["host", "runtime"]])]]);
		await assert.rejects(start(s, "watcher", { hold: true }), /host/);
		table.hosts = new Map([[s.id, new Map()]]);
		await assert.rejects(start(s, "watcher", { hold: true }), /host/);
		table.hosts.set(s.id, new Map([["bad", ""]]));
		await assert.rejects(start(s, "watcher", { hold: true }), /host/);
		for (const invalid of [null, {}, { version: 2, hosts: new Map(), holds: new Map() }]) {
			shared[HOLDS_KEY] = invalid;
			await assert.rejects(start(s, "watcher", { hold: true }), /completion/);
		}
		assert.equal(procs.all.length, 0);
		assert.equal(getRegistry().tasks.size, 0);
		assert.equal(getRegistry().launching.size, 0);
		assert.equal(getRegistry().nextId, 1);
	});

	it("creates hold before launch and refunds only its own provisional entry on spawn failure", async () => {
		const s = session();
		const table = host(s);
		table.holds.set(s.id, new Map([["foreign", { provider: "another-extension", ready: false }]]));
		procs.failNextLaunch = new Error("spawn failed");
		await assert.rejects(start(s, "watcher", { hold: true }), /spawn failed/);
		assert.deepEqual([...table.holds.get(s.id)!.keys()], ["foreign"]);
		procs.duringLaunch = () => {
			assert.equal(table.holds.get(s.id)!.size, 2);
			assert.equal(ready(s), false);
		};
		const id = await start(s, "watcher", { hold: true });
		assert.equal(getRegistry().tasks.get(id)!.ownerSessionId, s.id);
		assert.equal(table.holds.get(s.id)!.size, 2);
	});

	it("running/sent-unseen/aborted/error terminals stay held, normal observed terminal releases", async () => {
		const s = session();
		host(s);
		const id = await start(s, "watcher", { hold: true });
		assert.equal(ready(s), false);
		procs.of(id).exit(0);
		await clock.tick();
		await end(s);
		assert.equal(ready(s), false);
		for (const failure of ["aborted", "error"]) {
			await context(s);
			await end(s, failure);
			assert.equal(ready(s), false);
		}
		await context(s);
		await end(s);
		assert.equal(ready(s), true);
		assert.equal(getRegistry().tasks.get(id)!.terminalObserved, true);
	});

	it("late terminal and overlapping holds cannot be released by another request's observation", async () => {
		const s = session();
		host(s);
		const a = await start(s, "a", { hold: true });
		const b = await start(s, "b", { hold: true });
		await context(s);
		procs.of(a).exit(0);
		await clock.tick();
		await end(s);
		assert.equal(ready(s), false);
		await context(s);
		await end(s);
		const table = shared[HOLDS_KEY] as HoldTable;
		assert.equal(table.holds.get(s.id)!.get(getRegistry().tasks.get(a)!.holdId!)!.ready, true);
		assert.equal(ready(s), false);
		procs.of(b).exit(0);
		await clock.tick();
		await context(s);
		await end(s);
		assert.equal(ready(s), true);
	});

	it("B2 nested successful kill observes only top-level codemode result, not nested id", async () => {
		const s = session();
		host(s);
		const id = await start(s, "watcher", { hold: true });
		await clock.settle(s.tool("bash_kill").execute("codemode-1/1", { id } as never, undefined, undefined, s.ctx));
		await context(s, [{ role: "toolResult", toolCallId: "codemode-1/1", isError: false }] as never);
		await end(s);
		assert.equal(ready(s), false);
		await context(s, [{ role: "toolResult", toolCallId: "codemode-1", isError: false }] as never);
		await end(s);
		assert.equal(ready(s), true);
		assert.equal(s.sent.length, 0, "agent kill still has no completion message");
	});

	it("stuck nested kill stays held; a later successful kill is the recovery path", async () => {
		const s = session();
		host(s);
		const id = await start(s, "watcher", { hold: true });
		const proc = procs.of(id);
		proc.unkillable = true;
		proc.ignoresTerm = true;
		const kill = (callId: string) => s.tool("bash_kill").execute(callId, { id } as never, undefined, undefined, s.ctx);
		await clock.settle(kill("code-stuck/1"));
		await context(s, [{ role: "toolResult", toolCallId: "code-stuck", isError: false }] as never);
		await end(s);
		assert.equal(ready(s), false);
		proc.unkillable = false;
		await clock.settle(kill("code-recovery/1"));
		await context(s, [{ role: "toolResult", toolCallId: "code-recovery", isError: false }] as never);
		await end(s);
		assert.equal(ready(s), true);
	});

	it("hold is launch-only, stop-watch cannot release it, and nohold needs no table", async () => {
		const s = session();
		await assert.rejects(s.toolCall("bash", { command: "a", hold: true }), /background:true/);
		assert.equal(procs.all.length, 0);
		await start(s, "nohost");
		host(s);
		const id = await start(s, "watcher", { hold: true });
		await s.toolCall("bash_watch", { id });
		await s.toolCall("bash_watch", { id, action: "stop" });
		await end(s);
		assert.equal(ready(s), false);
	});
});

for (const reason of ["quit", "new", "resume", "fork"] as const) {
	it(`nonreload ${reason} removes bg-owned holds and output, not foreign provider rows`, async () => {
		const s = session();
		const table = host(s);
		const id = await start(s, "watcher", { hold: true });
		table.holds.get(s.id)!.set("foreign", { provider: "another-extension", ready: false });
		await s.toolCall("bash_watch", { id });
		procs.of(id).write("event\n");
		await clock.tick();
		await clock.settle(s.shutdown(reason));
		assert.deepEqual([...table.holds.get(s.id)!.keys()], ["foreign"]);
		assert.equal(getRegistry().output, undefined);
		assert.equal(getRegistry().tasks.size, 0);
	});
}

it("session end during an in-flight held launch cleans its provisional ownership", async () => {
	const s = session();
	const table = host(s);
	let shutdown: Promise<void> | undefined;
	procs.duringLaunch = () => {
		shutdown = s.shutdown("quit");
	};
	await clock.settle(start(s, "watcher", { hold: true }));
	await clock.settle(shutdown!);
	assert.equal(table.holds.has(s.id), false);
	assert.equal(procs.all[0].groupAlive(), false);
	assert.equal(getRegistry().tasks.size, 0);
	assert.equal(s.sent.length, 0);
});

it("reload preserves hold entry, task ownership and tokens", async () => {
	const s = session();
	const table = host(s);
	const id = await start(s, "watcher", { hold: true });
	const task = getRegistry().tasks.get(id)!;
	const token = task.terminalToken;
	await s.shutdown("reload");
	const fresh = session({ id: s.id });
	assert.equal(table.holds.get(s.id)!.get(task.holdId!)!.ready, false);
	procs.of(id).exit(0);
	await clock.tick();
	assert.equal(getRegistry().tasks.get(id)!.terminalToken, token);
	await context(fresh);
	await end(fresh);
	assert.equal(ready(fresh), true);
});

it("malformed shared holds do not prevent process cleanup on quit", async () => {
	const s = session();
	host(s);
	const id = await start(s, "watcher", { hold: true });
	const proc = procs.of(id);
	shared[HOLDS_KEY] = null;
	await clock.settle(s.shutdown("quit"));
	assert.equal(proc.groupAlive(), false);
	assert.equal(getRegistry().tasks.size, 0);
});
