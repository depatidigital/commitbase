import { createHash } from 'crypto';

/**
 * What a build is made of: the commit, the settings that drive install and
 * build, and the environment (build-time variables such as NEXT_PUBLIC_* are
 * baked in, and which ones a build reads is not knowable from here — so all of
 * them count). Two deploys with the same key produce the same tree.
 *
 * ponytail: platform-side changes to how builds run (build.sh, Node on the
 * node) are not in the key. Change the salt to force every app to rebuild once.
 */
const SALT = 'v1';

export function buildKeyOf(
  application: { type: string; installCommand?: string | null; buildCommand?: string | null; preDeployCommand?: string | null },
  commitSha: string,
  envVars: Record<string, string>,
): string {
  const env = Object.entries(envVars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(
      JSON.stringify([
        SALT,
        commitSha,
        application.type,
        application.installCommand ?? '',
        application.buildCommand ?? '',
        application.preDeployCommand ?? '',
        env,
      ]),
    )
    .digest('hex');
}
