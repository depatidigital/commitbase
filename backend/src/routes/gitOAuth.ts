import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { ApiResponse } from '../types';
import { canEncrypt, encrypt } from '../lib/secretBox';
import { getGitOAuthConfig, setGitOAuthConfigValue, GitOAuthProvider } from '../services/integrationConfigService';

// Mounted superadmin-only in index.ts, like the other integration credentials.
const router = Router();

const PROVIDERS: GitOAuthProvider[] = ['github', 'gitlab'];

/** What the panel shows: never the secret. callbackUrl is what git.ts sends as redirect_uri. */
async function status(req: AuthenticatedRequest) {
  const entries = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const { clientId, clientSecret, oauthBase, apiBase } = await getGitOAuthConfig(provider);
      return [
        provider,
        {
          clientId: clientId ?? '',
          hasSecret: !!clientSecret,
          oauthBase,
          apiBase,
          callbackUrl: `${req.protocol}://${req.get('host')}/api/git/${provider}/auth/callback`,
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

const isHttpUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await status(req) } as ApiResponse);
  } catch (error) {
    console.error('Error fetching Git OAuth config:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch Git OAuth config' } as ApiResponse);
  }
});

router.put('/:provider', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const provider = req.params.provider as GitOAuthProvider;
    if (!PROVIDERS.includes(provider)) {
      return res.status(404).json({ success: false, error: 'Unknown provider' } as ApiResponse);
    }
    const { clientId, clientSecret, oauthBase, apiBase } = req.body as Record<string, string | undefined>;

    const bases = provider === 'gitlab' ? { oauthBase: oauthBase?.trim(), apiBase: apiBase?.trim() } : {};
    for (const [key, value] of Object.entries(bases)) {
      if (value && !isHttpUrl(value)) {
        return res.status(400).json({ success: false, error: `${key} must be an http(s) URL` } as ApiResponse);
      }
    }
    if (clientId?.trim() && !clientSecret?.trim() && !(await getGitOAuthConfig(provider)).clientSecret) {
      return res.status(400).json({ success: false, error: 'Enter the client secret too' } as ApiResponse);
    }
    if (clientSecret?.trim() && !canEncrypt()) {
      return res.status(500).json({ success: false, error: 'CB_SECRET_KEY is not set, so the secret cannot be stored encrypted' } as ApiResponse);
    }

    // blank client id turns the provider off; blank secret keeps the stored one
    if (clientId !== undefined) await setGitOAuthConfigValue(provider, 'clientId', clientId.trim());
    if (clientSecret?.trim()) await setGitOAuthConfigValue(provider, 'clientSecret', encrypt(clientSecret.trim()));
    for (const [key, value] of Object.entries(bases)) {
      if (value !== undefined) await setGitOAuthConfigValue(provider, key as 'oauthBase' | 'apiBase', value);
    }

    return res.json({ success: true, data: await status(req) } as ApiResponse);
  } catch (error) {
    console.error('Error updating Git OAuth config:', error);
    return res.status(500).json({ success: false, error: 'Failed to update Git OAuth config' } as ApiResponse);
  }
});

export default router;
