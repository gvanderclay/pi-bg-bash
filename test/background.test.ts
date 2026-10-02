// Behaviour tier: starting a background task and the completion message, the
// log's place and mode, the footer and the tool's schema.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";

import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	cleanup,
	type FakeProcesses,
	fakeClock,
	fakeProcesses,
	gzipped,
	resetRegistry,
	restoreProcesses,
	root,
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

describe("bash with background: true", () => {
	it("returns a task id without waiting for the command", async () => {
		const s = session();
		const result = await s.toolCall("bash", { command: "sleep 30", background: true });
		assert.match(text(result), /^Started background task bg-\d+\./);
		assert.equal(s.sent.length, 0);
		procs.all[0].exit(0);
		await clock.until(() => s.sent.length > 0);
	});

	it("sends exactly one follow-up message that names the id, command, exit, runtime and output", async () => {
		const s = session();
		const id = await start(s, "echo one; echo two");
		procs.of(id).write("one\ntwo\n");
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		await clock.tick(3); // more ticks must not resend
		assert.equal(s.sent.length, 1);
		const { message, options } = s.sent[0];
		assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
		assert.equal(message.display, true);
		assert.equal(
			message.content,
			`Background task ${id} finished: exited (code 0), ran 2.0s.\nCommand: echo one; echo two\nLast output:\none\ntwo`,
		);
	});

	it("reports a non-zero exit with its code and says when there was no output", async () => {
		const s = session();
		const id = await start(s, "echo boom; exit 7");
		procs.of(id).write("boom\n");
		procs.of(id).exit(7);
		await clock.until(() => s.sent.length > 0);
		assert.match(s.sent[0].message.content, /finished: exited \(code 7\), ran 2\.0s\./);
		assert.match(s.sent[0].message.content, /Last output:\nboom$/);
		const quiet = await start(s, "exit 1");
		procs.of(quiet).exit(1);
		await clock.until(() => s.sent.length > 1);
		assert.match(s.sent[1].message.content, /\(no output\)$/);
	});

	it("gzipps the log after completion, keeping it private and ending with the exit marker", async () => {
		const s = session();
		const id = await start(s, "echo hi; exit 3");
		procs.of(id).write("hi\n");
		procs.of(id).exit(3);
		await clock.until(() => s.sent.length > 0);
		await clock.until(() => gzipped(s, id));
		assert.deepEqual(readdirSync(s.logDir()).sort(), [`${id}.log.gz`, "owner.pid"].sort());
		assert.equal(statSync(s.logDir()).mode & 0o777, 0o700);
		assert.equal(statSync(join(s.logDir(), `${id}.log.gz`)).mode & 0o777, 0o600);
		assert.match(
			gunzipSync(readFileSync(join(s.logDir(), `${id}.log.gz`))).toString("utf8"),
			/^hi\n\n__PI_BG_EXIT__:[0-9a-f]{16}:3\n$/,
		);
	});

	it("hands the launch the command, the working directory and Pi's session variables from the context", async () => {
		const s = session();
		const id = await start(s, "env");
		const proc = procs.of(id);
		assert.equal(proc.command, "env");
		assert.equal(proc.cwd, root);
		assert.deepEqual(proc.sessionEnv, {
			PI_SESSION_ID: s.id,
			PI_SESSION_FILE: join(root, "sessions", `${s.id}.jsonl`),
			PI_PROVIDER: "test-provider",
			PI_MODEL: "test-model",
			PI_REASONING_LEVEL: "high",
		});
		s.ctx.model = undefined;
		s.ctx.thinkingLevel = undefined;
		s.ctx.sessionManager.getSessionFile = () => undefined as never;
		const bare = await start(s, "env");
		assert.deepEqual(procs.of(bare).sessionEnv, { PI_SESSION_ID: s.id });
	});

	it("shows bg: 1 while the task runs and clears the footer when it ends", async () => {
		const s = session();
		const id = await start(s, "sleep 0.3");
		assert.deepEqual(s.statuses, [{ key: "bg", text: "bg: 1" }]);
		procs.of(id).exit(0);
		await clock.until(() => s.sent.length > 0);
		assert.deepEqual(s.statuses.at(-1), { key: "bg", text: undefined });
	});
});

describe("the bash tool's schema", () => {
	it("keeps the built-in schema and adds background, with the no-polling line in the description", () => {
		const tool = session().tool("bash");
		const builtin = createBashToolDefinition(root);
		assert.ok(tool.description.startsWith(builtin.description));
		assert.match(tool.description, /Set `background: true` for a command you expect to outlast a minute or two/);
		assert.match(tool.description, /so do not sleep or poll `bash_output` to wait for it/);
		assert.match(
			tool.description,
			/`gh run watch <run-id> --exit-status`.*instead of running `sleep N` and a check yourself/,
		);
		assert.doesNotMatch(tool.description.slice(builtin.description.length), /until [^;]*; do sleep/);
		const properties = Object.keys((tool.parameters as { properties: object }).properties);
		assert.deepEqual(properties.sort(), ["background", "command", "timeout"]);
	});
});
