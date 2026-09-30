// `pi-bg-bash`: the model's `bash` tool with a `background: true` flag.
//
// A background call starts the command detached, logs it under
// `$XDG_STATE_HOME/pi-bg/<session-id>/`, and returns a task id at once. When
// the command exits the agent gets one completion message, which starts a turn
// if the agent is idle. The footer shows `bg: N` while N tasks run. A call
// without `background` runs through Pi's own bash operations unchanged.
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { taskLine, stateText } from "./notify.ts";
import { readOutput } from "./output.ts";
import { attach, getRegistry, killTask, setContext, startTask } from "./registry.ts";

const BACKGROUND_DESCRIPTION =
	"Set `background: true` to start the command detached and return a task id at once; " +
	"the agent is woken when it finishes. " +
	"Background completion is reported automatically; do not sleep or poll `bash_output` to wait for it.";

export default function (pi: ExtensionAPI): void {
	attach(pi);
	const builtin = createBashToolDefinition(process.cwd());
	pi.registerTool({
		...builtin,
		description: `${builtin.description} ${BACKGROUND_DESCRIPTION}`,
		parameters: Type.Object({
			...builtin.parameters.properties,
			background: Type.Optional(
				Type.Boolean({ description: "Run the command as a detached background task and return its id" }),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			setContext(ctx);
			if (!params.background) return builtin.execute(toolCallId, params, signal, onUpdate, ctx);
			const task = await startTask(params.command, ctx, { timeout: params.timeout });
			return {
				content: [
					{
						type: "text",
						text: `Started background task ${task.id}. Its completion is reported automatically; do not sleep or poll to wait for it.`,
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
			"The result also says whether the task is running or has exited.",
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
			latest: Type.Optional(Type.Boolean({ description: "Skip to the end of the log and return the newest output" })),
			filter: Type.Optional(Type.String({ description: "Regex; return only the matching lines of the output read" })),
		}),
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}`);
			return { content: [{ type: "text", text: readOutput(task, params) }], details: undefined };
		},
	});
	pi.registerTool({
		name: "bash_tasks",
		label: "bash_tasks",
		description:
			"List every background bash task of this session with its id, command, state, runtime, " +
			"and exit code or reason. States: running, exited, killed, exit unknown.",
		parameters: Type.Object({}),
		async execute() {
			const tasks = [...getRegistry().tasks.values()];
			const text = tasks.length === 0 ? "No background tasks." : tasks.map(taskLine).join("\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerTool({
		name: "bash_kill",
		label: "bash_kill",
		description:
			"Stop a background bash task and everything it started: SIGTERM to its process group, then SIGKILL " +
			"after about 3 s if anything is left. No completion message follows; the result reports the final state.",
		parameters: Type.Object({
			id: Type.String({ description: "The task id returned by a background bash call" }),
		}),
		async execute(_toolCallId, params) {
			const task = getRegistry().tasks.get(params.id);
			if (task === undefined) throw new Error(`Unknown task id: ${params.id}`);
			const outcome = await killTask(task, "killed by agent", { notify: false });
			const text =
				outcome === "finished"
					? `Task ${task.id} has already finished: ${stateText(task)}.`
					: outcome === "gone"
						? `Task ${task.id} had already ended: exit unknown.`
						: outcome === "stuck"
							? `Task ${task.id} was sent SIGKILL, but its process group is still running.`
							: `Task ${task.id} killed; its process group is gone.`;
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerCommand("bg", {
		description: "List background bash tasks; pick a running one to kill it",
		handler: async (_args, ctx) => {
			setContext(ctx);
			const tasks = [...getRegistry().tasks.values()];
			if (tasks.length === 0) return ctx.ui.notify("No background tasks.", "info");
			const lines = tasks.map(taskLine);
			if (!ctx.hasUI) return ctx.ui.notify(lines.join("\n"), "info");
			const choice = await ctx.ui.select("Background tasks (pick a running one to kill it)", lines);
			const task = choice === undefined ? undefined : tasks[lines.indexOf(choice)];
			if (task?.state === "running") await killTask(task, "killed by user", { notify: true });
		},
	});
	pi.on("session_start", (_event, ctx) => setContext(ctx));
}
