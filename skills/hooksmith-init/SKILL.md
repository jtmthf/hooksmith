---
description: Generates a starter hooksmith.json config from a preset. Use when the user asks to "create hooksmith config", "init hooksmith", "set up hooks", or runs /hooksmith:init.
argument-hint: "[--preset minimal|frontend|python|fullstack|strict] [--project|--user|--package]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/init.js:*)
---

# /hooksmith:init

Generate a starter hooksmith configuration from a preset.

## Presets

| Preset | What it includes |
|--------|-----------------|
| `minimal` | Empty scaffold with schema reference |
| `frontend` | Prettier + ESLint for JS/TS/CSS/JSON on PostToolUse |
| `python` | Black + isort + Ruff for Python on PostToolUse |
| `fullstack` | Frontend + Python + Go + Rust formatters |
| `strict` | Fullstack formatters + guard rails + allow list + test gate on Stop + session context + async notifications |

## Scope flags

| Flag | Writes to |
|------|-----------|
| `--project` (default) | `.claude/hooksmith.json` |
| `--user` | `~/.claude/hooksmith.json` |
| `--package` | `package.json` → `hooksmith` key |

## Instructions

1. If the user did not specify a preset, ask which they want and explain the options above.

2. If the user did not specify a scope, default to `--project` and confirm.

3. Run:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/init.js --preset <preset> --<scope>
   ```

4. Show the generated file path from the output.

5. Suggest next steps:
   - Edit the config to fit the project
   - Add `"$schema": "./<relative-path>/schema/hooksmith.schema.json"` for IDE autocomplete
   - Run `/hooksmith` to validate
   - Run `/hooksmith:help` for full reference
