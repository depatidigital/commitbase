/**
 * Self-check for .env paste parsing: npx tsx src/lib/env.check.ts
 */
import assert from "node:assert";
import { parseEnv, rowsToEnv, mergeRows, isSecret } from "./env";

const NL = "\n";
const pasted = [
  "# database",
  "DATABASE_URL=",
  'export AUTH_SECRET="s3cr=t"',
  "PORT=3000 # default",
  "GREETING='hello # not a comment'",
  'MULTI="line1\\nline2"',
  "URL=postgres://u:p@h:5432/db?sslmode=require",
  "bad-key=x",
  "",
].join("\r\n");

assert.deepStrictEqual(parseEnv(pasted), [
  { key: "DATABASE_URL", value: "" },
  { key: "AUTH_SECRET", value: "s3cr=t" },
  { key: "PORT", value: "3000" },
  { key: "GREETING", value: "hello # not a comment" },
  { key: "MULTI", value: "line1" + NL + "line2" },
  { key: "URL", value: "postgres://u:p@h:5432/db?sslmode=require" },
]);

// the old textarea kept these quotes literally — the bug this replaces
assert.deepStrictEqual(rowsToEnv(parseEnv('DATABASE_URL="postgres://x"')), { DATABASE_URL: "postgres://x" });

// a prefill adds missing keys, never clobbers typed values
const typed = [{ key: "DATABASE_URL", value: "postgres://typed" }];
assert.deepStrictEqual(mergeRows(typed, [{ key: "DATABASE_URL", value: "" }, { key: "PORT", value: "3000" }]), [
  { key: "DATABASE_URL", value: "postgres://typed" },
  { key: "PORT", value: "3000" },
]);
// a paste the user makes does overwrite
assert.deepStrictEqual(mergeRows(typed, [{ key: "DATABASE_URL", value: "new" }], true), [{ key: "DATABASE_URL", value: "new" }]);

// masked: secret-sounding names, and URLs that carry a password; public prefixes never
for (const key of ["BETTER_AUTH_SECRET", "STRIPE_SECRET_KEY", "API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "SMTP_PASS", "JWT_PRIVATE"]) {
  assert.ok(isSecret(key), `${key} should be masked`);
}
assert.ok(isSecret("DATABASE_URL", "postgresql://postgres:s3cret@db:5432/app"));
assert.ok(!isSecret("DATABASE_URL", ""), "an empty URL has nothing to hide");
assert.ok(!isSecret("DATABASE_URL", "postgresql://localhost:5432/app"), "no password in it");
for (const key of ["NEXT_PUBLIC_BASE_URL", "NEXT_PUBLIC_STRIPE_KEY", "VITE_API_KEY", "PORT", "NODE_ENV", "APP_URL"]) {
  assert.ok(!isSecret(key, "x"), `${key} should be plain`);
}

console.log("env: ok");
