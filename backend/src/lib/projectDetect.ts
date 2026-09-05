import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  outputDir: string | null; // static sites only
  port: number | null;
  nodeVersion: string | null;
}

/** The files worth reading. Detection needs nothing else. */
export const DETECT_FILES = [
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

const FRAMEWORKS: Array<{ dep: string; framework: string; label: string; build: string; start: string; port: number }> = [
  { dep: 'next', framework: 'nextjs', label: 'Next.js', build: 'next build', start: 'next start -H 127.0.0.1 -p $PORT', port: 3000 },
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

/** Pure: takes file contents, returns the preset. Same logic for upload, git and deploy. */
export function detectFromFiles(files: DetectInput): DetectedProject {
  const nodeVersion = (files['.nvmrc'] || files['.node-version'] || '').trim().replace(/^v/, '') || null;

  if (files['package.json'] === undefined) {
    if (files['composer.json'] !== undefined || files['index.php'] !== undefined) {
      return base({ type: 'PHP', framework: 'php', label: 'PHP' });
    }
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

    return base({
      ...common,
      type: 'NODEJS',
      framework: fw.framework,
      label: fw.label,
      buildCommand: scripts.build ? runScript(pm, 'build') : fw.build || null,
      startCommand: scripts.start ? startScript(pm) : fw.start,
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

function base(partial: Partial<DetectedProject> & Pick<DetectedProject, 'type' | 'framework' | 'label'>): DetectedProject {
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

/** Read the detection files out of a directory on disk (the sources tree). */
export async function readDetectFiles(dir: string): Promise<DetectInput> {
  const out: DetectInput = {};
  await Promise.all(
    DETECT_FILES.map(async (name) => {
      try {
        // Lockfiles can be huge and only their presence matters.
        const content = await fs.readFile(path.join(dir, name), 'utf-8');
        out[name] = name.endsWith('.lock') || name.endsWith('lock.json') || name.endsWith('lock.yaml') || name.endsWith('.lockb') ? '' : content;
      } catch {
        /* absent */
      }
    })
  );
  return out;
}

export async function detectProject(dir: string): Promise<DetectedProject> {
  return detectFromFiles(await readDetectFiles(dir));
}

/**
 * Detect straight from a git remote without a full clone: blobless shallow
 * clone, then check out only the detection files. Works with any host.
 */
export async function detectFromRepo(repository: string, branch = 'main'): Promise<DetectedProject> {
  if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s'"]+$/.test(repository)) throw new Error('Invalid repository URL');
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error('Invalid branch name');

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-detect-'));
  try {
    await execAsync(
      `git clone --quiet --depth 1 --filter=blob:none --no-checkout --branch "${branch}" "${repository}" "${tmp}"`,
      { timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );
    // One checkout per file: a missing file fails the command, the others still land.
    await Promise.all(
      DETECT_FILES.map((name) =>
        execAsync(`git -C "${tmp}" checkout --quiet HEAD -- "${name}"`, { timeout: 30000 }).catch(() => {})
      )
    );
    return detectProject(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
