-- Email Watcher rules: the three "contains" filters become a list of conditions, joined
-- by AND (all) or OR (any). Each non-empty filter becomes a condition on its field; a
-- value written between slashes (/…/) was a regular expression and becomes one.

ALTER TABLE "email_rules"
  ADD COLUMN "match" TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN "conditions" JSONB NOT NULL DEFAULT '[]';

UPDATE "email_rules" r SET "conditions" = COALESCE((
  SELECT jsonb_agg(
    CASE WHEN f.v ~ '^/.+/$'
      THEN jsonb_build_object('field', f.field, 'op', 'regex', 'value', substring(f.v FROM 2 FOR length(f.v) - 2))
      ELSE jsonb_build_object('field', f.field, 'op', 'contains', 'value', f.v)
    END ORDER BY f.ord)
  FROM (VALUES (1, 'from', r."fromContains"), (2, 'subject', r."subjectContains"), (3, 'body', r."bodyContains")) AS f(ord, field, v)
  WHERE f.v <> ''
), '[]'::jsonb);

ALTER TABLE "email_rules"
  DROP COLUMN "fromContains",
  DROP COLUMN "subjectContains",
  DROP COLUMN "bodyContains";
