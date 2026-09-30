// The group kill: SIGTERM the task's process group, wait about 3 s, then
// SIGKILL what is left. The wrapper leads its own group (it is spawned
// detached), so the signal reaches the command and everything it started.
// Callers pass only pids the registry launched, never a pid read from anywhere else.
// It runs on `setTimeout`, above the process port, so fake time can drive it.
import { processPort } from "./port.ts";

/** How long the group gets to end after SIGTERM before SIGKILL. */
const GRACE_MS = 3000;
/** How long to wait for the group to vanish after SIGKILL. */
const AFTER_KILL_MS = 1000;
/** How often the group is looked at while waiting. */
const STEP_MS = 100;

/** The grace period; the contract tests shorten it with `PI_BG_BASH_GRACE_MS`. */
function graceMs(): number {
	const set = Number(process.env.PI_BG_BASH_GRACE_MS);
	return Number.isFinite(set) && set > 0 ? set : GRACE_MS;
}

/** How the group ended: it was already `gone`, it `stopped` (on SIGTERM or after SIGKILL), or it is `stuck`, still there after SIGKILL. */
export type GroupKill = "gone" | "stopped" | "stuck";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wait up to `ms` for the group to end; true when it did. */
async function waitGone(pid: number, ms: number): Promise<boolean> {
	for (let waited = 0; waited < ms; waited += STEP_MS) {
		await sleep(STEP_MS);
		if (!processPort().groupAlive(pid)) return true;
	}
	return false;
}

/** Stop the process group led by `pid`. Resolves once it is gone, or after SIGKILL had a second to work. */
export async function killGroup(pid: number): Promise<GroupKill> {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal process group ${pid}`);
	const port = processPort();
	if (!port.signalGroup(pid, "SIGTERM")) return "gone";
	if (await waitGone(pid, graceMs())) return "stopped";
	port.signalGroup(pid, "SIGKILL");
	return (await waitGone(pid, AFTER_KILL_MS)) ? "stopped" : "stuck";
}

/** Stop the process group at once with SIGKILL, as Pi's own `bash` does for a foreground command; resolves once it is gone, or after a second. */
export async function killGroupNow(pid: number): Promise<GroupKill> {
	if (!Number.isInteger(pid) || pid <= 1) throw new Error(`refusing to signal process group ${pid}`);
	if (!processPort().signalGroup(pid, "SIGKILL")) return "gone";
	return (await waitGone(pid, AFTER_KILL_MS)) ? "stopped" : "stuck";
}
