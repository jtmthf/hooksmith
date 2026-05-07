import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

// ─── Event sets ───────────────────────────────────────────────────────────────

export const TOOL_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'PermissionDenied', 'FileChanged',
]);

export const BLOCKING_EVENTS = new Set(['PreToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop']);
export const FEEDBACK_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure', 'PostToolBatch']);

// ─── PATH augmentation ────────────────────────────────────────────────────────

export function augmentedEnv() {
  const extraBinPaths = [
    join(process.cwd(), 'node_modules', '.bin'),
    join(process.cwd(), '..', 'node_modules', '.bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(process.env.HOME || '', '.npm-global', 'bin'),
  ];
  const extras = extraBinPaths.filter(p => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });
  return { ...process.env, PATH: [...extras, process.env.PATH || ''].join(':') };
}

// ─── Config loading ───────────────────────────────────────────────────────────

export function loadConfig() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const candidates = [
    { file: join(projectDir, '.claude', 'hooksmith.json'), type: 'json' },
    { file: join(projectDir, 'package.json'), type: 'package' },
    { file: join(process.cwd(), '.claude', 'hooksmith.json'), type: 'json' },
    { file: join(process.cwd(), 'package.json'), type: 'package' },
    { file: join(home, '.claude', 'hooksmith.json'), type: 'json' },
  ];

  const seen = new Set();
  for (const { file, type } of candidates) {
    const abs = resolve(file);
    if (seen.has(abs)) continue;
    seen.add(abs);

    if (!existsSync(abs)) continue;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      process.stderr.write(`hooksmith: failed to parse ${abs}: ${err.message}\n`);
      return null;
    }

    if (type === 'package') {
      if (!parsed.hooksmith) continue;
      return parsed.hooksmith;
    }
    return parsed;
  }
  return null;
}

// ─── Pattern matching ─────────────────────────────────────────────────────────

export function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchToolPattern(toolName, pattern) {
  if (!pattern || pattern === '*') return true;
  for (const part of pattern.split('|')) {
    const p = part.trim();
    if (!p) continue;
    if (p === toolName) return true;
    if (p.includes('*') || p.includes('?')) {
      try { if (globToRegex(p).test(toolName)) return true; } catch {}
    }
  }
  return false;
}

export function matchFileGlob(filepath, pattern) {
  if (!filepath) return false;
  const brace = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (brace) {
    const [, pre, alts, suf] = brace;
    return alts.split(',').some(a => matchFileGlob(filepath, `${pre}${a.trim()}${suf}`));
  }
  try {
    const re = globToRegex(pattern);
    return re.test(filepath) || re.test(basename(filepath));
  } catch { return false; }
}

export function matchStringPattern(value, pattern) {
  if (!value || !pattern) return false;
  if (pattern.length > 2 && pattern[0] === '/' && pattern[pattern.length - 1] === '/') {
    try { return new RegExp(pattern.slice(1, -1)).test(value); } catch { return false; }
  }
  return value.includes(pattern);
}

export function dotpathGet(obj, dotpath) {
  for (const key of dotpath.split('.')) {
    if (obj == null || typeof obj !== 'object') return undefined;
    obj = obj[key];
  }
  return obj;
}

export function ruleMatches(rule, event, hookEvent) {
  const spec = rule.match;
  if (spec == null) return true;

  const toolInput = event.tool_input || {};

  if (typeof spec === 'string') {
    if (TOOL_EVENTS.has(hookEvent)) return matchToolPattern(event.tool_name || '', spec);
    if (hookEvent === 'UserPromptSubmit' || hookEvent === 'UserPromptExpansion') {
      return matchStringPattern(event.user_prompt || event.prompt || '', spec);
    }
    if (hookEvent === 'Notification') return matchStringPattern(event.message || '', spec);
    return true;
  }

  if (typeof spec !== 'object' || Array.isArray(spec)) return true;

  if ('tool' in spec && !matchToolPattern(event.tool_name || '', spec.tool)) return false;
  if ('file' in spec) {
    const fp = toolInput.file_path || toolInput.filePath || '';
    if (!matchFileGlob(fp, spec.file)) return false;
  }
  if ('prompt' in spec) {
    if (!matchStringPattern(event.user_prompt || event.prompt || '', spec.prompt)) return false;
  }
  if ('message' in spec) {
    if (!matchStringPattern(event.message || '', spec.message)) return false;
  }
  for (const [key, pattern] of Object.entries(spec)) {
    if (!key.startsWith('input.') || typeof pattern !== 'string') continue;
    const val = dotpathGet(toolInput, key.slice(6));
    const str = val == null ? '' : typeof val === 'string' ? val : JSON.stringify(val);
    if (!matchStringPattern(str, pattern)) return false;
  }

  return true;
}

// ─── Template expansion ───────────────────────────────────────────────────────

export const MAX_LEN = 4000;
const BASE64_RE = /[A-Za-z0-9+/]{100,}={0,2}/g;

export function sanitize(text, max = MAX_LEN) {
  if (!text) return '';
  const stripped = text.replace(BASE64_RE, '[base64-omitted]');
  return stripped.length <= max ? stripped : `${stripped.slice(0, max)}…[+${stripped.length - max} chars]`;
}

export function expandTemplates(text, event) {
  const toolInput = event.tool_input || {};
  const fp = toolInput.file_path || toolInput.filePath || '';
  const rawOutput = event.tool_response;
  const output = rawOutput == null
    ? ''
    : sanitize(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput));
  const inputStr = Object.keys(toolInput).length ? sanitize(JSON.stringify(toolInput)) : '';

  const vars = {
    file: fp,
    tool: event.tool_name || '',
    input: inputStr,
    output,
    prompt: event.user_prompt || event.prompt || '',
    session_id: event.session_id || '',
    cwd: event.cwd || process.cwd(),
    event: event.hook_event_name || '',
  };

  return text.replace(/\{([a-zA-Z_][a-zA-Z0-9_.]*)\}/g, (m, key) => {
    if (key in vars) return vars[key];
    if (key.startsWith('input.')) {
      const val = dotpathGet(toolInput, key.slice(6));
      if (val == null) return '';
      return sanitize(typeof val === 'string' ? val : JSON.stringify(val));
    }
    return m;
  });
}

// ─── Decision builders ────────────────────────────────────────────────────────

export function hso(hookEvent, additionalContext) {
  return { hookSpecificOutput: { hookEventName: hookEvent, additionalContext } };
}

export function preToolDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function preToolAllow(updatedInput) {
  const out = {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'Allowed by hooksmith',
  };
  if (updatedInput) out.updatedInput = updatedInput;
  return { hookSpecificOutput: out };
}

export function permAllow(updatedInput) {
  const decision = { behavior: 'allow' };
  if (updatedInput) decision.updatedInput = updatedInput;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

export function permDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', reason },
    },
  };
}

// ─── Script resolution ────────────────────────────────────────────────────────

export function detectPackageManager(dir) {
  if (existsSync(join(dir, 'bun.lockb'))) return 'bun';
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function resolveScript(cmd, dir) {
  if (/[\s;&|<>$`]/.test(cmd)) return cmd;
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return cmd;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, cmd)) {
      return `${detectPackageManager(dir)} run ${cmd}`;
    }
  } catch {}
  return cmd;
}

// ─── Hook execution ───────────────────────────────────────────────────────────

export function firstLine(buf) {
  return (buf ? buf.toString() : '').trim().split('\n')[0].trim();
}

export function executeHook(rule, event, hookEvent) {
  const timeout = (rule.timeout || 55) * 1000;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ex = t => resolveScript(expandTemplates(t, event), projectDir);

  if ('deny' in rule) {
    const reason = ex(String(rule.deny));
    if (hookEvent === 'PreToolUse') return preToolDeny(reason);
    if (hookEvent === 'PermissionRequest') return permDeny(reason);
    return { decision: 'block', reason };
  }

  if (rule.allow === true) {
    if (hookEvent === 'PreToolUse') return preToolAllow(rule.updated_input);
    if (hookEvent === 'PermissionRequest') return permAllow(rule.updated_input);
    return null;
  }

  if ('run' in rule) {
    const cmds = Array.isArray(rule.run) ? rule.run : [rule.run];
    const env = augmentedEnv();
    const errors = [];

    for (const cmd of cmds) {
      const expanded = ex(cmd);

      if (rule.async) {
        const child = spawn(expanded, { shell: true, env, detached: true, stdio: 'ignore' });
        child.unref();
        continue;
      }

      const result = spawnSync(expanded, { shell: true, env, timeout, maxBuffer: 1024 * 1024 });

      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          errors.push(`timeout (${rule.timeout || 55}s): ${cmd}`);
        } else {
          errors.push(`error: ${result.error.message}`);
        }
        continue;
      }

      if (rule.output === 'json' && result.status === 0) {
        try { return JSON.parse(result.stdout.toString()); } catch {}
      }

      if (result.status === 2) {
        const msg = firstLine(result.stderr) || `blocked by: ${cmd}`;
        if (hookEvent === 'PreToolUse') return preToolDeny(msg);
        if (hookEvent === 'UserPromptSubmit') return { _exit: { code: 2, stderr: msg } };
        if (BLOCKING_EVENTS.has(hookEvent)) return { decision: 'block', reason: msg };
        if (msg) errors.push(msg);
        continue;
      }

      if (rule.block_on_fail && result.status !== 0) {
        if (hookEvent === 'Stop' || hookEvent === 'SubagentStop' || hookEvent === 'StopFailure') {
          return { decision: 'block', reason: firstLine(result.stderr) || `failed: ${cmd}` };
        }
      }

      if (result.status !== 0 && FEEDBACK_EVENTS.has(hookEvent)) {
        const msg = firstLine(result.stderr);
        if (msg) errors.push(`exit ${result.status}: ${msg}`);
        continue;
      }
    }

    if (rule.async) return null;

    if (errors.length > 0) {
      return hso(hookEvent, `hooksmith: ${errors.join('; ')}`);
    }
    return null;
  }

  if ('prompt' in rule) {
    return hso(hookEvent, `[hooksmith] ${ex(rule.prompt)}`);
  }

  if ('http' in rule) {
    const cfg = rule.http;
    const url = ex(cfg.url || '');
    const method = (cfg.method || 'POST').toUpperCase();
    const headerArgs = Object.entries(cfg.headers || {})
      .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${ex(v)}`)}`)
      .join(' ');
    const body = JSON.stringify(event);
    const curlCmd = `curl -s -m ${rule.timeout || 55} -X ${method} ${headerArgs} -H 'Content-Type: application/json' -d ${JSON.stringify(body)} ${JSON.stringify(url)}`;

    const env = augmentedEnv();
    const result = spawnSync(curlCmd, { shell: true, env, timeout, maxBuffer: 256 * 1024 });
    if (result.status === 0 && result.stdout && result.stdout.length > 0) {
      try { return JSON.parse(result.stdout.toString()); } catch {
        const responseBody = result.stdout.toString().trim();
        if (responseBody) return hso(hookEvent, responseBody);
      }
    } else if (result.status !== 0) {
      process.stderr.write(`hooksmith http error: exit ${result.status}\n`);
    }
    return null;
  }

  if ('agent' in rule) {
    return hso(hookEvent, `[hooksmith agent] ${ex(rule.agent)}`);
  }

  return null;
}

// ─── Sugar expansion ──────────────────────────────────────────────────────────

export function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

export function parseGuardEntry(entry, def) {
  if (typeof entry === 'string') return [entry, `${def}: ${entry}`];
  if (entry && typeof entry === 'object') return [entry.match || '', entry.reason || def];
  return [String(entry), def];
}

export function expandGuard(config) {
  const { bash = [], files = [] } = config.guard || {};
  const rules = [];
  for (const e of asArray(bash)) {
    const [p, r] = parseGuardEntry(e, 'Blocked by hooksmith');
    rules.push({ match: { tool: 'Bash', 'input.command': p }, deny: r });
  }
  for (const e of asArray(files)) {
    const [p, r] = parseGuardEntry(e, 'Protected by hooksmith');
    rules.push({ match: { tool: 'Write|Edit|MultiEdit', file: p }, deny: r });
  }
  return rules;
}

export function expandAllow(config) {
  const { bash = [] } = config.allow || {};
  return asArray(bash).map(entry => {
    const pattern = typeof entry === 'string' ? entry : (entry.match || '');
    return { match: { tool: 'Bash', 'input.command': pattern }, allow: true };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch {}

  let event = {};
  try { if (raw.trim()) event = JSON.parse(raw); } catch {}

  const hookEvent = event.hook_event_name || process.env.HOOKSMITH_EVENT || '';
  if (!hookEvent) process.exit(0);

  const config = loadConfig();
  if (!config) process.exit(0);

  const rules = [];
  if (hookEvent === 'PreToolUse') rules.push(...expandGuard(config));
  if (hookEvent === 'PermissionRequest') {
    rules.push(...expandAllow(config));
    rules.push(...expandGuard(config));
  }
  rules.push(...asArray((config.on || {})[hookEvent] || []));

  if (rules.length === 0) process.exit(0);

  const collectedContext = [];

  for (const rule of rules) {
    if (!ruleMatches(rule, event, hookEvent)) continue;

    if ('deny' in rule || rule.allow === true) {
      const result = executeHook(rule, event, hookEvent);
      if (result) { process.stdout.write(JSON.stringify(result)); process.exit(0); }
      continue;
    }

    const result = executeHook(rule, event, hookEvent);
    if (!result) continue;

    if (result._exit) {
      process.stderr.write(result._exit.stderr + '\n');
      process.exit(result._exit.code);
    }

    if (result.decision === 'block') {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    }

    const out = result.hookSpecificOutput || {};
    const perm = out.permissionDecision;
    const permBehavior = out.decision && out.decision.behavior;

    if (perm === 'deny' || perm === 'allow' || permBehavior === 'deny' || permBehavior === 'allow') {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    }

    if (out.updatedInput) {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    }

    if (out.additionalContext) collectedContext.push(out.additionalContext);
  }

  if (collectedContext.length > 0) {
    process.stdout.write(JSON.stringify(hso(hookEvent, collectedContext.join('\n'))));
  }

  process.exit(0);
}
