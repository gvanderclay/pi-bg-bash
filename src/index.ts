// `pi-bg-bash`: the model's `bash` tool with a `background: true` flag.
//
// A background call starts the command detached, logs it under
// `$XDG_STATE_HOME/pi-bg/<session-id>/`, and returns a task id at once. When
// the command exits the agent gets one completion message, which starts a turn
// if the agent is idle. The footer shows `bg: N` while N tasks run. A call
// without `background` is Pi's own `bash` over the same wrapper (`foreground.ts`),
// and moves to the background if it outlasts 120 s.
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

import { bgCommand } from "./bg.ts";
import { rotateDebugLog } from "./debug.ts";
import { COMPLETION_TEXT, foregroundRuns, PROMOTE_MS, runForeground } from "./foreground.ts";
import { GRACE_MS } from "./kill.ts";
import { cleanupOldLogs } from "./logs.ts";
import { stateText, taskData, taskLine } from "./notify.ts";
import { readOutput } from "./output.ts";
import { attach, endSession, getRegistry, killTask, setContext, startTask } from "./registry.ts";

const BACKGROUND_DESCRIPTION =
	"Set `background: true` for a command you expect to outlast a minute or two, such as a long build, a deploy or a server, " +
	"when you have other work to do meanwhile or nothing to do until it ends. " +
	"The call returns a task id at once; when the command exits, a message with its exit status and last lines of output arrives " +
	"and starts a turn if you are idle, so do not sleep or poll `bash_output` to wait for it. " +
	"To wait for something outside this machine, such as CI, background one command that blocks until it is done, " +
	"such as `gh run watch <run-id> --exit-status` or `gh pr checks <number> --watch`, instead of running `sleep N` and a check yourself. " +
	`A foreground command with no \`timeout\` still running after ${PROMOTE_MS / 1000} s (unless it starts with \`sleep\`) moves to the background on its own.`;

// No guard for a Pi without `outputSchema`, unlike bash's: these schemas stand alone,
// and such a Pi ignores the unknown fields.
const STATE_FIELDS = {
	task_id: Type.String(),
	state: Type.Union([
		Type.Literal("running"),
		Type.Literal("exited"),
		Type.Literal("killed"),
		Type.Literal("exit-unknown"),
	]),
	exit_code: Type.Optional(Type.Number({ description: "Set when state is exited" })),
	reason: Type.Optional(
		Type.Union(
			[
				Type.Literal("killed by agent"),
				Type.Literal("killed by user"),
				Type.Literal("timed out"),
				Type.Literal("log limit passed"),
			],
			{ description: "Set when state is killed" },
		),
	),
};
const TASK_FIELDS = {
	...STATE_FIELDS,
	command: Type.String(),
	started_at_ms: Type.Number({ description: "Epoch milliseconds" }),
	ended_at_ms: Type.Optional(Type.Number({ description: "Epoch milliseconds; absent while running" })),
	runtime_ms: Type.Number(),
};

export default function (pi: ExtensionAPI): void {
	attach(pi);
	// The user can move the running foreground command to the background at once.
	pi.registerShortcut("ctrl+shift+b", {
		description: "Move the running foreground command to the background",
		handler: (ctx) => {
			setContext(ctx);
			// One press promotes every foreground call in flight: with parallel tool
			// calls the turn stays blocked until all finish, so several can be running
			// at once.
			for (const run of foregroundRuns()) run.promote("shortcut");
		},
	});
	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${BACKGROUND_DESCRIPTION}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			waitFor: Type.Optional(
				Type.String({
					description:
						'Text to wait for in the output, such as "listening on" for a server. When it appears the call returns the output so far and the command keeps running as a background task. A `timeout` then limits the task, not the call.',
				}),
			),
			background: Type.Optional(
				Type.Boolean({ description: "Run the command as a detached background task and return its id" }),
			),
		}),
		// A Pi whose bash has no output schema returns no structured result to extend.
		outputSchema:
			builtin.outputSchema &&
			Type.Object({
				...(builtin.outputSchema as TObject).properties,
				exit_code: Type.Optional(Type.Number({ description: "Absent while the command runs on as task_id" })),
				task_id: Type.Optional(
					Type.String({
						description: "Set when the command runs on as a background task; pass it to bash_output or bash_kill",
					}),
				),
			}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			setContext(ctx);
			if (params.waitFor !== undefined && params.background)
				throw new Error("waitFor applies to foreground calls: drop `background: true`, or drop `waitFor`.");
			if (!params.background) return runForeground(toolCallId, params, signal, onUpdate, ctx);
			const startedAt = Date.now();
			const task = await startTask(params.command, ctx, { timeout: params.timeout });
			return {
				structuredContent: {
					output: "",
					truncated: false,
					wall_time_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
					task_id: task.id,
				},
				content: [
					{
						type: "text",
						text: `Started background task ${task.id}. ${COMPLETION_TEXT}`,
					},
				],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "bash_output",
		label: "bash_output",
		description:
			"Read the output of a background bash task from where you last stopped, capped like `bash`. " +
			"Each call returns only output you have not read yet and says how much remains. " +
			"`latest: true` skips to the newest unread output. `filter` is a regex that keeps only matching lines. " +
			"The result also says whether the task is running or has exited. " +
			"Do not call it again and again to wait for the task to end: its completion is reported automatically.",
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
			latest: Type.Optional(Type.Boolean({ description: "Skip to the end of the log and return the newest output" })),
			filter: Type.Optional(Type.String({ description: "Regex; return only the matching lines of the output read" })),
		}),
		outputSchema: Type.Object({
			...STATE_FIELDS,
			output: Type.String({ description: "The unread output this call returned, after `filter`" }),
			truncated: Type.Boolean({ description: "More output remains unread, or `latest` skipped some" }),
			unread_bytes: Type.Number({
				description: "Log bytes not yet read; the task is done when state is not running and this is 0",
			}),
		}),
		// Not read-only: each call moves the task's read position.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. bash_tasks lists this session's tasks.`);
			const read = readOutput(task, params);
			return { structuredContent: read.data, content: [{ type: "text", text: read.text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "bash_tasks",
		label: "bash_tasks",
		description:
			"List every background bash task of this session with its id, command, state, runtime, " +
			"and exit code or reason. States: running, exited, killed, exit unknown.",
		parameters: Type.Object({}),
		outputSchema: Type.Object({ tasks: Type.Array(Type.Object(TASK_FIELDS)) }),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute() {
			const tasks = [...getRegistry().tasks.values()];
			const text = tasks.length === 0 ? "No background tasks." : tasks.map(taskLine).join("\n");
			return {
				structuredContent: { tasks: tasks.map(taskData) },
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	});
	pi.registerTool({
		name: "bash_kill",
		label: "bash_kill",
		description:
			"Stop a background bash task and everything it started: SIGTERM to its process group, then SIGKILL " +
			`after about ${GRACE_MS / 1000} s if anything is left. No completion message follows; the result reports the final state.`,
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
		}),
		outputSchema: Type.Object({
			...TASK_FIELDS,
			outcome: Type.Union(
				[
					Type.Literal("killed"),
					Type.Literal("finished"),
					Type.Literal("gone"),
					Type.Literal("cleared"),
					Type.Literal("stuck"),
					Type.Literal("leftover-stuck"),
				],
				{
					description:
						"killed: stopped now; finished: had already ended; gone: had already ended, exit unknown; " +
						"cleared: had ended, its leftover processes stopped; stuck or leftover-stuck: survived SIGKILL",
				},
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}. bash_tasks lists this session's tasks.`);
			const outcome = await killTask(task, "killed by agent", { notify: false });
			const text =
				outcome === "finished"
					? `Task ${task.id} has already finished: ${stateText(task)}.`
					: outcome === "gone"
						? `Task ${task.id} had already ended: exit unknown.`
						: outcome === "cleared"
							? `Task ${task.id} had already finished: ${stateText(task)}; stopped the processes it left running.`
							: outcome === "leftover-stuck"
								? `Task ${task.id} had already finished: ${stateText(task)}; the processes it left running survived SIGKILL and are still running.`
								: outcome === "stuck"
									? `Task ${task.id} was sent SIGKILL, but its process group is still running.`
									: `Task ${task.id} killed; its process group is gone.`;
			return {
				structuredContent: { ...taskData(task), outcome },
				content: [{ type: "text", text }],
				details: undefined,
			};
		},
	});
	pi.registerCommand("bg", {
		description: "List background bash tasks: enter shows a task's output, x kills it",
		handler: async (_args, ctx) => {
			setContext(ctx);
			await bgCommand(ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		setContext(ctx);
		rotateDebugLog();
		cleanupOldLogs(getRegistry().tasks.values());
	});
	// Tasks belong to the session: a reload keeps them (the new load takes them over), every other end kills them.
	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "reload") await endSession();
	});
}
