import type { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Container, Text } from "@earendil-works/pi-tui";

import { runtimeText, stateText } from "./notify.ts";
import { getRegistry, type Task, updateFooter } from "./registry.ts";

type RenderResult = NonNullable<ReturnType<typeof createBashToolDefinition>["renderResult"]>;
type Args = Parameters<RenderResult>;

/** The row's timer line: how long the task has run, or how it ended and after how long. */
export function timerText(task: Task): string {
	if (task.state === "running") return `Running ${runtimeText(task)}`;
	const state = stateText(task);
	return `${state[0].toUpperCase()}${state.slice(1)} after ${runtimeText(task)}`;
}

/**
 * Pi's bash result renderer, with Pi's `Took` line replaced by the task's own timer on a row whose
 * call started or became a background task. Pi's line would show how long the call took, which
 * for `background: true` is no time at all.
 */
export function withTaskTimer(builtin: RenderResult): RenderResult {
	return (result: Args[0], options: Args[1], theme: Args[2], context: Args[3]) => {
		const registry = getRegistry();
		const task = [...registry.tasks.values()].find((t) => t.toolCallId === context.toolCallId);
		if (task === undefined) return builtin(result, options, theme, context);
		const state = context.state as { taskTimer?: ReturnType<typeof setInterval> };
		if (task.state === "running" && state.taskTimer === undefined) {
			let ended = false;
			const timer = setInterval(() => {
				// Node 22's mock timers keep firing an interval cleared from its own callback; the flag keeps the tests' redraw count true.
				if (ended) return;
				ended = task.state !== "running" || registry.tasks.get(task.id) !== task;
				if (ended) clearInterval(timer);
				context.invalidate();
				// Invalidating marks the row stale; the screen only redraws on a render request, which an idle
				// agent never makes. Pi requests one on every status update.
				updateFooter();
			}, 1000);
			timer.unref?.();
			state.taskTimer = timer;
		}
		// A state with no start time and no duration makes Pi leave its `Took` line out.
		const component = builtin(result, options, theme, {
			...context,
			state: {} as Args[3]["state"],
			durationMs: undefined,
		}) as Container;
		component.addChild(new Text(`\n${theme.fg("muted", timerText(task))}`, 0, 0));
		return component;
	};
}
