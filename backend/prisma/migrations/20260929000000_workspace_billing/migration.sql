-- AlterTable
ALTER TABLE "organizations" ADD COLUMN "billingUserId" TEXT;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_billingUserId_fkey" FOREIGN KEY ("billingUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Who pays each workspace today: its longest-standing OWNER
UPDATE "organizations" o SET "billingUserId" = (
  SELECT m."userId" FROM "memberships" m
  WHERE m."organizationId" = o."id" AND m."role" = 'OWNER'
  ORDER BY m."createdAt" ASC LIMIT 1
);

-- Welcome credit, Rp 50,000 once per user: into the first workspace each one pays for
INSERT INTO "wallet_entries" ("id", "organizationId", "kind", "amount", "ref", "note", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, first."id", 'WELCOME', 50000000000, 'welcome:' || first."billingUserId", 'Welcome credit', now(), now()
FROM (
  SELECT DISTINCT ON ("billingUserId") "id", "billingUserId"
  FROM "organizations" WHERE "billingUserId" IS NOT NULL
  ORDER BY "billingUserId", "createdAt" ASC
) first
ON CONFLICT ("ref") DO NOTHING;

-- …and the balances they add to
INSERT INTO "wallets" ("organizationId", "balance", "updatedAt")
SELECT "organizationId", "amount", now() FROM "wallet_entries" WHERE "kind" = 'WELCOME'
ON CONFLICT ("organizationId") DO UPDATE SET "balance" = "wallets"."balance" + EXCLUDED."balance", "updatedAt" = now();
