-- What an app needs installed on its node (lib/systemPackages): deploy makes sure it is there
ALTER TABLE "applications" ADD COLUMN "systemPackages" TEXT[] DEFAULT ARRAY[]::TEXT[];
