# CommitBase Backend

A robust backend API for the CommitBase application management platform, built with Express.js, TypeScript, and Prisma ORM.

## Features

- 🔐 **Authentication & Authorization** - JWT-based authentication with role-based access control
- 📱 **Application Management** - CRUD operations for applications with deployment tracking
- 🚀 **Deployment System** - Track and manage application deployments
- 🗄️ **Database Management** - Support for multiple database types (PostgreSQL, MySQL, MongoDB, Redis)
- 📊 **Logging & Metrics** - Comprehensive logging and system metrics collection
- 🔒 **Security** - Rate limiting, CORS, Helmet, and input validation
- 📈 **Monitoring** - Real-time application and system monitoring

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **ORM**: Prisma with PostgreSQL
- **Authentication**: JWT with bcrypt
- **Validation**: Zod
- **Security**: Helmet, CORS, Rate Limiting
- **Logging**: Morgan

## Database Schema

The application uses a comprehensive database schema with the following main entities:

### Core Entities

- **Users** - Authentication and user management
- **Applications** - Application configurations and metadata
- **Deployments** - Deployment history and build logs
- **Databases** - Database instances and configurations
- **Logs** - Application and system logs
- **SystemMetrics** - Performance and resource metrics

### Key Features

- Multi-tenant architecture with user isolation
- Comprehensive audit trail with timestamps
- Flexible environment variable management
- Support for multiple application types (Node.js, Static, Python, Go, Rust, PHP, Java)
- Real-time status tracking and monitoring

## Getting Started

### Prerequisites

- Node.js 18+ 
- PostgreSQL 12+
- Yarn

### Installation

1. **Clone the repository**
   ```bash
   cd backend
   ```

2. **Install dependencies**
   ```bash
   yarn install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   DATABASE_URL="postgresql://username:password@localhost:5432/commitbase?schema=public"
   JWT_SECRET="your-super-secret-jwt-key-here"
   PORT=3001
   ```

4. **Set up the database**
   ```bash
   # Generate Prisma client
   yarn db:generate
   
   # Push schema to database
   yarn db:push
   
   # Seed the database with sample data
   yarn db:seed
   ```

5. **Start the development server**
   ```bash
   yarn dev
   ```

The server will start on `http://localhost:3001`

## API Endpoints

### Authentication

- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user

### Applications

- `GET /api/applications` - Get user's applications
- `GET /api/applications/:id` - Get specific application
- `POST /api/applications` - Create new application
- `PUT /api/applications/:id` - Update application
- `DELETE /api/applications/:id` - Delete application
- `POST /api/applications/:id/start` - Start application
- `POST /api/applications/:id/stop` - Stop application

### Deployments

- `GET /api/deployments/application/:appId` - Get deployments for application
- `GET /api/deployments/:id` - Get specific deployment
- `POST /api/deployments` - Create new deployment
- `POST /api/deployments/:id/cancel` - Cancel deployment

### Databases

- `GET /api/databases/application/:appId` - Get databases for application
- `GET /api/databases/:id` - Get specific database
- `POST /api/databases` - Create new database
- `DELETE /api/databases/:id` - Delete database

### Logs

- `GET /api/logs/application/:appId` - Get application logs
- `GET /api/logs/system` - Get system logs
- `POST /api/logs` - Create log entry

### Metrics

- `GET /api/metrics/system` - Get system metrics
- `GET /api/metrics/application/:appId` - Get application metrics
- `POST /api/metrics` - Create metric entry

## Development

### Available Scripts

- `yarn dev` - Start development server with hot reload
- `yarn build` - Build for production
- `yarn start` - Start production server
- `yarn db:generate` - Generate Prisma client
- `yarn db:push` - Push schema to database
- `yarn db:migrate` - Run database migrations
- `yarn db:studio` - Open Prisma Studio
- `yarn db:seed` - Seed database with sample data

### Database Management

The application uses Prisma as the ORM. Key commands:

```bash
# Generate Prisma client after schema changes
yarn db:generate

# Push schema changes to database
yarn db:push

# Create and run migrations
yarn db:migrate

# Open Prisma Studio for database management
yarn db:studio
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `PORT` | Server port | 3001 |
| `NODE_ENV` | Environment | development |
| `JWT_SECRET` | JWT signing secret | Required |
| `JWT_EXPIRES_IN` | JWT expiration time | 7d |
| `CORS_ORIGIN` | CORS allowed origin | http://localhost:5173 |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | 900000 |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | 100 |

## Security Features

- **JWT Authentication** - Secure token-based authentication
- **Password Hashing** - bcrypt with salt rounds
- **Rate Limiting** - Prevent abuse with request limiting
- **CORS Protection** - Configured cross-origin resource sharing
- **Helmet Security** - Security headers and protection
- **Input Validation** - Zod schema validation
- **SQL Injection Protection** - Prisma ORM with parameterized queries

## Sample Data

The seeding script creates:

- **Admin User**: `admin@commitbase.com` / `admin123`
- **Demo User**: `user@commitbase.com` / `user123`
- **Sample Applications**: Portfolio, API Server, Blog
- **Sample Deployments**: With build logs and metrics
- **Sample Databases**: PostgreSQL and Redis instances
- **Sample Logs**: Application and system logs
- **Sample Metrics**: CPU, Memory, and Disk usage

## API Response Format

All API responses follow a consistent format:

```json
{
  "success": true,
  "data": { ... },
  "message": "Optional message",
  "error": "Error message if success is false"
}
```

## Error Handling

The API includes comprehensive error handling:

- **400 Bad Request** - Invalid input data
- **401 Unauthorized** - Missing or invalid authentication
- **403 Forbidden** - Insufficient permissions
- **404 Not Found** - Resource not found
- **429 Too Many Requests** - Rate limit exceeded
- **500 Internal Server Error** - Server-side errors

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details 
