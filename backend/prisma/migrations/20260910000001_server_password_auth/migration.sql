-- AlterTable: a node can authenticate with a key (default, unchanged) or a password.
ALTER TABLE "servers" ADD COLUMN "authMethod" TEXT NOT NULL DEFAULT 'KEY';
ALTER TABLE "servers" ADD COLUMN "sshPassword" TEXT;
ALTER TABLE "servers" ALTER COLUMN "sshKeyPath" DROP NOT NULL;

-- Free-form labels for grouping nodes.
ALTER TABLE "servers" ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
