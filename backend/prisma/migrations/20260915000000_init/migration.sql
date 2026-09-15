-- CreateEnum
CREATE TYPE "ProvisionState" AS ENUM ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "DbServerMode" AS ENUM ('TUNNEL', 'DIRECT');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPERADMIN', 'ADMIN', 'USER', 'CLIENT');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "AppType" AS ENUM ('NODEJS', 'STATIC', 'PYTHON', 'GO', 'RUST', 'PHP', 'JAVA');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('RUNNING', 'STOPPED', 'ERROR', 'DEPLOYING', 'BUILDING');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "DatabaseType" AS ENUM ('POSTGRESQL', 'MYSQL', 'MONGODB', 'REDIS', 'SQLITE');

-- CreateEnum
CREATE TYPE "DatabaseStatus" AS ENUM ('CREATING', 'RUNNING', 'STOPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING', 'ERROR');

-- CreateEnum
CREATE TYPE "SSLStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'ERROR');

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
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "serverId" TEXT,
    "uid" INTEGER,
    "postgresServerId" TEXT,
    "mysqlServerId" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_nodes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "state" "ProvisionState" NOT NULL DEFAULT 'NONE',
    "error" TEXT,
    "log" TEXT,
    "job" JSONB,
    "provisionedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "sshUser" TEXT NOT NULL DEFAULT 'larika',
    "sshPort" INTEGER NOT NULL DEFAULT 22,
    "authMethod" TEXT NOT NULL DEFAULT 'KEY',
    "sshKeyPath" TEXT,
    "sshPassword" TEXT,
    "publicIp" TEXT NOT NULL,
    "tags" TEXT[],
    "caddyApiUrl" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "provisioned" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "setupState" "ProvisionState" NOT NULL DEFAULT 'NONE',
    "setupError" TEXT,
    "setupJob" JSONB,
    "setupLog" TEXT,
    "setupAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "engine" "DatabaseType" NOT NULL,
    "mode" "DbServerMode" NOT NULL DEFAULT 'TUNNEL',
    "serverId" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "tlsMode" TEXT NOT NULL DEFAULT 'REQUIRE',
    "caCert" TEXT,
    "adminUser" TEXT NOT NULL,
    "adminPasswordEnc" TEXT NOT NULL,
    "appHost" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "version" TEXT,
    "adminRights" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_database_accounts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "databaseServerId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),

    CONSTRAINT "org_database_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_grants" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_users" (
    "id" TEXT NOT NULL,
    "databaseServerId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "host" TEXT NOT NULL DEFAULT '',
    "canLogin" BOOLEAN NOT NULL DEFAULT true,
    "superuser" BOOLEAN NOT NULL DEFAULT false,
    "databases" TEXT[],
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "invitedById" TEXT,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serve" JSONB,
    "type" "AppType" NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'STOPPED',
    "port" INTEGER,
    "memory" TEXT,
    "cpu" TEXT,
    "uptime" TEXT,
    "sourceId" TEXT,
    "rootDirectory" TEXT,
    "repository" TEXT,
    "branch" TEXT DEFAULT 'main',
    "domain" TEXT,
    "domainId" TEXT,
    "installCommand" TEXT,
    "buildCommand" TEXT,
    "preDeployCommand" TEXT,
    "startCommand" TEXT,
    "envVars" JSONB,
    "staticBucket" TEXT,
    "staticOrigin" TEXT,
    "lastDeployment" TIMESTAMP(3),
    "deploymentCount" INTEGER NOT NULL DEFAULT 0,
    "runtime" TEXT,
    "processName" TEXT,
    "rootPath" TEXT,
    "configPath" TEXT,
    "routing" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "gitAccountId" TEXT,
    "activeReleaseId" TEXT,
    "serverId" TEXT,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_domains" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "stripPrefix" BOOLEAN NOT NULL DEFAULT false,
    "applicationId" TEXT NOT NULL,
    "domainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "organizationId" TEXT,
    "serverId" TEXT,
    "path" TEXT,
    "repository" TEXT,
    "branch" TEXT DEFAULT 'main',
    "gitAccountId" TEXT,
    "activeReleaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
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
    "sourceId" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "releases" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT,
    "applicationId" TEXT,
    "imageTag" TEXT,
    "commitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ReleaseStatus" NOT NULL DEFAULT 'PENDING',
    "containerId" TEXT,
    "ports" JSONB,
    "health" TEXT,
    "logsRef" TEXT,
    "path" TEXT,
    "deploymentId" TEXT,
    "buildKey" TEXT,

    CONSTRAINT "releases_pkey" PRIMARY KEY ("id")
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
    "applicationId" TEXT,
    "organizationId" TEXT,
    "databaseServerId" TEXT,
    "dbName" TEXT,
    "discovered" BOOLEAN NOT NULL DEFAULT false,
    "sizeBytes" DOUBLE PRECISION,
    "lastError" TEXT,
    "ownerRole" TEXT,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_imports" (
    "id" TEXT NOT NULL,
    "databaseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" DOUBLE PRECISION NOT NULL,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "statements" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "database_imports_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'ACTIVE',
    "dnsRecords" JSONB,
    "sslStatus" "SSLStatus" NOT NULL DEFAULT 'PENDING',
    "sslExpiry" TIMESTAMP(3),
    "redirectTo" TEXT,
    "customConfig" JSONB,
    "registrar" TEXT,
    "cfZoneId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "integration_configs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_accounts" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "git_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "heartbeats" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "responseMs" INTEGER,
    "httpStatus" INTEGER,
    "error" TEXT,

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caddy_snapshots" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "hosts" TEXT[],
    "reason" TEXT,
    "checkpoint" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "caddy_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_uid_key" ON "organizations"("uid");

-- CreateIndex
CREATE INDEX "organizations_serverId_idx" ON "organizations"("serverId");

-- CreateIndex
CREATE INDEX "org_nodes_state_idx" ON "org_nodes"("state");

-- CreateIndex
CREATE UNIQUE INDEX "org_nodes_organizationId_serverId_key" ON "org_nodes"("organizationId", "serverId");

-- CreateIndex
CREATE INDEX "database_servers_serverId_idx" ON "database_servers"("serverId");

-- CreateIndex
CREATE INDEX "org_database_accounts_organizationId_databaseServerId_idx" ON "org_database_accounts"("organizationId", "databaseServerId");

-- CreateIndex
CREATE UNIQUE INDEX "org_database_accounts_databaseServerId_username_key" ON "org_database_accounts"("databaseServerId", "username");

-- CreateIndex
CREATE INDEX "database_grants_accountId_idx" ON "database_grants"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "database_grants_databaseId_accountId_key" ON "database_grants"("databaseId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "database_users_databaseServerId_username_host_key" ON "database_users"("databaseServerId", "username", "host");

-- CreateIndex
CREATE INDEX "memberships_organizationId_idx" ON "memberships"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_userId_organizationId_key" ON "memberships"("userId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "invites_tokenHash_key" ON "invites"("tokenHash");

-- CreateIndex
CREATE INDEX "invites_organizationId_idx" ON "invites"("organizationId");

-- CreateIndex
CREATE INDEX "invites_email_idx" ON "invites"("email");

-- CreateIndex
CREATE UNIQUE INDEX "applications_domain_key" ON "applications"("domain");

-- CreateIndex
CREATE INDEX "applications_userId_idx" ON "applications"("userId");

-- CreateIndex
CREATE INDEX "applications_domainId_idx" ON "applications"("domainId");

-- CreateIndex
CREATE INDEX "applications_gitAccountId_idx" ON "applications"("gitAccountId");

-- CreateIndex
CREATE INDEX "applications_organizationId_idx" ON "applications"("organizationId");

-- CreateIndex
CREATE INDEX "applications_sourceId_idx" ON "applications"("sourceId");

-- CreateIndex
CREATE INDEX "app_domains_applicationId_idx" ON "app_domains"("applicationId");

-- CreateIndex
CREATE INDEX "app_domains_domainId_idx" ON "app_domains"("domainId");

-- CreateIndex
CREATE UNIQUE INDEX "app_domains_host_path_key" ON "app_domains"("host", "path");

-- CreateIndex
CREATE INDEX "sources_gitAccountId_idx" ON "sources"("gitAccountId");

-- CreateIndex
CREATE INDEX "sources_organizationId_idx" ON "sources"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "sources_serverId_path_key" ON "sources"("serverId", "path");

-- CreateIndex
CREATE INDEX "deployments_sourceId_idx" ON "deployments"("sourceId");

-- CreateIndex
CREATE INDEX "releases_sourceId_idx" ON "releases"("sourceId");

-- CreateIndex
CREATE INDEX "databases_organizationId_idx" ON "databases"("organizationId");

-- CreateIndex
CREATE INDEX "databases_databaseServerId_idx" ON "databases"("databaseServerId");

-- CreateIndex
CREATE UNIQUE INDEX "databases_databaseServerId_dbName_key" ON "databases"("databaseServerId", "dbName");

-- CreateIndex
CREATE INDEX "database_imports_databaseId_createdAt_idx" ON "database_imports"("databaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "domains_name_key" ON "domains"("name");

-- CreateIndex
CREATE INDEX "domains_userId_idx" ON "domains"("userId");

-- CreateIndex
CREATE INDEX "domains_organizationId_idx" ON "domains"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_configs_provider_key_key" ON "integration_configs"("provider", "key");

-- CreateIndex
CREATE UNIQUE INDEX "git_accounts_userId_provider_externalId_key" ON "git_accounts"("userId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "heartbeats_targetType_targetId_at_idx" ON "heartbeats"("targetType", "targetId", "at");

-- CreateIndex
CREATE INDEX "caddy_snapshots_serverId_createdAt_idx" ON "caddy_snapshots"("serverId", "createdAt");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_postgresServerId_fkey" FOREIGN KEY ("postgresServerId") REFERENCES "database_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_mysqlServerId_fkey" FOREIGN KEY ("mysqlServerId") REFERENCES "database_servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_nodes" ADD CONSTRAINT "org_nodes_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_servers" ADD CONSTRAINT "database_servers_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_database_accounts" ADD CONSTRAINT "org_database_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_database_accounts" ADD CONSTRAINT "org_database_accounts_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_grants" ADD CONSTRAINT "database_grants_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_grants" ADD CONSTRAINT "database_grants_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "org_database_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_users" ADD CONSTRAINT "database_users_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_gitAccountId_fkey" FOREIGN KEY ("gitAccountId") REFERENCES "git_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_activeReleaseId_fkey" FOREIGN KEY ("activeReleaseId") REFERENCES "releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_domains" ADD CONSTRAINT "app_domains_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_domains" ADD CONSTRAINT "app_domains_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_gitAccountId_fkey" FOREIGN KEY ("gitAccountId") REFERENCES "git_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_activeReleaseId_fkey" FOREIGN KEY ("activeReleaseId") REFERENCES "releases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "releases" ADD CONSTRAINT "releases_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_databaseServerId_fkey" FOREIGN KEY ("databaseServerId") REFERENCES "database_servers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_imports" ADD CONSTRAINT "database_imports_databaseId_fkey" FOREIGN KEY ("databaseId") REFERENCES "databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_imports" ADD CONSTRAINT "database_imports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs" ADD CONSTRAINT "logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_accounts" ADD CONSTRAINT "git_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

