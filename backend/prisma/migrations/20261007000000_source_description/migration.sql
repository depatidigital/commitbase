-- a source's label is its description; renamed, not dropped, so names people gave stay
ALTER TABLE "sources" RENAME COLUMN "name" TO "description";
