-- Email Watcher fields read one part of an email: the subject, the body or the sender.
-- Fields saved before that (no source, or the mixed "all") read the body from now on.
UPDATE "email_rules" SET "fields" = (
  SELECT COALESCE(jsonb_agg(
    CASE WHEN f->>'source' IN ('subject', 'body', 'from') THEN f ELSE f || '{"source": "body"}'::jsonb END
  ), '[]'::jsonb)
  FROM jsonb_array_elements("fields") AS f
)
WHERE jsonb_typeof("fields") = 'array' AND jsonb_array_length("fields") > 0;
