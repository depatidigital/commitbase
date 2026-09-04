-- Docker runtime removed: releases are the sources tree on disk, not an image.
ALTER TABLE "releases" ALTER COLUMN "imageTag" DROP NOT NULL;
