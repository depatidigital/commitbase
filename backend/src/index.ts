import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from 'dotenv';
import { ContainerWatcher } from './services/containerWatcher';

config();

async function ensureCaddyReady(): Promise<void> {
  const caddyUrl = process.env.CADDY_API_URL;
  if (!caddyUrl) {
    return;
  }

  const fetchFn: any = (globalThis as any).fetch;
  if (!fetchFn) {
    console.warn('CADDY_API_URL is set but fetch is not available; skipping Caddy readiness check');
    return;
  }

  const baseUrl = caddyUrl.replace(/\/$/, '');

  try {
    const response = await fetchFn(`${baseUrl}/config`, {
      method: 'GET',
    });

    if (!response.ok) {
      console.error(`Caddy readiness check failed with status ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    console.log('✅ Caddy is reachable and ready for configuration');
  } catch (error) {
    console.error('Caddy readiness check error:', error);
    process.exit(1);
  }
}

// Import routes
import authRoutes from './routes/auth';
import applicationsRoutes from './routes/applications';
import databasesRoutes from './routes/databases';
import deploymentsRoutes from './routes/deployments';
import logsRoutes from './routes/logs';
import metricsRoutes from './routes/metrics';
import domainsRoutes from './routes/domains';
import templatesRoutes from './routes/templates';
import rdashRoutes from './routes/rdash';
import cloudflareRoutes from './routes/cloudflare';

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.CORS_ORIGIN 
    : true, // Allow all origins in development
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

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

// Container watcher status endpoint
app.get('/health/containers', (req, res) => {
  const containerWatcher = new ContainerWatcher();
  const status = containerWatcher.getWatcherStatus();
  res.json({
    status: 'OK',
    containerWatcher: status,
    timestamp: new Date().toISOString()
  });
});

// Mount routes
app.use('/api/auth', authRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api/databases', databasesRoutes);
app.use('/api/deployments', deploymentsRoutes);
app.use('/api/logs', logsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/domains', domainsRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/rdash', rdashRoutes);
app.use('/api/cloudflare', cloudflareRoutes);

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

app.listen(PORT, async () => {
  await ensureCaddyReady();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  
  // Start container watcher
  const containerWatcher = new ContainerWatcher();
  await containerWatcher.startWatching();
  console.log('🔍 Container watcher started');
}); 
