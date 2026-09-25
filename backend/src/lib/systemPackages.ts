/**
 * What an app may ask its node to have installed (Application.systemPackages).
 * Keys only — which apt packages each one is lives in runner/cb-app-unit.sh
 * (`packages`), so the panel can never name a package itself. Add a key in both.
 */
export const SYSTEM_PACKAGES = ['libreoffice'] as const;
export type SystemPackage = (typeof SYSTEM_PACKAGES)[number];

/** What names each one in an app's env — `LIBREOFFICE_PATH`, `SOFFICE_BIN=/usr/bin/soffice`. */
const MENTIONS: Record<SystemPackage, RegExp> = {
  libreoffice: /libre[_\s-]?office|soffice/i,
};

/**
 * The requirements an app's env points at, whether or not they are ticked:
 * an env var naming LibreOffice means the app calls it. Each with the first
 * env var that said so. Pure.
 */
export function detectSystemPackages(env: Record<string, string>): Array<{ key: SystemPackage; from: string }> {
  return SYSTEM_PACKAGES.flatMap((key) => {
    const from = Object.entries(env).find(([name, value]) => MENTIONS[key].test(name) || MENTIONS[key].test(value))?.[0];
    return from ? [{ key, from }] : [];
  });
}

/** The known keys of a request body's list, each once; null when it is not a list of them. Pure. */
export function readSystemPackages(raw: unknown): SystemPackage[] | null {
  if (!Array.isArray(raw) || !raw.every((key) => (SYSTEM_PACKAGES as readonly unknown[]).includes(key))) return null;
  return [...new Set(raw as SystemPackage[])];
}
