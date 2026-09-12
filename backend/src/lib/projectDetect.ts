import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// execFile, never a shell: the repository URL is user input, and inside a
// shell string `$(...)` or backticks in it would run
const execFileAsync = promisify(execFile);
// No prompts, and no borrowed login: an editor terminal (VS Code) exports
// GIT_ASKPASS pointing at its own GitHub session, which answers for git — a
// private repo would read as public here and then fail to clone at deploy.
// An empty GIT_ASKPASS switches askpass off (core.askPass/SSH_ASKPASS included).
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };

/**
 * Framework / package-manager detection, the way Vercel and Nixpacks do it:
 * read a handful of well-known files and derive the preset. Used to prefill
 * the "new app" form and as the fallback for apps whose build/start command
 * was left empty.
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DetectedProject {
  type: 'NODEJS' | 'STATIC' | 'PHP' | 'PYTHON';
  framework: string | null; // "nextjs" | "nuxt" | "astro" | "sveltekit" | "remix" | "vite" | "express" | ...
  label: string; // human name for the UI
  packageManager: PackageManager;
  installCommand: string;
  buildCommand: string | null;
  startCommand: string | null;
  outputDir: string | null; // static sites: build output; PHP: document root
  port: number | null;
  nodeVersion: string | null;
  env: RepoEnv;
  /** things in the project that will misbehave behind the platform's proxy */
  warnings: DetectWarning[];
  /** a step after the build, before the release goes live — Prisma's migrations — or null */
  preDeployCommand: string | null;
  /** a step before the build — Prisma's client generation — or null */
  generateCommand: string | null;
}

export type DetectWarning =
  /** the start script pins a port (`next start -p 3000`): PORT is ignored and the proxy gets a 502 */
  | { code: 'start-fixed-port'; port: string }
  /** the start script runs `next start` without -H: it listens on every interface, not just loopback */
  | { code: 'start-binds-all' };

/** What the repository says about its environment — the add-app form prefills from it. */
export interface RepoEnv {
  /** from .env.example / .sample / .template: every key, with its default when it has one */
  example: { file: string; vars: Array<{ key: string; value: string }> } | null;
  /** keys the repo's own .env.production sets — Next.js and Vite load it at build by themselves */
  production: string[];
  /** secret files that are committed and should not be: .env, .env.local */
  committed: string[];
  /** a SQL client or ORM in the dependencies — the app will want a DATABASE_URL */
  needsDatabase: boolean;
}

// what a Node app talks to Postgres/MySQL through (Mongo is not something Larika hosts)
const SQL_DEPS = ['pg', 'postgres', '@prisma/client', 'prisma', 'mysql2', 'mysql', 'drizzle-orm', 'typeorm', 'sequelize', 'knex', 'kysely'];

const EXAMPLE_ENV_FILES = ['.env.example', '.env.sample', '.env.template'] as const;
// read for their presence only — never their contents, which are secrets
const SECRET_ENV_FILES = ['.env', '.env.local'] as const;

/** The files worth reading. Detection needs nothing else. */
export const DETECT_FILES = [
  ...EXAMPLE_ENV_FILES,
  '.env.production',
  ...SECRET_ENV_FILES,
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  '.nvmrc',
  '.node-version',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'requirements.txt',
  'composer.json',
  'index.php',
  'index.html',
] as const;

export type DetectInput = Partial<Record<(typeof DETECT_FILES)[number], string>>;

// Next's own entry file, run by the Node run.sh selected: not a bare `next`
// (node_modules/.bin is not on PATH there) nor the .bin shim, which pnpm
// generates as a shell wrapper. node_modules/next is at the top level under
// every package manager (pnpm links it there).
// -H: `next start` binds 0.0.0.0 by default and ignores the HOST env run.sh sets.
const NEXT_START = 'node ./node_modules/next/dist/bin/next start -H 127.0.0.1 -p $PORT';

const FRAMEWORKS: Array<{ dep: string; framework: string; label: string; build: string; start: string; port: number }> = [
  { dep: 'next', framework: 'nextjs', label: 'Next.js', build: 'next build', start: NEXT_START, port: 3000 },
  { dep: 'nuxt', framework: 'nuxt', label: 'Nuxt', build: 'nuxt build', start: 'node .output/server/index.mjs', port: 3000 },
  { dep: '@sveltejs/kit', framework: 'sveltekit', label: 'SvelteKit', build: 'vite build', start: 'node build', port: 3000 },
  { dep: '@remix-run/dev', framework: 'remix', label: 'Remix', build: 'remix vite:build', start: 'remix-serve ./build/server/index.js', port: 3000 },
  { dep: 'astro', framework: 'astro', label: 'Astro', build: 'astro build', start: 'node ./dist/server/entry.mjs', port: 4321 },
  { dep: '@nestjs/core', framework: 'nestjs', label: 'NestJS', build: 'nest build', start: 'node dist/main.js', port: 3000 },
  { dep: 'fastify', framework: 'fastify', label: 'Fastify', build: '', start: 'node index.js', port: 3000 },
  { dep: 'express', framework: 'express', label: 'Express', build: '', start: 'node index.js', port: 3000 },
];

const STATIC_BUILDERS: Array<{ dep: string; framework: string; label: string; out: string }> = [
  { dep: 'vite', framework: 'vite', label: 'Vite', out: 'dist' },
  { dep: 'react-scripts', framework: 'cra', label: 'Create React App', out: 'build' },
  { dep: '@angular/core', framework: 'angular', label: 'Angular', out: 'dist' },
];

function packageManagerOf(files: DetectInput, pkg: any): PackageManager {
  const declared = String(pkg?.packageManager || '').split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared;
  if (files['pnpm-lock.yaml'] !== undefined) return 'pnpm';
  if (files['yarn.lock'] !== undefined) return 'yarn';
  if (files['bun.lockb'] !== undefined || files['bun.lock'] !== undefined) return 'bun';
  return 'npm';
}

function installCommandOf(pm: PackageManager, files: DetectInput): string {
  const locked = files['package-lock.json'] !== undefined;
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
    default:
      return locked ? 'npm ci --no-audit --no-fund' : 'npm install --no-audit --no-fund';
  }
}

function runScript(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

function startScript(pm: PackageManager): string {
  return pm === 'yarn' ? 'yarn start' : pm === 'npm' ? 'npm start' : `${pm} run start`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `.env` text → [key, value] pairs, by dotenv's own line rules: `#` comments,
 * an optional `export `, '…' literal, "…" with \n and \r expanded (and able to
 * span lines), `…`, or a bare value up to an inline ` #`. Keys that are not a
 * valid shell name are dropped — they could never be exported.
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  // [ \t], never \s: `KEY=` with no value must not swallow the next line
  const LINE =
    /^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]+)?[ \t]*(?:#.*)?$/gm;
  const out: Array<[string, string]> = [];
  for (const match of text.replace(/\r\n?/g, '\n').matchAll(LINE)) {
    const key = match[1]!;
    if (!ENV_NAME.test(key)) continue;
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
    }
    out.push([key, value]);
  }
  return out;
}

function repoEnvOf(files: DetectInput): RepoEnv {
  const exampleFile = EXAMPLE_ENV_FILES.find((name) => files[name] !== undefined);
  let deps: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(files['package.json'] || '{}');
    deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  } catch {
    // unreadable package.json: nothing to say about a database
  }
  return {
    needsDatabase: SQL_DEPS.some((dep) => dep in deps),
    example: exampleFile
      ? { file: exampleFile, vars: parseEnvFile(files[exampleFile] || '').map(([key, value]) => ({ key, value })) }
      : null,
    production: parseEnvFile(files['.env.production'] || '').map(([key]) => key),
    committed: SECRET_ENV_FILES.filter((name) => files[name] !== undefined),
  };
}

// runs a package's own binary with the project's package manager
const EXEC: Record<PackageManager, string> = { npm: 'npx', pnpm: 'pnpm', yarn: 'yarn', bun: 'bunx' };

/**
 * Prisma's schema step, for the pre-deploy command. Pure. With migrations
 * in the repo (or not known), apply them; a repo without prisma/migrations
 * syncs its schema with db push — which refuses changes that would lose data.
 */
export function preDeployOf(files: DetectInput, pm: PackageManager, migrations?: boolean): string | null {
  if (!usesPrisma(files)) return null;
  return migrations === false ? `${EXEC[pm]} prisma db push --skip-generate` : `${EXEC[pm]} prisma migrate deploy`;
}

/**
 * `prisma generate`, before the build. The client is not in the repo (Prisma 7's
 * `generated/prisma` is gitignored) and installing no longer generates it, so
 * without this the build fails on "Can't resolve '@/generated/prisma'".
 */
export function generateOf(files: DetectInput, pm: PackageManager): string | null {
  return usesPrisma(files) ? `${EXEC[pm]} prisma generate` : null;
}

function usesPrisma(files: DetectInput): boolean {
  try {
    const pkg = JSON.parse(files['package.json'] || '{}');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    return 'prisma' in deps || '@prisma/client' in deps;
  } catch {
    return false;
  }
}

/**
 * Pure: takes file contents, returns the preset. Same logic for upload, git and
 * deploy. `prismaMigrations`: whether the repo has prisma/migrations, when known.
 */
export function detectFromFiles(files: DetectInput, prismaMigrations?: boolean): DetectedProject {
  const preset = presetFromFiles(files);
  return {
    ...preset,
    env: repoEnvOf(files),
    warnings: warningsOf(files, preset),
    preDeployCommand: preset.type === 'NODEJS' ? preDeployOf(files, preset.packageManager, prismaMigrations) : null,
    generateCommand: preset.type === 'NODEJS' ? generateOf(files, preset.packageManager) : null,
  };
}

/** The start script as written — only when Larika runs it rather than its own command. */
function startScriptOf(files: DetectInput): string {
  try {
    return String(JSON.parse(files['package.json'] || '{}')?.scripts?.start || '');
  } catch {
    return '';
  }
}

function warningsOf(files: DetectInput, preset: Omit<DetectedProject, 'env' | 'warnings' | 'preDeployCommand'>): DetectWarning[] {
  if (preset.framework !== 'nextjs' || preset.startCommand === NEXT_START) return [];
  const script = startScriptOf(files);
  const warnings: DetectWarning[] = [];
  const pinned = script.match(/(?:^|\s)(?:-p|--port)(?:=|\s+)(\d+)/)?.[1];
  if (pinned) warnings.push({ code: 'start-fixed-port', port: pinned });
  if (/\bnext\s+start\b/.test(script) && !/(?:^|\s)(?:-H|--hostname)(?:=|\s)/.test(script)) {
    warnings.push({ code: 'start-binds-all' });
  }
  return warnings;
}

function presetFromFiles(files: DetectInput): Omit<DetectedProject, 'env' | 'warnings' | 'preDeployCommand'> {
  const nodeVersion = (files['.nvmrc'] || files['.node-version'] || '').trim().replace(/^v/, '') || null;

  // PHP first: Laravel ships a package.json for its assets, which must not
  // make it look like a Node app.
  if (files['composer.json'] !== undefined || files['index.php'] !== undefined) {
    let composer: any = {};
    try {
      composer = JSON.parse(files['composer.json'] || '{}');
    } catch {
      composer = {};
    }
    const require = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
    const laravel = 'laravel/framework' in require;
    const symfony = 'symfony/framework-bundle' in require;

    let pkg: any = {};
    try {
      pkg = JSON.parse(files['package.json'] || '{}');
    } catch {
      pkg = {};
    }
    const pm = packageManagerOf(files, pkg);
    const assets = pkg.scripts?.build ? `${installCommandOf(pm, files)} && ${runScript(pm, 'build')}` : null;

    return base({
      type: 'PHP',
      framework: laravel ? 'laravel' : symfony ? 'symfony' : 'php',
      label: laravel ? 'Laravel' : symfony ? 'Symfony' : 'PHP',
      packageManager: pm,
      installCommand:
        files['composer.json'] !== undefined ? 'composer install --no-dev --optimize-autoloader --no-interaction --no-progress' : '',
      buildCommand: assets,
      outputDir: laravel || symfony ? 'public' : '.',
      nodeVersion,
    });
  }

  if (files['package.json'] === undefined) {
    if (files['requirements.txt'] !== undefined) {
      return base({ type: 'PYTHON', framework: 'python', label: 'Python', startCommand: 'python app.py', port: 8000 });
    }
    if (files['index.html'] !== undefined) {
      return base({ type: 'STATIC', framework: 'html', label: 'Static HTML', outputDir: '.' });
    }
    return base({ type: 'NODEJS', framework: null, label: 'Unknown' });
  }

  let pkg: any = {};
  try {
    pkg = JSON.parse(files['package.json']);
  } catch {
    pkg = {};
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const scripts = pkg.scripts || {};
  const pm = packageManagerOf(files, pkg);
  const installCommand = installCommandOf(pm, files);
  const engines = String(pkg.engines?.node || '').trim() || null;

  const common = { packageManager: pm, installCommand, nodeVersion: nodeVersion || engines };

  for (const fw of FRAMEWORKS) {
    if (!(fw.dep in deps)) continue;

    // `output: 'export'` turns a Next app into a static site served from out/.
    const nextConfig = files['next.config.js'] ?? files['next.config.mjs'] ?? files['next.config.ts'] ?? '';
    if (fw.framework === 'nextjs' && /output\s*:\s*['"`]export['"`]/.test(nextConfig)) {
      return base({
        ...common,
        type: 'STATIC',
        framework: 'nextjs-static',
        label: 'Next.js (static export)',
        buildCommand: scripts.build ? runScript(pm, 'build') : 'next build',
        outputDir: 'out',
      });
    }

    // A start script that is only `next start` is run as Next itself, bound to
    // loopback on the platform's port; one that does more is the app's to keep.
    const plainNextStart = fw.framework === 'nextjs' && /^\s*next\s+start\s*$/.test(String(scripts.start || ''));
    return base({
      ...common,
      type: 'NODEJS',
      framework: fw.framework,
      label: fw.label,
      buildCommand: scripts.build ? runScript(pm, 'build') : fw.build || null,
      startCommand: scripts.start && !plainNextStart ? startScript(pm) : fw.start,
      port: fw.port,
    });
  }

  for (const sb of STATIC_BUILDERS) {
    if (!(sb.dep in deps)) continue;
    return base({
      ...common,
      type: 'STATIC',
      framework: sb.framework,
      label: sb.label,
      buildCommand: scripts.build ? runScript(pm, 'build') : null,
      outputDir: sb.out,
    });
  }

  // Plain Node: trust the scripts.
  return base({
    ...common,
    type: 'NODEJS',
    framework: 'node',
    label: 'Node.js',
    buildCommand: scripts.build ? runScript(pm, 'build') : null,
    startCommand: scripts.start ? startScript(pm) : pkg.main ? `node ${pkg.main}` : 'node index.js',
    port: 3000,
  });
}

function base(
  partial: Partial<Omit<DetectedProject, 'env' | 'warnings' | 'preDeployCommand' | 'generateCommand'>> & Pick<DetectedProject, 'type' | 'framework' | 'label'>,
): Omit<DetectedProject, 'env' | 'warnings' | 'preDeployCommand' | 'generateCommand'> {
  return {
    packageManager: 'npm',
    installCommand: 'npm install --no-audit --no-fund',
    buildCommand: null,
    startCommand: null,
    outputDir: null,
    port: null,
    nodeVersion: null,
    ...partial,
  };
}

/**
 * Detection files whose contents are never kept: lockfiles are huge and only
 * their presence matters; a committed .env is noted, its secrets never read.
 */
export const presenceOnly = (name: string): boolean =>
  (SECRET_ENV_FILES as readonly string[]).includes(name) || /(\.lockb?|lock\.json|lock\.yaml)$/.test(name);

type ReadText = (file: string) => Promise<string>;
const readLocal: ReadText = (file) => fs.readFile(file, 'utf-8');

/**
 * Read the detection files out of a directory (the sources tree). `read`
 * defaults to the local disk; pass AppFs.readText for a tree on a node.
 */
export async function readDetectFiles(dir: string, read: ReadText = readLocal): Promise<DetectInput> {
  const out: DetectInput = {};
  await Promise.all(
    DETECT_FILES.map(async (name) => {
      try {
        const content = await read(path.posix.join(dir, name));
        out[name] = presenceOnly(name) ? '' : content;
      } catch {
        /* absent */
      }
    })
  );
  return out;
}

export async function detectProject(dir: string, read?: ReadText, prismaMigrations?: boolean): Promise<DetectedProject> {
  return detectFromFiles(await readDetectFiles(dir, read), prismaMigrations);
}

/**
 * Detect straight from a git remote without a full clone: blobless shallow
 * clone, then check out only the detection files. Works with any host.
 */
const REPOSITORY_URL = /^(https?:\/\/|git@|ssh:\/\/)[^\s'"]+$/;

/** Credentials from gitAuthFor; none for a public remote. */
export type RemoteAuth = { args: string[]; env: Record<string, string> };
const ANONYMOUS: RemoteAuth = { args: [], env: {} };

/**
 * git argv/env for talking to a remote as exactly `auth` — the empty helper
 * first drops any credential helper the machine has (a developer's credential
 * manager), or a private repo would read as public here and fail at deploy.
 */
const remoteGit = (auth: RemoteAuth, args: string[]) => ({
  argv: ['-c', 'credential.helper=', ...auth.args, ...args],
  env: { ...GIT_ENV, ...auth.env },
});

export async function detectFromRepo(repository: string, branch = 'main', auth: RemoteAuth = ANONYMOUS): Promise<DetectedProject> {
  if (!REPOSITORY_URL.test(repository)) throw new Error('Invalid repository URL');
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith('-')) throw new Error('Invalid branch name');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-detect-'));
  try {
    // --sparse checks out the root-level files only — every detection file is
    // one — and the clone fetches their blobs itself, in one batch: ~100 KB for
    // a Next app. Not --no-checkout plus a checkout per file afterwards: those
    // raced for index.lock, and a lazy blob fetch from a shallow blobless clone
    // comes back without the blob, so detection never saw a package.json.
    const clone = remoteGit(auth, ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', branch, repository, tmp]);
    await execFileAsync('git', clone.argv, { timeout: 60000, env: clone.env });
    // the sparse checkout has the root only, but the trees are all there:
    // whether prisma/migrations exists costs one ls-tree, no download
    const migrations = await execFileAsync('git', ['-C', tmp, 'ls-tree', '--name-only', 'HEAD', 'prisma/migrations/'], { timeout: 10000 })
      .then(({ stdout }) => String(stdout).trim().length > 0)
      .catch(() => undefined);
    return detectProject(tmp, undefined, migrations);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export type RemoteBranches = { defaultBranch: string | null; branches: string[] };

/**
 * Parse `git ls-remote --symref <url>`: the `ref: refs/heads/X\tHEAD` line
 * names the default branch, every `refs/heads/*` line is a branch.
 */
export function parseLsRemote(output: string): RemoteBranches {
  let defaultBranch: string | null = null;
  const branches: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const symref = line.match(/^ref: refs\/heads\/(.+)\tHEAD$/);
    if (symref?.[1]) {
      defaultBranch = symref[1];
      continue;
    }
    const head = line.match(/^[0-9a-f]+\trefs\/heads\/(.+)$/);
    if (head?.[1]) branches.push(head[1]);
  }

  // default first, the rest alphabetical
  branches.sort((a, b) => Number(b === defaultBranch) - Number(a === defaultBranch) || a.localeCompare(b));
  return { defaultBranch, branches };
}

/** Branches of any remote, without cloning. A private repo needs `auth`. */
export async function listRemoteBranches(repository: string, auth: RemoteAuth = ANONYMOUS): Promise<RemoteBranches> {
  if (!REPOSITORY_URL.test(repository)) throw new Error('Invalid repository URL');
  const lsRemote = remoteGit(auth, ['ls-remote', '--symref', repository]);
  const { stdout } = await execFileAsync('git', lsRemote.argv, {
    timeout: 30000,
    env: lsRemote.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseLsRemote(stdout);
}

/**
 * Bash lines that put the right Node on PATH, for the generated run.sh and
 * build.sh. Sources the system-wide nvm (NVM_DIR, default /opt/nvm) when it is
 * there and falls back to whatever `node` is on PATH when it is not — so a
 * box without nvm still works, on its single Node.
 *
 * Only an exact version (`20`, `20.11`, `v22.4.1`) or an nvm alias
 * (`lts/*`, `lts/iron`) is honoured. Ranges such as `>=18` from engines.node
 * are ignored: nvm cannot install a range, and the default Node is the
 * sensible answer for them anyway.
 *
 * `install` is for build.sh, which may fetch a missing version as the backend
 * user. run.sh runs as the tenant and only selects.
 */
export function nvmPreamble(version: string | null, install: boolean): string[] {
  const pinned = version && /^(v?\d+(\.\d+){0,2}|lts\/[a-z*]+)$/.test(version) ? version.replace(/^v/, '') : null;
  const dir = (process.env.NVM_DIR || '/opt/nvm').replace(/'/g, '');
  const lines = [
    `export NVM_DIR='${dir}'`,
    // nvm.sh is not clean under `set -u`; relax it for the sourcing only.
    'if [ -s "$NVM_DIR/nvm.sh" ]; then',
    '  set +u',
    '  . "$NVM_DIR/nvm.sh"',
  ];
  if (pinned) {
    if (install) {
      lines.push(`  nvm install '${pinned}' >/dev/null 2>&1 || echo "nvm: could not install node ${pinned}, using default" >&2`);
    }
    lines.push(`  nvm use '${pinned}' >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true`);
  } else {
    lines.push('  nvm use default >/dev/null 2>&1 || true');
  }
  lines.push('  set -u', 'fi');
  return lines;
}
