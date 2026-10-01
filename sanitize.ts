// What the agent reads of a command's output: no ANSI escape codes and no control
// characters but newline and tab. Mirrors the pipeline Pi applies to the user's
// `!` commands (`core/bash-executor.js` in @earendil-works/pi-coding-agent:
// `sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "")`). Pi does not export
// these helpers, so this is an own copy of `stripAnsi` (`utils/ansi.js`, derived
// from the MIT-licensed `ansi-regex` and `strip-ansi` by Sindre Sorhus) and of
// `sanitizeBinaryOutput` (`utils/shell.js`), as of Pi 0.99.2.

// ansi-regex: OSC sequences (ESC ] ... up to the first ST, which is BEL, ESC \ or
// 0x9c), then CSI and related: ESC or 8-bit CSI, optional intermediates and
// parameters, a final byte.
const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
const OSC = `(?:\\u001B\\][\\s\\S]*?${ST})`;
const CSI = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
const ANSI = new RegExp(`${OSC}|${CSI}`, "g");

/** Pi's `stripAnsi`. */
function stripAnsi(value: string): string {
	if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
	return value.replace(ANSI, "");
}

/** Pi's `sanitizeBinaryOutput`: C0 controls except tab, newline and carriage return, and U+FFF9–U+FFFB. */
function sanitizeBinaryOutput(value: string): string {
	return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

/** Output as the agent should read it: escape codes, control characters and carriage returns removed. */
export function sanitize(text: string): string {
	return sanitizeBinaryOutput(stripAnsi(text)).replace(/\r/g, "");
}
