// Opens a release pull request: bumps package.json's version, moves the
// CHANGELOG's [Unreleased] entries under it, commits that on a release branch,
// opens a pull request and turns on auto-merge. Once CI passes it merges, and
// .github/workflows/release.yml tags it, publishes to npm and makes the GitHub
// release.
// Run from the package root, on an up-to-date main: pnpm release <patch|minor|major>
import { execFileSync } from "node:child_process";

const run = (command, ...args) =>
	execFileSync(command, args, { encoding: "utf8" }).trim();

function fail(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
	fail("usage: pnpm release <patch|minor|major>");
}
run("git", "fetch", "origin", "main");
if (run("git", "branch", "--show-current") !== "main") {
	fail("switch to main first");
}
if (run("git", "status", "--porcelain", "--untracked-files=no")) {
	fail("commit or stash your changes first");
}
if (run("git", "rev-parse", "HEAD") !== run("git", "rev-parse", "origin/main")) {
	fail("main differs from origin/main; pull first");
}

const version = run("npm", "version", bump, "--no-git-tag-version").replace(
	/^v/,
	"",
);
try {
	run("node", "scripts/release-changelog.mjs", version);
} catch {
	run("git", "checkout", "--", "package.json");
	process.exit(1); // release-changelog.mjs has said why
}

const title = `Release v${version}`;
run("git", "switch", "-c", `release/v${version}`);
run("git", "commit", "-am", title);
run("git", "push", "-u", "origin", `release/v${version}`);
const url = run(
	"gh",
	"pr",
	"create",
	"--title",
	title,
	"--body",
	`Merging this tags v${version}, publishes it to npm and makes the GitHub release.`,
);
run("gh", "pr", "merge", url, "--squash", "--auto");
run("git", "switch", "main");
console.log(`${url}\nmerges once CI passes; then release.yml publishes v${version}`);
