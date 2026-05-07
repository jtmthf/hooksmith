import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { parseArgs, PRESETS, targetPath } from '../lib/init.js';
import { mkTmp, runScript } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INIT_SCRIPT = join(__dirname, '..', 'scripts', 'init.js');

function spawnInit(args, { cwd, home } = {}) {
  return spawnSync(process.execPath, [INIT_SCRIPT, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...(home ? { HOME: home } : {}) },
  });
}

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('no args → { preset: null, scope: "project" }', () => {
    assert.deepStrictEqual(parseArgs([]), { preset: null, scope: 'project' });
  });

  it('--preset <name> sets preset', () => {
    assert.deepStrictEqual(parseArgs(['--preset', 'minimal']), { preset: 'minimal', scope: 'project' });
  });

  it('--preset=<name> form sets preset', () => {
    assert.deepStrictEqual(parseArgs(['--preset=frontend']), { preset: 'frontend', scope: 'project' });
  });

  it('--user sets scope to user', () => {
    assert.deepStrictEqual(parseArgs(['--preset', 'strict', '--user']), { preset: 'strict', scope: 'user' });
  });

  it('--package sets scope to package', () => {
    assert.deepStrictEqual(parseArgs(['--preset', 'minimal', '--package']), { preset: 'minimal', scope: 'package' });
  });

  it('--project sets scope to project (explicit)', () => {
    assert.deepStrictEqual(parseArgs(['--project']), { preset: null, scope: 'project' });
  });

  it('last scope flag wins when multiple are given', () => {
    const result = parseArgs(['--preset', 'x', '--project', '--user']);
    assert.strictEqual(result.scope, 'user');
  });

  it('--preset without a following value leaves preset null', () => {
    const result = parseArgs(['--preset']);
    assert.strictEqual(result.preset, null);
  });
});

// ─── PRESETS ─────────────────────────────────────────────────────────────────

describe('PRESETS', () => {
  it('all five presets exist', () => {
    for (const name of ['minimal', 'frontend', 'python', 'fullstack', 'strict']) {
      assert.ok(name in PRESETS, `missing preset: ${name}`);
    }
  });

  it('each preset is a non-null object', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      assert.ok(preset && typeof preset === 'object', `${name} is not an object`);
    }
  });

  it('minimal preset has guard, allow, and on as empty objects', () => {
    const { guard, allow, on } = PRESETS.minimal;
    assert.deepStrictEqual(guard, {});
    assert.deepStrictEqual(allow, {});
    assert.deepStrictEqual(on, {});
  });

  it('strict preset has guard.bash and guard.files as non-empty arrays', () => {
    const { guard } = PRESETS.strict;
    assert.ok(Array.isArray(guard.bash) && guard.bash.length > 0);
    assert.ok(Array.isArray(guard.files) && guard.files.length > 0);
  });

  it('strict preset has allow.bash as a non-empty array', () => {
    assert.ok(Array.isArray(PRESETS.strict.allow.bash) && PRESETS.strict.allow.bash.length > 0);
  });

  it('frontend preset has PostToolUse rules', () => {
    const rules = PRESETS.frontend.on.PostToolUse;
    assert.ok(Array.isArray(rules) && rules.length > 0);
  });

  it('python preset has PostToolUse rules including multi-command run array', () => {
    const rules = PRESETS.python.on.PostToolUse;
    assert.ok(rules.some(r => Array.isArray(r.run)));
  });

  it('no preset contains undefined values at the top level', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const [key, value] of Object.entries(preset)) {
        assert.notStrictEqual(value, undefined, `${name}.${key} is undefined`);
      }
    }
  });
});

// ─── targetPath ───────────────────────────────────────────────────────────────

describe('targetPath', () => {
  it('"project" scope targets .claude/hooksmith.json in cwd', () => {
    const result = targetPath('project');
    assert.ok(result.endsWith(join('.claude', 'hooksmith.json')));
    assert.ok(result.startsWith(process.cwd()));
  });

  it('"user" scope targets HOME/.claude/hooksmith.json', () => {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const result = targetPath('user');
    assert.strictEqual(result, join(home, '.claude', 'hooksmith.json'));
  });

  it('"package" scope targets package.json in cwd', () => {
    const result = targetPath('package');
    assert.strictEqual(result, join(process.cwd(), 'package.json'));
  });
});

// ─── init subprocess integration ─────────────────────────────────────────────

describe('init subprocess integration', () => {
  it('no args exits 0 and lists available preset names', () => {
    const result = runScript(INIT_SCRIPT, { stdin: '' });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('minimal'));
    assert.ok(result.stdout.includes('strict'));
    assert.ok(result.stdout.includes('frontend'));
  });

  it('unknown preset exits 1 with error mentioning the name', () => {
    const result = spawnInit(['--preset', 'nonexistent']);
    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('nonexistent'));
  });

  it('--preset minimal --project creates .claude/hooksmith.json with minimal content', () => {
    const tmp = mkTmp();
    try {
      const result = spawnInit(['--preset', 'minimal', '--project'], { cwd: tmp.dir, home: tmp.dir });
      assert.strictEqual(result.status, 0, result.stderr);
      const configPath = join(tmp.dir, '.claude', 'hooksmith.json');
      assert.ok(existsSync(configPath));
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepStrictEqual(written.guard, {});
      assert.deepStrictEqual(written.allow, {});
      assert.deepStrictEqual(written.on, {});
    } finally {
      tmp.cleanup();
    }
  });

  it('--preset minimal --project exits 1 when the file already exists', () => {
    const tmp = mkTmp();
    try {
      const args = ['--preset', 'minimal', '--project'];
      spawnInit(args, { cwd: tmp.dir, home: tmp.dir });
      const result = spawnInit(args, { cwd: tmp.dir, home: tmp.dir });
      assert.strictEqual(result.status, 1);
    } finally {
      tmp.cleanup();
    }
  });

  it('--preset minimal --package merges hooksmith key into package.json without $schema', () => {
    const tmp = mkTmp();
    try {
      writeFileSync(join(tmp.dir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf8');
      const result = spawnInit(['--preset', 'minimal', '--package'], { cwd: tmp.dir, home: tmp.dir });
      assert.strictEqual(result.status, 0, result.stderr);
      const pkg = JSON.parse(readFileSync(join(tmp.dir, 'package.json'), 'utf8'));
      assert.ok('hooksmith' in pkg);
      assert.ok(!('$schema' in pkg.hooksmith), '$schema should be stripped from package.json embed');
    } finally {
      tmp.cleanup();
    }
  });

  it('--preset minimal --package exits 1 when hooksmith key already exists', () => {
    const tmp = mkTmp();
    try {
      writeFileSync(
        join(tmp.dir, 'package.json'),
        JSON.stringify({ name: 'test', hooksmith: {} }),
        'utf8',
      );
      const result = spawnInit(['--preset', 'minimal', '--package'], { cwd: tmp.dir, home: tmp.dir });
      assert.strictEqual(result.status, 1);
    } finally {
      tmp.cleanup();
    }
  });

  it('--preset strict --user writes to HOME/.claude/hooksmith.json with guard rules', () => {
    const tmp = mkTmp();
    try {
      const result = spawnInit(['--preset', 'strict', '--user'], { cwd: tmp.dir, home: tmp.dir });
      assert.strictEqual(result.status, 0, result.stderr);
      const configPath = join(tmp.dir, '.claude', 'hooksmith.json');
      assert.ok(existsSync(configPath));
      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.ok(Array.isArray(written.guard.bash) && written.guard.bash.length > 0);
      assert.ok(Array.isArray(written.guard.files) && written.guard.files.length > 0);
    } finally {
      tmp.cleanup();
    }
  });

  it('all five presets generate valid, parseable JSON files', () => {
    for (const preset of ['minimal', 'frontend', 'python', 'fullstack', 'strict']) {
      const tmp = mkTmp();
      try {
        const result = spawnInit(['--preset', preset, '--project'], { cwd: tmp.dir, home: tmp.dir });
        assert.strictEqual(result.status, 0, `${preset} failed: ${result.stderr}`);
        const configPath = join(tmp.dir, '.claude', 'hooksmith.json');
        assert.ok(existsSync(configPath), `${preset} did not create config file`);
        assert.doesNotThrow(
          () => JSON.parse(readFileSync(configPath, 'utf8')),
          `${preset} produced invalid JSON`,
        );
      } finally {
        tmp.cleanup();
      }
    }
  });
});
