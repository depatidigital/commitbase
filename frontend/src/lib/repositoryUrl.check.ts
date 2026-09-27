/**
 * Self-check for typed repository addresses: npx tsx src/lib/repositoryUrl.check.ts
 */
import assert from "node:assert";
import { parseRepository as parse } from "./repositoryUrl";

// not a repository yet: a host alone, or an owner without a repo
assert.equal(parse("git.com"), null);
assert.equal(parse("github.com/owner"), null);
assert.equal(parse("owner/repo"), null);
// no scheme: https assumed
assert.deepEqual(parse("github.com/owner/repo"), { url: "https://github.com/owner/repo", name: "owner/repo" });
// as typed, the name without .git or a trailing slash
assert.deepEqual(parse("https://github.com/owner/repo.git/"), { url: "https://github.com/owner/repo.git/", name: "owner/repo" });
assert.deepEqual(parse("git@github.com:owner/repo.git"), { url: "git@github.com:owner/repo.git", name: "owner/repo" });
// GitLab subgroups
assert.deepEqual(parse("ssh://git@gitlab.com/g/sub/repo"), { url: "ssh://git@gitlab.com/g/sub/repo", name: "g/sub/repo" });

console.log("repositoryUrl: ok");
