-- AlterEnum
ALTER TYPE "AppType" ADD VALUE 'COMPOSE';

-- AlterTable
ALTER TABLE "servers" ADD COLUMN "containerRuntime" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN "runtimes" JSONB,
ADD COLUMN "disk" JSONB;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "composeFiles" TEXT[],
ADD COLUMN "composeEnvFiles" TEXT[],
ADD COLUMN "composePort" INTEGER,
ADD COLUMN "composeService" TEXT;
