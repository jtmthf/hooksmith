---
description: Validates and summarizes the hooksmith hook configuration. Use when the user asks to "validate hooks", "check hooksmith config", "show hooksmith rules", or runs /hooksmith.
argument-hint: "[path/to/hooksmith.json]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/validate.js:*)
---

# /hooksmith

Validate the active hooksmith configuration and display a summary.

## Instructions

1. Run the validator:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/validate.js
   ```
   Pass the argument if the user provided a path.

2. If validation fails, explain each error using the path shown (e.g. `on.PostToolUse[0].match`) and suggest a fix.

3. If no config is found, tell the user to run `/hooksmith:init` and mention the three search locations:
   - `.claude/hooksmith.json` (project)
   - `package.json` → `hooksmith` key (project)
   - `~/.claude/hooksmith.json` (user-global)

4. If validation passes, display the summary as-is.
