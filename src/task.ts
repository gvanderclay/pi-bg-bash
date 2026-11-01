// Task construction and launch, shared by background calls and foreground promotion.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debugError } from "./debug.ts";
import { removeHold, reserveHold } from "./holds.ts";
import { sessionLogDir } from "./launch.ts";
import { adopt, getRegistry, launchGroup, type Task } from "./registry.ts";

/** A log, id and nonce reserved for a command about to launch. */
export type Reservation = { id: string; logPath: string; nonce: string };

/** Reserve the next free task id and its log under `sessionId`. Ids restart per process but logs belong to the session: skip any id an earlier run of it used. */
export function reserve(sessionId: string): Reservation {
	const registry = getRegistry();
	const dir = sessionLogDir(sessionId);
	let id: string;
	do id = `bg-${registry.nextId++}`;
	while (existsSync(join(dir, `${id}.log`)) || existsSync(join(dir, `${id}.log.gz`)));
	return { id, logPath: join(dir, `${id}.log`), nonce: randomBytes(8).toString("hex") };
}

/** Give back the id of a reservation nothing came of, when it is the newest, so ids stay consecutive. */
export function release(reservation: Reservation): void {
	const registry = getRegistry();
	if (reservation.id === `bg-${registry.nextId - 1}`) registry.nextId--;
}

/** A running task for a launched process; `startedAt` is when it really began. Not registered yet: see `adopt`. */
export function makeTask(
	reservation: Reservation,
	launched: {
		command: string;
		cwd: string;
		pid: number;
		startedAt: number;
		ownerSessionId: string;
		timeout?: number;
		holdId?: string;
	},
): Task {
	const { id, logPath, nonce } = reservation;
	const { command, cwd, pid, startedAt } = launched;
	return {
		id,
		ownerSessionId: launched.ownerSessionId,
		terminalToken: randomBytes(16).toString("hex"),
		terminalObserved: false,
		holdId: launched.holdId,
		command,
		cwd,
		logPath,
		pid,
		nonce,
		scanFrom: 0,
		startedAt,
		deadline: launched.timeout !== undefined && launched.timeout > 0 ? startedAt + launched.timeout * 1000 : undefined,
		state: "running",
		readPosition: 0,
		notified: false,
		readFailures: 0,
	};
}

/** Start `command` as a registered background task under `ctx`'s session. */
export async function startTask(
	command: string,
	ctx: ExtensionContext,
	options: { timeout?: number; hold?: boolean } = {},
): Promise<Task> {
	getRegistry().ctx = ctx;
	const ownerSessionId = ctx.sessionManager.getSessionId();
	const holdId = options.hold ? reserveHold(ownerSessionId) : undefined;
	try {
		const reservation = reserve(ownerSessionId);
		const { logPath, nonce } = reservation;
		const pid = await launchGroup({ command, cwd: ctx.cwd, logPath, nonce, sessionEnv: sessionEnv(ctx) });
		return adopt(
			makeTask(reservation, {
				command,
				cwd: ctx.cwd,
				pid,
				startedAt: Date.now(),
				timeout: options.timeout,
				ownerSessionId,
				holdId,
			}),
		);
	} catch (error) {
		if (holdId !== undefined) {
			try {
				removeHold(ownerSessionId, holdId);
			} catch (cleanupError) {
				debugError("hold-refund", cleanupError);
			}
		}
		throw error;
	}
}

/**
 * What Pi's `resolveSpawnContext` exports from the session, as far as `ctx`
 * reaches: id, session file, model provider and id, and the reasoning level.
 */
function sessionEnv(ctx: ExtensionContext): Record<string, string> {
	const env: Record<string, string> = { PI_SESSION_ID: ctx.sessionManager.getSessionId() };
	const file = ctx.sessionManager.getSessionFile();
	if (file) env.PI_SESSION_FILE = file;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}
