-- AlterTable
ALTER TABLE "applications" ADD COLUMN "gitAccountId" TEXT;

-- AlterTable
ALTER TABLE "git_accounts" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "git_accounts" ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "applications_gitAccountId_idx" ON "applications"("gitAccountId");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_gitAccountId_fkey" FOREIGN KEY ("gitAccountId") REFERENCES "git_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
