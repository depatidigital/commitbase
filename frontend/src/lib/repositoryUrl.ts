/**
 * A typed repository address, with or without its scheme — git@host:owner/repo,
 * https://host/owner/repo, or just host/owner/repo — as the URL to clone and its
 * owner/repo to show. null until it names a repository (a host alone does not).
 */
export function parseRepository(input: string): { url: string; name: string } | null {
  const raw = input.trim();
  if (/[\s'"]/.test(raw)) return null;
  const scp = /^[^@/:]+@([^:/]+\.[^:/]+):(.+)$/.exec(raw);
  const web = /^(?:(?:https?|ssh):\/\/)?(?:[^@/]+@)?([^/]+\.[^/]+)\/(.+)$/.exec(raw);
  const path = (scp ?? web)?.[2].replace(/\/+$/, "").replace(/\.git$/, "");
  if (!path?.includes("/")) return null;
  return { url: scp || /^[a-z]+:\/\//.test(raw) ? raw : `https://${raw}`, name: path };
}
