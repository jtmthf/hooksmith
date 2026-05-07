---
description: Shows the complete hooksmith configuration reference. Use when the user asks "how do I use hooksmith", "hooksmith syntax", "what events does hooksmith support", or runs /hooksmith:help.
---

# /hooksmith:help

Display the complete hooksmith reference to the user.

---

## hooksmith.json reference

hooksmith reads config from (in priority order):
1. `.claude/hooksmith.json` — project config (commit to git)
2. `package.json` → `hooksmith` key — project config inline
3. `~/.claude/hooksmith.json` — user-global config

Add `"$schema": "../schema/hooksmith.schema.json"` for IDE autocomplete and inline validation.

---

## Structure

```json
{
  "$schema": "../schema/hooksmith.schema.json",
  "guard": { ... },
  "allow": { ... },
  "on": {
    "<EventName>": [ { "match": { ... }, "run": "..." }, ... ]
  }
}
```

---

## `guard` — Block dangerous operations

Expands to PreToolUse `deny` rules automatically.

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

Bash patterns are substring matches. Wrap in `/` for regex: `"/sudo\\s+/"`.
File patterns are shell globs with brace expansion: `"*.{ts,tsx,js}"`.

---

## `allow` — Auto-approve safe commands

Expands to PermissionRequest `allow` rules.

```json
{
  "allow": {
    "bash": ["npm test", "npx prettier", "/npx eslint.*/"]
  }
}
```

---

## `on` — Event hooks

Maps any Claude Code event to an array of rules.

```json
{
  "on": {
    "PostToolUse": [
      {
        "match": { "tool": "Write|Edit|MultiEdit", "file": "*.{ts,tsx}" },
        "run": "prettier --write {file}"
      }
    ]
  }
}
```

---

## Events (28 total)

| Event | Fires when | Supports matchers |
|-------|-----------|-------------------|
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

## Match block

Omit `match` to fire on every occurrence.

**String shorthand** — matches tool name (tool events) or prompt text:
```json
{ "match": "Bash", "run": "echo 'bash was called'" }
```

**Object form** — all conditions must match:
```json
{
  "match": {
    "tool": "Write|Edit|MultiEdit",
    "file": "*.{ts,tsx,js}",
    "input.command": "/pattern/"
  }
}
```

| Key | Events | Syntax |
|-----|--------|--------|
| `tool` | Tool events | Pipe-separated names or globs: `"Bash"`, `"Edit\|Write"`, `"mcp__github__*"` |
| `file` | Tool events | Glob + brace expansion: `"*.{ts,tsx}"`, `".env*"`, `"src/**/*.py"` |
| `input.<path>` | Tool events | Dotpath into `tool_input`. Substring or `/regex/` |
| `prompt` | UserPromptSubmit | Substring or `/regex/` |
| `message` | Notification | Substring or `/regex/` |

**MCP tool matching:**
```json
{ "match": { "tool": "mcp__github__*" }, "prompt": "Review: {input}" }
```

---

## Actions

Each rule needs exactly one action.

### `run` — Shell command
```json
{ "run": "prettier --write {file}" }
{ "run": ["black {file}", "isort {file}"] }
```
hooksmith automatically prepends `node_modules/.bin` and common tool paths to `PATH`.

**Package script shorthand:** a bare word matching a key in `package.json#scripts` is automatically rewritten to `<pm> run <name>` (detects bun/pnpm/yarn/npm from lockfiles). Avoids broad permission grants like `node *`:
```json
{ "run": "test", "block_on_fail": true }
```

**Output policy:** success is silent (no stdout forwarded to Claude). Failure forwards exit code + first line of stderr only.

### `prompt` — LLM evaluation
```json
{ "prompt": "Review this change for security issues: {input}" }
```

### `http` — Webhook
```json
{
  "http": {
    "url": "http://localhost:9090/hooks/audit",
    "method": "POST",
    "headers": { "Authorization": "Bearer $TOKEN", "X-Tool": "{tool}" }
  }
}
```

### `agent` — Agent evaluation
```json
{ "agent": "Evaluate if this tool use is safe: {input}" }
```

### `deny` — Immediate denial
```json
{ "match": { "tool": "Bash", "input.command": "rm -rf" }, "deny": "Blocked: {input.command}" }
```

### `allow` — Immediate approval
```json
{ "match": { "tool": "Bash", "input.command": "npm test" }, "allow": true }
```

---

## Template variables

Use `{var}` in `run`, `prompt`, `deny`, `agent`, `http.url`, `http.headers`:

| Variable | Value |
|----------|-------|
| `{file}` | `tool_input.file_path` |
| `{tool}` | Tool name |
| `{input}` | Full `tool_input` as JSON (truncated, base64 stripped) |
| `{input.command}` | Specific field via dotpath |
| `{output}` | `tool_response` — PostToolUse only (truncated, base64 stripped) |
| `{prompt}` | User prompt text |
| `{session_id}` | Session ID |
| `{cwd}` | Working directory |
| `{event}` | Hook event name |

---

## Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `timeout` | number | 55 | Seconds before the command is killed |
| `async` | boolean | false | Run in background without blocking Claude Code |
| `output` | `"json"` | — | Parse command stdout as a JSON decision |
| `block_on_fail` | boolean | false | Stop/SubagentStop: block if command exits non-zero |

---

## Decision control

Set `"output": "json"` and return structured JSON for fine-grained control.

**PreToolUse** — allow, deny, or modify the tool call:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by policy",
    "updatedInput": { "command": "safe-version" }
  }
}
```

**Stop** — block Claude from stopping:
```json
{ "decision": "block", "reason": "Tests are failing" }
```

**PermissionRequest** — allow or deny:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

---

## Execution model

- **deny / allow / block** short-circuit immediately — first match wins
- **run commands** accumulate across rules — all matching rules execute
- **guard** rules evaluate before `on` rules for the same event
- **async: true** detaches the process — no output, no blocking

---

## Skills

| Command | Description |
|---------|-------------|
| `/hooksmith` | Validate config and show summary |
| `/hooksmith:init` | Generate config from a preset |
| `/hooksmith:help` | Show this reference |
