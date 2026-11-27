import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Whether Pi adds a tool to this model's conversation in place, so loading a
 * deferred tool through `tool_search` keeps the prompt cache. Every other
 * model is sent the whole tool list again. Mirrors pi-ai's per-API handling of
 * tool changes (pi-ai README, "Models that accept system messages
 * mid-conversation"), as pi-web-access, pi-squire and pi-session-mail decide it.
 */
export function addsToolsInPlace(model: ExtensionContext["model"]): boolean {
	const compat: unknown = model?.compat;
	// Each API's compat type declares only its own flags.
	const has = (flag: string): boolean =>
		typeof compat === "object" && compat !== null && Reflect.get(compat, flag) === true;
	if (!model || !has("supportsMidConvoSystemMessages")) return false;
	switch (model.api) {
		case "anthropic-messages":
			return has("supportsMidConvoToolChanges");
		case "openai-completions":
			return has("supportsMidConvoToolAdditions");
		case "openai-responses":
		case "openai-codex-responses":
		case "azure-openai-responses":
			return has("supportsAdditionalTools") || has("supportsToolSearch");
		default:
			return false;
	}
}

/**
 * Declare the deferred tools `names` wherever reaching them would cost the
 * prompt cache or be impossible. A codemode script calls one by name without
 * changing the declared tools; `tool_search` loading one keeps the cache only
 * on a model that adds tools in place. With neither, the tools are declared.
 * This only adds tools: a later model switch already loses the cache.
 */
export function declareUnlessReachable(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">,
	names: readonly string[],
	model: ExtensionContext["model"],
): void {
	const registered = new Set(pi.getAllTools().map((tool) => tool.name));
	const active = new Set(pi.getActiveTools());
	const reach = (name: string): boolean => registered.has(name) && active.has(name);
	if (reach("codemode") || (reach("tool_search") && addsToolsInPlace(model))) return;
	const declare = names.filter((name) => registered.has(name) && !active.has(name));
	if (declare.length > 0) pi.setActiveTools([...active, ...declare]);
}
