import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Database as DatabaseIcon, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EnvEditor } from "@/components/EnvEditor";
import { DatabaseDialog } from "@/components/DatabaseDialog";
import { testDatabaseUrl } from "@/lib/databases";
import { useToast } from "@/hooks/use-toast";
import { Application, DetectedProject, getApplication, hasBeenDeployed, updateApplication } from "@/lib/applications";
import {
  DATABASE_KEYS,
  PLATFORM_KEYS,
  generateSecret,
  mergeRows,
  parseDatabaseUrl,
  pointsAtLocalhost,
  requiredKeys,
  rowsToEnv,
  suggestAppUrl,
  type EnvRow,
} from "@/lib/env";
import { t } from "@/lib/i18n";

const toRows = (env?: Record<string, string>): EnvRow[] =>
  Object.entries(env ?? {}).map(([key, value]) => ({ key, value }));

/**
 * How the form stands right now — what the setup checklist shows, saved or not.
 * `warnings`: filled but likely wrong on the server (localhost, a PORT the platform ignores).
 */
export type EnvStatus = { missing: string[]; warnings: string[]; dirty: boolean };

interface AppEnvironmentProps {
  application: Application;
  detected?: DetectedProject | null;
  onStatus?: (status: EnvStatus) => void;
}

/**
 * An app's env vars: the saved ones, plus the keys its code expects (from
 * .env.example, and DATABASE_URL when it uses an ORM) as empty rows to fill.
 * A database connects through its own dialog so its URL never passes here.
 */
export function AppEnvironment({ application, detected, onStatus }: AppEnvironmentProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const saved = application.envVars ?? {};
  const required = useMemo(() => requiredKeys(detected), [detected]);
  // every name the code expects, with or without a default
  const locked = useMemo(
    () => new Set([...(detected?.env.example?.vars ?? []).map((v) => v.key), ...required]),
    [detected, required],
  );

  // the saved env, then every expected key it lacks — with the example's default when there is
  // one. PORT/HOST/NODE_ENV are left out: the platform sets them.
  const initial = useMemo(() => {
    const expected: EnvRow[] = [
      ...(detected?.env.example?.vars ?? []).filter((v) => !(v.key in PLATFORM_KEYS)),
      ...(detected?.env.needsDatabase ? [{ key: "DATABASE_URL", value: "" }] : []),
    ];
    return mergeRows(toRows(saved), expected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(saved), detected]);

  const [rows, setRows] = useState<EnvRow[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  // A refetch (a database connected, another tab saved) resets only an untouched
  // form — on a change of what is saved, never on the form turning clean: right
  // after a save the page may still hold the old env, and resetting to it then
  // would show the saved values reverted.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setRows(initial);
  }, [initial]);

  // counted from what is on screen, not what is saved: a value just typed is no longer "empty"
  const missing = useMemo(
    () => [...required].filter((key) => !rows.find((row) => row.key === key)?.value.trim()),
    [required, rows],
  );
  // a database URL can be tried from the app's node (verify below) — whether
  // localhost works there is for that test to say, not for its text
  const isDatabaseUrl = (row: EnvRow) => !!parseDatabaseUrl(row.value).engine;
  const warnings = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            row.value.trim() &&
            ((pointsAtLocalhost(row.value) && !isDatabaseUrl(row)) || PLATFORM_KEYS[row.key] === "ignored"),
        )
        .map((row) => row.key),
    [rows],
  );
  useEffect(() => {
    onStatus?.({ missing, warnings, dirty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.join(","), warnings.join(","), dirty]);

  // the database variables this app reads; "Connect database" fills them all
  const databaseKeys = rows.map((row) => row.key).filter((key) => DATABASE_KEYS.has(key));
  // where the Connect button goes: DATABASE_URL, else the first of the others (Laravel's DB_HOST)
  const databaseAnchor = databaseKeys.includes("DATABASE_URL") ? "DATABASE_URL" : databaseKeys[0];

  const hints = useMemo(() => {
    const from: Record<string, string> = {};
    const file = detected?.env.example?.file;
    for (const { key } of detected?.env.example?.vars ?? []) from[key] = t("from {file}", { file: file ?? "" });
    if (detected?.env.needsDatabase && !from.DATABASE_URL) from.DATABASE_URL = t("the app uses a SQL database");
    for (const key of databaseKeys) if (key !== databaseAnchor) from[key] = t("filled by Connect database");
    return from;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, databaseKeys.join(","), databaseAnchor]);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await updateApplication(application.id, { envVars: rowsToEnv(rows) });
      // The page's copy of the app first, then mark the form clean: the other
      // way round, the form resets to the stale "saved" env for a render and
      // what was just saved appears to have reverted.
      queryClient.setQueryData<Application>(["application", application.id], (prev) =>
        prev ? { ...prev, envVars: updated.envVars ?? rowsToEnv(rows) } : prev,
      );
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      toast(
        hasBeenDeployed(application)
          ? { title: t("Environment saved"), description: t("Redeploy to apply it — build-time variables such as NEXT_PUBLIC_* are baked in.") }
          : { title: t("Environment saved") },
      );
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not save"), description: error instanceof Error ? error.message : "" });
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="space-y-4">
      {!!detected?.env.committed.length && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("{files} is committed to the repository. It likely holds secrets — remove it from git, rotate what it contains, and set the values here instead.", {
            files: detected.env.committed.join(", "),
          })}
        </p>
      )}
      {!!detected?.env.production.length && (
        <p className="text-xs text-muted-foreground">
          {t("The repository's .env.production also sets {keys} at build time.", { keys: detected.env.production.join(", ") })}
        </p>
      )}

      <EnvEditor
        rows={rows}
        required={required}
        locked={locked}
        hints={hints}
        // the database is how DATABASE_URL gets its value — so it lives on that row
        renderAction={(row) =>
          row.key === databaseAnchor ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setDbOpen(true)} disabled={saving}>
              <DatabaseIcon className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">{row.value ? t("Change database") : t("Connect database")}</span>
            </Button>
          ) : null
        }
        // the app's own https URL for NEXT_PUBLIC_BASE_URL and friends
        suggest={(row) => suggestAppUrl(row.key, row.value, application.domain)}
        // a fresh secret for the ones the app mints itself (BETTER_AUTH_SECRET, APP_KEY…)
        generate={(row) => (row.value ? null : generateSecret(row.key))}
        // tried from the node the app runs on, with the value as typed
        verify={(row) => (isDatabaseUrl(row) ? () => testDatabaseUrl(application.id, row.key, row.value) : null)}
        disabled={saving}
        onChange={(next) => {
          setRows(next);
          setDirty(true);
        }}
      />

      <div className="flex items-center justify-end gap-2">
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => { setRows(initial); setDirty(false); }} disabled={saving}>
            {t("Reset")}
          </Button>
        )}
        <Button type="button" onClick={save} disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {t("Save environment")}
        </Button>
      </div>

      <DatabaseDialog
        open={dbOpen}
        onOpenChange={setDbOpen}
        application={application}
        currentUrl={rows.find((row) => row.key === "DATABASE_URL")?.value}
        alsoKeys={databaseKeys.filter((key) => key !== "DATABASE_URL")}
        onConnected={async (keys) => {
          // already saved server-side; put them in the rows too, keeping any unsaved
          // edits — otherwise the next Save would write the old values back over them
          const fresh = await getApplication(application.id).catch(() => null);
          const filled = keys.flatMap((key) => (fresh?.envVars?.[key] ? [{ key, value: fresh.envVars[key] }] : []));
          if (filled.length) setRows((prev) => mergeRows(prev, filled, true));
          await queryClient.invalidateQueries({ queryKey: ["application", application.id] });
        }}
      />
    </div>
  );
}
