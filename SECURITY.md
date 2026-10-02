# Security

pi-bg-bash runs the model's shell commands, as the same user as Pi, the way
Pi's own `bash` tool does. It is not a sandbox: a command can do anything the
user can. The security questions are what else the extension does with
processes and files, and whether anything reaches a command that should not.
This page says which problems count as security bugs and how to report them.

## Reporting

Report privately through GitHub:
[open a security advisory](https://github.com/gvanderclay/pi-bg-bash/security/advisories/new).
Do not open a public issue. Include the command, your OS and shell, and the
Pi version.

## What the extension does

- It runs the command, passed as an argument rather than spliced into a
  script, in Pi's shell with Pi's shell environment plus the `PI_SESSION_ID`,
  `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`
  variables Pi's own `bash` tool sets.
- It signals only process groups it launched itself, never a pid of 1 or
  below, and stops signalling a group once it has seen it empty, so a pid the
  OS has reused is not killed.
- It writes logs under `$XDG_STATE_HOME/pi-bg/<session-id>/` (default
  `~/.local/state`), with directories `0700` and files `0600`, created
  exclusively. Cleanup removes only its own `bg-<n>.log` and `bg-<n>.log.gz`
  files and emptied session directories, and never a directory owned by a
  live Pi.

## In scope

- Text from a command, a task id or a `bash_output` filter running as shell
  code anywhere other than the command itself, or reaching another process's
  arguments.
- A signal reaching a process the extension did not start.
- A log readable by other users, or cleanup deleting a file that is not one
  of the extension's logs.
- Output that looks like an exit marker changing a task's reported state.

## Out of scope

- What the command itself does. It runs with the user's rights; limit it with
  a permission extension.
- Secrets that a command prints to its own log.
