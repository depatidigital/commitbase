import { Router, Response, Request } from 'express';
import jwt from 'jsonwebtoken';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { ApiResponse } from '../types';

interface GitRepository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl?: string | null;
  provider: 'github' | 'gitlab';
  accountId: string;
  workspace: string | null;
}

interface GitBranch {
  name: string;
}

interface GitConnectionStatus {
  githubConnected: boolean;
  gitlabConnected: boolean;
}

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
  '/status',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const [githubAccounts, gitlabAccounts] = await Promise.all([
        gitAccountClient.count({
          where: {
            userId: req.user!.userId,
            provider: 'github',
          },
        }),
        gitAccountClient.count({
          where: {
            userId: req.user!.userId,
            provider: 'gitlab',
          },
        }),
      ]);

      const status: GitConnectionStatus = {
        githubConnected: githubAccounts > 0,
        gitlabConnected: gitlabAccounts > 0,
      };

      return res.json({
        success: true,
        data: status,
        message: 'Git connection status retrieved successfully',
      } as ApiResponse<GitConnectionStatus>);
    } catch (error: any) {
      console.error('Error fetching git connection status:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch git connection status',
      } as ApiResponse);
    }
  },
);

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
          'User-Agent': 'commitbase',
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
      url.searchParams.set('scope', 'read_api');
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

router.get(
  '/github/projects',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { accountId } = req.query as { accountId?: string };

      const account = accountId
        ? await gitAccountClient.findFirst({
            where: {
              id: accountId,
              userId: req.user!.userId,
              provider: 'github',
            },
          })
        : await gitAccountClient.findFirst({
            where: {
              userId: req.user!.userId,
              provider: 'github',
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

      if (!account) {
        return res.status(400).json({
          success: false,
          error: 'GitHub account not found',
        } as ApiResponse);
      }

      const token = account.accessToken;

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const response = await fetchFn(
        'https://api.github.com/user/repos?per_page=100',
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'commitbase',
          },
        },
      );

      const raw = await response.text();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error:
            raw ||
            `GitHub request failed with status ${response.status} ${response.statusText}`,
        } as ApiResponse);
      }

      let data: any;

      try {
        data = JSON.parse(raw);
      } catch {
        data = [];
      }

      const repos: GitRepository[] = Array.isArray(data)
        ? data.map((repo: any) => {
            const sshUrl = repo.ssh_url ? String(repo.ssh_url) : null;
            const fullName = String(repo.full_name || repo.name || '');
            let workspace: string | null = null;

            if (fullName.includes('/')) {
              workspace = fullName.split('/')[0] || null;
            }

            return {
              id: String(repo.id),
              name: String(repo.name || ''),
              fullName,
              cloneUrl: String(
                repo.clone_url || repo.ssh_url || repo.svn_url || '',
              ),
              sshUrl,
              provider: 'github',
              accountId: account.id,
              workspace,
            };
          })
        : [];

      return res.json({
        success: true,
        data: repos,
        message: 'GitHub repositories retrieved successfully',
      } as ApiResponse<GitRepository[]>);
    } catch (error: any) {
      console.error('Error fetching GitHub repositories:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitHub repositories',
      } as ApiResponse);
    }
  },
);

router.get(
  '/gitlab/projects',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { accountId } = req.query as { accountId?: string };

      const account = accountId
        ? await gitAccountClient.findFirst({
            where: {
              id: accountId,
              userId: req.user!.userId,
              provider: 'gitlab',
            },
          })
        : await gitAccountClient.findFirst({
            where: {
              userId: req.user!.userId,
              provider: 'gitlab',
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

      if (!account) {
        return res.status(400).json({
          success: false,
          error: 'GitLab account not found',
        } as ApiResponse);
      }

      const token = account.accessToken;
      const apiBase =
        process.env.GITLAB_API_BASE || 'https://gitlab.com/api/v4';

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const url = `${apiBase.replace(
        /\/$/,
        '',
      )}/projects?membership=true&simple=true&per_page=100`;

      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          'PRIVATE-TOKEN': token,
        },
      });

      const raw = await response.text();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error:
            raw ||
            `GitLab request failed with status ${response.status} ${response.statusText}`,
        } as ApiResponse);
      }

      let data: any;

      try {
        data = JSON.parse(raw);
      } catch {
        data = [];
      }

      const repos: GitRepository[] = Array.isArray(data)
        ? data.map((project: any) => {
            const sshUrl = project.ssh_url_to_repo
              ? String(project.ssh_url_to_repo)
              : null;
            const fullName = String(
              project.path_with_namespace || project.name || '',
            );
            const workspace = (() => {
              const parts = fullName.split('/');
              return parts.length > 1
                ? parts.slice(0, parts.length - 1).join('/')
                : null;
            })();

            return {
              id: String(project.id),
              name: String(project.name || ''),
              fullName,
              cloneUrl: String(
                project.http_url_to_repo ||
                  project.ssh_url_to_repo ||
                  project.web_url ||
                  '',
              ),
              sshUrl,
              provider: 'gitlab',
              accountId: account.id,
              workspace,
            };
          })
        : [];

      return res.json({
        success: true,
        data: repos,
        message: 'GitLab projects retrieved successfully',
      } as ApiResponse<GitRepository[]>);
    } catch (error: any) {
      console.error('Error fetching GitLab projects:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitLab projects',
      } as ApiResponse);
    }
  },
);

router.get(
  '/github/projects/:id/branches',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { accountId } = req.query as { accountId?: string };

      const account = accountId
        ? await gitAccountClient.findFirst({
            where: {
              id: accountId,
              userId: req.user!.userId,
              provider: 'github',
            },
          })
        : await gitAccountClient.findFirst({
            where: {
              userId: req.user!.userId,
              provider: 'github',
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

      if (!account) {
        return res.status(400).json({
          success: false,
          error: 'GitHub account not found',
        } as ApiResponse);
      }

      const token = account.accessToken;

      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Repository ID is required',
        } as ApiResponse);
      }

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const url = `https://api.github.com/repositories/${encodeURIComponent(
        id,
      )}/branches?per_page=100`;

      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'commitbase',
        },
      });

      const raw = await response.text();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error:
            raw ||
            `GitHub request failed with status ${response.status} ${response.statusText}`,
        } as ApiResponse);
      }

      let data: any;

      try {
        data = JSON.parse(raw);
      } catch {
        data = [];
      }

      const branches: GitBranch[] = Array.isArray(data)
        ? data.map((branch: any) => ({
            name: String(branch.name || ''),
          }))
        : [];

      return res.json({
        success: true,
        data: branches,
        message: 'GitHub branches retrieved successfully',
      } as ApiResponse<GitBranch[]>);
    } catch (error: any) {
      console.error('Error fetching GitHub branches:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitHub branches',
      } as ApiResponse);
    }
  },
);

router.get(
  '/gitlab/projects/:id/branches',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { accountId } = req.query as { accountId?: string };

      const account = accountId
        ? await gitAccountClient.findFirst({
            where: {
              id: accountId,
              userId: req.user!.userId,
              provider: 'gitlab',
            },
          })
        : await gitAccountClient.findFirst({
            where: {
              userId: req.user!.userId,
              provider: 'gitlab',
            },
            orderBy: {
              createdAt: 'asc',
            },
          });

      if (!account) {
        return res.status(400).json({
          success: false,
          error: 'GitLab account not found',
        } as ApiResponse);
      }

      const token = account.accessToken;
      const apiBase =
        process.env.GITLAB_API_BASE || 'https://gitlab.com/api/v4';

      const { id } = req.params;

      if (!id) {
        return res.status(400).json({
          success: false,
          error: 'Project ID is required',
        } as ApiResponse);
      }

      const fetchFn: any = (globalThis as any).fetch;

      if (!fetchFn) {
        return res.status(500).json({
          success: false,
          error: 'Fetch API is not available in this runtime',
        } as ApiResponse);
      }

      const url = `${apiBase.replace(
        /\/$/,
        '',
      )}/projects/${encodeURIComponent(id)}/repository/branches?per_page=100`;

      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const raw = await response.text();

      if (!response.ok) {
        return res.status(response.status).json({
          success: false,
          error:
            raw ||
            `GitLab request failed with status ${response.status} ${response.statusText}`,
        } as ApiResponse);
      }

      let data: any;

      try {
        data = JSON.parse(raw);
      } catch {
        data = [];
      }

      const branches: GitBranch[] = Array.isArray(data)
        ? data.map((branch: any) => ({
            name: String(branch.name || ''),
          }))
        : [];

      return res.json({
        success: true,
        data: branches,
        message: 'GitLab branches retrieved successfully',
      } as ApiResponse<GitBranch[]>);
    } catch (error: any) {
      console.error('Error fetching GitLab branches:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch GitLab branches',
      } as ApiResponse);
    }
  },
);

export default router;

