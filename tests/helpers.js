import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export function mkTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'hooksmith-test-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function runScript(scriptPath, { stdin, env, cwd } = {}) {
  const input = typeof stdin === 'string' ? stdin : JSON.stringify(stdin ?? {});
  const result = spawnSync(process.execPath, [scriptPath], {
    input,
    env: { ...process.env, ...env },
    cwd: cwd ?? undefined,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

export function writeHooksmith(dir, config) {
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, 'hooksmith.json'),
    JSON.stringify(config, null, 2) + '\n',
    'utf8',
  );
}
