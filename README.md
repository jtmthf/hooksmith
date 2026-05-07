# hooksmith

**Declarative Claude Code hooks — inspired by [husky](https://github.com/typicode/husky) + [lint-staged](https://github.com/lint-staged/lint-staged).**

Stop writing deeply nested JSON with handler arrays and exit-code protocols. Write this instead:

```json
{
  "guard": {
    "bash": [{ "match": "rm -rf /", "reason": "Nope" }],
    "files": [".env*", "*.pem"]
  },
  "allow": {
    "bash": ["npm test", "npx prettier"]
  },
  "on": {
    "PostToolUse": [
      {
        "match": { "tool": "Write|Edit|MultiEdit", "file": "*.{ts,tsx}" },
        "run": "prettier --write {file}"
      }
    ],
    "Stop": [
      { "run": "npm test", "block_on_fail": true }
    ]
  }
}
```

One file. All 28 events. Four action types. File globs, MCP tool patterns, jsonpath matchers, decision control — the full Claude Code hooks API without the ceremony.

---

## Install

```bash
claude plugin install hooksmith
```

Or locally:

```bash
git clone <repo> && cd hooksmith
claude plugin marketplace add ./
claude plugin install hooksmith
```

Requires Node.js (no npm install needed — zero dependencies).

## Quick start

```
/hooksmith:init --preset strict
```

Edit `.claude/hooksmith.json`, then validate:

```
/hooksmith
```

---

## Config location

| File | Scope |
|------|-------|
| `.claude/hooksmith.json` | Project (commit to git) |
| `package.json` → `hooksmith` key | Project inline |
| `~/.claude/hooksmith.json` | User-global |

Project `.claude/hooksmith.json` takes priority.

Add `"$schema": "<plugin-root>/schema/hooksmith.schema.json"` for IDE autocomplete and inline validation.

---

## The three sections

### `guard` — Block dangerous operations

Sugar that expands to PreToolUse `deny` rules.

```json
{
  "guard": {
    "bash": [
      { "match": "rm -rf /", "reason": "Destructive command blocked" },
      { "match": "/sudo\\s+/", "reason": "sudo not allowed" },
      "DROP TABLE"
    ],
    "files": [
      { "match": ".env*", "reason": "Environment files protected" },
      "*.pem", "*.key"
    ]
  }
}
```

### `allow` — Auto-approve safe commands

Sugar that expands to PermissionRequest `allow` rules.

```json
{
  "allow": {
    "bash": ["npm test", "npx prettier", "npx eslint"]
  }
}
```

### `on` — Event hooks

Maps any Claude Code event to an array of rules. Each rule has an optional `match` block and one action.

```json
{
  "on": {
    "PostToolUse": [ ... ],
    "PreToolUse":  [ ... ],
    "Stop":        [ ... ]
  }
}
```

---

## Events

All 28 Claude Code hook events are supported:

| Event | Fires when | Matchers |
|-------|-----------|----------|
| `PreToolUse` | Before a tool executes | tool, file, input.* |
| `PostToolUse` | After a tool succeeds | tool, file, input.* |
| `PostToolUseFailure` | After a tool fails | tool, file, input.* |
| `PostToolBatch` | After a batch of tool calls | tool, file, input.* |
| `PermissionRequest` | Permission dialog shown | tool, file, input.* |
| `PermissionDenied` | Permission request denied | tool, file, input.* |
| `FileChanged` | File changes on disk | tool, file, input.* |
| `Stop` | Claude finishes responding | — |
| `StopFailure` | Claude's stop sequence fails | — |
| `SubagentStart` | Subagent starts | — |
| `SubagentStop` | Subagent finishes | — |
| `SessionStart` | Session begins | — |
| `SessionEnd` | Session ends | — |
| `UserPromptSubmit` | User sends a prompt | prompt |
| `UserPromptExpansion` | User prompt is expanded | prompt |
| `Notification` | Claude sends a notification | message |
| `WorktreeCreate` | Git worktree created | — |
| `WorktreeRemove` | Git worktree removed | — |
| `ConfigChange` | Settings changed | — |
| `PreCompact` | Before context compaction | — |
| `PostCompact` | After context compaction | — |
| `TaskCompleted` | Background task completes | — |
| `TaskCreated` | Background task created | — |
| `TeammateIdle` | Teammate agent becomes idle | — |
| `InstructionsLoaded` | CLAUDE.md loaded | — |
| `CwdChanged` | Working directory changed | — |
| `Elicitation` | Elicitation request fires | — |
| `ElicitationResult` | Elicitation result returned | — |

---

## Matchers

Omit `match` to fire on every occurrence.

```json
{ "match": "Bash", "run": "echo 'bash was called'" }
```

```json
{
  "match": {
    "tool": "Write|Edit|MultiEdit",
    "file": "*.{ts,tsx,js,jsx}",
    "input.command": "/pattern/"
  }
}
```

| Key | Events | Syntax |
|-----|--------|--------|
| `tool` | Tool events | Pipe-separated names or globs: `"Bash"`, `"Edit\|Write"`, `"mcp__github__*"` |
| `file` | Tool events | Glob + brace expansion: `"*.{ts,tsx}"`, `".env*"` |
| `input.<path>` | Tool events | Dotpath into `tool_input`. Substring or `/regex/` |
| `prompt` | UserPromptSubmit | Substring or `/regex/` |
| `message` | Notification | Substring or `/regex/` |

---

## Actions

### `run` — Shell command

```json
{ "run": "prettier --write {file}" }
{ "run": ["black {file}", "isort {file}"] }
```

hooksmith automatically prepends `node_modules/.bin`, `/opt/homebrew/bin`, and other common tool paths to `PATH` — binaries installed locally (without `-g`) work without `npx`.

**Token-optimal output:** success is silent. Failure forwards exit code + first line of stderr only.

### `prompt` — LLM evaluation

```json
{ "prompt": "Review this code change for security issues: {input}" }
```

### `http` — Webhook

```json
{
  "http": {
    "url": "http://localhost:9090/hooks/audit",
    "headers": { "Authorization": "Bearer $TOKEN", "X-Tool": "{tool}" },
    "method": "POST"
  }
}
```

### `agent` — Agent evaluation

```json
{ "agent": "Evaluate if this tool use is appropriate: {input}" }
```

### `deny` / `allow` — Immediate decisions

```json
{ "match": { "tool": "Bash", "input.command": "rm -rf" }, "deny": "Blocked" }
{ "match": { "tool": "Bash", "input.command": "npm test" }, "allow": true }
```

---

## Template variables

| Variable | Value |
|----------|-------|
| `{file}` | `tool_input.file_path` |
| `{tool}` | Tool name |
| `{input}` | Full `tool_input` as JSON (truncated at 4000 chars, base64 stripped) |
| `{input.command}` | Specific field via dotpath |
| `{output}` | `tool_response` — PostToolUse (truncated, base64 stripped) |
| `{prompt}` | User prompt text |
| `{session_id}` | Session ID |
| `{cwd}` | Working directory |
| `{event}` | Hook event name |

---

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `timeout` | number | 55 | Seconds before the command is killed |
| `async` | boolean | false | Fire-and-forget — run without blocking Claude Code |
| `output` | `"json"` | — | Parse command stdout as a full JSON decision object |
| `block_on_fail` | boolean | false | Stop/SubagentStop: block if command exits non-zero |

---

## Decision control

For full protocol access, set `"output": "json"` and write structured JSON to stdout.

**PreToolUse:**
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Policy violation",
    "updatedInput": { "command": "safe-version" }
  }
}
```

**Stop:**
```json
{ "decision": "block", "reason": "Tests are failing" }
```

---

## Execution model

- **deny / allow / block** short-circuit immediately (first match wins)
- **run commands** accumulate — all matching rules execute and their output merges
- **guard** rules evaluate before `on` rules for the same event
- **async: true** detaches the process — no output, no blocking

---

## Skills

| Skill | Description |
|-------|-------------|
| `/hooksmith` | Validate config and show summary |
| `/hooksmith:init` | Generate config from a preset |
| `/hooksmith:help` | Full configuration reference |

## Presets

| Preset | Includes |
|--------|---------|
| `minimal` | Empty scaffold |
| `frontend` | Prettier + ESLint for JS/TS |
| `python` | Black + isort + Ruff |
| `fullstack` | Frontend + Python + Go + Rust |
| `strict` | Fullstack + guard rails + allow list + test gate + session context + async notifications |

---

## License

MIT
