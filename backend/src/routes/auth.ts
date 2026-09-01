import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { CreateUserSchema, LoginSchema, ApiResponse } from '../types';
import { validateRequest } from '../middleware/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

// Bootstrap the first (ADMIN) account. Once any user exists this endpoint is closed —
// further accounts are created by an admin via POST /api/admin/users.
router.post('/register', validateRequest(CreateUserSchema), async (req: Request, res: Response) => {
  try {
    const { email, name, password } = req.body;

    const userCount = await prisma.user.count();
    if (userCount > 0) {
      return res.status(403).json({
        success: false,
        error: 'Public registration is disabled. Ask an administrator for an account.',
      } as ApiResponse);
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User with this email already exists',
      } as ApiResponse);
    }

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create the first user plus their organization; they own both
    const user = await prisma.user.create({
      data: {
        email,
        name,
        password: hashedPassword,
        role: 'SUPERADMIN', // first account owns the platform
        memberships: {
          create: {
            role: 'OWNER',
            organization: {
              create: {
                name: name || 'Default Organization',
                slug: 'default',
              },
            },
          },
        },
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      process.env.JWT_SECRET as any,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as any }
    );

    return res.status(201).json({
      success: true,
      data: {
        user,
        token,
      },
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

// Login user
router.post('/login', validateRequest(LoginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
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
        },
      });
    } else if (!user.isActive) {
      return res.status(403).json({ success: false, error: 'Account is disabled' } as ApiResponse);
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
