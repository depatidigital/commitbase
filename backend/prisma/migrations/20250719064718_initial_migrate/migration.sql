-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "AppType" AS ENUM ('NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('RUNNING', 'STOPPED', 'ERROR', 'DEPLOYING', 'BUILDING');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DatabaseType" AS ENUM ('POSTGRESQL', 'MYSQL', 'MONGODB', 'REDIS', 'SQLITE');

-- CreateEnum
CREATE TYPE "DatabaseStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL');

-- CreateEnum
CREATE TYPE "MetricType" AS ENUM ('CPU_USAGE', 'MEMORY_USAGE', 'DISK_USAGE', 'NETWORK_IN', 'NETWORK_OUT', 'APP_COUNT', 'DEPLOYMENT_COUNT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "type" "AppType" NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'STOPPED',
    "port" INTEGER,
    "memory" TEXT,
    "cpu" TEXT,
    "uptime" TEXT,
    "repository" TEXT,
    "branch" TEXT DEFAULT 'main',
    "buildCommand" TEXT,
    "startCommand" TEXT,
    "envVars" JSONB,
    "lastDeployment" TIMESTAMP(3),
    "deploymentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "buildLogs" TEXT,
    "deployLogs" TEXT,
    "commitHash" TEXT,
    "commitMessage" TEXT,
    "buildTime" INTEGER,
    "buildSize" TEXT,
    "envVars" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "databases" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DatabaseType" NOT NULL,
    "status" "DatabaseStatus" NOT NULL DEFAULT 'CREATING',
    "connectionString" TEXT,
    "port" INTEGER,
    "memory" TEXT,
    "cpu" TEXT,
    "version" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "applicationId" TEXT NOT NULL,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "logs" (
    "id" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    "applicationId" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_metrics" (
    "id" TEXT NOT NULL,
    "type" "MetricType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "system_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "applications_domain_key" ON "applications"("domain");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
