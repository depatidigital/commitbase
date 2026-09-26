-- launchDeploy's options, so a queued deploy starts again with them after a panel restart
ALTER TABLE "deployments" ADD COLUMN "options" JSONB;
