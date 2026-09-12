-- The deploy that produced each release, so the history is one row per version
ALTER TABLE "releases" ADD COLUMN "deploymentId" TEXT;
