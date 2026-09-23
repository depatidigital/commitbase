import { z } from 'zod';
import { Request } from 'express';
import { cleanRootDirectory, ROOT_DIRECTORY_RE } from '../lib/appPaths';

// User types
export const UserRole = {
  SUPERADMIN: 'SUPERADMIN',
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const;

export type UserRole = typeof UserRole[keyof typeof UserRole];

export const AppType = {
  NODEJS: 'NODEJS',
  STATIC: 'STATIC',
  PYTHON: 'PYTHON',
  GO: 'GO',
  RUST: 'RUST',
  PHP: 'PHP',
  JAVA: 'JAVA',
  COMPOSE: 'COMPOSE',
} as const;

export type AppType = typeof AppType[keyof typeof AppType];

export const AppStatus = {
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  ERROR: 'ERROR',
  DEPLOYING: 'DEPLOYING',
  BUILDING: 'BUILDING',
} as const;

export type AppStatus = typeof AppStatus[keyof typeof AppStatus];

export const DeploymentStatus = {
  PENDING: 'PENDING',
  BUILDING: 'BUILDING',
  DEPLOYING: 'DEPLOYING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type DeploymentStatus = typeof DeploymentStatus[keyof typeof DeploymentStatus];

export const DatabaseType = {
  POSTGRESQL: 'POSTGRESQL',
  MYSQL: 'MYSQL',
  MONGODB: 'MONGODB',
  REDIS: 'REDIS',
  SQLITE: 'SQLITE',
} as const;

export type DatabaseType = typeof DatabaseType[keyof typeof DatabaseType];

export const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
} as const;

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];

// Zod schemas for validation
export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(6),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// Domain schemas
export const CreateDomainSchema = z.object({
  name: z.string().min(1, 'Domain name is required'),
  organizationId: z.string().min(1, 'Owning organization is required'),
  redirectTo: z.string().optional(),
  customConfig: z.record(z.any()).optional(),
});

export const UpdateDomainSchema = z.object({
  name: z.string().min(1, 'Domain name is required').optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'PENDING', 'ERROR']).optional(),
  redirectTo: z.string().optional(),
  customConfig: z.record(z.any()).optional(),
});

// Application schemas
const rootDirectorySchema = z
  .string()
  .nullable()
  .optional()
  .refine((raw) => {
    const cleaned = cleanRootDirectory(raw);
    return cleaned === null || ROOT_DIRECTORY_RE.test(cleaned);
  }, 'Root directory is a folder in the repository, like apps/web');

/**
 * A file inside the app's tree — a compose file or an env file. It ends up in a
 * path join and in an argv, so it stays relative and may not climb out with
 * `..`. Dotfiles are allowed on purpose: `.env` and `.ckan-env` are two of these.
 */
const COMPOSE_PATH_RE = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*$/;
const composePathList = (what: string) =>
  z
    .array(z.string().trim().min(1).max(255).regex(COMPOSE_PATH_RE, `${what} is a file in the repository, like docker-compose.yml`))
    .max(10)
    .optional();

/** A COMPOSE app's columns — composeEnvFiles is every app type's: the env files its deploy writes. Shared by create and update. */
const composeFields = {
  composeFiles: composePathList('A compose file'),
  composeEnvFiles: composePathList('An env file'),
  composePort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  composeService: z.string().trim().min(1).max(63).regex(/^[A-Za-z0-9._-]+$/, 'invalid service name').nullable().optional(),
};

export const CreateApplicationSchema = z.object({
  name: z.string().min(1, 'Application name is required'),
  // its first host — optional: an app is created first, its hosts added (and it deployed) later
  domain: z.string().optional(),
  type: z.enum(['NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA', 'COMPOSE']),
  repository: z.string().optional(),
  // Which connected GitHub/GitLab account clones a private repository
  gitAccountId: z.string().optional(),
  branch: z.string().optional(),
  // an app's folder in a monorepo; '' or null = the repository root
  rootDirectory: rootDirectorySchema,
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  preDeployCommand: z.string().optional(),
  startCommand: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  // the node to run on — honoured for superadmins; others get the org's default
  serverId: z.string().min(1).optional(),
  // whose app it is, under a shared platform domain; an owned domain decides it itself
  organizationId: z.string().min(1).optional(),
  // the user agreed to replace what the hostname points at today (lib/appHostname applyAppDns)
  dnsConsent: z.boolean().optional(),
  // add it to this project (a Source) instead of starting a new one
  sourceId: z.string().min(1).optional(),
  // a new project's own name, when its first app is named apart from it (a monorepo's drafts)
  projectName: z.string().optional(),
  ...composeFields,
});

export const UpdateApplicationSchema = z.object({
  name: z.string().min(1, 'Application name is required').optional(),
  type: z.enum(['NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA', 'COMPOSE']).optional(),
  repository: z.string().optional(),
  gitAccountId: z.string().nullable().optional(),
  branch: z.string().optional(),
  // an app's folder in a monorepo; '' or null = the repository root
  rootDirectory: rootDirectorySchema,
  installCommand: z.string().optional(),
  buildCommand: z.string().optional(),
  preDeployCommand: z.string().optional(),
  startCommand: z.string().optional(),
  envVars: z.record(z.string()).optional(),
  // the env files after the first, each its own variables: { ".ckan-env": { KEY: value } }
  extraEnvVars: z.record(z.string().regex(COMPOSE_PATH_RE, 'An env file is a file in the repository, like .env'), z.record(z.string())).optional(),
  dnsConsent: z.boolean().optional(),
  ...composeFields,
});

// Database schemas
export const CreateDatabaseSchema = z.object({
  // the part after the org prefix; databaseName() holds it to identifier rules
  name: z.string().trim().min(1, 'Database name is required').max(41),
  // the engine; taken from the server when one is chosen
  type: z.enum(['POSTGRESQL', 'MYSQL', 'MONGODB', 'REDIS', 'SQLITE']).optional(),
  // the server to create it on; else the organization's server for the engine
  databaseServerId: z.string().min(1).optional(),
  // the login that reaches it: one the org has, a new named one, or the org's default
  login: z
    .union([z.object({ accountId: z.string().min(1) }), z.object({ username: z.string().trim().min(1).max(31) })])
    .optional(),
  // who owns it: the app's organization when an app is given, else this one
  organizationId: z.string().min(1).optional(),
  applicationId: z.string().min(1).optional(),
});

export const UpdateDatabaseSchema = z.object({
  name: z.string().min(1, 'Database name is required').optional(),
  type: z.enum(['POSTGRESQL', 'MYSQL', 'MONGODB', 'REDIS', 'SQLITE']).optional(),
  version: z.string().optional(),
  config: z.record(z.any()).optional(),
});

// Log schemas
export const CreateLogSchema = z.object({
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']),
  message: z.string().min(1, 'Log message is required'),
  metadata: z.record(z.any()).optional(),
});

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  details?: any[];
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Domain types
export interface Domain {
  id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE' | 'PENDING' | 'ERROR';
  dnsRecords?: any;
  sslStatus: 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'ERROR';
  sslExpiry?: Date;
  redirectTo?: string;
  customConfig?: any;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
}

// Application types
export interface Application {
  id: string;
  name: string;
  /** its hostnames, all alike */
  domains: Array<{ host: string; domainId: string | null }>;
  type: 'NODEJS' | 'STATIC' | 'PYTHON' | 'GO' | 'RUST' | 'PHP' | 'JAVA' | 'COMPOSE';
  status: 'RUNNING' | 'STOPPED' | 'ERROR' | 'DEPLOYING' | 'BUILDING';
  port?: number;
  memory?: string;
  cpu?: string;
  uptime?: string;
  repository?: string;
  branch?: string;
  buildCommand?: string;
  startCommand?: string;
  envVars?: any;
  lastDeployment?: Date;
  deploymentCount: number;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  deployments?: Deployment[];
}

// Database types
export interface Database {
  id: string;
  name: string;
  type: 'POSTGRESQL' | 'MYSQL' | 'MONGODB' | 'REDIS' | 'SQLITE';
  status: 'CREATING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  connectionString?: string;
  port?: number;
  memory?: string;
  cpu?: string;
  version?: string;
  config?: any;
  createdAt: Date;
  updatedAt: Date;
  applicationId: string;
}

// Deployment types
export interface Deployment {
  id: string;
  status: 'PENDING' | 'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  commitHash?: string;
  commitMessage?: string;
  buildTime?: number;
  buildSize?: string;
  envVars?: any;
  createdAt: Date;
  updatedAt: Date;
  applicationId: string;
  userId: string;
}

// Log types
export interface Log {
  id: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  timestamp: Date;
  metadata?: any;
  applicationId?: string;
  userId: string;
}

// User types
export interface User {
  id: string;
  email: string;
  name?: string;
  role: 'ADMIN' | 'USER';
  createdAt: Date;
  updatedAt: Date;
}

// JWT Payload
export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

// Request with user
export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
} 