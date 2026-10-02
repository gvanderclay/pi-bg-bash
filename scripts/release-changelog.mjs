// Moves CHANGELOG.md's [Unreleased] entries under a heading for a new
// version, and updates the compare links at the bottom. Refuses when there is
// nothing under [Unreleased]. Used by scripts/release.mjs.
// Run from the package root: node scripts/release-changelog.mjs <version>
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
	console.error("usage: node scripts/release-changelog.mjs <x.y.z>");
	process.exit(1);
}

let text = readFileSync("CHANGELOG.md", "utf8");
const entries = text.match(/## \[Unreleased\]\n([\s\S]*?)\n## \[/)?.[1];
if (!entries?.trim()) {
	console.error("CHANGELOG.md has nothing under [Unreleased] to release");
	process.exit(1);
}
const link = text.match(/^\[Unreleased\]: (.+)\/compare\/(v[^.]+\.[^.]+\.[^.]+)\.\.\.HEAD$/m);
if (!link) {
	console.error("CHANGELOG.md has no [Unreleased] compare link");
	process.exit(1);
}
const [line, repo, previous] = link;
const date = new Date().toISOString().slice(0, 10);

text = text
	.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${date}\n`)
	.replace(
		line,
		`[Unreleased]: ${repo}/compare/v${version}...HEAD\n[${version}]: ${repo}/compare/${previous}...v${version}`,
	);
writeFileSync("CHANGELOG.md", text);
console.log(`CHANGELOG.md: released ${version}`);
