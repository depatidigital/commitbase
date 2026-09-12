import { prisma } from './prisma';

/**
 * Credentials for cloning a private repository.
 *
 * The token never reaches the command line or the repository's stored config:
 * it goes in the environment, and a one-shot credential helper reads it back
 * when git asks. `https://<token>@host/repo` would have been shorter and would
 * have leaked the token into `.git/config`, into `ps` output for every user on
 * the box, and into the deploy log.
 */

/** The username each provider expects alongside an OAuth token over HTTPS. */
export const USERNAME: Record<string, string> = {
  github: 'x-access-token',
  gitlab: 'oauth2',
};

/** Refresh a GitLab token this many seconds before it actually expires. */
const REFRESH_SKEW_SECONDS = 120;

type Account = {
  id: string;
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

/** Expired, or close enough that a slow deploy would outlive the token. */
export function needsRefresh(tokenExpiresAt: Date | null, refreshToken: string | null, now = Date.now()): boolean {
  if (!tokenExpiresAt || !refreshToken) return false;
  return tokenExpiresAt.getTime() - REFRESH_SKEW_SECONDS * 1000 <= now;
}

/**
 * The credential helper git runs when the remote asks who we are. The token is
 * `$CB_GIT_TOKEN` verbatim — it must stay a shell variable reference here, so
 * the secret lives only in the environment.
 */
export function credentialArgs(username: string): string[] {
  return ['-c', `credential.helper=!f(){ echo username=${username}; echo "password=$CB_GIT_TOKEN"; };f`];
}

/**
 * A GitLab access token lives ~2 hours, so any app connected yesterday needs a
 * refresh before today's deploy. GitHub OAuth App tokens do not expire and
 * carry no refresh token, so they fall straight through.
 *
 * ponytail: no locking — two deploys of the same app starting in the same
 * second can both refresh, and GitLab rotates the refresh token, so the loser
 * saves a stale one and the user reconnects. Take a row lock here if concurrent
 * deploys per account become normal.
 */
export async function freshAccessToken(account: Account): Promise<string> {
  if (!needsRefresh(account.tokenExpiresAt, account.refreshToken)) return account.accessToken;

  const clientId = process.env.GITLAB_CLIENT_ID;
  const clientSecret = process.env.GITLAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GitLab OAuth is not configured — cannot refresh the expired token');
  }

  const oauthBase = (process.env.GITLAB_OAUTH_BASE || 'https://gitlab.com/oauth').replace(/\/$/, '');
  const response = await fetch(`${oauthBase}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error('GitLab token has expired and could not be refreshed — reconnect the account');
  }

  const accessToken = String(data.access_token);
  await prisma.gitAccount.update({
    where: { id: account.id },
    data: {
      accessToken,
      refreshToken: data.refresh_token ? String(data.refresh_token) : account.refreshToken,
      tokenExpiresAt: Number.isFinite(Number(data.expires_in))
        ? new Date(Date.now() + Number(data.expires_in) * 1000)
        : null,
    },
  });

  return accessToken;
}

export interface GitAuth {
  /** Goes between `git` and the subcommand. Empty for a public clone. */
  args: string[];
  /** Give to the git process as environment (AppFs.run keeps it out of argv). */
  env: Record<string, string>;
}

const NO_AUTH: GitAuth = { args: [], env: {} };

/**
 * Build the credential arguments for an application's connected git account.
 * No account (public repo, or an upload) means no credentials, which is not an
 * error — the clone simply has to succeed unauthenticated.
 */
export async function gitAuthFor(gitAccountId: string | null | undefined): Promise<GitAuth> {
  if (!gitAccountId) return NO_AUTH;

  const account = await prisma.gitAccount.findUnique({
    where: { id: gitAccountId },
    select: { id: true, provider: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
  });

  // The account was disconnected after the app was created. Say so rather than
  // falling back to an anonymous clone that fails with "repository not found".
  if (!account) {
    throw new Error('The git account for this application was disconnected — reconnect it and redeploy');
  }

  const username = USERNAME[account.provider];
  if (!username) throw new Error(`Unsupported git provider: ${account.provider}`);

  const token = await freshAccessToken(account);

  // A helper that answers once from the environment. `!f(){ ...; };f` is git's
  // own syntax for an inline shell helper.
  return { args: credentialArgs(username), env: { CB_GIT_TOKEN: token } };
}
