// Behaviour tier: the bash row's timer for a call that started a background task.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, it } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

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

/** The theme Pi passes; its own renderer draws through the global one `initTheme` sets up. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
let clock: ReturnType<typeof fakeClock>;
let procs: FakeProcesses;
beforeEach(() => {
	initTheme();
	procs = fakeProcesses();
	clock = fakeClock();
});
afterEach(() => {
	clock.restore();
	resetRegistry();
	restoreProcesses();
});
after(cleanup);

/** The bash row's result as plain lines, drawn by the tool's renderer with the context fields it reads. */
function rowLines(s: Session, text: string, context: { toolCallId: string; state: object; invalidate: () => void }) {
	const renderResult = s.tool("bash").renderResult;
	assert.ok(renderResult);
	const result = { content: [{ type: "text", text }], details: undefined };
	return renderResult(result, { expanded: false, isPartial: false }, theme, { durationMs: 1200, ...context } as never)
		.render(80)
		.map((line) => stripTerminalSequences(line).trim())
		.filter(Boolean);
}

it("a background call's row counts the task's runtime instead of Pi's Took, and redraws each second until the task ends", async () => {
	const s = session();
	const id = await start(s, "sleep 300");
	const task = getRegistry().tasks.get(id);
	assert.ok(task?.toolCallId);
	let invalidations = 0;
	const context = { toolCallId: task.toolCallId, state: {}, invalidate: () => invalidations++ };
	const lines = () => rowLines(s, `Started background task ${id}.`, context);

	assert.deepEqual(lines(), [`Started background task ${id}.`, "Running 0.0s"]);
	await clock.advance(61_000);
	assert.ok(invalidations >= 60, `${invalidations} redraws`);
	assert.equal(lines().at(-1), "Running 1m 1s");
	procs.of(id).exit(0);
	await clock.until(() => task.state !== "running");
	assert.match(lines().at(-1) ?? "", /^Exited \(code 0\) after 1m \ds$/);
	const before = invalidations;
	await clock.advance(5_000);
	assert.ok(invalidations <= before + 1, "the redraws stop once the task has ended");
});

it("a row whose call started no task keeps Pi's own rendering", () => {
	const lines = rowLines(session(), "hi", { toolCallId: "other", state: {}, invalidate: () => {} });
	assert.ok(!lines.some((line) => line.startsWith("Running")), lines.join("\n"));
});
