// The process port: the extension's only contact with real processes. It has
// four operations, at the level of launch, signal and liveness, and owns the
// errno mapping: ESRCH, and the EPERM macOS answers for a zombie-only group (or
// for a pid that now belongs to someone else), both mean "gone". Everything above
// it (the TERM, grace, KILL escalation, the poller) runs on timers and can be
// driven by fake time against a fake port; see `test/harness.ts`.
import { type LaunchOptions, launch } from "./launch.ts";

export type ProcessPort = {
	/** Start a task detached; resolves to its pid, rejects as `launch` does. */
	launch(options: LaunchOptions): Promise<number>;
	/** Send `signal` to the process group `pid` leads; false when nothing is left to signal. */
	signalGroup(pid: number, signal: NodeJS.Signals): boolean;
	/** Whether anything is left in the process group `pid` leads. */
	groupAlive(pid: number): boolean;
	/** Whether the process `pid` exists. */
	pidAlive(pid: number): boolean;
};

/** Run `kill`: true when the signal reached something, false on "no such process" or "not permitted" (nothing of ours is left). */
function reached(send: () => void): boolean {
	try {
		send();
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "EPERM") return false;
		throw error;
	}
}

export const realPort: ProcessPort = {
	launch,
	signalGroup: (pid, signal) => reached(() => process.kill(-pid, signal)),
	groupAlive: (pid) => reached(() => process.kill(-pid, 0)),
	pidAlive: (pid) => reached(() => process.kill(pid, 0)),
};

let current: ProcessPort = realPort;

/** The port the extension uses: the real one unless the test harness replaced it. */
export function processPort(): ProcessPort {
	return current;
}

/** For the test harness only: swap the port. Nothing in the extension calls this. */
export function setProcessPort(port: ProcessPort): void {
	current = port;
}
