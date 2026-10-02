// The shell wrapper and its spawn. A task is `sh` running the command, spawned
// detached so it leads its own process group, with stdout and stderr on the
// log's file descriptor. The command travels as an argument, never inside the
// wrapper text, so quotes, `#`, `$` and heredocs reach `sh` as written. When
// the command exits the wrapper appends the marker line that ends the log. A
// separate watcher, its own detached process outside the task's group, kills
// whatever the command left running when Pi dies (see `WATCH`).
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import * as pi from "@earendil-works/pi-coding-agent";

/**
 * The wrapper. `$1` is the command, `$2` the task's nonce, `$3` Pi's pid (unused
 * here; the watcher reads it), the rest the shell and its arguments. It runs the
 * command in that shell, then appends the marker line, which carries the nonce so
 * only this wrapper can write a valid one. The wrapper's own stderr is silenced,
 * so a job notice such as "Killed: 9" for a command that killed itself stays out of
 * the log; the command's stderr still goes to the log, through fd 3, which the
 * command does not inherit.
 */
const WRAPPER = [
	"cmd=$1; nonce=$2; shift 3; exec 3>&2 2>/dev/null",
	'"$@" "$cmd" 2>&3 3>&-; code=$?',
	'printf "\\n__PI_BG_EXIT__:%s:%s\\n" "$nonce" "$code"',
].join("\n");

/**
 * The Pi-gone watcher: its own detached process outside the task's group (spec
 * Q34). `$1` is Pi's pid, `$2` the task's group, `$3` the nonce. It loops while
 * Pi lives, exiting when the group has no members left (`kill -s 0 -- -grp`;
 * EPERM/failure mean empty). When Pi is gone and the group still has members it
 * appends the GONE marker and SIGKILLs the group. `kill -s 0` works in dash and
 * bash 3.2; `kill -0 "$pi"` works in both too.
 */
const WATCH =
	'pi=$1; grp=$2; nonce=$3; exec 2>/dev/null; while kill -0 "$pi"; do kill -s 0 -- "-$grp" || exit 0; sleep 1; done; kill -s 0 -- "-$grp" || exit 0; printf "\\n__PI_BG_GONE__:%s\\n" "$nonce"; kill -s KILL -- "-$grp"';

/** `$XDG_STATE_HOME/pi-bg`, by default `~/.local/state/pi-bg`. */
export function stateRoot(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-bg");
}

/** The file in a session log directory naming the Pi process that created it. */
export const OWNER_FILE = "owner.pid";

/** This session's log directory, created `0o700` and tagged with this process's pid so another Pi can tell it is live. */
export function sessionLogDir(sessionId: string): string {
	const dir = join(stateRoot(), sessionId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	// Written aside and renamed in, so another Pi's cleanup never reads a truncated, empty marker.
	const tmp = join(dir, `${OWNER_FILE}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, String(process.pid), { mode: 0o600 });
		renameSync(tmp, join(dir, OWNER_FILE));
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// nothing more to do
		}
		// the directory stays usable without an owner marker
	}
	return dir;
}

/** The pid in a session directory's owner marker, or `undefined` when it has none or is malformed. */
export function ownerPid(dir: string): number | undefined {
	try {
		const pid = Number(readFileSync(join(dir, OWNER_FILE), "utf8").trim());
		// Bounded like `process.kill`: a larger value throws rather than answering liveness.
		return Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff ? pid : undefined;
	} catch {
		return undefined;
	}
}

export type Shell = { shell: string; args: string[]; env: NodeJS.ProcessEnv };

/**
 * The shell and environment Pi's own `bash` tool uses: `getShellConfig`, and
 * `getShellEnv` (Pi's bin dir at the front of PATH). An export a Pi version
 * lacks falls back: `getShellEnv` to `process.env` with `<agent dir>/bin`
 * prepended, `getShellConfig` (or a throw from it) to `sh -c`.
 */
export function resolveShell(): Shell {
	const api = pi as unknown as Record<string, ((...args: never[]) => unknown) | undefined>;
	let shell = "sh";
	let args = ["-c"];
	try {
		const config = api.getShellConfig?.() as { shell: string; args: string[] } | undefined;
		if (config !== undefined) ({ shell, args } = config);
	} catch {
		// keep sh -c
	}
	let env: NodeJS.ProcessEnv | undefined;
	try {
		env = api.getShellEnv?.() as NodeJS.ProcessEnv | undefined;
	} catch {
		// use the fallback
	}
	if (env === undefined) {
		env = { ...process.env };
		try {
			const bin = join(api.getAgentDir?.() as string, "bin");
			const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
			const current = env[key] ?? "";
			// As Pi's `getShellEnv`: the PATH is kept as written, empty entries included.
			if (!current.split(delimiter).includes(bin)) env[key] = [bin, current].filter(Boolean).join(delimiter);
		} catch {
			// no agent dir: leave PATH alone
		}
	}
	return { shell, args, env };
}

export type LaunchOptions = {
	command: string;
	cwd: string;
	logPath: string;
	/** Random per task; the wrapper writes it into the marker. */
	nonce: string;
	/** Overrides `resolveShell()`, for a caller that already has Pi's environment. */
	shell?: Shell;
	/** The pid the watcher watches: when it is gone the watcher kills the task's group. Default: this process. */
	piPid?: number;
	/** Pi's per-session variables for the command; the same names inherited from `env` are dropped first. */
	sessionEnv?: Record<string, string>;
};

/** The variables Pi's `bash` tool sets from the session, and clears when it has none. */
export const SESSION_ENV_KEYS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

/**
 * Start `command` detached in Pi's shell, writing its output and the marker
 * to the new file `logPath` (which must not exist). Resolves to the wrapper's pid once the process exists; rejects,
 * leaving no log behind, when the working directory is missing or the spawn fails.
 */
export async function launch(options: LaunchOptions): Promise<number> {
	const { command, cwd, logPath, nonce } = options;
	try {
		accessSync(cwd, constants.F_OK);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
	}
	const { shell, args, env: base } = options.shell ?? resolveShell();
	const env = { ...base };
	for (const key of SESSION_ENV_KEYS) delete env[key];
	Object.assign(env, options.sessionEnv);
	// Exclusive: a log that already exists belongs to an earlier run and must not be appended to.
	const fd = openSync(logPath, "wx", 0o600);
	try {
		const child = spawn("sh", ["-c", WRAPPER, "pi-bg", command, nonce, String(options.piPid ?? process.pid), shell, ...args], {
			cwd,
			env,
			detached: true,
			stdio: ["ignore", fd, fd],
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", reject);
		});
		child.on("error", () => {}); // a later error must not become an uncaught exception
		child.unref();
		if (child.pid === undefined) throw new Error(`could not start the shell for ${JSON.stringify(command)}`);
		// The watcher outlives the command while its group has members, and kills them
		// when Pi dies. It fails open: a watcher that cannot start leaves the task
		// running without a crash watch, never failing the task itself.
		try {
			const watcher = spawn("sh", ["-c", WATCH, "pi-bg-watch", String(options.piPid ?? process.pid), String(child.pid), nonce], { detached: true, stdio: ["ignore", fd, fd] });
			watcher.on("error", () => {}); // the async "error" event is the same fail-open path
			watcher.unref();
		} catch {
			// spawn threw synchronously: the task still runs, unprotected.
		}
		return child.pid;
	} catch (error) {
		rmSync(logPath, { force: true });
		throw error;
	} finally {
		closeSync(fd);
	}
}
