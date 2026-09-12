import { Router, Response, Request } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';
import { freshAccessToken } from '../lib/gitCredentials';

const gitAccountClient: any = (prisma as any).gitAccount;

const router = Router();

function getFrontendBaseUrl() {
  return (
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:5173'
  );
}

function getBackendRedirectUrl(req: Request, path: string) {
  const protocol = req.protocol;
  const host = req.get('host');

  return `${protocol}://${host}${path}`;
}

router.get(
  '/github/accounts',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const accounts = await gitAccountClient.findMany({
        where: {
          userId: req.user!.userId,
          provider: 'github',
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      const result = accounts.map((acc: any) => ({
        id: acc.id as string,
        externalId: acc.externalId as string,
        username: acc.username as string,
        displayName: acc.displayName as string,
        provider: 'github' as const,
      }));

      return res.json({
        success: true,
        data: result,
        message: 'GitHub accounts retrieved successfully',
      } as ApiResponse);
    } catch (error: any) {
      console.error('Error fetching GitHub accounts:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitHub accounts',
      } as ApiResponse);
    }
  },
);

router.get(
  '/gitlab/accounts',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const accounts = await gitAccountClient.findMany({
        where: {
          userId: req.user!.userId,
          provider: 'gitlab',
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      const result = accounts.map((acc: any) => ({
        id: acc.id as string,
        externalId: acc.externalId as string,
        username: acc.username as string,
        displayName: acc.displayName as string,
        provider: 'gitlab' as const,
      }));

      return res.json({
        success: true,
        data: result,
        message: 'GitLab accounts retrieved successfully',
      } as ApiResponse);
    } catch (error: any) {
      console.error('Error fetching GitLab accounts:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitLab accounts',
      } as ApiResponse);
    }
  },
);

router.patch(
  '/accounts/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { displayName } = req.body as { displayName?: string };

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Account ID is required',
        } as ApiResponse);
      }

      if (!displayName || !displayName.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Display name is required',
        } as ApiResponse);
      }

      const account = await gitAccountClient.findFirst({
        where: {
          id,
          userId: req.user!.userId,
        },
      });

      if (!account) {
        return res.status(404).json({
          success: false,
          error: 'Account not found',
        } as ApiResponse);
      }

      const updated = await gitAccountClient.update({
        where: { id },
        data: {
          displayName: displayName.trim(),
        },
      });

      return res.json({
        success: true,
        data: {
          id: updated.id as string,
          externalId: updated.externalId as string,
          username: updated.username as string,
          displayName: updated.displayName as string,
          provider: updated.provider as 'github' | 'gitlab',
        },
        message: 'Git account updated successfully',
      } as ApiResponse);
    } catch (error: any) {
      console.error('Error updating git account:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to update git account',
      } as ApiResponse);
    }
  },
);

router.delete(
  '/accounts/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Account ID is required',
        } as ApiResponse);
      }

      const account = await gitAccountClient.findFirst({
        where: {
          id,
          userId: req.user!.userId,
        },
      });

      if (!account) {
        return res.status(404).json({
          success: false,
          error: 'Account not found',
        } as ApiResponse);
      }

      await gitAccountClient.delete({
        where: { id },
      });

      return res.json({
        success: true,
        message: 'Git account disconnected successfully',
      } as ApiResponse);
    } catch (error: any) {
      console.error('Error deleting git account:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to delete git account',
      } as ApiResponse);
    }
  },
);

router.get(
  '/github/auth/url',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(400).json({
          success: false,
          error: 'GitHub OAuth is not configured',
        } as ApiResponse);
      }

      const jwtSecret = process.env.JWT_SECRET;

      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'JWT secret is not configured',
        } as ApiResponse);
      }

      const state = jwt.sign(
        {
          userId: req.user!.userId,
          provider: 'github',
          type: 'oauth_state',
        },
        jwtSecret,
        { expiresIn: '10m' },
      );

      const redirectUri = getBackendRedirectUrl(
        req,
        '/api/git/github/auth/callback',
      );

      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'repo');
      url.searchParams.set('state', state);

      return res.json({
        success: true,
        data: {
          url: url.toString(),
        },
        message: 'GitHub OAuth URL generated',
      } as ApiResponse<{ url: string }>);
    } catch (error: any) {
      console.error('Error generating GitHub OAuth URL:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate GitHub OAuth URL',
      } as ApiResponse);
    }
  },
);

router.get(
  '/github/auth/callback',
  async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query as {
        code?: string;
        state?: string;
      };

      if (!code || !state) {
        return res.status(400).json({
          success: false,
          error: 'Invalid GitHub OAuth callback parameters',
        } as ApiResponse);
      }

      const jwtSecret = process.env.JWT_SECRET;

      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'JWT secret is not configured',
        } as ApiResponse);
      }

      let decoded: any;

      try {
        decoded = jwt.verify(state, jwtSecret);
      } catch (error) {
        console.error('Invalid GitHub OAuth state:', error);
        return res.status(400).json({
          success: false,
          error: 'Invalid OAuth state',
        } as ApiResponse);
      }

      const userId = decoded.userId as string | undefined;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid OAuth state payload',
        } as ApiResponse);
      }

      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        return res.status(400).json({
          success: false,
          error: 'GitHub OAuth is not configured',
        } as ApiResponse);
      }

      const redirectUri = getBackendRedirectUrl(
        req,
        '/api/git/github/auth/callback',
      );

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const tokenResponse = await fetchFn(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        },
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error('GitHub token exchange failed:', tokenData);
        return res.status(500).json({
          success: false,
          error: 'Failed to complete GitHub OAuth flow',
        } as ApiResponse);
      }

      const accessToken = String(tokenData.access_token);

      const userResponse = await fetchFn('https://api.github.com/user', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'larika',
        },
      });

      const userRaw = await userResponse.text();

      if (!userResponse.ok) {
        console.error('GitHub user fetch failed:', userRaw);
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch GitHub user information',
        } as ApiResponse);
      }

      let userData: any;

      try {
        userData = JSON.parse(userRaw);
      } catch {
        userData = {};
      }

      const externalId = String(userData.id || '');
      const username = String(userData.login || '');
      const displayName = String(
        userData.name || userData.login || userData.email || '',
      );

      if (!externalId || !username) {
        return res.status(500).json({
          success: false,
          error: 'GitHub user information is incomplete',
        } as ApiResponse);
      }

      await gitAccountClient.upsert({
        where: {
          userId_provider_externalId: {
            userId,
            provider: 'github',
            externalId,
          },
        },
        create: {
          userId,
          provider: 'github',
          externalId,
          username,
          displayName,
          accessToken,
        },
        update: {
          username,
          displayName,
          accessToken,
        },
      });

      const frontendBase = getFrontendBaseUrl();
      const redirectTarget = `${frontendBase.replace(
        /\/$/,
        '',
      )}/add-app?provider=github&status=connected`;

      return res.redirect(302, redirectTarget);
    } catch (error: any) {
      console.error('Error handling GitHub OAuth callback:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to handle GitHub OAuth callback',
      } as ApiResponse);
    }
  },
);

router.get(
  '/gitlab/auth/url',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const clientId = process.env.GITLAB_CLIENT_ID;
      const clientSecret = process.env.GITLAB_CLIENT_SECRET;
      const authBase =
        process.env.GITLAB_OAUTH_BASE || 'https://gitlab.com/oauth';

      if (!clientId || !clientSecret) {
        return res.status(400).json({
          success: false,
          error: 'GitLab OAuth is not configured',
        } as ApiResponse);
      }

      const jwtSecret = process.env.JWT_SECRET;

      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'JWT secret is not configured',
        } as ApiResponse);
      }

      const state = jwt.sign(
        {
          userId: req.user!.userId,
          provider: 'gitlab',
          type: 'oauth_state',
        },
        jwtSecret,
        { expiresIn: '10m' },
      );

      const redirectUri = getBackendRedirectUrl(
        req,
        '/api/git/gitlab/auth/callback',
      );

      const url = new URL(`${authBase.replace(/\/$/, '')}/authorize`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      // read_api drives the project/branch pickers; read_repository is what
      // lets a deploy clone a private project over HTTPS. Accounts connected
      // before read_repository was requested must reconnect.
      url.searchParams.set('scope', 'read_api read_repository');
      url.searchParams.set('state', state);

      return res.json({
        success: true,
        data: {
          url: url.toString(),
        },
        message: 'GitLab OAuth URL generated',
      } as ApiResponse<{ url: string }>);
    } catch (error: any) {
      console.error('Error generating GitLab OAuth URL:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to generate GitLab OAuth URL',
      } as ApiResponse);
    }
  },
);

router.get(
  '/gitlab/auth/callback',
  async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query as {
        code?: string;
        state?: string;
      };

      if (!code || !state) {
        return res.status(400).json({
          success: false,
          error: 'Invalid GitLab OAuth callback parameters',
        } as ApiResponse);
      }

      const jwtSecret = process.env.JWT_SECRET;

      if (!jwtSecret) {
        return res.status(500).json({
          success: false,
          error: 'JWT secret is not configured',
        } as ApiResponse);
      }

      let decoded: any;

      try {
        decoded = jwt.verify(state, jwtSecret);
      } catch (error) {
        console.error('Invalid GitLab OAuth state:', error);
        return res.status(400).json({
          success: false,
          error: 'Invalid OAuth state',
        } as ApiResponse);
      }

      const userId = decoded.userId as string | undefined;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid OAuth state payload',
        } as ApiResponse);
      }

      const clientId = process.env.GITLAB_CLIENT_ID;
      const clientSecret = process.env.GITLAB_CLIENT_SECRET;
      const oauthBase =
        process.env.GITLAB_OAUTH_BASE || 'https://gitlab.com/oauth';

      if (!clientId || !clientSecret) {
        return res.status(400).json({
          success: false,
          error: 'GitLab OAuth is not configured',
        } as ApiResponse);
      }

      const redirectUri = getBackendRedirectUrl(
        req,
        '/api/git/gitlab/auth/callback',
      );

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const tokenResponse = await fetchFn(
        `${oauthBase.replace(/\/$/, '')}/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
          }),
        },
      );

      const tokenData = await tokenResponse.json();

      if (!tokenResponse.ok || !tokenData.access_token) {
        console.error('GitLab token exchange failed:', tokenData);
        return res.status(500).json({
          success: false,
          error: 'Failed to complete GitLab OAuth flow',
        } as ApiResponse);
      }

      const accessToken = String(tokenData.access_token);
      // GitLab access tokens are short-lived (2h by default), so the refresh
      // token is the difference between a deploy that works today and one that
      // works next week. GitHub sends neither field and both stay null there.
      const refreshToken = tokenData.refresh_token ? String(tokenData.refresh_token) : null;
      const tokenExpiresAt = Number.isFinite(Number(tokenData.expires_in))
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
        : null;

      const apiBase =
        process.env.GITLAB_API_BASE || 'https://gitlab.com/api/v4';

      const userResponse = await fetchFn(
        `${apiBase.replace(/\/$/, '')}/user`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const userRaw = await userResponse.text();

      if (!userResponse.ok) {
        console.error('GitLab user fetch failed:', userRaw);
        return res.status(500).json({
          success: false,
          error: 'Failed to fetch GitLab user information',
        } as ApiResponse);
      }

      let userData: any;

      try {
        userData = JSON.parse(userRaw);
      } catch {
        userData = {};
      }

      const externalId = String(userData.id || '');
      const username = String(userData.username || '');
      const displayName = String(
        userData.name || userData.username || userData.email || '',
      );

      if (!externalId || !username) {
        return res.status(500).json({
          success: false,
          error: 'GitLab user information is incomplete',
        } as ApiResponse);
      }

      await gitAccountClient.upsert({
        where: {
          userId_provider_externalId: {
            userId,
            provider: 'gitlab',
            externalId,
          },
        },
        create: {
          userId,
          provider: 'gitlab',
          externalId,
          username,
          displayName,
          accessToken,
          refreshToken,
          tokenExpiresAt,
        },
        update: {
          username,
          displayName,
          accessToken,
          refreshToken,
          tokenExpiresAt,
        },
      });

      const frontendBase = getFrontendBaseUrl();
      const redirectTarget = `${frontendBase.replace(
        /\/$/,
        '',
      )}/add-app?provider=gitlab&status=connected`;

      return res.redirect(302, redirectTarget);
    } catch (error: any) {
      console.error('Error handling GitLab OAuth callback:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to handle GitLab OAuth callback',
      } as ApiResponse);
    }
  },
);

type ListedRepository = {
  fullName: string;
  /** the HTTPS clone URL — what the add-app form takes */
  cloneUrl: string;
  provider: 'github' | 'gitlab';
  accountId: string;
  account: string;
  private: boolean;
};

type ListedAccount = {
  id: string;
  provider: string;
  username: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
};

// ponytail: the 300 most recently active per account; server-side search if someone has thousands
const REPOSITORY_PAGES = 3;

async function githubRepositories(account: ListedAccount): Promise<ListedRepository[]> {
  const token = await freshAccessToken(account);
  const repositories: ListedRepository[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const response = await fetch(`https://api.github.com/user/repos?per_page=100&sort=pushed&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'larika' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as any[];
    repositories.push(
      ...data.map((repo) => ({
        fullName: String(repo.full_name),
        cloneUrl: String(repo.clone_url),
        provider: 'github' as const,
        accountId: account.id,
        account: account.username,
        private: !!repo.private,
      })),
    );
    if (data.length < 100) break;
  }
  return repositories;
}

async function gitlabRepositories(account: ListedAccount): Promise<ListedRepository[]> {
  // refreshes an expired GitLab token, which lives ~2h
  const token = await freshAccessToken(account);
  const apiBase = (process.env.GITLAB_API_BASE || 'https://gitlab.com/api/v4').replace(/\/$/, '');
  const repositories: ListedRepository[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES; page++) {
    const response = await fetch(
      `${apiBase}/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100&page=${page}`,
      // an OAuth token is a Bearer token; PRIVATE-TOKEN is only for personal access tokens
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as any[];
    repositories.push(
      ...data.map((project) => ({
        fullName: String(project.path_with_namespace),
        cloneUrl: String(project.http_url_to_repo),
        provider: 'gitlab' as const,
        accountId: account.id,
        account: account.username,
        private: project.visibility !== 'public',
      })),
    );
    if (data.length < 100) break;
  }
  return repositories;
}

/**
 * Every repository the caller's connected GitHub and GitLab accounts can see,
 * for the add-app picker. One account failing (a revoked token) leaves the
 * others listed and is reported in `errors`.
 */
router.get('/repositories', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const accounts: ListedAccount[] = await prisma.gitAccount.findMany({
      where: { userId: req.user!.userId },
      select: { id: true, provider: true, username: true, accessToken: true, refreshToken: true, tokenExpiresAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const results = await Promise.allSettled(
      accounts.map((account) => (account.provider === 'gitlab' ? gitlabRepositories(account) : githubRepositories(account))),
    );

    return res.json({
      success: true,
      data: {
        accounts: accounts.map(({ id, provider, username }) => ({ id, provider, username })),
        repositories: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
        errors: results.flatMap((result, i) =>
          result.status === 'rejected'
            ? [`${accounts[i]!.provider}/${accounts[i]!.username}: ${result.reason?.message ?? 'failed'}`]
            : [],
        ),
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Error listing repositories:', error);
    return res.status(500).json({ success: false, error: 'Failed to list repositories' } as ApiResponse);
  }
});

export default router;

