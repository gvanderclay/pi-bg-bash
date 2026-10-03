// Behaviour tier: `bash_tasks`, `bash_kill`, deadlines and `/bg` over the fake
// process table and fake time.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";

import { getRegistry } from "../src/registry.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	keys,
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

/** Fake ms a call takes to settle. */
async function timed(call: Promise<unknown>): Promise<number> {
	const from = Date.now();
	await clock.settle(call);
	return Date.now() - from;
}

describe("bash_tasks", () => {
	it("says so when there are no tasks", async () => {
		const s = session();
		assert.equal(text(await s.toolCall("bash_tasks", {})), "No background tasks.");
	});

	it("lists running and finished tasks with id, command, state and runtime", async () => {
		const s = session();
		const finished = await start(s, "echo hi; exit 3");
		procs.of(finished).exit(3);
		await clock.until(() => s.sent.length > 0);
		const running = await start(s, "sleep 30");
		await clock.advance(4000);
		const lines = text(await s.toolCall("bash_tasks", {})).split("\n");
		assert.deepEqual(lines, [
			`${finished} | exited (code 3) | 2.0s | echo hi; exit 3`,
			`${running} | running | 4.0s | sleep 30`,
		]);
	});

	it("freezes a finished task's runtime at its end, in the list and in the completion message", async () => {
		const s = session();
		const id = await start(s, "job");
		await clock.advance(5000);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0); // the poll at 6 s notices
		await clock.advance(60_000);
		assert.equal(text(await s.toolCall("bash_tasks", {})), `${id} | exited (code 0) | 6.0s | job`);
		assert.match(s.sent[0].message.content, /finished: exited \(code 0\), ran 6\.0s\./);
	});
});

describe("bash_kill", () => {
	it("refuses an unknown id", async () => {
		const s = session();
		await assert.rejects(s.toolCall("bash_kill", { id: "bg-9" }), /Unknown task id: bg-9/);
	});

	it("sends SIGTERM first, and a task that honours it ends within the grace period", async () => {
		const s = session();
		const id = await start(s, "sleep 60");
		const proc = procs.of(id);
		const took = await timed(s.toolCall("bash_kill", { id }));
		assert.deepEqual(proc.signals, ["SIGTERM"]);
		assert.ok(took <= 200, `took ${took} ms`);
	});

	it("leaves neither the task nor its child alive, and sends no completion message", async () => {
		const s = session();
		const id = await start(s, "sleep 60 & wait");
		const proc = procs.of(id);
		proc.spawnChild();
		const result = text(await clock.settle(s.toolCall("bash_kill", { id })));
		assert.equal(result, `Task ${id} killed; its process group is gone.`);
		assert.equal(proc.groupAlive(), false);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
		assert.match(text(await s.toolCall("bash_tasks", {})), new RegExp(`^${id} \\| killed \\(killed by agent\\) \\|`));
		assert.match(text(await s.toolCall("bash_output", { id })), /^Task bg-1: killed \(killed by agent\)\./);
	});

	it("sends SIGKILL to a task that ignores SIGTERM when the grace period ends, and not before", async () => {
		const s = session();
		const id = await start(s, "trap '' TERM; while :; do sleep 1; done");
		const proc = procs.of(id);
		proc.ignoresTerm = true;
		const killing = s.toolCall("bash_kill", { id });
		await clock.advance(2900);
		assert.deepEqual(proc.signals, ["SIGTERM"]);
		assert.equal(proc.groupAlive(), true, "still alive before the grace period ends");
		await clock.advance(100);
		assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(text(await clock.settle(killing)), `Task ${id} killed; its process group is gone.`);
		assert.equal(proc.groupAlive(), false);
	});

	it("does not send SIGKILL to a task that ends by itself during the grace period", async () => {
		const s = session();
		const id = await start(s, "trap '' TERM; cleanup");
		const proc = procs.of(id);
		proc.ignoresTerm = true;
		const killing = s.toolCall("bash_kill", { id });
		await clock.advance(1000);
		proc.die();
		assert.match(text(await clock.settle(killing)), /killed/);
		assert.deepEqual(proc.signals, ["SIGTERM"]);
	});

	it("says so when the group survives SIGKILL, instead of claiming it is gone", async () => {
		const s = session();
		const id = await start(s, "stuck");
		const proc = procs.of(id);
		proc.ignoresTerm = true;
		proc.unkillable = true;
		const result = text(await clock.settle(s.toolCall("bash_kill", { id })));
		assert.equal(result, `Task ${id} was sent SIGKILL, but its process group is still running.`);
		assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
		assert.match(text(await s.toolCall("bash_tasks", {})), /killed \(killed by agent\)/);
	});

	it("refuses to signal a pid of 1 or below", async () => {
		const s = session();
		for (const pid of [1, 0]) {
			procs.nextPid = pid;
			const id = await start(s, "odd");
			await assert.rejects(clock.settle(s.toolCall("bash_kill", { id })), /refusing to signal process group/);
			assert.deepEqual(procs.of(id).signals, []);
		}
	});

	it("reports a finished task as already finished", async () => {
		const s = session();
		const id = await start(s, "exit 2");
		procs.of(id).exit(2);
		await clock.until(() => s.sent.length > 0);
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} has already finished: exited (code 2).`);
	});

	it("reports a task that finished but was not yet polled as already finished, and sends no message", async () => {
		const s = session();
		const id = await start(s, "exit 2");
		procs.of(id).exit(2); // no poller tick has run
		assert.equal(s.sent.length, 0);
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} has already finished: exited (code 2).`);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});

	it("settles a task whose process is gone with no marker as already finished, exit unknown", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).die();
		assert.equal(text(await s.toolCall("bash_kill", { id })), `Task ${id} has already finished: exit unknown.`);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});

	it("reports a group with only zombies left (EPERM) as already ended", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		const proc = procs.of(id);
		proc.zombie();
		assert.equal(
			text(await clock.settle(s.toolCall("bash_kill", { id }))),
			`Task ${id} had already ended: exit unknown.`,
		);
		assert.deepEqual(proc.signals, [], "nothing was signalled");
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});

	it("handles a task still 'running' because its log is unreadable while its group is gone", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		procs.of(id).die();
		const log = join(s.logDir(), `${id}.log`);
		chmodSync(log, 0o000);
		try {
			assert.equal(
				text(await clock.settle(s.toolCall("bash_kill", { id }))),
				`Task ${id} had already ended: exit unknown.`,
			);
		} finally {
			chmodSync(log, 0o600);
		}
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.equal(getRegistry().tasks.get(id)?.state, "exit-unknown");
	});

	it("shares one kill between two calls", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		const proc = procs.of(id);
		const first = s.toolCall("bash_kill", { id });
		const second = s.toolCall("bash_kill", { id });
		assert.match(text(await clock.settle(first)), /killed/);
		assert.match(text(await clock.settle(second)), /killed/);
		assert.deepEqual(proc.signals, ["SIGTERM"]);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
	});
});

describe("a background timeout", () => {
	it("kills the task once the deadline passes, and the completion message says it timed out", async () => {
		const s = session();
		const id = await start(s, "sleep 60 & wait", { timeout: 5 });
		const proc = procs.of(id);
		proc.spawnChild();
		await clock.advance(4000);
		assert.equal(s.sent.length, 0);
		assert.equal(proc.groupAlive(), true);
		await clock.until(() => s.sent.length > 0);
		assert.equal(proc.groupAlive(), false);
		assert.deepEqual(proc.signals, ["SIGTERM"]);
		// The poll at 6 s sends SIGTERM; the group is seen gone 0.1 s later.
		assert.match(
			s.sent[0].message.content,
			new RegExp(`^Background task ${id} finished: killed \\(timed out\\), ran 6\\.1s\\.`),
		);
		assert.deepEqual(s.sent[0].options, { deliverAs: "followUp", triggerTurn: true });
		await clock.tick(3);
		assert.equal(s.sent.length, 1);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
		assert.match(text(await s.toolCall("bash_tasks", {})), /killed \(timed out\)/);
	});

	it("reports 'timed out', never 'exit unknown', for a task that traps SIGTERM", async () => {
		const s = session();
		const id = await start(s, "trap '' TERM; while :; do sleep 1; done", { timeout: 5 });
		const proc = procs.of(id);
		proc.ignoresTerm = true;
		await clock.advance(8000); // the wrapper died of SIGTERM at 6 s; the group lingers; polls must skip the task
		assert.equal(s.sent.length, 0);
		await clock.until(() => s.sent.length > 0);
		assert.equal(s.sent.length, 1);
		assert.match(
			s.sent[0].message.content,
			new RegExp(`^Background task ${id} finished: killed \\(timed out\\), ran 9\\.1s\\.`),
		);
		assert.doesNotMatch(s.sent[0].message.content, /exit unknown/);
		assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(getRegistry().tasks.get(id)?.state, "killed");
	});

	it("leaves a task that finishes before its deadline alone", async () => {
		const s = session();
		const id = await start(s, "echo quick", { timeout: 60 });
		const proc = procs.of(id);
		proc.exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /finished: exited \(code 0\), ran 2\.0s\./);
		await clock.tick(35);
		assert.equal(s.sent.length, 1);
		assert.deepEqual(proc.signals, []);
	});

	it("does not stop a background task that has no timeout", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		await clock.tick(60);
		assert.equal(getRegistry().tasks.get(id)?.state, "running");
		assert.deepEqual(procs.of(id).signals, []);
	});
});

describe("/bg", () => {
	it("is registered", () => {
		assert.equal(session().hasCommand("bg"), true);
	});

	it("lists every task; x asks, then kills the task with one 'killed by user' message and lists again", async () => {
		const s = session();
		const done = await start(s, "echo hi");
		procs.of(done).exit(0);
		await clock.until(() => s.sent.length > 0);
		const running = await start(s, "sleep 30");
		const proc = procs.of(running);
		s.dialogs.keys = [[keys.down, "x"], [keys.escape]];
		await clock.settle(s.command("bg"));
		const [first, second] = s.dialogs.screens;
		assert.match(first.join("\n"), new RegExp(`${done} \\| exited \\(code 0\\) \\| 2\\.0s \\| echo hi`));
		assert.match(first.join("\n"), new RegExp(`${running} \\| running \\| 0\\.0s \\| sleep 30`));
		assert.deepEqual(s.dialogs.confirms, [`Kill ${running}?`]);
		assert.equal(proc.groupAlive(), false);
		assert.match(second.join("\n"), new RegExp(`${running} \\| killed \\(killed by user\\)`));
		await clock.tick(3);
		assert.equal(s.sent.length, 2);
		assert.match(
			s.sent[1].message.content,
			new RegExp(`^Background task ${running} finished: killed \\(killed by user\\), ran 0\\.2s\\.`),
		);
		assert.deepEqual(s.sent[1].options, { deliverAs: "followUp", triggerTurn: true });
	});

	it("reports 'killed by user', never 'exit unknown', for a task that traps SIGTERM", async () => {
		const s = session();
		const id = await start(s, "trap '' TERM; while :; do sleep 1; done");
		procs.of(id).ignoresTerm = true;
		s.dialogs.keys = [["x"], [keys.escape]];
		const command = s.command("bg");
		await clock.advance(2500); // a poll runs during the kill and must skip the task
		assert.equal(s.sent.length, 0);
		await clock.settle(command);
		assert.equal(s.sent.length, 1);
		assert.match(s.sent[0].message.content, /finished: killed \(killed by user\), ran 3\.2s\./);
		assert.doesNotMatch(s.sent[0].message.content, /exit unknown/);
	});

	it("kills nothing when the confirmation is declined or the list is closed", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		s.dialogs.confirm = false;
		s.dialogs.keys = [["x"], [keys.escape]];
		await s.command("bg");
		await clock.tick(3);
		assert.deepEqual(s.dialogs.confirms, [`Kill ${id}?`]);
		assert.equal(s.dialogs.screens.length, 2);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(procs.of(id).signals, []);
	});

	it("enter shows the end of a task's output without moving bash_output's position; esc goes back", async () => {
		const s = session();
		const id = await start(s, "build");
		procs.of(id).write(`${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
		s.dialogs.keys = [[keys.enter], [keys.home, keys.escape], [keys.escape]];
		await s.command("bg");
		const [, output, list] = s.dialogs.screens;
		assert.match(output[1], new RegExp(`^${id} \\| running`));
		assert.deepEqual(
			output.slice(2, -2),
			Array.from({ length: 18 }, (_, i) => `line ${i + 23}`),
		);
		assert.match(output.at(-2) ?? "", /^lines 23–40 of 40/);
		assert.match(list.join("\n"), new RegExp(`${id} \\| running`));
		assert.deepEqual(procs.of(id).signals, []);
		assert.match(text(await s.toolCall("bash_output", { id })), /^Task bg-\d+: running\.\nline 1\n/);
	});

	it("the kill confirmation shows the command on one line", async () => {
		const s = session();
		await start(s, "echo one\n  echo two");
		s.dialogs.confirm = false;
		s.dialogs.keys = [["x"], [keys.escape]];
		await s.command("bg");
		assert.deepEqual(s.dialogs.confirmMessages, ["echo one ⏎ echo two"]);
	});

	it("the list refreshes each second with new and changed tasks and keeps the selection", async () => {
		const s = session();
		await start(s, "sleep 30");
		const second = await start(s, "sleep 40");
		s.dialogs.confirm = false;
		s.dialogs.keys = [
			[
				keys.down,
				() => {
					const task = getRegistry().tasks.get(second);
					if (task) getRegistry().tasks.set("bg-99", { ...task, id: "bg-99", command: "late" });
					mock.timers.tick(1000);
				},
				"x",
			],
			[keys.escape],
		];
		await clock.settle(s.command("bg"));
		const frame = s.dialogs.frames[0].join("\n");
		assert.match(frame, /bg-99 \| running \| .* \| late/);
		assert.match(frame, new RegExp(`${second} \\| running \\| 1\\.\\ds`));
		assert.deepEqual(s.dialogs.confirms, [`Kill ${second}?`]);
	});

	it("the output view follows new output at the bottom, keeps its place when scrolled up, and stops refreshing on close", async () => {
		const s = session();
		const id = await start(s, "build");
		const proc = procs.of(id);
		const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`);
		proc.write(`${lines(1, 40).join("\n")}\n`);
		const append = (n: number) => () => {
			proc.write(`line ${n}\n`);
			mock.timers.tick(1000);
		};
		s.dialogs.keys = [[keys.enter], [append(41), keys.up, append(42), keys.escape], [keys.escape]];
		await clock.settle(s.command("bg"));
		const [atBottom, scrolled] = s.dialogs.frames;
		assert.deepEqual(atBottom.slice(2, -2), lines(24, 41));
		assert.match(atBottom.at(-2) ?? "", /^lines 24–41 of 41/);
		assert.deepEqual(scrolled.slice(2, -2), lines(23, 40));
		assert.match(scrolled.at(-2) ?? "", /^lines 23–40 of 42/);
		const requests = s.dialogs.renderRequests;
		await clock.advance(5000);
		assert.equal(s.dialogs.renderRequests, requests);
	});

	it("in RPC mode kills a picked task after a confirmation", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		s.ctx.mode = "rpc";
		s.dialogs.answer = (options) => options[0];
		await clock.settle(s.command("bg"));
		assert.deepEqual(s.dialogs.selects[0].options, [`${id} | running | 0.0s | sleep 30`]);
		assert.deepEqual(s.dialogs.confirms, [`Kill ${id}?`]);
		assert.equal(procs.of(id).groupAlive(), false);
		assert.equal(s.dialogs.screens.length, 0);
	});

	it("without a UI prints the list through notify and kills nothing", async () => {
		const s = session();
		const id = await start(s, "sleep 30");
		s.ctx.hasUI = false;
		await s.command("bg");
		assert.equal(s.dialogs.selects.length, 0);
		assert.deepEqual(s.dialogs.notices, [`${id} | running | 0.0s | sleep 30`]);
		await clock.tick(3);
		assert.equal(s.sent.length, 0);
		assert.deepEqual(procs.of(id).signals, []);
	});

	it("says so when there are no tasks", async () => {
		const s = session();
		await s.command("bg");
		assert.deepEqual(s.dialogs.notices, ["No background tasks."]);
		assert.equal(s.dialogs.selects.length, 0);
	});
});
