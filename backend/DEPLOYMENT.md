# Deployment System

This document describes the deployment system for CommitBase applications.

## Overview

The deployment system handles the complete lifecycle of application deployment using **PM2** for process management and **file-based logging** for easy monitoring:

1. **App Directory Preparation** - Creates and manages application directories
2. **Repository Sync** - Clones or pulls the latest code from Git repositories
3. **Dependency Installation** - Installs dependencies automatically
4. **Build Process** - Runs build commands with environment variables
5. **Application Startup** - Starts applications with PM2 and proper port configuration
6. **Log Management** - All logs are written to files for easy tailing

## PM2 Process Management

### Installation
```bash
# Install PM2 globally
npm install -g pm2

# Run setup script
chmod +x scripts/setup-pm2.sh
./scripts/setup-pm2.sh
```

### PM2 Features
- **Process Management**: Automatic restart on crashes
- **Log Management**: Structured logging to files
- **Monitoring**: Real-time process monitoring
- **Load Balancing**: Multiple instances support
- **Startup Scripts**: Auto-start on system boot

## Supported Application Types

### Node.js Applications ⚡
- **Build Command**: `yarn build`, `npm run build`, etc.
- **Start Command**: `yarn start`, `npm start`, `node app.js`, etc.
- **Port Configuration**: Automatically sets PORT environment variable
- **Environment Variables**: Full support for custom environment variables
- **PM2 Management**: Automatic process management with PM2

### Static Websites 🌐
- **Build Command**: `yarn build`, `npm run build`, etc.
- **No Runtime**: Static files are served directly
- **Environment Variables**: Support for build-time environment variables

## Deployment Process

### 1. Directory Structure
```
apps_dir/
├── app.example.com/
│   ├── logs/
│   │   ├── combined.log       # All logs
│   │   ├── out.log           # Standard output
│   │   ├── error.log         # Error logs
│   │   └── build.log         # Build logs
│   ├── sources/
│   │   ├── .git/
│   │   ├── package.json
│   │   ├── src/
│   │   ├── dist/
│   │   └── ...
│   └── ecosystem.config.js    # PM2 configuration
├── api.example.com/
│   ├── logs/
│   ├── sources/
│   └── ecosystem.config.js
└── ...
```

### 2. Deployment Steps

#### Step 1: Prepare App Directory
- Creates `apps_dir/` directory if it doesn't exist
- Creates application-specific directory: `apps_dir/{subdomain.domain.tld}/`
- Creates `logs/` subdirectory for log files
- Creates `sources/` subdirectory for source code
- Ensures proper permissions and structure

#### Step 2: Sync Repository
- **First Deployment**: Clones the repository into `sources/` directory
- **Subsequent Deployments**: Pulls latest changes
- Supports branch specification
- Handles Git authentication (if configured)

#### Step 3: Install Dependencies
- Automatically detects `package.json` in `sources/` directory
- Runs `yarn install` (or `npm install` if you prefer)
- Installs production dependencies
- Handles dependency conflicts

#### Step 4: Build Application
- Runs the specified build command in `sources/` directory
- Passes environment variables to build process
- Captures build logs and saves to `logs/build.log`
- Times out after 5 minutes

#### Step 5: Start Application with PM2 (Node.js only)
- Creates PM2 ecosystem configuration file
- Starts application with PM2 process manager
- Sets PORT environment variable
- Sets NODE_ENV=production
- Configures log files for output and errors
- Captures process ID for management
- Times out after 3 minutes

## Log Management

### File-Based Logging
All application logs are written to files in the `apps_dir/{domain}/logs/` directory:

- **`combined.log`**: All application logs (stdout + stderr)
- **`out.log`**: Standard output only
- **`error.log`**: Error logs only
- **`build.log`**: Build process logs

### Log Access
```bash
# Tail logs in real-time
tail -f apps_dir/app.example.com/logs/combined.log

# View recent logs
tail -n 100 apps_dir/app.example.com/logs/out.log

# Monitor errors
tail -f apps_dir/app.example.com/logs/error.log

# View build logs
tail -f apps_dir/app.example.com/logs/build.log
```

### API Log Endpoints
```http
# Get application logs
GET /api/logs/application/{appId}?lines=100&type=combined

# Stream logs in real-time
GET /api/logs/application/{appId}/stream?type=combined

# Get PM2 status
GET /api/logs/pm2/status
```

## Environment Variables

### Build Environment
- `NODE_ENV=production`
- Custom variables from application configuration
- Repository-specific variables

### Runtime Environment (Node.js)
- `PORT={application_port}`
- `NODE_ENV=production`
- Custom variables from application configuration

## API Endpoints

### Start Application
```http
POST /api/applications/{id}/start
Authorization: Bearer {token}
```

### Stop Application
```http
POST /api/applications/{id}/stop
Authorization: Bearer {token}
```

### Restart Application
```http
POST /api/applications/{id}/restart
Authorization: Bearer {token}
```

### Get Application Logs
```http
GET /api/logs/application/{appId}?lines=100&type=combined
Authorization: Bearer {token}
```

### Stream Application Logs
```http
GET /api/logs/application/{appId}/stream?type=combined
Authorization: Bearer {token}
```

### Get PM2 Status
```http
GET /api/logs/pm2/status
Authorization: Bearer {token}
```

## Configuration

### Environment Variables
```bash
# Applications directory
APPS_DIR="./apps_dir"

# Server configuration
PORT=3001
NODE_ENV=production

# Database
DATABASE_URL="postgresql://..."
```

### PM2 Ecosystem Configuration
Each application gets an `ecosystem.config.js` file:
```javascript
module.exports = {
  apps: [{
    name: 'app-subdomain-domain-tld',
    script: 'yarn start',
    cwd: '/path/to/apps_dir/subdomain.domain.tld/sources',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: '3000',
      // Custom environment variables
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    time: true
  }]
};
```

### Application Configuration
```json
{
  "name": "My App",
  "type": "NODEJS",
  "domain": "app.example.com",
  "repository": "https://github.com/user/repo.git",
  "branch": "main",
  "buildCommand": "yarn build",
  "startCommand": "yarn start",
  "port": 3000,
  "envVars": {
    "DATABASE_URL": "postgresql://...",
    "API_KEY": "your-api-key"
  }
}
```

## Process Management

### Starting Applications
- Uses PM2 ecosystem configuration
- Runs processes in background
- Captures process ID for management
- Redirects output to log files
- Sets proper working directory

### Stopping Applications
- Sends SIGTERM signal to PM2 process
- Waits for graceful shutdown
- Deletes PM2 process
- Updates application status

### Restarting Applications
- Restarts PM2 process
- Maintains log files
- Updates application status

### Status Monitoring
- Checks PM2 process status
- Updates database with current status
- Handles crashed applications
- Provides status API endpoints

## Logging

### Build Logs
- Captured during build process
- Stored in `logs/build.log` file
- Available via API endpoints
- Includes error details

### Runtime Logs
- Redirected to log files in `apps_dir/{domain}/logs/`
- Available for real-time tailing
- Structured by type (combined, out, error, build)
- Include timestamps and process information

### Log Streaming
- Server-Sent Events (SSE) for real-time logs
- File monitoring for new log entries
- Automatic cleanup on disconnect
- Support for different log types

## Security Considerations

### Directory Isolation
- Each application runs in its own directory
- No cross-application file access
- Proper file permissions

### Environment Variables
- Isolated per application
- No cross-application variable sharing
- Secure storage in database

### Process Isolation
- Each application runs as separate PM2 process
- No shared memory or resources
- Proper signal handling

## Troubleshooting

### Common Issues

#### Build Failures
- Check build command syntax
- Verify dependencies in package.json
- Check environment variables
- Review build logs

#### Startup Failures
- Verify start command
- Check port availability
- Review application logs
- Verify environment variables

#### PM2 Issues
- Check PM2 installation: `pm2 --version`
- View PM2 processes: `pm2 list`
- Check PM2 logs: `pm2 logs`
- Restart PM2 daemon: `pm2 kill && pm2 start`

#### Repository Issues
- Check repository URL
- Verify branch exists
- Check authentication
- Review Git logs

### Debugging Commands
```bash
# Check application directory
ls -la apps_dir/{domain}/

# View application logs
tail -f apps_dir/{domain}/logs/combined.log

# Check PM2 processes
pm2 list

# Check PM2 logs
pm2 logs {app-name}

# Check port usage
netstat -tlnp | grep {port}

# Monitor PM2 processes
pm2 monit
```

## Future Enhancements

### Planned Features
- **Real-time Log Streaming**: WebSocket-based log streaming
- **Health Checks**: Automatic health check endpoints
- **Auto-scaling**: Automatic scaling based on load
- **Rollback Support**: Quick rollback to previous deployments
- **Blue-Green Deployments**: Zero-downtime deployments
- **Docker Support**: Container-based deployments
- **SSL/TLS**: Automatic SSL certificate management

### Monitoring
- **Resource Usage**: CPU, memory, disk usage
- **Performance Metrics**: Response times, throughput
- **Error Tracking**: Automatic error reporting
- **Alerting**: Email/Slack notifications

## Testing

Run the deployment test:
```bash
yarn test:deployment
# or
npx ts-node src/scripts/test-deployment.ts
```

This will test all deployment service functions without affecting production applications.

## PM2 Commands Reference

### Basic Commands
```bash
pm2 list                    # List all processes
pm2 logs [app-name]         # View logs
pm2 restart [app-name]      # Restart application
pm2 stop [app-name]         # Stop application
pm2 delete [app-name]       # Delete application
pm2 monit                   # Monitor processes
```

### Advanced Commands
```bash
pm2 save                    # Save current configuration
pm2 startup                 # Generate startup script
pm2 resurrect               # Restore saved processes
pm2 reload [app-name]       # Zero-downtime reload
pm2 scale [app-name] [num]  # Scale application
```

### Log Commands
```bash
pm2 logs --lines 100        # Show last 100 lines
pm2 logs --timestamp        # Show logs with timestamps
pm2 flush                   # Clear all logs
pm2 reloadLogs              # Reload log files
``` 
