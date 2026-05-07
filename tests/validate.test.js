import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { findConfig, validate, summarize } from '../lib/validate.js';
import { mkTmp } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALIDATE_SCRIPT = join(__dirname, '..', 'scripts', 'validate.js');

// ─── findConfig ───────────────────────────────────────────────────────────────

describe('findConfig', () => {
  it('returns [path, config, null] for an explicit path that exists', () => {
    const tmp = mkTmp();
    try {
      const file = join(tmp.dir, 'hooksmith.json');
      const config = { on: {} };
      writeFileSync(file, JSON.stringify(config), 'utf8');
      const [p, c, err] = findConfig(file);
      assert.strictEqual(p, file);
      assert.deepStrictEqual(c, config);
      assert.strictEqual(err, null);
    } finally {
      tmp.cleanup();
    }
  });

  it('returns [null, null, error] for a path that does not exist', () => {
    const [p, c, err] = findConfig('/nonexistent/path/hooksmith.json');
    assert.strictEqual(p, null);
    assert.strictEqual(c, null);
    assert.ok(typeof err === 'string');
    assert.ok(err.includes('not found'));
  });

  it('returns [null, null, error] for a file with invalid JSON', () => {
    const tmp = mkTmp();
    try {
      const file = join(tmp.dir, 'bad.json');
      writeFileSync(file, '{invalid json}', 'utf8');
      const [p, c, err] = findConfig(file);
      assert.strictEqual(p, null);
      assert.strictEqual(c, null);
      assert.ok(err.includes('parse error'));
    } finally {
      tmp.cleanup();
    }
  });
});

// ─── validate ─────────────────────────────────────────────────────────────────

describe('validate — valid configs', () => {
  it('empty object produces no errors', () => {
    assert.deepStrictEqual(validate({}), []);
  });

  it('$schema alone is valid', () => {
    assert.deepStrictEqual(validate({ $schema: './hooksmith.schema.json' }), []);
  });

  it('empty guard, allow, and on are valid', () => {
    assert.deepStrictEqual(validate({ guard: {}, allow: {}, on: {} }), []);
  });

  it('a fully valid config with multiple events is accepted', () => {
    const config = {
      guard: { bash: ['rm -rf /'], files: ['.env*'] },
      allow: { bash: ['npm test'] },
      on: {
        PostToolUse: [
          { match: { tool: 'Write', file: '*.ts' }, run: 'prettier --write {file}' },
        ],
        Stop: [
          { run: ['npm test'], block_on_fail: true },
        ],
      },
    };
    assert.deepStrictEqual(validate(config), []);
  });
});

describe('validate — unknown top-level key', () => {
  it('flags unknown keys at the root level', () => {
    const errors = validate({ unknown_key: true });
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].msg.includes('unknown_key'));
  });
});

describe('validate — guard', () => {
  it('guard that is an array is an error', () => {
    const errors = validate({ guard: [] });
    assert.ok(errors.some(e => e.path === 'guard'));
  });

  it('unknown subkey in guard is flagged', () => {
    const errors = validate({ guard: { unknown: [] } });
    assert.ok(errors.some(e => e.path === 'guard.unknown'));
  });

  it('bash entry that is an array (nested) is flagged', () => {
    const errors = validate({ guard: { bash: [['nested']] } });
    assert.ok(errors.some(e => e.path.startsWith('guard.bash')));
  });

  it('bash object entry missing match field is flagged', () => {
    const errors = validate({ guard: { bash: [{ reason: 'no match' }] } });
    assert.ok(errors.some(e => e.path === 'guard.bash[0]' && e.msg.includes("'match'")));
  });

  it('bash object entry with an unknown field is flagged', () => {
    const errors = validate({ guard: { bash: [{ match: 'foo', badfield: true }] } });
    assert.ok(errors.some(e => e.path === 'guard.bash[0].badfield'));
  });

  it('bash string entry is valid', () => {
    assert.deepStrictEqual(validate({ guard: { bash: ['rm -rf /'] } }), []);
  });

  it('files object entry missing match is flagged', () => {
    const errors = validate({ guard: { files: [{ reason: 'protected' }] } });
    assert.ok(errors.some(e => e.path === 'guard.files[0]'));
  });
});

describe('validate — allow', () => {
  it('allow that is an array is an error', () => {
    const errors = validate({ allow: [] });
    assert.ok(errors.some(e => e.path === 'allow'));
  });

  it('unknown key in allow is flagged', () => {
    const errors = validate({ allow: { run: [] } });
    assert.ok(errors.some(e => e.path === 'allow.run'));
  });

  it('bash entry that is a number is flagged', () => {
    const errors = validate({ allow: { bash: [42] } });
    assert.ok(errors.some(e => e.path === 'allow.bash[0]'));
  });

  it('bash string entry is valid', () => {
    assert.deepStrictEqual(validate({ allow: { bash: ['npm test'] } }), []);
  });

  it('bash object entry with match is valid', () => {
    assert.deepStrictEqual(validate({ allow: { bash: [{ match: 'npm run' }] } }), []);
  });
});

describe('validate — on', () => {
  it('on that is an array is an error', () => {
    const errors = validate({ on: [] });
    assert.ok(errors.some(e => e.path === 'on'));
  });

  it('unknown event name is flagged', () => {
    const errors = validate({ on: { NotARealEvent: [] } });
    assert.ok(errors.some(e => e.path === 'on.NotARealEvent'));
  });

  it('event rules not an array is flagged', () => {
    const errors = validate({ on: { PostToolUse: {} } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse'));
  });

  it('rule that is not an object is flagged', () => {
    const errors = validate({ on: { PostToolUse: ['not-an-object'] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0]'));
  });

  it('rule with an unknown key is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: 'echo', badkey: true }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].badkey'));
  });

  it('rule with no action is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ match: { tool: 'Write' } }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0]' && e.msg.includes('missing action')));
  });
});

describe('validate — match spec', () => {
  it('unknown matcher key is flagged', () => {
    const errors = validate({
      on: { PostToolUse: [{ run: 'echo', match: { badkey: 'val' } }] },
    });
    assert.ok(errors.some(e => e.path.includes('match.badkey')));
  });

  it('input.* dotpath key is valid', () => {
    const errors = validate({
      on: { PostToolUse: [{ run: 'echo', match: { 'input.command': 'npm' } }] },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('tool matcher on a TOOL_EVENT is valid', () => {
    const errors = validate({
      on: { PreToolUse: [{ run: 'echo', match: { tool: 'Bash' } }] },
    });
    assert.deepStrictEqual(errors, []);
  });

  it('tool matcher on a non-tool event is flagged', () => {
    const errors = validate({
      on: { UserPromptSubmit: [{ run: 'echo', match: { tool: 'Bash' } }] },
    });
    assert.ok(errors.some(e => e.path.includes('match.tool')));
  });

  it('file matcher on a non-tool event is flagged', () => {
    const errors = validate({
      on: { Stop: [{ run: 'echo', match: { file: '*.ts' } }] },
    });
    assert.ok(errors.some(e => e.path.includes('match.file')));
  });
});

describe('validate — rule properties', () => {
  it('run as non-string non-array is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: 42 }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].run'));
  });

  it('run as string is valid', () => {
    assert.deepStrictEqual(validate({ on: { PostToolUse: [{ run: 'echo' }] } }), []);
  });

  it('run as string array is valid', () => {
    assert.deepStrictEqual(validate({ on: { PostToolUse: [{ run: ['echo', 'ls'] }] } }), []);
  });

  it('run array with non-string element is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: ['echo', 42] }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].run[1]'));
  });

  it('http not an object is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ http: 'https://example.com' }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].http'));
  });

  it('http missing url is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ http: { method: 'GET' } }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].http.url'));
  });

  it('http with url is valid', () => {
    assert.deepStrictEqual(
      validate({ on: { PostToolUse: [{ http: { url: 'https://example.com' } }] } }),
      [],
    );
  });

  it('prompt not a string is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ prompt: 42 }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].prompt'));
  });

  it('prompt as string is valid', () => {
    assert.deepStrictEqual(validate({ on: { PostToolUse: [{ prompt: 'review' }] } }), []);
  });

  it('agent not a string is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ agent: 42 }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].agent'));
  });

  it('timeout of zero is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: 'echo', timeout: 0 }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].timeout'));
  });

  it('negative timeout is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: 'echo', timeout: -5 }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].timeout'));
  });

  it('positive timeout is valid', () => {
    assert.deepStrictEqual(
      validate({ on: { PostToolUse: [{ run: 'echo', timeout: 30 }] } }),
      [],
    );
  });

  it('unknown output value is flagged', () => {
    const errors = validate({ on: { PostToolUse: [{ run: 'echo', output: 'xml' }] } });
    assert.ok(errors.some(e => e.path === 'on.PostToolUse[0].output'));
  });

  it('output:"json" is valid', () => {
    assert.deepStrictEqual(
      validate({ on: { PostToolUse: [{ run: 'echo', output: 'json' }] } }),
      [],
    );
  });
});

// ─── summarize ────────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('returns "(no rules defined)" for an empty config', () => {
    assert.strictEqual(summarize({}), '  (no rules defined)');
    assert.strictEqual(summarize({ on: {} }), '  (no rules defined)');
  });

  it('shows guard bash rule count and file pattern count', () => {
    const result = summarize({ guard: { bash: ['a', 'b'], files: ['*.env'] } });
    assert.ok(result.includes('2 bash rule'));
    assert.ok(result.includes('1 file pattern'));
  });

  it('shows allow bash pattern count', () => {
    const result = summarize({ allow: { bash: ['npm test', 'npm run lint'] } });
    assert.ok(result.includes('2 bash pattern'));
  });

  it('shows each event with rule count and action type tags', () => {
    const result = summarize({
      on: {
        PostToolUse: [{ run: 'prettier' }, { prompt: 'review' }],
      },
    });
    assert.ok(result.includes('PostToolUse'));
    assert.ok(result.includes('2 rule'));
    assert.ok(result.includes('['));
  });

  it('shows async count when rules have async:true', () => {
    const result = summarize({
      on: { Notification: [{ run: 'notify', async: true }] },
    });
    assert.ok(result.includes('async'));
  });

  it('sorts events alphabetically', () => {
    const result = summarize({
      on: {
        Stop: [{ run: 'echo' }],
        PostToolUse: [{ run: 'echo' }],
        Notification: [{ run: 'echo' }],
      },
    });
    const notifIdx = result.indexOf('Notification');
    const postIdx = result.indexOf('PostToolUse');
    const stopIdx = result.indexOf('Stop');
    assert.ok(notifIdx < postIdx && postIdx < stopIdx);
  });

  it('skips on events with empty arrays', () => {
    const result = summarize({ on: { PostToolUse: [] } });
    assert.ok(!result.includes('PostToolUse'));
  });
});

// ─── validate subprocess integration ─────────────────────────────────────────

describe('validate subprocess integration', () => {
  it('exits 1 when no config file is found', () => {
    const tmp = mkTmp();
    try {
      const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, HOME: tmp.dir },
        cwd: tmp.dir,
      });
      assert.strictEqual(result.status, 1);
    } finally {
      tmp.cleanup();
    }
  });

  it('exits 0 and prints ✓ for a valid config passed as an argument', () => {
    const tmp = mkTmp();
    try {
      const configFile = join(tmp.dir, 'hooksmith.json');
      writeFileSync(
        configFile,
        JSON.stringify({ on: { PostToolUse: [{ run: 'echo' }] } }),
        'utf8',
      );
      const result = spawnSync(process.execPath, [VALIDATE_SCRIPT, configFile], {
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('✓'));
    } finally {
      tmp.cleanup();
    }
  });

  it('exits 1 and reports errors for an invalid config', () => {
    const tmp = mkTmp();
    try {
      const configFile = join(tmp.dir, 'hooksmith.json');
      writeFileSync(configFile, JSON.stringify({ badkey: true }), 'utf8');
      const result = spawnSync(process.execPath, [VALIDATE_SCRIPT, configFile], {
        encoding: 'utf8',
      });
      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('error'));
    } finally {
      tmp.cleanup();
    }
  });

  it('discovers package.json#hooksmith during auto-discovery', () => {
    const tmp = mkTmp();
    try {
      writeFileSync(
        join(tmp.dir, 'package.json'),
        JSON.stringify({ hooksmith: { on: { PostToolUse: [{ run: 'echo' }] } } }),
        'utf8',
      );
      const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
        encoding: 'utf8',
        cwd: tmp.dir,
        env: { ...process.env, HOME: tmp.dir },
      });
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('package.json'));
    } finally {
      tmp.cleanup();
    }
  });
});
