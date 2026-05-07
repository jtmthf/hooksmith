import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ─── Presets ──────────────────────────────────────────────────────────────────

export const PRESETS = {
  minimal: {
    $schema: '../schema/hooksmith.schema.json',
    guard: {},
    allow: {},
    on: {},
  },

  frontend: {
    $schema: '../schema/hooksmith.schema.json',
    on: {
      PostToolUse: [
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'prettier --write {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'eslint --fix {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{json,yaml,yml,md,css,scss}' },
          run: 'prettier --write {file}',
        },
      ],
    },
  },

  python: {
    $schema: '../schema/hooksmith.schema.json',
    on: {
      PostToolUse: [
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: ['black {file}', 'isort {file}'],
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: 'ruff check --fix {file}',
        },
      ],
    },
  },

  fullstack: {
    $schema: '../schema/hooksmith.schema.json',
    on: {
      PostToolUse: [
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'prettier --write {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'eslint --fix {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{json,yaml,yml,md,css,scss}' },
          run: 'prettier --write {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: ['black {file}', 'isort {file}'],
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: 'ruff check --fix {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.go' },
          run: 'gofmt -w {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.rs' },
          run: 'rustfmt {file}',
        },
      ],
    },
  },

  strict: {
    $schema: '../schema/hooksmith.schema.json',
    guard: {
      bash: [
        { match: 'rm -rf /', reason: 'Destructive root deletion blocked' },
        { match: ':(){ :|:& };:', reason: 'Fork bomb blocked' },
        { match: '/curl[^|]+\\|\\s*sh/', reason: 'Pipe-to-shell blocked' },
        { match: 'DROP TABLE', reason: 'Database DDL blocked' },
        { match: 'TRUNCATE TABLE', reason: 'Database DDL blocked' },
        { match: 'chmod -R 777', reason: 'Overly permissive chmod blocked' },
      ],
      files: [
        { match: '.env*', reason: 'Environment files are protected' },
        { match: '*.pem', reason: 'Certificate files are protected' },
        { match: '*.key', reason: 'Key files are protected' },
        { match: 'id_rsa*', reason: 'SSH keys are protected' },
        { match: '*.p12', reason: 'PKCS12 keystores are protected' },
      ],
    },
    allow: {
      bash: ['npm test', 'npm run lint', 'npm run build', 'npx prettier', 'npx eslint'],
    },
    on: {
      PostToolUse: [
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'prettier --write {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{ts,tsx,js,jsx,mjs,cjs}' },
          run: 'eslint --fix {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.{json,yaml,yml,md,css,scss}' },
          run: 'prettier --write {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: ['black {file}', 'isort {file}'],
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.py' },
          run: 'ruff check --fix {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.go' },
          run: 'gofmt -w {file}',
        },
        {
          match: { tool: 'Write|Edit|MultiEdit', file: '*.rs' },
          run: 'rustfmt {file}',
        },
      ],
      Stop: [
        { run: 'npm test', block_on_fail: true },
      ],
      SessionStart: [
        {
          run: 'echo "Project: $(basename $(pwd)) | Branch: $(git branch --show-current 2>/dev/null || echo n/a)"',
        },
      ],
      UserPromptSubmit: [
        {
          match: { prompt: '/deploy|production|release|rollback/' },
          prompt: 'This prompt mentions a high-impact operation. Verify intent and confirm safety before proceeding: {prompt}',
        },
      ],
      Notification: [
        {
          run: "notify-send 'Claude Code' 'Awaiting your input' 2>/dev/null || osascript -e 'display notification \"Awaiting your input\" with title \"Claude Code\"' 2>/dev/null || true",
          async: true,
        },
      ],
    },
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function parseArgs(argv = process.argv.slice(2)) {
  const result = { preset: null, scope: 'project' };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preset' && argv[i + 1]) result.preset = argv[++i];
    else if (argv[i] === '--project') result.scope = 'project';
    else if (argv[i] === '--user') result.scope = 'user';
    else if (argv[i] === '--package') result.scope = 'package';
    else if (argv[i].startsWith('--preset=')) result.preset = argv[i].slice(9);
  }

  return result;
}

export function targetPath(scope) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (scope === 'user') return join(home, '.claude', 'hooksmith.json');
  if (scope === 'package') return join(process.cwd(), 'package.json');
  return join(process.cwd(), '.claude', 'hooksmith.json');
}

export function writeConfig(scope, config) {
  const target = targetPath(scope);

  if (scope === 'package') {
    let pkg = {};
    if (existsSync(target)) {
      try { pkg = JSON.parse(readFileSync(target, 'utf8')); } catch {}
    }
    if (pkg.hooksmith) {
      throw new Error(`hooksmith key already exists in ${target}. Remove it first.`);
    }
    pkg.hooksmith = { ...config };
    delete pkg.hooksmith.$schema;
    writeFileSync(target, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    return target;
  }

  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  if (existsSync(target)) {
    throw new Error(`${target} already exists. Remove it first or choose a different scope.`);
  }

  writeFileSync(target, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return target;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function main() {
  const { preset, scope } = parseArgs();

  if (!preset) {
    console.log('hooksmith init\n');
    console.log('Usage: node init.js --preset <preset> [--project|--user|--package]\n');
    console.log('Presets:');
    for (const name of Object.keys(PRESETS)) {
      console.log(`  ${name}`);
    }
    process.exit(0);
  }

  if (!(preset in PRESETS)) {
    console.error(`hooksmith: unknown preset '${preset}'. Valid: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  const config = JSON.parse(JSON.stringify(PRESETS[preset]));

  let target;
  try {
    target = writeConfig(scope, config);
  } catch (err) {
    console.error(`hooksmith: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n✓  Written to ${target}`);
  console.log('\nNext steps:');
  console.log('  1. Edit the config to fit your project');
  console.log('  2. Run /hooksmith to validate');
  console.log('  3. Run /hooksmith:help for the full reference\n');
}
