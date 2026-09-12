-- Install command override and a pre-deploy step (migrations) per application
ALTER TABLE "applications" ADD COLUMN "installCommand" TEXT;
ALTER TABLE "applications" ADD COLUMN "preDeployCommand" TEXT;
