-- CreateTable
CREATE TABLE "ai_accounts" (
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "billedSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_accounts_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "wallets" (
    "organizationId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "wallet_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "ref" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_accounts_accountId_key" ON "ai_accounts"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_entries_ref_key" ON "wallet_entries"("ref");

-- CreateIndex
CREATE INDEX "wallet_entries_organizationId_createdAt_idx" ON "wallet_entries"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

