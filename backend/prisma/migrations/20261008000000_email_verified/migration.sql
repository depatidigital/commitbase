-- accounts from before verification existed count as verified
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
UPDATE "users" SET "emailVerifiedAt" = "createdAt";
