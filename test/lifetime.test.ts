// Behaviour tier: what happens to tasks when the session ends, reloads or
// meets a hard stop, over the fake process table and fake time. The Pi-gone
// watch is a separate detached watcher process outside the task's group (see
// `launch.ts` `WATCH` and spec Q34); it is exercised by the contract tests.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { foregroundRuns } from "../src/foreground.ts";
import { processPort } from "../src/port.ts";
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

describe("/reload", () => {
	it("leaves a running task alive, listed in the new registration, and reports it once through the new one", async () => {
		const old = session();
		const id = await start(old, "dev-server");
		await clock.settle(old.shutdown("reload"));
		const fresh = session({ id: old.id });
		assert.deepEqual(procs.of(id).signals, []);
		assert.equal(procs.of(id).groupAlive(), true);
		assert.match(text(await fresh.toolCall("bash_tasks", {})), new RegExp(`^${id} \\| running \\|`));
		procs.of(id).exit(0);
		await clock.until(() => fresh.sent.length > 0);
		await clock.tick(3);
		assert.equal(fresh.sent.length, 1);
		assert.equal(old.sent.length, 0);
	});

	it("runs one poller after two registrations: an interval checks each task once", async () => {
		const first = session();
		await start(first, "one");
		session({ id: first.id }); // the reload's registration
		const port = processPort();
		const probe = port.pidAlive;
		let probes = 0;
		port.pidAlive = (pid) => {
			probes++;
			return probe(pid);
		};
		await clock.tick(1);
		assert.equal(probes, 1);
	});

	it("leaves a foreground command in flight running, and still listed", async () => {
		const old = session();
		const call = old.toolCall("bash", { command: "slow-build" });
		await clock.until(() => procs.all.length > 0);
		await clock.settle(old.shutdown("reload"));
		const fresh = session({ id: old.id });
		assert.deepEqual(procs.all[0].signals, []);
		assert.deepEqual(
			[...foregroundRuns()].map((run) => run.command),
			["slow-build"],
		);
		// A reload loads a fresh copy of the module (`moduleCache: false`): it sees the same runs.
		const reloaded = "../src/foreground.ts?reloaded"; // a fresh module instance, as /reload loads
		const copy = (await import(reloaded)) as typeof import("../src/foreground.ts");
		assert.notEqual(copy.foregroundRuns, foregroundRuns);
		assert.deepEqual(
			[...copy.foregroundRuns()].map((run) => run.command),
			["slow-build"],
		);
		procs.all[0].exit(0);
		assert.equal(text(await clock.settle(call)), "(no output)");
		assert.equal(fresh.sent.length, 0);
	});
});

for (const reason of ["quit", "new", "resume", "fork"] as const) {
	describe(`session_shutdown: ${reason}`, () => {
		it("kills the group of every running task", async () => {
			const s = session();
			const a = await start(s, "one");
			const b = await start(s, "two");
			const groups = [procs.of(a), procs.of(b)]; // the tasks are forgotten at shutdown
			await clock.settle(s.shutdown(reason));
			for (const group of groups) {
				assert.equal(group.signals[0], "SIGTERM");
				assert.equal(group.groupAlive(), false);
			}
		});

		it("kills what a finished task left running, and leaves an empty group unsignalled", async () => {
			const s = session();
			const leaves = await start(s, "server &");
			const clean = await start(s, "true");
			procs.of(leaves).exit(0, { child: true });
			procs.of(clean).exit(0);
			await clock.until(() => s.sent.length === 2);
			const [left, empty] = [procs.of(leaves), procs.of(clean)];
			await clock.settle(s.shutdown(reason));
			assert.equal(left.signals[0], "SIGTERM");
			assert.equal(left.groupAlive(), false);
			assert.deepEqual(empty.signals, []);
		});

		it("kills a foreground command still in flight", async () => {
			const s = session();
			const call = s.toolCall("bash", { command: "slow-build" }).catch((error: Error) => error);
			await clock.until(() => procs.all.length > 0);
			await clock.settle(s.shutdown(reason));
			assert.equal(procs.all[0].signals[0], "SIGTERM");
			assert.equal(procs.all[0].groupAlive(), false);
			await clock.settle(call);
		});

		it("kills a task whose spawn was still pending, once the spawn resolves", async () => {
			const s = session();
			let shutdown: Promise<void> | undefined;
			procs.duringLaunch = () => {
				shutdown = s.shutdown(reason);
			};
			const started = start(s, "late");
			await clock.settle(started);
			await clock.settle(shutdown!);
			assert.equal(procs.all[0].signals[0], "SIGTERM");
			assert.equal(procs.all[0].groupAlive(), false);
		});

		it("forgets the session's tasks and sends no completion message for them", async () => {
			const s = session();
			await start(s, "one");
			await clock.settle(s.shutdown(reason));
			await clock.tick(3);
			assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
			assert.equal(s.sent.length, 0);
		});

		it("sets notified on every task so an in-flight kill cannot leak its message into the next session", async () => {
			const s = session();
			await start(s, "long");
			s.dialogs.answer = (options) => options[0];
			const killing = s.command("bg"); // a /bg kill with notify: true, left in flight
			await clock.advance(100); // into the SIGTERM grace period
			const fresh = session({ id: s.id });
			await clock.settle(s.shutdown(reason));
			await clock.settle(killing);
			await clock.tick(3);
			assert.equal(fresh.sent.length, 0);
			assert.equal(s.sent.length, 0);
		});

		it("does not signal a group the poller recorded empty, even if it looks alive again (pid reuse)", async () => {
			const s = session();
			const id = await start(s, "true");
			const proc = procs.of(id);
			proc.exit(0);
			await clock.until(() => s.sent.length > 0); // the poller settles it and records the empty group
			proc.spawnChild(); // the pid now leads an unrelated, live group
			await clock.settle(s.shutdown(reason));
			assert.deepEqual(proc.signals, []);
		});

		it("clears the registry's group set and the footer at shutdown", async () => {
			const s = session();
			await start(s, "one");
			await clock.settle(s.shutdown(reason));
			assert.equal(getRegistry().groups.size, 0);
			assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
		});
	});
}

describe("a task whose command has exited", () => {
	it("bash_kill stops what the command left running and says so", async () => {
		const s = session();
		const id = await start(s, "sleep 60 &");
		procs.of(id).exit(0, { child: true });
		await clock.until(() => s.sent.length > 0);
		const result = await clock.settle(s.toolCall("bash_kill", { id }));
		assert.equal(
			text(result),
			`Task ${id} had already finished: exited (code 0); stopped the processes it left running.`,
		);
		assert.equal(procs.of(id).signals[0], "SIGTERM");
		assert.equal(procs.of(id).groupAlive(), false);
	});

	it("bash_kill on a finished task with nothing left says it already finished, as before", async () => {
		const s = session();
		const id = await start(s, "true");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		const result = await clock.settle(s.toolCall("bash_kill", { id }));
		assert.equal(text(result), `Task ${id} has already finished: exited (code 0).`);
		assert.deepEqual(procs.of(id).signals, []);
	});

	it("bash_kill on a recorded-empty group says already finished even if the pid looks alive again (pid reuse)", async () => {
		const s = session();
		const id = await start(s, "true");
		const proc = procs.of(id);
		proc.exit(0);
		await clock.until(() => s.sent.length > 0); // the poller settles it and records the empty group
		proc.spawnChild(); // a recycled pid now leads an unrelated, live group
		const result = await clock.settle(s.toolCall("bash_kill", { id }));
		assert.equal(text(result), `Task ${id} has already finished: exited (code 0).`);
		assert.deepEqual(proc.signals, []);
	});

	it("shares the finished-task kill between concurrent bash_kill calls", async () => {
		const s = session();
		const id = await start(s, "server &");
		const proc = procs.of(id);
		proc.exit(0, { child: true });
		await clock.until(() => s.sent.length > 0);
		const first = s.toolCall("bash_kill", { id });
		const second = s.toolCall("bash_kill", { id });
		const [r1, r2] = [await clock.settle(first), await clock.settle(second)];
		assert.equal(proc.signals.filter((signal) => signal === "SIGTERM").length, 1, "one shared group kill");
		assert.equal(text(r1), text(r2));
	});

	it("bash_kill does not report a group that survived SIGKILL as stopped", async () => {
		const s = session();
		const id = await start(s, "server &");
		procs.of(id).exit(0, { child: true });
		procs.of(id).ignoresTerm = true;
		procs.of(id).unkillable = true;
		await clock.until(() => s.sent.length > 0);
		const result = await clock.settle(s.toolCall("bash_kill", { id }));
		assert.match(text(result), /the processes it left running survived SIGKILL/);
		assert.doesNotMatch(text(result), /stopped the processes/);
	});

	it("a /bg pick kills what is left, and tells the user", async () => {
		const s = session();
		const id = await start(s, "server &");
		procs.of(id).exit(0, { child: true });
		await clock.until(() => s.sent.length > 0);
		s.dialogs.answer = (options) => options[0];
		await clock.settle(s.command("bg"));
		assert.equal(procs.of(id).signals[0], "SIGTERM");
		assert.match(s.dialogs.notices.join("\n"), /stopped the processes it left running/);
	});
});
