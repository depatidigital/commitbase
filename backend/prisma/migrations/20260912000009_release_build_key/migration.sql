-- What went into a release's build, so an unchanged redeploy reuses it
ALTER TABLE "releases" ADD COLUMN "buildKey" TEXT;
