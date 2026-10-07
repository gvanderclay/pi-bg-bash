// The `/bg` command. In the terminal UI it lists the tasks: enter shows a task's
// output, x kills the task after a confirmation, q or esc closes the list. In RPC mode,
// which has no custom components, a picked task is killed after a confirmation.
// Without a UI it prints the list.
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DynamicBorder,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	matchesKey,
	SelectList,
	Text,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { logTail, oneLine, taskLine } from "./notify.ts";
import { getRegistry, killTask, type Task } from "./registry.ts";

/** How often the open list and output view re-read the registry and the log. */
const REFRESH_MS = 1000;

type Pick = { task: Task; action: "view" | "kill" };

/** The tasks as `/bg` lists them: running first, then the most recently started. */
function listed(): Task[] {
	return [...getRegistry().tasks.values()].sort(
		(a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt,
	);
}

export async function bgCommand(ctx: ExtensionCommandContext): Promise<void> {
	const tasks = listed;
	if (tasks().length === 0) return ctx.ui.notify("No background tasks.", "info");
	if (!ctx.hasUI) return ctx.ui.notify(tasks().map(taskLine).join("\n"), "info");
	if (ctx.mode !== "tui") {
		const list = tasks();
		const lines = list.map(taskLine);
		const choice = await ctx.ui.select("Background tasks (pick one to kill it)", lines);
		const task = choice === undefined ? undefined : list[lines.indexOf(choice)];
		if (task !== undefined) await confirmKill(task, ctx);
		return;
	}
	let selected: string | undefined;
	// The list comes back after each view or kill, with the tasks' current state, until esc.
	while (tasks().length > 0) {
		const at = selected;
		const pick = await ctx.ui.custom<Pick | undefined>((tui, theme, _keys, done) => taskList(at, tui, theme, done));
		if (pick === undefined) return;
		selected = pick.task.id;
		if (pick.action === "kill") await confirmKill(pick.task, ctx);
		else await ctx.ui.custom<void>((tui, theme, _keys, done) => outputView(pick.task, tui, theme, done));
	}
}

async function confirmKill(task: Task, ctx: ExtensionCommandContext): Promise<void> {
	const title = task.state === "running" ? `Kill ${task.id}?` : `Stop what ${task.id} left running?`;
	if (!(await ctx.ui.confirm(title, oneLine(task.command)))) return;
	const outcome = await killTask(task, "killed by user", { notify: true });
	if (outcome === "finished" || outcome === "gone")
		ctx.ui.notify(`Task ${task.id} had already finished; nothing was left running.`, "info");
	if (outcome === "cleared") ctx.ui.notify(`Task ${task.id}: stopped the processes it left running.`, "info");
	if (outcome === "leftover-stuck")
		ctx.ui.notify(`Task ${task.id}: the processes it left running survived SIGKILL and are still running.`, "warning");
}

function taskList(
	selectedId: string | undefined,
	tui: TUI,
	theme: Theme,
	done: (pick: Pick | undefined) => void,
): Component {
	const accent = (text: string): string => theme.fg("accent", text);
	const muted = (text: string): string => theme.fg("muted", text);
	let tasks: Task[] = [];
	let list: SelectList;
	const container = new Container();
	// SelectList cannot swap its items, so each refresh builds a new one and keeps the selected task.
	const build = (keep: string | undefined, fallback: number): void => {
		tasks = listed();
		const items = tasks.map((task) => ({ value: task.id, label: taskLine(task) }));
		list = new SelectList(items, Math.max(1, Math.min(items.length, 10)), {
			selectedPrefix: accent,
			selectedText: accent,
			description: muted,
			scrollInfo: muted,
			noMatch: muted,
		});
		const at = tasks.findIndex((task) => task.id === keep);
		list.setSelectedIndex(at >= 0 ? at : Math.min(fallback, Math.max(0, tasks.length - 1)));
		list.onSelect = (): void => {
			const task = current();
			if (task !== undefined) finish({ task, action: "view" });
		};
		list.onCancel = (): void => finish(undefined);
		container.clear();
		container.addChild(new DynamicBorder(accent));
		container.addChild(new Text(accent(theme.bold("Background tasks"))));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ select • enter view output • x kill • q/esc close")));
		container.addChild(new DynamicBorder(accent));
	};
	const current = (): Task | undefined => tasks.find((task) => task.id === list.getSelectedItem()?.value);
	const timer = setInterval(() => {
		build(current()?.id, Math.max(0, tasks.indexOf(current() as Task)));
		tui.requestRender();
	}, REFRESH_MS);
	const finish = (pick: Pick | undefined): void => {
		clearInterval(timer);
		done(pick);
	};
	build(selectedId, 0);
	return {
		render: (width: number): string[] => container.render(width),
		invalidate: (): void => container.invalidate(),
		handleInput(data: string): void {
			const task = current();
			if (matchesKey(data, "x") && task !== undefined) finish({ task, action: "kill" });
			else if (matchesKey(data, "q")) finish(undefined);
			else list.handleInput(data);
			tui.requestRender();
		},
	};
}

/** Lines of chrome around the output: two borders, the title and the hint. */
const CHROME = 4;

/** The end of the task's log, scrollable, opened at the bottom and following the log while it is there. Never moves the read position. */
function outputView(task: Task, tui: TUI, theme: Theme, done: () => void): Component {
	const read = (): { lines: string[]; cut: boolean } => {
		const { text, cut } = logTail(task, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
		return { lines: (text === "" ? "(no output)" : text).replace(/\t/g, "    ").split("\n"), cut };
	};
	let { lines, cut } = read();
	let rows: string[] = [];
	let wrappedAt = 0;
	let top = Number.POSITIVE_INFINITY;
	// ponytail: fills the terminal less a little room for Pi's own rows; an overlay if that crowds them.
	const height = (): number => Math.max(3, tui.terminal.rows - CHROME - 2);
	const clamp = (): void => {
		top = Math.max(0, Math.min(top, rows.length - height()));
	};
	const timer = setInterval(() => {
		clamp();
		const atBottom = top >= rows.length - height();
		({ lines, cut } = read());
		wrappedAt = 0; // render wraps the new lines
		if (atBottom) top = Number.POSITIVE_INFINITY;
		tui.requestRender();
	}, REFRESH_MS);
	return {
		render(width: number): string[] {
			if (width !== wrappedAt) {
				rows = lines.flatMap((line) => wrapTextWithAnsi(line, width));
				wrappedAt = width;
			}
			clamp();
			const body = rows.slice(top, top + height());
			const where = `lines ${top + 1}–${top + body.length} of ${rows.length}${cut ? ", earlier output not shown" : ""}`;
			const border = theme.fg("accent", "─".repeat(width));
			return [
				border,
				truncateToWidth(theme.fg("accent", theme.bold(taskLine(task))), width),
				...body,
				truncateToWidth(theme.fg("dim", `${where} • ↑↓ pgup pgdn home end scroll • esc back`), width),
				border,
			];
		},
		invalidate(): void {
			wrappedAt = 0;
		},
		handleInput(data: string): void {
			clamp();
			if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "q")) {
				clearInterval(timer);
				done();
			} else if (matchesKey(data, "up")) top -= 1;
			else if (matchesKey(data, "down")) top += 1;
			else if (matchesKey(data, "pageUp")) top -= height();
			else if (matchesKey(data, "pageDown")) top += height();
			else if (matchesKey(data, "home")) top = 0;
			else if (matchesKey(data, "end")) top = Number.POSITIVE_INFINITY;
			tui.requestRender();
		},
	};
}
