// Makes the GitHub repository match .github/repo-settings.json. `repository`
// goes as-is to the repository update API; each ruleset is created, or
// replaced whole, by name; a ruleset the file does not name is deleted, so the
// file is the whole truth. Every run sends everything, so it is safe to repeat.
// Needs gh, logged in as an admin of the repository.
// Run from the repository root: node scripts/repo-settings.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const desired = JSON.parse(readFileSync(".github/repo-settings.json", "utf8"));

function gh(args, body) {
	const out = execFileSync("gh", body ? [...args, "--input", "-"] : args, {
		encoding: "utf8",
		input: body ? JSON.stringify(body) : undefined,
	});
	return out.trim() ? JSON.parse(out) : undefined;
}

function act(label, method, path, body) {
	console.log(dryRun ? `would ${label}` : label);
	if (!dryRun) gh(["api", "-X", method, path], body);
}

const repo = gh(["repo", "view", "--json", "nameWithOwner"]).nameWithOwner;
act(`update the settings of ${repo}`, "PATCH", `repos/${repo}`, desired.repository);

// ponytail: one page of 100 rulesets; paginate if a repository ever has more.
const existing = new Map(
	gh(["api", `repos/${repo}/rulesets?includes_parents=false&per_page=100`]).map(
		(ruleset) => [ruleset.name, ruleset.id],
	),
);
for (const ruleset of desired.rulesets) {
	const id = existing.get(ruleset.name);
	existing.delete(ruleset.name);
	if (id === undefined) {
		act(`create ruleset "${ruleset.name}"`, "POST", `repos/${repo}/rulesets`, ruleset);
	} else {
		act(`update ruleset "${ruleset.name}"`, "PUT", `repos/${repo}/rulesets/${id}`, ruleset);
	}
}
for (const [name, id] of existing) {
	act(`delete ruleset "${name}"`, "DELETE", `repos/${repo}/rulesets/${id}`);
}
