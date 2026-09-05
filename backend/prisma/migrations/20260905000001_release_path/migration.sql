-- Each release is built into its own directory; rollback switches the current symlink to it.
ALTER TABLE "releases" ADD COLUMN "path" TEXT;
