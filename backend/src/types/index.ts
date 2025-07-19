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
  name: z.string().min(1).optional(),
  password: z.string().min(8),
});

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const CreateApplicationSchema = z.object({
  name: z.string().min(1).max(100),
  domain: z.string().min(1).max(255),
  type: z.nativeEnum(AppType),
  repository: z.string().url().optional(),
  branch: z.string().default('main'),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  port: z.number().int().positive().optional(),
  envVars: z.record(z.string()).optional(),
});

export const UpdateApplicationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  domain: z.string().min(1).max(255).optional(),
  type: z.nativeEnum(AppType).optional(),
  repository: z.string().url().optional(),
  branch: z.string().optional(),
  buildCommand: z.string().optional(),
  startCommand: z.string().optional(),
  port: z.number().int().positive().optional(),
  envVars: z.record(z.string()).optional(),
});

export const CreateDatabaseSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.nativeEnum(DatabaseType),
  version: z.string().optional(),
  config: z.record(z.any()).optional(),
});

export const CreateDeploymentSchema = z.object({
  applicationId: z.string(),
  envVars: z.record(z.string()).optional(),
});

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
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