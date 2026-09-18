-- Prisma 7's db push rejects --skip-generate; drop it from the saved pre-deploy commands
UPDATE "applications"
SET "preDeployCommand" = REPLACE("preDeployCommand", 'prisma db push --skip-generate', 'prisma db push')
WHERE "preDeployCommand" LIKE '%prisma db push --skip-generate%';
