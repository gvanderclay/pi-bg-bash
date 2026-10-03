// Behaviour tier: the opt-in debug log (`PI_BG_BASH_DEBUG=1`): what it records,
// that nothing is written without the variable, a swallowed error being logged,
// the rotation at session start, and the 7-day cleanup leaving it alone.
// Fake processes and fake time; the files are real.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { processPort, setProcessPort } from "../src/port.ts";
import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	resetRegistry,
	restoreProcesses,
	session,
	start,
	stateHome,
	text,
} from "./harness.ts";

let clock: ReturnType<typeof fakeClock>;
let procs: FakeProcesses;
const dir = join(stateHome, "pi-bg");
const logFile = join(dir, "debug.log");
const gen = (n: number) => `${logFile}.${n}.gz`;
const MIB = 1024 * 1024;

beforeEach(() => {
	rmSync(dir, { recursive: true, force: true });
	procs = fakeProcesses();
	clock = fakeClock();
});
afterEach(() => {
	delete process.env.PI_BG_BASH_DEBUG;
	clock.restore();
	resetRegistry();
	restoreProcesses();
});
after(cleanup);

type Line = { t: string; event: string; [key: string]: unknown };
const lines = (): Line[] =>
	existsSync(logFile)
		? readFileSync(logFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
const events = (name: string) => lines().filter((l) => l.event === name);
const debugOn = () => {
	process.env.PI_BG_BASH_DEBUG = "1";
};

describe("without PI_BG_BASH_DEBUG", () => {
	it("writes nothing, and rotation does nothing", async () => {
		const s = session();
		const id = await start(s, "job", { timeout: 5 });
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		mkdirSync(dir, { recursive: true });
		writeFileSync(logFile, Buffer.alloc(6 * MIB));
		await s.sessionStart();
		assert.equal(statSync(logFile).size, 6 * MIB);
		assert.equal(existsSync(gen(1)), false);
		rmSync(logFile);
		await start(s, "other");
		assert.equal(existsSync(logFile), false);
	});

	it("is on only for the value 1", async () => {
		process.env.PI_BG_BASH_DEBUG = "0";
		await start(session(), "job");
		assert.equal(existsSync(logFile), false);
	});
});

describe("with PI_BG_BASH_DEBUG=1", () => {
	it("records task start and exit as JSON lines with a timestamp, in a 0600 file", async () => {
		debugOn();
		const s = session();
		const id = await start(s, "echo one\necho two");
		procs.of(id).exit(3);
		await clock.until(() => s.sent.length > 0);
		const [started] = events("task-start");
		assert.equal(started.task, id);
		assert.equal(started.session, s.id);
		assert.equal(started.command, "echo one ⏎ echo two");
		assert.ok(!Number.isNaN(Date.parse(started.t)));
		const [exited] = events("task-exit");
		assert.equal(exited.task, id);
		assert.equal(exited.state, "exited");
		assert.equal(exited.exitCode, 3);
		assert.equal(statSync(logFile).mode & 0o777, 0o600);
	});

	it("records a kill with its reason and outcome", async () => {
		debugOn();
		const s = session();
		const id = await start(s, "server");
		const kill = s.toolCall("bash_kill", { id });
		await clock.settle(kill);
		assert.equal(events("kill-request")[0].reason, "killed by agent");
		const [killed] = events("kill");
		assert.equal(killed.task, id);
		assert.equal(killed.reason, "killed by agent");
		assert.equal(killed.state, "killed");
		assert.equal(killed.outcome, "stopped");
	});

	it("records the deadline firing", async () => {
		debugOn();
		const s = session();
		const id = await start(s, "slow", { timeout: 5 });
		await clock.until(() => s.sent.length > 0);
		assert.equal(events("deadline")[0].task, id);
		assert.equal(events("kill")[0].reason, "timed out");
	});

	it("records the automatic promotion and the shortcut promotion", async () => {
		debugOn();
		const s = session();
		const auto = s.toolCall("bash", { command: "slow-build" });
		await clock.advance(100);
		assert.match(text(await clock.settle(auto)), /moved to the background as task bg-1/);
		const byShortcut = s.toolCall("bash", { command: "other-build" });
		await clock.advance(100);
		s.shortcut("ctrl+shift+b");
		await clock.settle(byShortcut);
		const promoted = events("promote");
		assert.deepEqual(
			promoted.map((p) => [p.by, p.command]),
			[
				["timer", "slow-build"],
				["shortcut", "other-build"],
			],
		);
		assert.equal(events("task-start").length, 2);
	});

	it("logs an error the code swallows, with where, message and stack", async () => {
		debugOn();
		const s = session();
		await start(s, "job");
		const real = processPort();
		setProcessPort({
			...real,
			pidAlive: () => {
				throw new Error("probe failed");
			},
		});
		await clock.tick(1);
		const [error] = events("error");
		assert.equal(error.where, "poll");
		assert.equal(error.error, "probe failed");
		assert.match(String(error.stack), /probe failed/);
		assert.equal(error.task, "bg-1");
	});

	it("never throws when the log cannot be written", async () => {
		debugOn();
		mkdirSync(logFile, { recursive: true }); // a directory where the file should be
		const s = session();
		await start(s, "job");
		assert.equal(statSync(logFile).isDirectory(), true);
	});
});

describe("rotation at session start", () => {
	const big = (byte: string, size = 6 * MIB) => Buffer.alloc(size, byte);
	const unzipped = (n: number) => gunzipSync(readFileSync(gen(n))).toString("utf8");

	it("gzips a log over 5 MiB into debug.log.1.gz and starts a new one", async () => {
		debugOn();
		mkdirSync(dir, { recursive: true });
		writeFileSync(logFile, big("a"));
		await session().sessionStart();
		assert.equal(unzipped(1), "a".repeat(6 * MIB));
		assert.equal(statSync(gen(1)).mode & 0o777, 0o600);
		assert.ok(!readFileSync(logFile, "utf8").includes("aaaa"));
		assert.deepEqual(events("rotate").length, 1, "the rotation is itself recorded in the new log");
	});

	it("shifts the generations and drops the sixth", async () => {
		debugOn();
		mkdirSync(dir, { recursive: true });
		for (let n = 1; n <= 5; n++) writeFileSync(gen(n), gzipSync(`gen${n}`));
		writeFileSync(logFile, big("n"));
		await session().sessionStart();
		assert.equal(unzipped(1), "n".repeat(6 * MIB));
		for (let n = 2; n <= 5; n++) assert.equal(unzipped(n), `gen${n - 1}`);
		assert.equal(existsSync(gen(6)), false);
	});

	it("leaves a log of 5 MiB or less alone", async () => {
		debugOn();
		mkdirSync(dir, { recursive: true });
		writeFileSync(logFile, big("a", 5 * MIB));
		await session().sessionStart();
		assert.equal(statSync(logFile).size, 5 * MIB);
		assert.equal(existsSync(gen(1)), false);
	});
});

describe("the 7-day cleanup", () => {
	it("leaves debug.log and its generations alone, however old", async () => {
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		mkdirSync(dir, { recursive: true });
		const files = [logFile, ...[1, 2, 3, 4, 5].map(gen)];
		for (const file of files) {
			writeFileSync(file, "x");
			utimesSync(file, old, old);
		}
		await session().sessionStart();
		for (const file of files) assert.equal(existsSync(file), true, file);
	});
});
