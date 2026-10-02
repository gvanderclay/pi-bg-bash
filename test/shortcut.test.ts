// Behaviour tier: the ctrl+shift+b shortcut and the 2 s background hint, over
// the fake process table and fake time. The commands here are names no shell
// knows, so a red run never starts anything real.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { foregroundRuns } from "../src/foreground.ts";
import { cleanup, fakeClock, fakeProcesses, type FakeProcesses, resetRegistry, restoreProcesses, session, type Session, text } from "./harness.ts";

const HINT_KEY = "pi-bg-bash-hint";
const HINT_TEXT = "(ctrl+shift+b to background)";

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
async function launched() {
	await clock.until(() => procs.all.length > 0);
	return procs.all[0];
}

/** The widget records for the hint key, in order. */
const hint = (s: Session) => s.widgets.filter((w) => w.key === HINT_KEY);
/** Whether the hint is currently shown: the last record for the key is the text. */
const shown = (s: Session) => hint(s).at(-1)?.content?.[0] === HINT_TEXT;

/** Wrap the mocked timer globals to track which timer and interval ids are still pending, and what each is for. */
function trackTimers() {
	const pending = new Map<unknown, string>();
	const originals = {
		setInterval: globalThis.setInterval,
		clearInterval: globalThis.clearInterval,
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
	};
	globalThis.setInterval = ((callback: (...args: never[]) => void, ms?: number) => {
		const id = originals.setInterval(callback as never, ms as never);
		pending.set(id, `interval ${ms}`);
		return id;
	}) as typeof setInterval;
	globalThis.setTimeout = ((callback: (...args: never[]) => void, ms?: number) => {
		const id = originals.setTimeout(callback as never, ms as never);
		pending.set(id, `timeout ${ms}`);
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
		/** The labels of every timer or interval still pending. */
		pending: () => [...pending.values()],
		restore: () => {
			globalThis.setInterval = originals.setInterval;
			globalThis.clearInterval = originals.clearInterval;
			globalThis.setTimeout = originals.setTimeout;
			globalThis.clearTimeout = originals.clearTimeout;
		},
	};
}

describe("the shortcut registration", () => {
	it("registers ctrl+shift+b and leaves ctrl+b unbound", () => {
		const s = session();
		assert.ok("ctrl+shift+b" in s.shortcuts, "ctrl+shift+b must be registered");
		assert.ok(!("ctrl+b" in s.shortcuts), "ctrl+b stays Pi's cursor-left key");
	});
});

describe("firing the shortcut", () => {
	it("moves a running foreground command to the background at once, and the process keeps running", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("compiling\n");
		await clock.advance(3000);
		s.shortcut("ctrl+shift+b");
		const result = await clock.settle(call);
		assert.match(text(result), /^Command still running after 3 s; moved to the background as task bg-1\./);
		assert.match(text(result), /Output so far:\ncompiling\n$/);
		assert.equal(result.isError, undefined);
		assert.equal(proc.pidAlive(), true);
		assert.deepEqual(proc.signals, []);
		assert.match(text(await s.toolCall("bash_tasks", {})), /^bg-1 \| running \| 3\.[0-9]s \| slow-build$/);
	});

	it("applies to any command, including sleep and one with an explicit timeout", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "sleep 500", timeout: 300 });
		const proc = await launched();
		await clock.advance(5000);
		s.shortcut("ctrl+shift+b");
		const result = await clock.settle(call);
		assert.match(text(result), /moved to the background as task bg-1/);
		assert.equal(proc.pidAlive(), true);
	});

	it("does nothing when no foreground command is running", async () => {
		const s = session();
		s.shortcut("ctrl+shift+b");
		assert.equal(foregroundRuns().size, 0);
		assert.deepEqual(s.statuses, []);
		assert.equal(s.sent.length, 0);
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("one press promotes every concurrent foreground call", async () => {
		const s = session();
		const callA = s.toolCall("bash", { command: "slow-a" });
		const callB = s.toolCall("bash", { command: "slow-b" });
		await clock.until(() => procs.all.length === 2);
		await clock.advance(1000);
		s.shortcut("ctrl+shift+b");
		const a = await clock.settle(callA);
		const b = await clock.settle(callB);
		assert.match(text(a), /moved to the background as task bg-1/);
		assert.match(text(b), /moved to the background as task bg-2/);
		assert.equal(procs.all[0].pidAlive(), true);
		assert.equal(procs.all[1].pidAlive(), true);
	});
});

describe("the background hint", () => {
	it("appears 2 s into a foreground command, below the editor, and not before", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		await launched();
		await clock.advance(1000);
		assert.equal(shown(s), false, "no hint within the first second");
		await clock.advance(1000);
		assert.equal(shown(s), true, "the hint is shown once 2 s have passed");
		const record = hint(s).at(-1)!;
		assert.deepEqual(record.content, [HINT_TEXT]);
		assert.equal(record.placement, "belowEditor");
	});

	it("shows the hint at 2000 ms and not at 1999 ms", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		await launched();
		await clock.tickMs(1999);
		assert.equal(shown(s), false, "no hint at 1999 ms");
		await clock.tickMs(1);
		assert.equal(shown(s), true, "the hint at 2000 ms");
	});

	it("never sets the hint for a command that finishes within 2 s", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		proc.write("fast\n");
		proc.exit(0);
		await clock.settle(call);
		assert.equal(hint(s).length, 0, "a fast command never touches the hint widget");
	});

	it("never sets the hint when the command exits at 1.9 s, though the call ends after the grace", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(1900);
		proc.exit(0);
		await clock.settle(call);
		assert.equal(hint(s).length, 0, "a command that exits at 1.9 s never touches the hint widget");
	});

	it("clears the hint when the command ends", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		proc.write("done\n");
		proc.exit(0);
		await clock.settle(call);
		assert.equal(hint(s).at(-1)?.content, undefined, "the hint is cleared on a normal end");
	});

	it("clears a shown hint as soon as the exit marker is seen, not after the grace", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		proc.exit(0);
		await clock.advance(50);
		assert.equal(hint(s).at(-1)?.content, undefined, "the hint clears when the marker is seen, before the grace ends");
		await clock.settle(call);
	});

	it("clears the hint when the command is promoted by the shortcut", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		s.shortcut("ctrl+shift+b");
		await clock.settle(call);
		assert.equal(hint(s).at(-1)?.content, undefined, "the hint is cleared on promotion");
	});

	it("clears the hint when the turn aborts", async () => {
		const s = session();
		const turn = new AbortController();
		const call = s.toolCall("bash", { command: "slow-build" }, turn.signal).catch((error: Error) => error);
		await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		turn.abort();
		await clock.settle(call, 10_000);
		assert.equal(hint(s).at(-1)?.content, undefined, "the hint is cleared on abort");
	});

	it("clears the hint when the explicit timeout fires", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build", timeout: 5 }).catch((error: Error) => error);
		await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		await clock.settle(call, 10_000);
		assert.equal(hint(s).at(-1)?.content, undefined, "the hint is cleared when the timeout kills the command");
	});

	it("sets no hint widget when there is no UI", async () => {
		const s = session({ hasUI: false });
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(3000);
		assert.equal(hint(s).length, 0, "no widget without a UI");
		proc.exit(0);
		await clock.settle(call);
	});
});

describe("a stale context", () => {
	it("clears the hint best-effort in finish, and the call still settles", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		await clock.advance(2100);
		assert.equal(shown(s), true);
		s.faults.staleUI = true;
		proc.exit(0);
		const result = await clock.settle(call);
		assert.equal(result.isError, undefined);
		assert.equal(foregroundRuns().size, 0, "the run is removed even when the hint clear throws");
	});

	it("ignores a stale context when the hint callback fires, and the call still settles", async () => {
		const s = session();
		const call = s.toolCall("bash", { command: "slow-build" });
		const proc = await launched();
		s.faults.staleUI = true;
		await clock.advance(2100);
		proc.exit(0);
		const result = await clock.settle(call);
		assert.equal(result.isError, undefined);
		assert.equal(foregroundRuns().size, 0, "the run is removed even when the hint show throws");
	});
});

describe("the hint timer", () => {
	it("leaves no timer behind after a call that was promoted past the hint", async () => {
		const s = session();
		const track = trackTimers();
		try {
			const call = s.toolCall("bash", { command: "slow-build" });
			await launched();
			await clock.advance(2100);
			assert.equal(shown(s), true);
			s.shortcut("ctrl+shift+b");
			await clock.settle(call);
			// The task's poller (an interval) legitimately outlives the call; the
			// hint's setTimeout and the promotion timer must both be gone.
			assert.equal(track.pending().filter((label) => label.startsWith("timeout")).length, 0, "no timeout may outlive the promoted call");
		} finally {
			track.restore();
		}
	});

	it("leaves no timer behind after a call that ended before the hint", async () => {
		const s = session();
		const track = trackTimers();
		try {
			const call = s.toolCall("bash", { command: "slow-build" });
			const proc = await launched();
			proc.exit(0);
			await clock.settle(call);
			assert.equal(track.pending().length, 0, "no timer or interval may outlive a call that ended first");
		} finally {
			track.restore();
		}
	});
});
