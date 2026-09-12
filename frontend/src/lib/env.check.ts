/**
 * Self-check for .env paste parsing: npx tsx src/lib/env.check.ts
 */
import assert from "node:assert";
import { parseEnv, rowsToEnv, mergeRows, isSecret, parseDatabaseUrl, pointsAtLocalhost, suggestAppUrl } from "./env";

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

// masked: secret-sounding names only; public prefixes and URLs never
for (const key of ["BETTER_AUTH_SECRET", "STRIPE_SECRET_KEY", "API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "SMTP_PASS", "JWT_PRIVATE"]) {
  assert.ok(isSecret(key), `${key} should be masked`);
}
for (const key of ["DATABASE_URL", "NEXT_PUBLIC_BASE_URL", "NEXT_PUBLIC_STRIPE_KEY", "VITE_API_KEY", "PORT", "NODE_ENV", "APP_URL"]) {
  assert.ok(!isSecret(key), `${key} should be plain`);
}

// DATABASE_URL prefills the database form: engine from the scheme, name from the path
assert.deepStrictEqual(parseDatabaseUrl("postgresql://postgres:postgres@localhost:5432/umojati?schema=public"), {
  engine: "POSTGRESQL",
  name: "umojati",
});
assert.deepStrictEqual(parseDatabaseUrl("postgres://u:p@h/app"), { engine: "POSTGRESQL", name: "app" });
assert.deepStrictEqual(parseDatabaseUrl("mysql://root@127.0.0.1:3306/My-Shop"), { engine: "MYSQL", name: "my_shop" });
assert.deepStrictEqual(parseDatabaseUrl("postgresql://localhost:5432"), { engine: "POSTGRESQL", name: undefined });
assert.deepStrictEqual(parseDatabaseUrl(""), {});
assert.deepStrictEqual(parseDatabaseUrl("not a url"), {});

// localhost values get a warning: on the node they point at the node
for (const value of [
  "postgresql://postgres:postgres@localhost:5432/umojati?schema=public",
  "http://localhost:3000",
  "localhost",
  "redis://127.0.0.1:6379",
  "http://0.0.0.0:8080/api",
  "http://[::1]:3000",
  "mysql://root@LOCALHOST/db",
]) {
  assert.ok(pointsAtLocalhost(value), `${value} is local`);
}
for (const value of ["postgresql://u:p@db.depatidigital.com:5432/app", "https://mylocalhost.dev", "http://localhost.example.com", "3000", ""]) {
  assert.ok(!pointsAtLocalhost(value), `${value} is not local`);
}

// the app's own URL is offered for its URL variables — empty or still local
const domain = "umojati.desahebat.id";
assert.strictEqual(suggestAppUrl("NEXT_PUBLIC_BASE_URL", "http://localhost:3000", domain), "https://umojati.desahebat.id");
assert.strictEqual(suggestAppUrl("BETTER_AUTH_URL", "", domain), "https://umojati.desahebat.id");
assert.strictEqual(suggestAppUrl("NEXTAUTH_URL", "http://127.0.0.1:3000/api/auth/", domain), "https://umojati.desahebat.id/api/auth");
assert.strictEqual(suggestAppUrl("APP_ORIGIN", "http://localhost:5173?x=1", domain), "https://umojati.desahebat.id?x=1");
// already real, another service, or not a URL variable: nothing
assert.strictEqual(suggestAppUrl("NEXT_PUBLIC_BASE_URL", "https://umojati.desahebat.id", domain), null);
assert.strictEqual(suggestAppUrl("DATABASE_URL", "postgresql://u:p@localhost/db", domain), null);
assert.strictEqual(suggestAppUrl("REDIS_URL", "", domain), null);
assert.strictEqual(suggestAppUrl("NEXT_PUBLIC_API_URL", "http://localhost:4000", domain), null);
assert.strictEqual(suggestAppUrl("PORT", "", domain), null);

console.log("env: ok");
