import { z } from 'zod';
import { Request } from 'express';

// User types
export const UserRole = {
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
export const CreateApplicationSchema = z.object({
  name: z.string().min(1, 'Application name is required'),
  domain: z.string().min(1, 'Domain is required'),
  type: z.enum(['NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA']),
  repository: z.string().optional(),
  branch: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  envVars: z.record(z.string()).optional(),
});

export const UpdateApplicationSchema = z.object({
  name: z.string().min(1, 'Application name is required').optional(),
  domain: z.string().min(1, 'Domain is required').optional(),
  type: z.enum(['NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA']).optional(),
  repository: z.string().optional(),
  branch: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  envVars: z.record(z.string()).optional(),
});

// Database schemas
export const CreateDatabaseSchema = z.object({
  name: z.string().min(1, 'Database name is required'),
  type: z.enum(['POSTGRESQL', 'MYSQL', 'MONGODB', 'REDIS', 'SQLITE']),
  version: z.string().optional(),
  config: z.record(z.any()).optional(),
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
  domain: string;
  type: 'NODEJS' | 'STATIC' | 'PYTHON' | 'GO' | 'RUST' | 'PHP' | 'JAVA';
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