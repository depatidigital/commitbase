-- One wallet per user — the billing user (payer) of their workspaces — instead of one per
-- workspace. Balances, entries and top-ups move to each workspace's payer; money in (top-ups,
-- gifts, welcome credit, adjustments) stops pointing at a workspace. The AI accounts restart
-- per payer (the AI gateway was never live, so nothing is lost there).

-- Who pays each workspace: its billing user while still an OWNER, else its longest-standing OWNER.
CREATE TEMP TABLE org_payer AS
SELECT o.id AS org_id, COALESCE(
  (SELECT m."userId" FROM memberships m WHERE m."organizationId" = o.id AND m.role = 'OWNER' AND m."userId" = o."billingUserId" LIMIT 1),
  (SELECT m."userId" FROM memberships m WHERE m."organizationId" = o.id AND m.role = 'OWNER' ORDER BY m."createdAt" LIMIT 1)
) AS user_id
FROM organizations o;

-- ── Wallets: one per payer, the sum of their workspaces' ──
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_organizationId_fkey";
CREATE TABLE "wallets_new" (
    "userId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "arusniagaContactId" TEXT,
    "balanceNotice" TEXT,
    "balanceNoticeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL
);
INSERT INTO "wallets_new" ("userId", "balance", "arusniagaContactId", "updatedAt")
SELECT p.user_id, SUM(w."balance"), MIN(w."arusniagaContactId"), MAX(w."updatedAt")
FROM "wallets" w JOIN org_payer p ON p.org_id = w."organizationId"
WHERE p.user_id IS NOT NULL
GROUP BY p.user_id;
DROP TABLE "wallets";
ALTER TABLE "wallets_new" RENAME TO "wallets";
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("userId");
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Entries: whose wallet; the workspace only for what was spent on it ──
ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_organizationId_fkey";
ALTER TABLE "wallet_entries" ADD COLUMN "userId" TEXT;
UPDATE "wallet_entries" e SET "userId" = p.user_id FROM org_payer p WHERE p.org_id = e."organizationId";
-- a workspace with no OWNER had no one to hold its money: its entries went with no wallet above
DELETE FROM "wallet_entries" WHERE "userId" IS NULL;
ALTER TABLE "wallet_entries" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "wallet_entries" ALTER COLUMN "organizationId" DROP NOT NULL;
UPDATE "wallet_entries" SET "organizationId" = NULL WHERE "kind" IN ('TOPUP', 'GIFT', 'WELCOME', 'ADJUST');
CREATE INDEX "wallet_entries_userId_createdAt_idx" ON "wallet_entries"("userId", "createdAt");
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Top-ups: the payer's; the workspace kept as where it was made from ──
ALTER TABLE "top_ups" DROP CONSTRAINT "top_ups_organizationId_fkey";
DROP INDEX "top_ups_organizationId_createdAt_idx";
ALTER TABLE "top_ups" ADD COLUMN "userId" TEXT;
UPDATE "top_ups" t SET "userId" = p.user_id FROM org_payer p WHERE p.org_id = t."organizationId";
DELETE FROM "top_ups" WHERE "userId" IS NULL;
ALTER TABLE "top_ups" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "top_ups" ALTER COLUMN "organizationId" DROP NOT NULL;
CREATE INDEX "top_ups_userId_createdAt_idx" ON "top_ups"("userId", "createdAt");
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "top_ups" ADD CONSTRAINT "top_ups_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Balance warnings: per wallet now ──
ALTER TABLE "organizations" DROP COLUMN "balanceNotice", DROP COLUMN "balanceNoticeAt";

-- ── AI: one gateway account per payer; each key mapped to its workspace ──
DROP TABLE "ai_accounts";
CREATE TABLE "ai_accounts" (
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "billedSpent" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_accounts_pkey" PRIMARY KEY ("userId")
);
CREATE UNIQUE INDEX "ai_accounts_accountId_key" ON "ai_accounts"("accountId");
ALTER TABLE "ai_accounts" ADD CONSTRAINT "ai_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ai_keys" (
    "keyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_keys_pkey" PRIMARY KEY ("keyId")
);
CREATE INDEX "ai_keys_organizationId_idx" ON "ai_keys"("organizationId");
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP TABLE org_payer;
