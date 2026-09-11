// Every t("…") key in src must have an Indonesian entry in src/locales/id/*.ts.
// Usage: node scripts/check-i18n.mjs [file ...]   (no args: all of src)
// ponytail: regex over source, not a TS parser — catches literal keys only,
// which is all t() should ever be given.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(tsx?|mjs)$/.test(name) ? [path] : [];
  });

const unquote = (quote, body) => (quote === '"' ? JSON.parse(`"${body}"`) : body.replace(/\\(.)/g, "$1"));

const keys = new Set();
for (const file of walk("src/locales/id")) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^\s*(?:(["'])((?:\\.|(?!\1).)*)\1|([A-Za-z_$][\w$]*))\s*:/gm)) {
    keys.add(m[3] ?? unquote(m[1], m[2]));
  }
}

const files = process.argv.length > 2 ? process.argv.slice(2) : walk("src").filter((f) => !f.includes("locales") && !f.endsWith("i18n.ts"));
let missing = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
    const key = unquote(m[1], m[2]);
    if (!keys.has(key)) {
      missing++;
      console.log(`${file}: ${JSON.stringify(key)}`);
    }
  }
  if (/\bt\(\s*`/.test(text)) console.log(`${file}: t() called with a template literal — use t("… {name} …", { name })`);
}

console.log(missing ? `\n${missing} key(s) with no Indonesian entry` : "i18n: every key has an Indonesian entry");
process.exit(missing ? 1 : 0);
