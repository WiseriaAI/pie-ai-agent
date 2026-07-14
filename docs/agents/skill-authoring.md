# Skill script authoring (disk skills)

A disk skill lives at `~/.pie/skills/<name>/` (or the read-only shared root
`~/.agents/skills/<name>/`). Scripts you drop in `scripts/` become runnable via
the agent's `run_skill_script` tool once the daemon ("本地打通") is connected.

**A script is a plain CLI process, not a sandboxed function.** The daemon runs it
under `@anthropic-ai/sandbox-runtime` (write-restricted, network-off by default,
sensitive reads denied). There is no `default export` handshake and no return
value — think `node script.ts arg1 arg2`, not `(input) => output`.

## The contract

| Dimension | Rule |
|-----------|------|
| Input | `run_skill_script`'s `args` array → your `process.argv` (after `argv[0]`/`argv[1]`). |
| Output (data) | **stdout.** Capped at 1 MB; overflow is flagged `truncated`. |
| Output (files) | Write into **cwd** (= the session workspace). The daemon lists them back to the agent, which can read them with `read_skill_output`. |
| **Return value** | **Discarded.** A returned/exported value goes nowhere — it is a CLI process, not a sandbox callback. This is the single most common mistake. |
| cwd | `~/.pie/sessions/<sessionId>/workspace/` — per-session, shared across skills in that session (so skill A can hand a file to skill B). |
| Writable | cwd subtree + any paths declared in `metadata.pie.write`. |
| Readable | Everything except denied sensitive dirs (`~/.ssh`, `~/.aws`, …). Read your own skill's bundled resources via `$PIE_SKILL_DIR`. |
| Network | Off by default; only domains listed in `metadata.pie.network` are allowed out. |
| Timeout | 60 s. |
| Failure | Non-zero exit → the agent gets an error with the last 2000 chars of stderr. |

Two environment variables are injected:

- `PIE_SKILL_DIR` — absolute path to your skill directory (read bundled assets from here).
- `PIE_WORKSPACE` — absolute path to cwd (same as the session workspace).

## Minimal example

`scripts/dedupe.ts`:

```ts
// args: run_skill_script({ entry: "dedupe.ts", args: ["input.csv"] })
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const inputName = process.argv[2] ?? "input.csv";

// Read a bundled reference from the skill dir (NOT the cwd).
const template = readFileSync(join(process.env.PIE_SKILL_DIR!, "reference/header.txt"), "utf8");

// Read a product an earlier step wrote into the workspace (cwd).
const rows = readFileSync(inputName, "utf8").split("\n");
const unique = [...new Set(rows)];

// Result → stdout (the agent reads this directly).
console.log(`${unique.length} unique rows (from ${rows.length})`);

// Product → a file in cwd (the agent reads this with read_skill_output).
writeFileSync("deduped.csv", template + "\n" + unique.join("\n"));
```

The agent will see the stdout line, plus an observation like:

```
Files written to the session workspace (read them with read_skill_output):
deduped.csv (12 KB)
```

## Gotchas

- **Don't `return` your result.** Print it or write a file. A bare
  `export default () => {...}` runs, defines nothing observable, and exits 0 —
  the agent gets "produced nothing".
- **Only files under the workspace (cwd) are listed.** If you write to a
  `metadata.pie.write` path outside the workspace, the daemon does not scan for
  it — `console.log` the path yourself so the agent knows where it went.
- **Products are per-session.** Two sessions running the same script write into
  different workspaces; they never collide. Within one session, skills share the
  workspace, so name your outputs distinctly if that matters.
- **Never write into the skill directory** — it is read-only to the process
  (especially the shared `~/.agents/skills` root, which belongs to other agents).
  Use the workspace.
