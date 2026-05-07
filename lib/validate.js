import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VALID_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'PermissionDenied', 'FileChanged',
  'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'SessionStart', 'SessionEnd',
  'UserPromptSubmit', 'UserPromptExpansion',
  'Notification',
  'WorktreeCreate', 'WorktreeRemove',
  'ConfigChange',
  'PreCompact', 'PostCompact',
  'TaskCompleted', 'TaskCreated',
  'TeammateIdle',
  'InstructionsLoaded',
  'CwdChanged',
  'Elicitation', 'ElicitationResult',
]);

export const TOOL_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
  'PermissionRequest', 'PermissionDenied', 'FileChanged',
]);

export const VALID_TOP_KEYS = new Set(['$schema', 'guard', 'allow', 'on']);
export const VALID_RULE_KEYS = new Set([
  'match', 'run', 'prompt', 'http', 'agent',
  'deny', 'allow', 'updated_input',
  'timeout', 'async', 'output', 'block_on_fail',
]);
export const VALID_MATCH_KEYS = new Set(['tool', 'file', 'prompt', 'message']);
export const ACTION_KEYS = ['run', 'prompt', 'http', 'agent', 'deny', 'allow'];

// ─── Config discovery ─────────────────────────────────────────────────────────

export function findConfig(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) return [null, null, `file not found: ${explicit}`];
    try {
      return [explicit, JSON.parse(readFileSync(explicit, 'utf8')), null];
    } catch (e) {
      return [null, null, `parse error: ${e.message}`];
    }
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    { file: join(process.cwd(), '.claude', 'hooksmith.json'), type: 'json' },
    { file: join(process.cwd(), 'package.json'), type: 'package' },
    { file: join(home, '.claude', 'hooksmith.json'), type: 'json' },
  ];

  for (const { file, type } of candidates) {
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      return [null, null, `parse error in ${file}: ${e.message}`];
    }
    if (type === 'package') {
      if (!parsed.hooksmith) continue;
      return [`${file}#hooksmith`, parsed.hooksmith, null];
    }
    return [file, parsed, null];
  }

  return [null, null, null];
}

// ─── Structural validation ────────────────────────────────────────────────────

export function validate(config) {
  const errors = [];

  for (const key of Object.keys(config)) {
    if (!VALID_TOP_KEYS.has(key)) {
      errors.push({
        path: key,
        msg: `unknown top-level key '${key}'. Expected: ${[...VALID_TOP_KEYS].sort().join(', ')}`,
      });
    }
  }

  const guard = config.guard;
  if (guard != null) {
    if (typeof guard !== 'object' || Array.isArray(guard)) {
      errors.push({ path: 'guard', msg: 'must be an object' });
    } else {
      for (const k of Object.keys(guard)) {
        if (k !== 'bash' && k !== 'files') {
          errors.push({ path: `guard.${k}`, msg: 'unknown key. Expected: bash, files' });
        }
      }
      for (const section of ['bash', 'files']) {
        for (const [i, entry] of (guard[section] || []).entries()) {
          const p = `guard.${section}[${i}]`;
          if (typeof entry === 'string') continue;
          if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
            if (!('match' in entry)) errors.push({ path: p, msg: "missing 'match' field" });
            for (const k of Object.keys(entry)) {
              if (k !== 'match' && k !== 'reason') {
                errors.push({ path: `${p}.${k}`, msg: 'unknown field. Expected: match, reason' });
              }
            }
          } else {
            errors.push({ path: p, msg: 'must be a string or { match, reason } object' });
          }
        }
      }
    }
  }

  const allow = config.allow;
  if (allow != null) {
    if (typeof allow !== 'object' || Array.isArray(allow)) {
      errors.push({ path: 'allow', msg: 'must be an object' });
    } else {
      for (const k of Object.keys(allow)) {
        if (k !== 'bash') errors.push({ path: `allow.${k}`, msg: 'unknown key. Expected: bash' });
      }
      for (const [i, entry] of (allow.bash || []).entries()) {
        if (typeof entry !== 'string' && (typeof entry !== 'object' || !entry.match)) {
          errors.push({ path: `allow.bash[${i}]`, msg: 'must be a string or { match } object' });
        }
      }
    }
  }

  const on = config.on;
  if (on != null) {
    if (typeof on !== 'object' || Array.isArray(on)) {
      errors.push({ path: 'on', msg: 'must be an object' });
    } else {
      for (const [eventName, rules] of Object.entries(on)) {
        const ep = `on.${eventName}`;
        if (!VALID_EVENTS.has(eventName)) {
          errors.push({ path: ep, msg: 'unknown event. Run /hooksmith:help for the full event list' });
          continue;
        }
        if (!Array.isArray(rules)) {
          errors.push({ path: ep, msg: 'must be an array of rule objects' });
          continue;
        }
        for (const [i, rule] of rules.entries()) {
          const rp = `${ep}[${i}]`;
          if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
            errors.push({ path: rp, msg: 'must be an object' });
            continue;
          }

          for (const k of Object.keys(rule)) {
            if (!VALID_RULE_KEYS.has(k)) {
              errors.push({ path: `${rp}.${k}`, msg: 'unknown key' });
            }
          }

          const actions = ACTION_KEYS.filter(k => k in rule);
          if (actions.length === 0) {
            errors.push({ path: rp, msg: `missing action. Add one of: ${ACTION_KEYS.join(', ')}` });
          }

          const matchSpec = rule.match;
          if (matchSpec != null && typeof matchSpec === 'object' && !Array.isArray(matchSpec)) {
            for (const mk of Object.keys(matchSpec)) {
              if (!VALID_MATCH_KEYS.has(mk) && !mk.startsWith('input.')) {
                errors.push({
                  path: `${rp}.match.${mk}`,
                  msg: 'unknown matcher key. Use: tool, file, prompt, message, input.<path>',
                });
              }
            }
            if (!TOOL_EVENTS.has(eventName)) {
              if ('tool' in matchSpec) {
                errors.push({ path: `${rp}.match.tool`, msg: `'tool' matcher not applicable for ${eventName}` });
              }
              if ('file' in matchSpec) {
                errors.push({ path: `${rp}.match.file`, msg: `'file' matcher not applicable for ${eventName}` });
              }
            }
          }

          if ('run' in rule) {
            const run = rule.run;
            if (Array.isArray(run)) {
              run.forEach((cmd, j) => {
                if (typeof cmd !== 'string') {
                  errors.push({ path: `${rp}.run[${j}]`, msg: 'must be a string' });
                }
              });
            } else if (typeof run !== 'string') {
              errors.push({ path: `${rp}.run`, msg: 'must be a string or array of strings' });
            }
          }

          if ('http' in rule) {
            if (typeof rule.http !== 'object' || rule.http === null) {
              errors.push({ path: `${rp}.http`, msg: 'must be an object' });
            } else if (!rule.http.url) {
              errors.push({ path: `${rp}.http.url`, msg: "missing required 'url' field" });
            }
          }

          if ('prompt' in rule && typeof rule.prompt !== 'string') {
            errors.push({ path: `${rp}.prompt`, msg: 'must be a string' });
          }
          if ('agent' in rule && typeof rule.agent !== 'string') {
            errors.push({ path: `${rp}.agent`, msg: 'must be a string' });
          }
          if ('timeout' in rule && (typeof rule.timeout !== 'number' || rule.timeout <= 0)) {
            errors.push({ path: `${rp}.timeout`, msg: 'must be a positive number (seconds)' });
          }
          if ('output' in rule && rule.output !== 'json') {
            errors.push({ path: `${rp}.output`, msg: `unknown value '${rule.output}'. Only 'json' is supported` });
          }
        }
      }
    }
  }

  return errors;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export function summarize(config) {
  const lines = [];
  const guard = config.guard || {};
  const allow = config.allow || {};
  const on = config.on || {};

  const guardBash = (guard.bash || []).length;
  const guardFiles = (guard.files || []).length;
  const allowBash = (allow.bash || []).length;

  if (guardBash || guardFiles) {
    lines.push(`  Guard:  ${guardBash} bash rule(s), ${guardFiles} file pattern(s)`);
  }
  if (allowBash) {
    lines.push(`  Allow:  ${allowBash} bash pattern(s)`);
  }

  const eventEntries = Object.entries(on).sort(([a], [b]) => a.localeCompare(b));
  for (const [eventName, rules] of eventEntries) {
    if (!Array.isArray(rules) || rules.length === 0) continue;
    const types = new Set();
    let asyncCount = 0;
    for (const r of rules) {
      for (const t of ACTION_KEYS) { if (t in r) types.add(t); }
      if (r.async) asyncCount++;
    }
    const detail = [
      `[${[...types].sort().join('/')}]`,
      asyncCount > 0 ? `${asyncCount} async` : null,
    ].filter(Boolean).join(', ');
    lines.push(`  ${eventName}: ${rules.length} rule(s) ${detail}`);
  }

  return lines.join('\n') || '  (no rules defined)';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function main() {
  const args = process.argv.slice(2);
  const explicitPath = args.find(a => !a.startsWith('--')) || null;

  const [configPath, config, loadErr] = findConfig(explicitPath);

  if (loadErr) {
    console.error(`hooksmith: ${loadErr}`);
    process.exit(1);
  }

  if (!configPath) {
    console.log('hooksmith: no hooksmith.json found\n');
    console.log('Searched:');
    console.log('  .claude/hooksmith.json');
    console.log('  package.json (hooksmith key)');
    console.log('  ~/.claude/hooksmith.json\n');
    console.log('Create one with: /hooksmith:init');
    process.exit(1);
  }

  const errors = validate(config);

  if (errors.length > 0) {
    console.error(`hooksmith: ${errors.length} error(s) in ${configPath}:\n`);
    for (const { path: p, msg } of errors) {
      console.error(`  ✗  ${p}: ${msg}`);
    }
    process.exit(1);
  }

  console.log(`hooksmith: ✓  ${configPath}\n`);
  console.log(summarize(config));
  process.exit(0);
}
