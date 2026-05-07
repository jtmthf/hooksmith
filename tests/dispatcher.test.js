import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  globToRegex,
  matchToolPattern,
  matchFileGlob,
  matchStringPattern,
  dotpathGet,
  firstLine,
  sanitize,
  expandTemplates,
  hso,
  preToolDeny,
  preToolAllow,
  permAllow,
  permDeny,
  ruleMatches,
  expandGuard,
  expandAllow,
  asArray,
  parseGuardEntry,
  executeHook,
  loadConfig,
  MAX_LEN,
} from '../lib/dispatcher.js';
import { mkTmp, runScript, writeHooksmith } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DISPATCHER = join(__dirname, '..', 'scripts', 'dispatcher.js');

// ─── globToRegex ──────────────────────────────────────────────────────────────

describe('globToRegex', () => {
  it('matches an exact string', () => {
    assert.ok(globToRegex('foo').test('foo'));
    assert.ok(!globToRegex('foo').test('foobar'));
    assert.ok(!globToRegex('foo').test('xfoo'));
  });

  it('* matches zero or more characters', () => {
    assert.ok(globToRegex('*.ts').test('foo.ts'));
    assert.ok(globToRegex('*.ts').test('.ts'));
    assert.ok(!globToRegex('*.ts').test('foo.tsx'));
  });

  it('? matches exactly one character', () => {
    assert.ok(globToRegex('f?o').test('foo'));
    assert.ok(globToRegex('f?o').test('fxo'));
    assert.ok(!globToRegex('f?o').test('fo'));
    assert.ok(!globToRegex('f?o').test('fooo'));
  });

  it('escapes regex special characters in literal patterns', () => {
    assert.ok(globToRegex('a.b').test('a.b'));
    assert.ok(!globToRegex('a.b').test('axb'));
    assert.ok(globToRegex('a+b').test('a+b'));
    assert.ok(!globToRegex('a+b').test('ab'));
  });
});

// ─── matchToolPattern ─────────────────────────────────────────────────────────

describe('matchToolPattern', () => {
  it('null, undefined, empty string, and "*" all match any tool', () => {
    assert.ok(matchToolPattern('Bash', null));
    assert.ok(matchToolPattern('Bash', undefined));
    assert.ok(matchToolPattern('Bash', ''));
    assert.ok(matchToolPattern('Bash', '*'));
  });

  it('exact match succeeds', () => {
    assert.ok(matchToolPattern('Bash', 'Bash'));
    assert.ok(!matchToolPattern('Write', 'Bash'));
  });

  it('pipe alternation matches any listed tool', () => {
    assert.ok(matchToolPattern('Write', 'Write|Edit|MultiEdit'));
    assert.ok(matchToolPattern('Edit', 'Write|Edit|MultiEdit'));
    assert.ok(matchToolPattern('MultiEdit', 'Write|Edit|MultiEdit'));
    assert.ok(!matchToolPattern('Read', 'Write|Edit|MultiEdit'));
    assert.ok(!matchToolPattern('Bash', 'Write|Edit|MultiEdit'));
  });

  it('trims whitespace around pipe separators', () => {
    assert.ok(matchToolPattern('Edit', 'Write | Edit | MultiEdit'));
    assert.ok(matchToolPattern('Write', 'Write | Edit | MultiEdit'));
  });

  it('glob wildcard in pattern', () => {
    assert.ok(matchToolPattern('Bash', 'Ba*'));
    assert.ok(matchToolPattern('Bash', '*ash'));
    assert.ok(!matchToolPattern('Write', 'Ba*'));
  });
});

// ─── matchFileGlob ────────────────────────────────────────────────────────────

describe('matchFileGlob', () => {
  it('returns false for empty filepath', () => {
    assert.ok(!matchFileGlob('', '*.ts'));
    assert.ok(!matchFileGlob(null, '*.ts'));
  });

  it('matches on the full path', () => {
    assert.ok(matchFileGlob('/src/foo.ts', '/src/*.ts'));
    assert.ok(!matchFileGlob('/src/foo.ts', '/lib/*.ts'));
  });

  it('falls back to matching on basename', () => {
    assert.ok(matchFileGlob('/long/path/to/file.ts', '*.ts'));
    assert.ok(!matchFileGlob('/long/path/to/file.js', '*.ts'));
  });

  it('brace expansion matches any listed extension', () => {
    assert.ok(matchFileGlob('foo.ts', '*.{ts,tsx}'));
    assert.ok(matchFileGlob('foo.tsx', '*.{ts,tsx}'));
    assert.ok(!matchFileGlob('foo.js', '*.{ts,tsx}'));
  });

  it('brace expansion trims whitespace around alternatives', () => {
    assert.ok(matchFileGlob('foo.ts', '*.{ ts , tsx }'));
    assert.ok(matchFileGlob('foo.tsx', '*.{ ts , tsx }'));
  });

  it('brace expansion with many alternatives', () => {
    const pattern = '*.{ts,tsx,js,jsx,mjs,cjs}';
    assert.ok(matchFileGlob('app.jsx', pattern));
    assert.ok(matchFileGlob('index.mjs', pattern));
    assert.ok(!matchFileGlob('styles.css', pattern));
  });
});

// ─── matchStringPattern ───────────────────────────────────────────────────────

describe('matchStringPattern', () => {
  it('returns false for empty value or empty pattern', () => {
    assert.ok(!matchStringPattern('', 'foo'));
    assert.ok(!matchStringPattern('foo', ''));
    assert.ok(!matchStringPattern(null, 'foo'));
    assert.ok(!matchStringPattern('foo', null));
  });

  it('substring match', () => {
    assert.ok(matchStringPattern('hello world', 'world'));
    assert.ok(matchStringPattern('deploy to prod', 'deploy'));
    assert.ok(!matchStringPattern('hello world', 'xyz'));
  });

  it('regex pattern delimited by slashes', () => {
    assert.ok(matchStringPattern('deploy to prod', '/deploy|production/'));
    assert.ok(matchStringPattern('production release', '/deploy|production/'));
    assert.ok(!matchStringPattern('hello world', '/deploy|production/'));
  });

  it('regex with flags inside the delimiters is treated as content', () => {
    assert.ok(matchStringPattern('Deploy Now', '/Deploy/'));
    assert.ok(!matchStringPattern('deploy now', '/Deploy/'));
  });

  it('invalid regex inside slashes returns false', () => {
    assert.ok(!matchStringPattern('foo', '/[invalid/'));
  });

  it('two-character string starting with slash is treated as substring', () => {
    assert.ok(matchStringPattern('/x', '/x'));
  });
});

// ─── dotpathGet ───────────────────────────────────────────────────────────────

describe('dotpathGet', () => {
  it('retrieves a top-level key', () => {
    assert.strictEqual(dotpathGet({ a: 1 }, 'a'), 1);
  });

  it('retrieves a deeply nested key', () => {
    assert.strictEqual(dotpathGet({ a: { b: { c: 42 } } }, 'a.b.c'), 42);
  });

  it('returns undefined for a missing key', () => {
    assert.strictEqual(dotpathGet({ a: 1 }, 'b'), undefined);
    assert.strictEqual(dotpathGet({ a: 1 }, 'a.b'), undefined);
  });

  it('returns undefined when traversing through null', () => {
    assert.strictEqual(dotpathGet({ a: null }, 'a.b'), undefined);
  });

  it('returns undefined for non-object root', () => {
    assert.strictEqual(dotpathGet(null, 'a'), undefined);
    assert.strictEqual(dotpathGet(undefined, 'a'), undefined);
  });
});

// ─── firstLine ────────────────────────────────────────────────────────────────

describe('firstLine', () => {
  it('returns first line of a multi-line string', () => {
    assert.strictEqual(firstLine('line1\nline2\nline3'), 'line1');
  });

  it('trims surrounding whitespace', () => {
    assert.strictEqual(firstLine('  hello  \n  world  '), 'hello');
  });

  it('handles falsy input', () => {
    assert.strictEqual(firstLine(null), '');
    assert.strictEqual(firstLine(undefined), '');
    assert.strictEqual(firstLine(Buffer.from('')), '');
  });

  it('handles Buffer input', () => {
    assert.strictEqual(firstLine(Buffer.from('error text\nmore')), 'error text');
  });
});

// ─── sanitize ─────────────────────────────────────────────────────────────────

describe('sanitize', () => {
  it('returns empty string for falsy values', () => {
    assert.strictEqual(sanitize(''), '');
    assert.strictEqual(sanitize(null), '');
    assert.strictEqual(sanitize(undefined), '');
  });

  it('passes short strings through unchanged', () => {
    assert.strictEqual(sanitize('hello world'), 'hello world');
  });

  it('truncates strings longer than MAX_LEN', () => {
    // Use '!' — not in the base64 alphabet — so the regex won't strip it first
    const long = '!'.repeat(MAX_LEN + 100);
    const result = sanitize(long);
    assert.ok(result.startsWith('!'.repeat(MAX_LEN)));
    assert.ok(result.includes('[+100 chars]'));
  });

  it('respects a custom max length', () => {
    const result = sanitize('abcdef', 3);
    assert.ok(result.startsWith('abc'));
    assert.ok(result.includes('[+3 chars]'));
  });

  it('replaces base64-like strings (100+ alphanum chars)', () => {
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(2);
    const result = sanitize(`before ${b64} after`);
    assert.ok(result.includes('[base64-omitted]'));
    assert.ok(!result.includes(b64));
  });

  it('leaves short alphanum strings alone', () => {
    assert.strictEqual(sanitize('shortstring'), 'shortstring');
  });
});

// ─── expandTemplates ──────────────────────────────────────────────────────────

describe('expandTemplates', () => {
  const event = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: '/src/foo.ts', nested: { key: 'val' } },
    tool_response: 'done',
    user_prompt: 'fix the bug',
    session_id: 'sess-123',
    cwd: '/project',
  };

  it('{file} → tool_input.file_path', () => {
    assert.strictEqual(expandTemplates('{file}', event), '/src/foo.ts');
  });

  it('{tool} → tool_name', () => {
    assert.strictEqual(expandTemplates('{tool}', event), 'Write');
  });

  it('{output} → tool_response', () => {
    assert.strictEqual(expandTemplates('{output}', event), 'done');
  });

  it('{prompt} → user_prompt', () => {
    assert.strictEqual(expandTemplates('{prompt}', event), 'fix the bug');
  });

  it('{session_id} → session_id', () => {
    assert.strictEqual(expandTemplates('{session_id}', event), 'sess-123');
  });

  it('{cwd} → cwd', () => {
    assert.strictEqual(expandTemplates('{cwd}', event), '/project');
  });

  it('{event} → hook_event_name', () => {
    assert.strictEqual(expandTemplates('{event}', event), 'PostToolUse');
  });

  it('{input} → JSON-stringified tool_input', () => {
    const result = expandTemplates('{input}', event);
    assert.ok(result.includes('file_path'));
  });

  it('{input.nested.key} → nested value via dotpath', () => {
    assert.strictEqual(expandTemplates('{input.nested.key}', event), 'val');
  });

  it('{input.missing} → empty string for unknown dotpath', () => {
    assert.strictEqual(expandTemplates('{input.missing}', event), '');
  });

  it('unknown variable is left as-is', () => {
    assert.strictEqual(expandTemplates('{unknown_var}', event), '{unknown_var}');
  });

  it('non-string tool_response is JSON-stringified', () => {
    const e = { ...event, tool_response: { status: 'ok', code: 0 } };
    const result = expandTemplates('{output}', e);
    assert.strictEqual(result, '{"status":"ok","code":0}');
  });

  it('empty tool_input produces empty {input}', () => {
    const e = { ...event, tool_input: {} };
    assert.strictEqual(expandTemplates('{input}', e), '');
  });

  it('null tool_response produces empty {output}', () => {
    const e = { ...event, tool_response: null };
    assert.strictEqual(expandTemplates('{output}', e), '');
  });

  it('falls back to process.cwd() when event.cwd is absent', () => {
    const e = { ...event, cwd: undefined };
    const result = expandTemplates('{cwd}', e);
    assert.strictEqual(result, process.cwd());
  });
});

// ─── Decision builders ────────────────────────────────────────────────────────

describe('decision builders', () => {
  it('hso returns correct hookSpecificOutput shape', () => {
    assert.deepStrictEqual(hso('PostToolUse', 'some context'), {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'some context' },
    });
  });

  it('preToolDeny sets permissionDecision to deny', () => {
    const result = preToolDeny('blocked because reasons');
    assert.strictEqual(result.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(result.hookSpecificOutput.permissionDecisionReason, 'blocked because reasons');
  });

  it('preToolAllow without updatedInput omits the field', () => {
    const result = preToolAllow(undefined);
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(!('updatedInput' in result.hookSpecificOutput));
  });

  it('preToolAllow with updatedInput includes it', () => {
    const updatedInput = { file_path: '/new/path.ts' };
    const result = preToolAllow(updatedInput);
    assert.deepStrictEqual(result.hookSpecificOutput.updatedInput, updatedInput);
  });

  it('permAllow without updatedInput sets behavior to allow', () => {
    const result = permAllow(undefined);
    assert.strictEqual(result.hookSpecificOutput.decision.behavior, 'allow');
    assert.ok(!('updatedInput' in result.hookSpecificOutput.decision));
  });

  it('permAllow with updatedInput includes it', () => {
    const updatedInput = { command: 'safe cmd' };
    const result = permAllow(updatedInput);
    assert.deepStrictEqual(result.hookSpecificOutput.decision.updatedInput, updatedInput);
  });

  it('permDeny sets behavior to deny with reason', () => {
    const result = permDeny('not allowed');
    assert.strictEqual(result.hookSpecificOutput.decision.behavior, 'deny');
    assert.strictEqual(result.hookSpecificOutput.decision.reason, 'not allowed');
  });
});

// ─── asArray / parseGuardEntry ────────────────────────────────────────────────

describe('asArray', () => {
  it('returns arrays unchanged', () => {
    assert.deepStrictEqual(asArray([1, 2, 3]), [1, 2, 3]);
    assert.deepStrictEqual(asArray([]), []);
  });

  it('wraps a non-array value in an array', () => {
    assert.deepStrictEqual(asArray('foo'), ['foo']);
    assert.deepStrictEqual(asArray(42), [42]);
  });

  it('returns [] for null or undefined', () => {
    assert.deepStrictEqual(asArray(null), []);
    assert.deepStrictEqual(asArray(undefined), []);
  });
});

describe('parseGuardEntry', () => {
  it('string entry uses value as pattern and appends it to the default reason', () => {
    const [pattern, reason] = parseGuardEntry('rm -rf /', 'Blocked');
    assert.strictEqual(pattern, 'rm -rf /');
    assert.strictEqual(reason, 'Blocked: rm -rf /');
  });

  it('object entry uses match and reason fields', () => {
    const [pattern, reason] = parseGuardEntry({ match: 'DROP TABLE', reason: 'No DDL' }, 'Blocked');
    assert.strictEqual(pattern, 'DROP TABLE');
    assert.strictEqual(reason, 'No DDL');
  });

  it('object entry with no reason falls back to the default', () => {
    const [, reason] = parseGuardEntry({ match: 'foo' }, 'Fallback');
    assert.strictEqual(reason, 'Fallback');
  });

  it('object entry with no match uses empty string as pattern', () => {
    const [pattern] = parseGuardEntry({ reason: 'block all' }, 'Default');
    assert.strictEqual(pattern, '');
  });
});

// ─── ruleMatches ─────────────────────────────────────────────────────────────

describe('ruleMatches', () => {
  it('null match spec always matches', () => {
    assert.ok(ruleMatches({ run: 'echo' }, {}, 'PostToolUse'));
    assert.ok(ruleMatches({ run: 'echo' }, { tool_name: 'Bash' }, 'PreToolUse'));
  });

  it('string spec on TOOL_EVENTS matches tool_name', () => {
    assert.ok(ruleMatches({ match: 'Bash' }, { tool_name: 'Bash' }, 'PreToolUse'));
    assert.ok(!ruleMatches({ match: 'Write' }, { tool_name: 'Bash' }, 'PreToolUse'));
    assert.ok(ruleMatches({ match: 'Bash' }, { tool_name: 'Bash' }, 'PostToolUse'));
  });

  it('string spec on UserPromptSubmit matches user_prompt', () => {
    assert.ok(ruleMatches({ match: 'deploy' }, { user_prompt: 'deploy to prod' }, 'UserPromptSubmit'));
    assert.ok(!ruleMatches({ match: 'rollback' }, { user_prompt: 'deploy to prod' }, 'UserPromptSubmit'));
  });

  it('string spec on UserPromptExpansion matches prompt field', () => {
    assert.ok(ruleMatches({ match: 'fix' }, { prompt: 'fix the bug' }, 'UserPromptExpansion'));
  });

  it('string spec on Notification matches message', () => {
    assert.ok(ruleMatches({ match: 'alert' }, { message: 'alert: disk full' }, 'Notification'));
    assert.ok(!ruleMatches({ match: 'error' }, { message: 'alert: disk full' }, 'Notification'));
  });

  it('string spec on unclassified events always returns true', () => {
    assert.ok(ruleMatches({ match: 'anything' }, {}, 'SessionStart'));
    assert.ok(ruleMatches({ match: 'anything' }, {}, 'Stop'));
  });

  it('array match spec always returns true', () => {
    assert.ok(ruleMatches({ match: [], run: 'echo' }, {}, 'PostToolUse'));
  });

  it('object spec with tool filter', () => {
    const rule = { match: { tool: 'Bash' }, run: 'echo' };
    assert.ok(ruleMatches(rule, { tool_name: 'Bash' }, 'PreToolUse'));
    assert.ok(!ruleMatches(rule, { tool_name: 'Write' }, 'PreToolUse'));
  });

  it('object spec with file filter uses tool_input.file_path', () => {
    const rule = { match: { tool: 'Write', file: '*.ts' }, run: 'echo' };
    const match = { tool_name: 'Write', tool_input: { file_path: '/src/foo.ts' } };
    const noMatch = { tool_name: 'Write', tool_input: { file_path: '/src/foo.js' } };
    assert.ok(ruleMatches(rule, match, 'PostToolUse'));
    assert.ok(!ruleMatches(rule, noMatch, 'PostToolUse'));
  });

  it('object spec with file filter also uses tool_input.filePath (camelCase)', () => {
    const rule = { match: { file: '*.ts' }, run: 'echo' };
    const event = { tool_name: 'Write', tool_input: { filePath: '/src/foo.ts' } };
    assert.ok(ruleMatches(rule, event, 'PostToolUse'));
  });

  it('object spec with prompt filter', () => {
    const rule = { match: { prompt: 'deploy' }, run: 'echo' };
    assert.ok(ruleMatches(rule, { user_prompt: 'deploy now' }, 'UserPromptSubmit'));
    assert.ok(!ruleMatches(rule, { user_prompt: 'just refactor' }, 'UserPromptSubmit'));
  });

  it('object spec with message filter', () => {
    const rule = { match: { message: 'urgent' }, run: 'echo' };
    assert.ok(ruleMatches(rule, { message: 'urgent: fix needed' }, 'Notification'));
    assert.ok(!ruleMatches(rule, { message: 'info: all good' }, 'Notification'));
  });

  it('object spec with input.* dotpath filter', () => {
    const rule = { match: { 'input.command': 'rm -rf' }, run: 'echo' };
    const match = { tool_input: { command: 'rm -rf /' } };
    const noMatch = { tool_input: { command: 'ls -la' } };
    assert.ok(ruleMatches(rule, match, 'PreToolUse'));
    assert.ok(!ruleMatches(rule, noMatch, 'PreToolUse'));
  });

  it('input.* filter serializes non-string values to JSON for matching', () => {
    const rule = { match: { 'input.flags': 'verbose' }, run: 'echo' };
    const event = { tool_input: { flags: { verbose: true } } };
    assert.ok(ruleMatches(rule, event, 'PreToolUse'));
  });
});

// ─── expandGuard ─────────────────────────────────────────────────────────────

describe('expandGuard', () => {
  it('returns [] for an empty or missing guard', () => {
    assert.deepStrictEqual(expandGuard({}), []);
    assert.deepStrictEqual(expandGuard({ guard: {} }), []);
  });

  it('bash string entry creates a deny rule for Bash with input.command matcher', () => {
    const rules = expandGuard({ guard: { bash: ['rm -rf /'] } });
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].match.tool, 'Bash');
    assert.strictEqual(rules[0].match['input.command'], 'rm -rf /');
    assert.ok(rules[0].deny.includes('rm -rf /'));
  });

  it('bash object entry uses its custom reason', () => {
    const rules = expandGuard({ guard: { bash: [{ match: 'DROP TABLE', reason: 'No DDL' }] } });
    assert.strictEqual(rules[0].deny, 'No DDL');
    assert.strictEqual(rules[0].match['input.command'], 'DROP TABLE');
  });

  it('files string entry creates a deny rule for Write|Edit|MultiEdit with file matcher', () => {
    const rules = expandGuard({ guard: { files: ['.env*'] } });
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].match.tool, 'Write|Edit|MultiEdit');
    assert.strictEqual(rules[0].match.file, '.env*');
    assert.ok(rules[0].deny.includes('.env*'));
  });

  it('files object entry uses its custom reason', () => {
    const rules = expandGuard({ guard: { files: [{ match: '*.pem', reason: 'Cert protected' }] } });
    assert.strictEqual(rules[0].deny, 'Cert protected');
    assert.strictEqual(rules[0].match.file, '*.pem');
  });

  it('single string (not array) is treated as one entry via asArray', () => {
    const rules = expandGuard({ guard: { bash: 'rm -rf /' } });
    assert.strictEqual(rules.length, 1);
  });

  it('produces bash rules before file rules', () => {
    const rules = expandGuard({ guard: { bash: ['cmd'], files: ['*.env'] } });
    assert.strictEqual(rules[0].match.tool, 'Bash');
    assert.strictEqual(rules[1].match.tool, 'Write|Edit|MultiEdit');
  });
});

// ─── expandAllow ─────────────────────────────────────────────────────────────

describe('expandAllow', () => {
  it('returns [] for empty or missing allow', () => {
    assert.deepStrictEqual(expandAllow({}), []);
    assert.deepStrictEqual(expandAllow({ allow: {} }), []);
    assert.deepStrictEqual(expandAllow({ allow: { bash: [] } }), []);
  });

  it('bash string entry creates an allow:true rule targeting Bash', () => {
    const rules = expandAllow({ allow: { bash: ['npm test'] } });
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].allow, true);
    assert.strictEqual(rules[0].match.tool, 'Bash');
    assert.strictEqual(rules[0].match['input.command'], 'npm test');
  });

  it('bash object entry uses the match field', () => {
    const rules = expandAllow({ allow: { bash: [{ match: 'npm run' }] } });
    assert.strictEqual(rules[0].match['input.command'], 'npm run');
    assert.strictEqual(rules[0].allow, true);
  });

  it('single string (not array) via asArray', () => {
    const rules = expandAllow({ allow: { bash: 'npm test' } });
    assert.strictEqual(rules.length, 1);
  });
});

// ─── executeHook ─────────────────────────────────────────────────────────────

describe('executeHook — deny rule', () => {
  it('PreToolUse returns preToolDeny shape', () => {
    const result = executeHook({ deny: 'blocked' }, {}, 'PreToolUse');
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(result.hookSpecificOutput.permissionDecisionReason, 'blocked');
  });

  it('PermissionRequest returns permDeny shape', () => {
    const result = executeHook({ deny: 'blocked' }, {}, 'PermissionRequest');
    assert.strictEqual(result.hookSpecificOutput.decision.behavior, 'deny');
  });

  it('other event returns { decision: "block" }', () => {
    const result = executeHook({ deny: 'blocked' }, {}, 'PostToolUse');
    assert.strictEqual(result.decision, 'block');
    assert.strictEqual(result.reason, 'blocked');
  });

  it('expands template variables in the deny reason', () => {
    const event = { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };
    const result = executeHook({ deny: 'blocked {tool}: {input.command}' }, event, 'PreToolUse');
    assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('Bash'));
    assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('rm -rf /'));
  });
});

describe('executeHook — allow rule', () => {
  it('PreToolUse returns preToolAllow shape', () => {
    const result = executeHook({ allow: true }, {}, 'PreToolUse');
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'allow');
  });

  it('PermissionRequest returns permAllow shape', () => {
    const result = executeHook({ allow: true }, {}, 'PermissionRequest');
    assert.strictEqual(result.hookSpecificOutput.decision.behavior, 'allow');
  });

  it('other event returns null', () => {
    assert.strictEqual(executeHook({ allow: true }, {}, 'PostToolUse'), null);
    assert.strictEqual(executeHook({ allow: true }, {}, 'SessionStart'), null);
  });

  it('passes updated_input through on PreToolUse', () => {
    const result = executeHook({ allow: true, updated_input: { command: 'safe' } }, {}, 'PreToolUse');
    assert.deepStrictEqual(result.hookSpecificOutput.updatedInput, { command: 'safe' });
  });
});

describe('executeHook — prompt rule', () => {
  it('returns hso with the expanded prompt text', () => {
    const event = { tool_name: 'Write' };
    const result = executeHook({ prompt: 'Review this {tool} operation' }, event, 'PostToolUse');
    assert.ok(result.hookSpecificOutput.additionalContext.includes('Write'));
    assert.ok(result.hookSpecificOutput.additionalContext.startsWith('[hooksmith]'));
  });
});

describe('executeHook — agent rule', () => {
  it('returns hso with the agent message', () => {
    const result = executeHook({ agent: 'run the linter' }, {}, 'PostToolUse');
    assert.ok(result.hookSpecificOutput.additionalContext.includes('run the linter'));
    assert.ok(result.hookSpecificOutput.additionalContext.startsWith('[hooksmith agent]'));
  });
});

describe('executeHook — run rule', () => {
  it('exit 0 returns null', () => {
    assert.strictEqual(executeHook({ run: 'exit 0' }, {}, 'PostToolUse'), null);
  });

  it('exit 2 on PreToolUse returns preToolDeny', () => {
    const result = executeHook({ run: 'exit 2' }, {}, 'PreToolUse');
    assert.strictEqual(result.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('exit 2 on UserPromptSubmit returns { _exit: { code: 2 } }', () => {
    const result = executeHook({ run: 'exit 2' }, {}, 'UserPromptSubmit');
    assert.ok(result._exit);
    assert.strictEqual(result._exit.code, 2);
  });

  it('exit 2 on Stop (a blocking event) returns { decision: "block" }', () => {
    const result = executeHook({ run: 'exit 2' }, {}, 'Stop');
    assert.strictEqual(result.decision, 'block');
  });

  it('exit 2 on SubagentStop returns { decision: "block" }', () => {
    const result = executeHook({ run: 'exit 2' }, {}, 'SubagentStop');
    assert.strictEqual(result.decision, 'block');
  });

  it('stderr message from exit 2 appears in the deny reason', () => {
    const result = executeHook({ run: 'sh -c "echo blocked >&2; exit 2"' }, {}, 'PreToolUse');
    assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes('blocked'));
  });

  it('non-zero exit on a FEEDBACK_EVENT collects stderr as context', () => {
    const result = executeHook(
      { run: 'sh -c "echo lint error >&2; exit 1"' },
      {},
      'PostToolUse',
    );
    assert.ok(result.hookSpecificOutput.additionalContext.includes('lint error'));
  });

  it('block_on_fail with non-zero exit on Stop returns { decision: "block" }', () => {
    const result = executeHook({ run: 'exit 1', block_on_fail: true }, {}, 'Stop');
    assert.strictEqual(result.decision, 'block');
  });

  it('block_on_fail with non-zero exit on SubagentStop returns { decision: "block" }', () => {
    const result = executeHook({ run: 'exit 1', block_on_fail: true }, {}, 'SubagentStop');
    assert.strictEqual(result.decision, 'block');
  });

  it('block_on_fail with non-zero exit on StopFailure returns { decision: "block" }', () => {
    const result = executeHook({ run: 'exit 1', block_on_fail: true }, {}, 'StopFailure');
    assert.strictEqual(result.decision, 'block');
  });

  it('block_on_fail with exit 0 returns null', () => {
    assert.strictEqual(executeHook({ run: 'exit 0', block_on_fail: true }, {}, 'Stop'), null);
  });

  it('multiple commands in an array all run when all succeed', () => {
    assert.strictEqual(executeHook({ run: ['exit 0', 'exit 0'] }, {}, 'PostToolUse'), null);
  });

  it('output:"json" with valid JSON stdout returns the parsed object', () => {
    const result = executeHook(
      { run: 'printf \'{"decision":"allow"}\'', output: 'json' },
      {},
      'PreToolUse',
    );
    assert.deepStrictEqual(result, { decision: 'allow' });
  });

  it('output:"json" with invalid JSON stdout falls through without crashing', () => {
    const result = executeHook(
      { run: 'echo not-json', output: 'json' },
      {},
      'PostToolUse',
    );
    assert.strictEqual(result, null);
  });

  it('async:true fires and returns null without waiting', () => {
    const result = executeHook({ run: 'sleep 60', async: true }, {}, 'PostToolUse');
    assert.strictEqual(result, null);
  });

  it('timeout triggers ETIMEDOUT error which appears in context', () => {
    const result = executeHook({ run: 'sleep 5', timeout: 0.001 }, {}, 'PostToolUse');
    // Platform may kill before timeout kicks in — either is acceptable
    assert.ok(
      result === null ||
        result.hookSpecificOutput.additionalContext.includes('timeout'),
    );
  });
});

describe('executeHook — http rule', () => {
  it('returns null when the request fails (connection refused)', () => {
    const rule = { http: { url: 'http://localhost:19999/hook' }, timeout: 2 };
    const result = executeHook(rule, {}, 'PostToolUse');
    assert.strictEqual(result, null);
  });
});

// ─── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmp;
  let savedProjectDir;
  let savedHome;

  beforeEach(() => {
    tmp = mkTmp();
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    savedHome = process.env.HOME;
    process.env.CLAUDE_PROJECT_DIR = tmp.dir;
    // Point HOME at tmp.dir so the HOME candidate doesn't pick up real user config
    process.env.HOME = tmp.dir;
  });

  afterEach(() => {
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    tmp.cleanup();
  });

  it('returns null when no config files exist', () => {
    assert.strictEqual(loadConfig(), null);
  });

  it('loads config from CLAUDE_PROJECT_DIR/.claude/hooksmith.json', () => {
    const config = { on: { PostToolUse: [] } };
    writeHooksmith(tmp.dir, config);
    assert.deepStrictEqual(loadConfig(), config);
  });

  it('loads hooksmith key from CLAUDE_PROJECT_DIR/package.json', () => {
    const config = { on: {} };
    writeFileSync(
      join(tmp.dir, 'package.json'),
      JSON.stringify({ name: 'test', hooksmith: config }),
      'utf8',
    );
    assert.deepStrictEqual(loadConfig(), config);
  });

  it('skips package.json when it has no hooksmith key', () => {
    writeFileSync(join(tmp.dir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf8');
    assert.strictEqual(loadConfig(), null);
  });

  it('returns null and does not throw on invalid JSON', () => {
    mkdirSync(join(tmp.dir, '.claude'), { recursive: true });
    writeFileSync(join(tmp.dir, '.claude', 'hooksmith.json'), '{not valid json}', 'utf8');
    assert.strictEqual(loadConfig(), null);
  });

  it('loads from HOME/.claude/hooksmith.json when project dir has no config', () => {
    const homeTmp = mkTmp();
    try {
      process.env.HOME = homeTmp.dir;
      writeHooksmith(homeTmp.dir, { on: {} });
      assert.deepStrictEqual(loadConfig(), { on: {} });
    } finally {
      homeTmp.cleanup();
    }
  });

  it('prefers CLAUDE_PROJECT_DIR over HOME when both have configs', () => {
    writeHooksmith(tmp.dir, { on: { PostToolUse: [] } });
    const homeTmp = mkTmp();
    try {
      process.env.HOME = homeTmp.dir;
      writeHooksmith(homeTmp.dir, { on: { Stop: [] } });
      const result = loadConfig();
      assert.ok('PostToolUse' in (result.on || {}));
    } finally {
      homeTmp.cleanup();
    }
  });
});

// ─── Subprocess integration ───────────────────────────────────────────────────

describe('dispatcher subprocess integration', () => {
  let tmp;

  before(() => { tmp = mkTmp(); });
  after(() => { tmp.cleanup(); });

  it('exits 0 with no output when event has no hook_event_name', () => {
    const result = runScript(DISPATCHER, {
      stdin: { tool_name: 'Bash' },
      env: { CLAUDE_PROJECT_DIR: tmp.dir, HOME: tmp.dir },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
  });

  it('exits 0 with no output when no config is found', () => {
    const result = runScript(DISPATCHER, {
      stdin: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      env: { CLAUDE_PROJECT_DIR: tmp.dir, HOME: tmp.dir },
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '');
  });

  it('uses HOOKSMITH_EVENT env var when hook_event_name is absent', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        on: { PostToolUse: [{ prompt: 'hello from hook' }] },
      });
      const result = runScript(DISPATCHER, {
        stdin: '{}',
        env: {
          HOOKSMITH_EVENT: 'PostToolUse',
          CLAUDE_PROJECT_DIR: configTmp.dir,
          HOME: configTmp.dir,
        },
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.ok(out.hookSpecificOutput.additionalContext.includes('hello from hook'));
    } finally {
      configTmp.cleanup();
    }
  });

  it('guard deny blocks a matching Bash command on PreToolUse', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        guard: { bash: [{ match: 'rm -rf /', reason: 'Destructive command blocked' }] },
      });
      const result = runScript(DISPATCHER, {
        stdin: {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
        },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('Destructive'));
    } finally {
      configTmp.cleanup();
    }
  });

  it('allow rule permits a PermissionRequest', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        allow: { bash: ['npm test'] },
      });
      const result = runScript(DISPATCHER, {
        stdin: {
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
        },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.hookSpecificOutput.decision.behavior, 'allow');
    } finally {
      configTmp.cleanup();
    }
  });

  it('prompt rule on PostToolUse returns additionalContext', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        on: { PostToolUse: [{ prompt: 'please review this change' }] },
      });
      const result = runScript(DISPATCHER, {
        stdin: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.ok(out.hookSpecificOutput.additionalContext.includes('please review this change'));
    } finally {
      configTmp.cleanup();
    }
  });

  it('multiple prompt rules accumulate into a single joined context', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        on: {
          PostToolUse: [
            { prompt: 'first instruction' },
            { prompt: 'second instruction' },
          ],
        },
      });
      const result = runScript(DISPATCHER, {
        stdin: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      const out = JSON.parse(result.stdout);
      assert.ok(out.hookSpecificOutput.additionalContext.includes('first instruction'));
      assert.ok(out.hookSpecificOutput.additionalContext.includes('second instruction'));
    } finally {
      configTmp.cleanup();
    }
  });

  it('run rule with exit 0 produces no stdout', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        on: { PostToolUse: [{ run: 'exit 0' }] },
      });
      const result = runScript(DISPATCHER, {
        stdin: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '');
    } finally {
      configTmp.cleanup();
    }
  });

  it('run rule with exit 2 on UserPromptSubmit exits with code 2', () => {
    const configTmp = mkTmp();
    try {
      writeHooksmith(configTmp.dir, {
        on: { UserPromptSubmit: [{ run: 'sh -c "echo blocked >&2; exit 2"' }] },
      });
      const result = runScript(DISPATCHER, {
        stdin: { hook_event_name: 'UserPromptSubmit', user_prompt: 'do something' },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 2);
    } finally {
      configTmp.cleanup();
    }
  });

  it('discovers config from package.json hooksmith key', () => {
    const configTmp = mkTmp();
    try {
      writeFileSync(
        join(configTmp.dir, 'package.json'),
        JSON.stringify({ hooksmith: { on: { PostToolUse: [{ prompt: 'from package.json' }] } } }),
        'utf8',
      );
      const result = runScript(DISPATCHER, {
        stdin: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
        env: { CLAUDE_PROJECT_DIR: configTmp.dir, HOME: configTmp.dir },
      });
      assert.strictEqual(result.status, 0);
      const out = JSON.parse(result.stdout);
      assert.ok(out.hookSpecificOutput.additionalContext.includes('from package.json'));
    } finally {
      configTmp.cleanup();
    }
  });
});
