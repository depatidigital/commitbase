-- A binding that answers with a redirect to another of its app's names instead of serving the app
ALTER TABLE "app_domains" ADD COLUMN "redirectTo" TEXT;
