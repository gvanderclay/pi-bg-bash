// Shared, process-local completion data. The host registers only its live session;
// providers own their entries. No callbacks, transport or durable task registry.
import { randomBytes } from "node:crypto";

export const HOLDS_KEY = Symbol.for("pi.completion-holds.v1");
export type Hold = { provider: string; ready: boolean };
export type HoldTable = {
	version: 1;
	hosts: Map<string, Map<string, string>>;
	holds: Map<string, Map<string, Hold>>;
};
const PROVIDER = "pi-bg-bash";

/** Read without repairing malformed shared state: corruption must fail closed. */
function table(): HoldTable | undefined {
	const value: unknown = (globalThis as unknown as Record<symbol, unknown>)[HOLDS_KEY];
	if (value === undefined) return undefined;
	const candidate = value as Partial<HoldTable> | null;
	if (candidate?.version !== 1 || !(candidate.hosts instanceof Map) || !(candidate.holds instanceof Map))
		throw new Error("Invalid completion-hold table; reload the completion host before launching held work.");
	return candidate as HoldTable;
}

/** Reserve before spawn. Only a host registered for this exact live session qualifies. */
export function reserveHold(sessionId: string): string {
	const shared = table();
	const hosts = shared?.hosts.get(sessionId);
	if (
		!(hosts instanceof Map) ||
		hosts.size === 0 ||
		![...hosts].every(
			([name, runtime]) => typeof name === "string" && name !== "" && typeof runtime === "string" && runtime !== "",
		)
	)
		throw new Error(
			"This session has no active completion host; use hold:false only when automatic finalization is not required.",
		);
	if (shared === undefined) throw new Error("Completion host unavailable.");
	const existing = shared.holds.get(sessionId);
	if (existing !== undefined && (!(existing instanceof Map) || !validEntries(existing)))
		throw new Error("Invalid session completion holds.");
	const holds: Map<string, Hold> = existing ?? new Map();
	const id = randomBytes(16).toString("hex");
	holds.set(id, { provider: PROVIDER, ready: false });
	shared.holds.set(sessionId, holds);
	return id;
}

function validEntries(holds: Map<unknown, unknown>): boolean {
	return [...holds].every(([id, value]) => {
		const entry = value as Partial<Hold> | null;
		return (
			typeof id === "string" &&
			id !== "" &&
			typeof entry?.provider === "string" &&
			entry.provider !== "" &&
			typeof entry.ready === "boolean"
		);
	});
}

export function completeHold(sessionId: string, id: string): void {
	const entry = table()?.holds.get(sessionId)?.get(id);
	if (entry?.provider !== PROVIDER || typeof entry.ready !== "boolean")
		throw new Error("Completion hold is unavailable.");
	entry.ready = true;
}

/** Refund a failed launch, or remove this provider's holds on non-reload shutdown. */
export function removeHold(sessionId: string, id: string): void {
	const shared = table();
	const holds = shared?.holds.get(sessionId);
	if (!(holds instanceof Map) || holds.get(id)?.provider !== PROVIDER) return;
	holds.delete(id);
	if (holds.size === 0) shared?.holds.delete(sessionId);
}
