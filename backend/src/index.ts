import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';

// Application.diskBytes is a BigInt; res.json() has no idea what to do with one.
// Sizes fit a number — every BigInt on the wire is one.
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};
import * as appStatusWatcher from './services/appStatusWatcher';
import { startCronJobs } from './services/cron';
import { applyConnectionLimits } from './services/databaseProvisionService';
import { snapshotCaddyConfig } from './services/caddySnapshotService';
import { DeploymentService } from './services/deployment';
import { allServers } from './lib/servers';
import { getCaddyConfig } from './services/caddyService';
import { backfillSources } from './lib/sources';
import { backfillAppDomains } from './lib/appDomains';
import { recoverPm2Deploys } from './services/pm2DeployService';
import { resumeQueuedDeploys, watchDrain } from './services/deployLaunch';

config();

/**
 * Can each node's Caddy be reached over its SSH connection? Not fatal any more:
 * with several nodes, one unreachable box must not stop the control plane —
 * the watchdog keeps trying and the server row carries the error.
 */
async function ensureCaddyReady(): Promise<void> {
  const nodes = await allServers();

  for (const node of nodes) {
    const config = await getCaddyConfig(node);
    if (config === null) {
      console.error(`❌ Caddy on ${node.hostname} did not answer over SSH`);
      continue;
    }
    console.log(`✅ Caddy on ${node.hostname} is reachable`);
  }
}

// Import routes
import authRoutes from './routes/auth';
import applicationsRoutes from './routes/applications';
import sourcesRoutes from './routes/sources';
import billingRoutes from './routes/billing';
import databasesRoutes from './routes/databases';
import deploymentsRoutes from './routes/deployments';
import logsRoutes from './routes/logs';
import metricsRoutes from './routes/metrics';
import domainsRoutes from './routes/domains';
import rdashRoutes from './routes/rdash';
import cloudflareRoutes from './routes/cloudflare';
import googleRoutes from './routes/google';
import gitOAuthRoutes from './routes/gitOAuth';
import gitRoutes from './routes/git';
import adminRoutes from './routes/admin';
import systemRoutes from './routes/system';
import organizationsRoutes from './routes/organizations';
import serversRoutes from './routes/servers';
import databaseServersRoutes from './routes/databaseServers';
import { authenticateToken, requireRole } from './middleware/auth';

const app = express();
const PORT = process.env.PORT || 3001;

// Caddy on the same host terminates TLS: take req.protocol / req.ip from its
// X-Forwarded-* headers (OAuth redirect_uri, rate limiting). 'loopback' only
// believes those headers from 127.0.0.1/::1, so a direct client can't spoof them.
app.set('trust proxy', 'loopback');

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.CORS_ORIGIN 
    : true, // Allow all origins in development
  credentials: true,
  // downloads (database backups) name their file here
  exposedHeaders: ['Content-Disposition'],
}));

// Rate limiting: only where guessing pays — signing in and redeeming an invite.
// No limit on the API as a whole: the dashboard polls (project, health, source,
// deploy progress) and a few open tabs ran past any per-IP cap, locking the
// user out of sign-in too. Only failed attempts count, so signing in is never
// blocked by having signed in before. JSON, like every other error the app reads.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many failed sign-in attempts — wait 15 minutes, then try again.' },
});
app.use(['/api/auth/login', '/api/auth/register', '/api/auth/accept-invite'], authLimiter);

// Compression middleware
app.use(compression());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Application status watcher endpoint
app.get('/health/apps', (req, res) => {
  res.json({
    status: 'OK',
    appStatusWatcher: appStatusWatcher.getWatcherStatus(),
    timestamp: new Date().toISOString()
  });
});

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/sources', sourcesRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/databases', databasesRoutes);
app.use('/api/deployments', deploymentsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/domains', domainsRoutes);
// Admin-only: shared infra + provider credentials, never tenant-scoped
// Integration credentials are platform-owner only
app.use('/api/rdash', authenticateToken, requireRole(['SUPERADMIN']), rdashRoutes);
app.use('/api/cloudflare', authenticateToken, requireRole(['SUPERADMIN']), cloudflareRoutes);
app.use('/api/google', authenticateToken, requireRole(['SUPERADMIN']), googleRoutes);
app.use('/api/git-oauth', authenticateToken, requireRole(['SUPERADMIN']), gitOAuthRoutes);
app.use('/api/admin', authenticateToken, requireRole(['SUPERADMIN', 'ADMIN']), adminRoutes);
app.use('/api/system', authenticateToken, requireRole(['SUPERADMIN']), systemRoutes);
app.use('/api/organizations', organizationsRoutes);
app.use('/api/servers', serversRoutes);
app.use('/api/database-servers', databaseServersRoutes);
app.use('/api/git', gitRoutes);

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Global error handler:', err);
  
  if (err.message && err.message.includes('CORS')) {
    res.status(403).json({
      success: false,
      error: 'Not allowed by CORS',
    });
    return;
  }

  if (err.name === 'ValidationError') {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: err.details,
    });
    return;
  }

  if (err.code === 'P2002') {
    res.status(400).json({
      success: false,
      error: 'Resource already exists',
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message || 'Internal server error',
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

async function onListening() {
  await ensureCaddyReady();
  // Caddy keeps tenant routes in memory; a reload from the Caddyfile loses them.
  new DeploymentService()
    .reapplyCaddyRoutes()
    .then(async ({ applied, failed }) => {
      if (applied || failed) console.log(`🔁 Caddy routes re-applied: ${applied} ok, ${failed} failed`);
      // there are no site files to rebuild from any more — keep a copy of what
      // is live, so a reload cannot take the routes with it for good
      console.log(`💾 Caddy config: ${await snapshotCaddyConfig()}`);
    })
    .catch((err) => console.error('Caddy route re-apply failed:', err));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  // an upgrade (larika-upgrade.sh) waits for running deploys through this
  watchDrain();
  // deploys still queued when the panel stopped: started again, not lost
  resumeQueuedDeploys()
    .then((resumed) => resumed && console.log(`▶️ ${resumed} queued deploy(s) started again`))
    .catch((err) => console.error('Could not resume queued deploys:', err));
  
  // Start application status watcher
  await appStatusWatcher.startWatching();
  console.log('🔍 Application status watcher started');

  startCronJobs();

  // a raised DB_ORG_CONNECTION_LIMIT reaches the logins made before it
  applyConnectionLimits()
    .then((count) => count && console.log(`🔌 Connection limit set on ${count} database login(s)`))
    .catch((err) => console.error('Could not apply database connection limits:', err));
}

// before the first request: every app reads its repository from its source
backfillSources()
  .then((created) => created && console.log(`📦 Sources created for ${created} existing app(s)`))
  .catch((err) => console.error('Source backfill failed — apps without a source show no repository:', err))
  // a pm2 build cut off by this restart: said so, and the app no longer "deploying"
  .then(() => recoverPm2Deploys())
  .then((recovered) => recovered && console.log(`🧹 ${recovered} interrupted build(s) marked failed`))
  .catch((err) => console.error('Could not recover interrupted pm2 builds:', err))
  // before the first request too: every app reads its hostnames from app_domains
  .then(() => backfillAppDomains())
  .then((moved) => moved && console.log(`🌐 Hostnames moved for ${moved} existing app(s)`))
  .catch((err) => console.error('Hostname backfill failed — apps without one show no address:', err))
  .then(() => app.listen(PORT, onListening));
