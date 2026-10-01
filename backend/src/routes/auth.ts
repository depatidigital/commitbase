import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { CreateUserSchema, LoginSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { grantWelcomeCredit } from '../services/walletService';
import { mailEnabled, sendMail } from '../lib/mailer';

const router: Router = Router();

/**
 * A new account. No workspace yet: the panel asks them to name their first one
 * (AuthGuard → Onboarding) before anything else.
 * The very first account on an install owns the platform (SUPERADMIN).
 */
async function createAccount(email: string, name: string | undefined, password: string, emailVerified: boolean) {
  const first = (await prisma.user.count()) === 0;
  const user = await prisma.user.create({
    data: {
      email,
      name: name || null,
      password: await bcrypt.hash(password, 12),
      role: first ? 'SUPERADMIN' : 'CLIENT',
      // the install's owner, and installs that cannot send mail, skip the link
      emailVerifiedAt: emailVerified || first || !mailEnabled ? new Date() : null,
    },
  });
  if (user.emailVerifiedAt) await grantWelcomeCredit(user.id).catch((error) => console.error('Welcome credit failed:', error));
  else await sendVerification(user);
  return user;
}

/**
 * Verify links: a JWT naming this user and address, so a link mailed to an old
 * address does not confirm a new one. Three days.
 */
async function sendVerification(user: { id: string; email: string }) {
  const appUrl = process.env.APP_URL?.replace(/\/$/, '');
  if (!appUrl) return console.warn('APP_URL not set — verification email skipped');
  const token = jwt.sign({ userId: user.id, email: user.email, purpose: 'verify' }, process.env.JWT_SECRET as string, { expiresIn: '3d' });
  const link = `${appUrl}/verify-email?token=${token}`;
  const appName = process.env.APP_NAME || 'Larika';
  await sendMail({
    to: user.email,
    subject: `Confirm your email for ${appName}`,
    text: [`Welcome to ${appName}!`, '', `Confirm your email to start: ${link}`, '', 'The link expires in 3 days.'].join('\n'),
    html: `<p>Welcome to ${appName}!</p>
<p><a href="${link}">Confirm your email</a> to start.</p>
<p>The link expires in 3 days.</p>`,
  });
}

/** Their address is proven (link, Google, invite, reset): mark it, and hand the welcome credit that waited on it. */
async function markVerified(user: { id: string; emailVerifiedAt: Date | null }) {
  if (user.emailVerifiedAt) return;
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  await grantWelcomeCredit(user.id).catch((error) => console.error('Welcome credit failed:', error));
}

const publicUser = (user: { id: string; email: string; name: string | null; role: string }) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});

// Public sign-up with email and password
router.post('/register', validateRequest(CreateUserSchema), async (req: Request, res: Response) => {
  try {
    const email = String(req.body.email).trim().toLowerCase();

    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      return res.status(400).json({
        success: false,
        error: 'User with this email already exists',
      } as ApiResponse);
    }

    const user = await createAccount(email, req.body.name?.trim(), req.body.password, false);

    return res.status(201).json({
      success: true,
      data: { user: publicUser(user), token: signToken(user) },
      message: 'User registered successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

// Which sign-in buttons the login page shows
router.get('/providers', (_req: Request, res: Response) => {
  return res.json({ success: true, data: { googleClientId: process.env.GOOGLE_CLIENT_ID || null } } as ApiResponse);
});

const GoogleSchema = z.object({ credential: z.string().min(1) });

/**
 * Sign in or sign up with Google: the page gets an ID token from Google's
 * button, we check it and log in the account with that email, creating it
 * (with its first workspace) the first time.
 */
router.post('/google', validateRequest(GoogleSchema), async (req: Request, res: Response) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res.status(404).json({ success: false, error: 'Google sign-in is not set up' } as ApiResponse);
    }

    // ponytail: Google's tokeninfo endpoint checks the signature and expiry for us (one HTTP call per sign-in);
    // verify locally with google-auth-library if sign-in volume grows
    const check = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(req.body.credential)}`);
    const info = check.ok ? ((await check.json()) as { aud?: string; email?: string; email_verified?: string | boolean; name?: string }) : null;
    if (!info?.email || info.aud !== clientId || String(info.email_verified) !== 'true') {
      return res.status(400).json({ success: false, error: 'Google sign-in failed' } as ApiResponse);
    }

    const email = info.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // they sign in with Google; the random password only fills the column
      user = await createAccount(email, info.name, crypto.randomBytes(32).toString('hex'), true);
    } else if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account is disabled' } as ApiResponse);
    } else {
      await markVerified(user); // Google vouches for the address
    }

    return res.json({
      success: true,
      data: { user: { ...publicUser(user), mustChangePassword: user.mustChangePassword }, token: signToken(user) },
      message: 'Login successful',
    } as ApiResponse);
  } catch (error) {
    console.error('Google sign-in error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Login user
router.post('/login', validateRequest(LoginSchema), async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    const email = String(req.body.email).trim();

    // case-insensitive: "Budi@Gmail.com" signs in to budi@gmail.com
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as ApiResponse);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      } as ApiResponse);
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is disabled',
      } as ApiResponse);
    }

    const token = signToken(user);

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
        },
        token,
      },
      message: 'Login successful',
    } as ApiResponse);
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

const AcceptInviteSchema = z.object({
  token: z.string().min(32),
  name: z.string().min(1).optional(),
  password: z.string().min(8).optional(), // required only when the account does not exist yet
});

const signToken = (user: {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  mustChangePassword?: boolean;
}) =>
  jwt.sign(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      mustChangePassword: user.mustChangePassword ?? false,
    },
    process.env.JWT_SECRET as any,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
  );

/**
 * Public preview of an invite, so the accept screen can name the organization
 * instead of asking for a password against an opaque token.
 * Returns only what the holder of the token already knows.
 */
router.get('/invite/:token', async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || '');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invite = await prisma.invite.findUnique({
      where: { tokenHash },
      include: { organization: { select: { name: true } } },
    });

    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      return res.status(404).json({
        success: false,
        error: 'Invite is invalid, already used, or expired',
      } as ApiResponse);
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: invite.email },
      select: { id: true },
    });

    return res.json({
      success: true,
      data: {
        email: invite.email,
        role: invite.role,
        organizationName: invite.organization.name,
        expiresAt: invite.expiresAt,
        needsPassword: !existingUser,
      },
    } as ApiResponse);
  } catch (error) {
    console.error('Invite preview error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// Change your own password. Also clears the forced-change flag set on admin-issued accounts.
router.post(
  '/change-password',
  authenticateToken,
  validateRequest(ChangePasswordSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { currentPassword, newPassword } = req.body;

      const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' } as ApiResponse);
      }

      if (!(await bcrypt.compare(currentPassword, user.password))) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' } as ApiResponse);
      }

      if (await bcrypt.compare(newPassword, user.password)) {
        return res.status(400).json({
          success: false,
          error: 'New password must differ from the current one',
        } as ApiResponse);
      }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          password: await bcrypt.hash(newPassword, 12),
          mustChangePassword: false,
        },
      });

      // reissue so the client stops seeing the forced-change flag
      return res.json({
        success: true,
        data: { token: signToken(updated) },
        message: 'Password updated',
      } as ApiResponse);
    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

/**
 * Accept an organization invite. Creates the account on first use, then joins the org.
 * Public by design — the invite token is the credential, so it is single-use and expiring.
 */
router.post('/accept-invite', validateRequest(AcceptInviteSchema), async (req: Request, res: Response) => {
  try {
    const { token, name, password } = req.body;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invite = await prisma.invite.findUnique({ where: { tokenHash } });

    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
      return res.status(400).json({
        success: false,
        error: 'Invite is invalid, already used, or expired',
      } as ApiResponse);
    }

    let user = await prisma.user.findUnique({ where: { email: invite.email } });

    if (!user) {
      if (!password) {
        return res.status(400).json({
          success: false,
          error: 'A password is required to create your account',
        } as ApiResponse);
      }

      user = await prisma.user.create({
        data: {
          email: invite.email,
          name: name ?? null,
          password: await bcrypt.hash(password, 12),
          role: 'CLIENT',
          emailVerifiedAt: new Date(), // the invite link reached this address
        },
      });
    } else if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account is disabled' } as ApiResponse);
    } else {
      await markVerified(user);
    }

    await prisma.$transaction([
      prisma.membership.upsert({
        where: { userId_organizationId: { userId: user.id, organizationId: invite.organizationId } },
        create: { userId: user.id, organizationId: invite.organizationId, role: invite.role },
        update: { role: invite.role },
      }),
      prisma.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } }),
    ]);

    return res.json({
      success: true,
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token: signToken(user),
        organizationId: invite.organizationId,
      },
      message: 'Invite accepted',
    } as ApiResponse);
  } catch (error) {
    console.error('Accept invite error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

/**
 * Reset links: a JWT signed with the server secret plus the user's current
 * password hash, so it dies the moment the password changes (single use) and
 * needs no table. Expires in an hour.
 */
const resetSecret = (passwordHash: string) => `${process.env.JWT_SECRET}:${passwordHash}`;

// Mail a reset link. Always the same answer, so it does not tell who has an account.
router.post(
  '/forgot-password',
  validateRequest(z.object({ email: z.string().email() })),
  async (req: Request, res: Response) => {
    try {
      const email = String(req.body.email).trim();
      const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
      const appUrl = process.env.APP_URL?.replace(/\/$/, '');
      if (!appUrl) console.warn('APP_URL not set — password reset email skipped');

      if (user?.isActive && appUrl) {
        const token = jwt.sign({ userId: user.id, purpose: 'reset' }, resetSecret(user.password), { expiresIn: '1h' });
        const link = `${appUrl}/reset-password?token=${token}`;
        const appName = process.env.APP_NAME || 'Larika';
        await sendMail({
          to: user.email,
          subject: `Reset your ${appName} password`,
          text: [
            `Someone asked to reset the password of your ${appName} account.`,
            '',
            `Choose a new password: ${link}`,
            '',
            'The link works once and expires in an hour. If it was not you, ignore this email.',
          ].join('\n'),
          html: `<p>Someone asked to reset the password of your ${appName} account.</p>
<p><a href="${link}">Choose a new password</a></p>
<p>The link works once and expires in an hour. If it was not you, ignore this email.</p>`,
        });
      }

      return res.json({ success: true, message: 'If that email has an account, a reset link is on its way' } as ApiResponse);
    } catch (error) {
      console.error('Forgot password error:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// Set a new password from a reset link, and sign in
router.post(
  '/reset-password',
  validateRequest(z.object({ token: z.string().min(1), password: z.string().min(8) })),
  async (req: Request, res: Response) => {
    const invalid = () =>
      res.status(400).json({ success: false, error: 'This reset link is invalid or expired' } as ApiResponse);
    try {
      const claims = jwt.decode(req.body.token) as { userId?: string; purpose?: string } | null;
      if (!claims?.userId || claims.purpose !== 'reset') return invalid();
      const user = await prisma.user.findUnique({ where: { id: claims.userId } });
      if (!user?.isActive) return invalid();
      try {
        jwt.verify(req.body.token, resetSecret(user.password));
      } catch {
        return invalid();
      }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(req.body.password, 12), mustChangePassword: false },
      });
      await markVerified(user); // the link reached their inbox
      return res.json({ success: true, data: { token: signToken(updated) }, message: 'Password updated' } as ApiResponse);
    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// Confirm the address from the link mailed at sign-up
router.post(
  '/verify-email',
  validateRequest(z.object({ token: z.string().min(1) })),
  async (req: Request, res: Response) => {
    const invalid = () => res.status(400).json({ success: false, error: 'This link is invalid or expired' } as ApiResponse);
    try {
      let claims: { userId?: string; email?: string; purpose?: string };
      try {
        claims = jwt.verify(req.body.token, process.env.JWT_SECRET as string) as typeof claims;
      } catch {
        return invalid();
      }
      const user = claims.purpose === 'verify' && claims.userId ? await prisma.user.findUnique({ where: { id: claims.userId } }) : null;
      if (!user || user.email !== claims.email) return invalid();
      await markVerified(user);
      return res.json({ success: true, message: 'Email confirmed' } as ApiResponse);
    } catch (error) {
      console.error('Verify email error:', error);
      return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
    }
  }
);

// Mail the link again
router.post('/resend-verification', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (user && !user.emailVerifiedAt) await sendVerification(user);
    return res.json({ success: true, message: 'Verification email sent' } as ApiResponse);
  } catch (error) {
    console.error('Resend verification error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' } as ApiResponse);
  }
});

// Validate user token
router.get('/validate', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // If we reach here, the token is valid (authenticateToken middleware passed)
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'User not found',
      } as ApiResponse);
    }

    // ponytail: JWTs stay valid until expiry; this check revokes a disabled account
    // on the frontend's next validate call. Add a token denylist if instant revocation matters.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'Account is disabled',
      } as ApiResponse);
    }

    return res.json({
      success: true,
      data: {
        user,
        valid: true,
      },
      message: 'Token is valid',
    } as ApiResponse);
  } catch (error) {
    console.error('Token validation error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    } as ApiResponse);
  }
});

export default router; 
