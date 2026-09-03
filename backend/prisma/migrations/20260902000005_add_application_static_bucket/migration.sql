-- Static sites served from Cloudflare R2
ALTER TABLE "applications" ADD COLUMN "staticBucket" TEXT;
ALTER TABLE "applications" ADD COLUMN "staticOrigin" TEXT;
