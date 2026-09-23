import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Database as DatabaseIcon, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EnvEditor } from "@/components/EnvEditor";
import { DatabaseDialog } from "@/components/DatabaseDialog";
import { DatabaseValue } from "@/components/DatabaseSource";
import { getAppDatabases, testDatabaseUrl } from "@/lib/databases";
import { getProject } from "@/lib/projects";
import { useToast } from "@/hooks/use-toast";
import { Application, DetectedProject, getApplication, hasBeenDeployed, hostsOf, updateApplication } from "@/lib/applications";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DATABASE_KEYS,
  databaseNameOf,
  envWarnings,
  expectedRows,
  generateSecret,
  mergeRows,
  parseDatabaseUrl,
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
  /** set to this form's save, so Deploy can take unsaved edits with it; resolves false when it failed */
  saveRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /** set to open the database dialog — the Database tab connects through this form so unsaved edits merge */
  connectDbRef?: React.MutableRefObject<(() => void) | null>;
}

/**
 * An app's env vars: the saved ones, plus the keys its code expects (from
 * .env.example, and DATABASE_URL when it uses an ORM) as empty rows to fill.
 * A database connects through its own dialog so its URL never passes here.
 */
export function AppEnvironment({ application, detected, onStatus, saveRef, connectDbRef }: AppEnvironmentProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const saved = application.envVars ?? {};
  const required = useMemo(() => requiredKeys(detected), [detected]);
  // every name the code expects, with or without a default
  const locked = useMemo(
    () => new Set([...(detected?.env.example?.vars ?? []).map((v) => v.key), ...required]),
    [detected, required],
  );

  // The saved env, then — until it is first saved — every expected key it lacks.
  // Once saved, what is in it is the app's choice: a key removed then (the app
  // does not use it) is not put back; it is offered below instead.
  const prefill = application.envConfirmed === false;
  const initial = useMemo(
    () => mergeRows(toRows(saved), prefill ? expectedRows(detected) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(saved), detected, prefill],
  );

  const [rows, setRows] = useState<EnvRow[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dbOpen, setDbOpen] = useState(false);
  // Save asked with something still empty or likely wrong: said before it is saved
  const [confirmSave, setConfirmSave] = useState(false);
  // DATABASE_URL is one of ours (shown by name — its URL carries the password) or a
  // URL of its own (shown by its host); either is chosen in the database dialog
  const { data: appDatabases } = useQuery({
    queryKey: ["databases", "application", application.id],
    queryFn: () => getAppDatabases(application.id),
  });
  // every host of the project's apps (its own too), offered on *_URL rows — the
  // frontend's VITE_API_URL is the API app's address. The project page's own query.
  const { data: project } = useQuery({
    queryKey: ["project", application.sourceId],
    queryFn: () => getProject(application.sourceId!),
    enabled: !!application.sourceId,
    staleTime: 60_000,
  });
  const urlOptions = useMemo(
    () => [
      ...new Set(
        (project?.applications ?? [{ domains: hostsOf(application).map((host) => ({ host, path: "" })) }])
          .flatMap((app) => app.domains)
          .filter((d) => !d.host.endsWith(".local"))
          // the host alone (an origin: CORS_ORIGIN, APP_URL), and under its path when it has one (an API base)
          .flatMap((d) => {
            const path = (d.path ?? "").replace(/\*+$/, "").replace(/\/+$/, "");
            return [`https://${d.host}`, ...(path ? [`https://${d.host}${path}`] : [])];
          }),
      ),
    ],
    [project, application],
  );
  // one of ours, by the database the URL names (databaseNameOf — not `new URL`, which some browsers misread)
  const managedDatabase = (url: string) => {
    const name = databaseNameOf(url);
    return name ? appDatabases?.find((db) => !db.discovered && db.dbName === name) : undefined;
  };
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
  // an expected key that was removed is not missing — the app said it does not use it
  // saved empty: kept that way on purpose (Save asked first, naming it) — some are
  // meant to be empty (S3_ROOT_DIR=""). Not missing; said as such on its row.
  const emptyOnPurpose = (key: string) => key in saved && saved[key] === "";
  const missing = useMemo(
    () => [...required].filter((key) => !emptyOnPurpose(key) && rows.some((row) => row.key === key && !row.value.trim())),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [required, rows, JSON.stringify(saved)],
  );
  // what .env.example (or the ORM) expects that is not in the env — removed, or new in the repo since
  const absent = useMemo(() => expectedRows(detected).filter((row) => !rows.some((r) => r.key === row.key)), [detected, rows]);
  // a database URL can be tried from the app's node (verify below) — whether
  // localhost works there is for that test to say, not for its text
  const isDatabaseUrl = (row: EnvRow) => !!parseDatabaseUrl(row.value).engine;
  const warnings = useMemo(() => envWarnings(rows), [rows]);
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
    // an expected key that was saved empty — on purpose, it was asked
    for (const key of required) if (emptyOnPurpose(key)) from[key] = t("Saved empty — on purpose");
    return from;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, databaseKeys.join(","), databaseAnchor, JSON.stringify(saved)]);

  // quiet: saved as part of a deploy, which says what happens next itself
  const save = async (quiet = false) => {
    setSaving(true);
    try {
      const updated = await updateApplication(application.id, { envVars: rowsToEnv(rows) });
      // The page's copy of the app first, then mark the form clean: the other
      // way round, the form resets to the stale "saved" env for a render and
      // what was just saved appears to have reverted.
      queryClient.setQueryData<Application>(["application", application.id], (prev) =>
        prev ? { ...prev, envVars: updated.envVars ?? rowsToEnv(rows), envConfirmed: true } : prev,
      );
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      // which database is "in use" follows the env
      void queryClient.invalidateQueries({ queryKey: ["databases", "application", application.id] });
      // the project page's cards and setup checklists read it too
      void queryClient.invalidateQueries({ queryKey: ["project"] });
      if (!quiet)
        toast(
          hasBeenDeployed(application)
            ? { title: t("Environment saved"), description: t("Redeploy to apply it — build-time variables such as NEXT_PUBLIC_* are baked in.") }
            : { title: t("Environment saved") },
        );
      return true;
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not save"), description: error instanceof Error ? error.message : "" });
      return false;
    } finally {
      setSaving(false);
    }
  };
  if (saveRef) saveRef.current = () => save(true);
  if (connectDbRef) connectDbRef.current = () => setDbOpen(true);


  return (
    // a flex column down to the table: in a dialog the table scrolls, the dialog does not
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {!!detected?.env.committed.length && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("{files} is committed to the repository. It likely holds secrets — remove it from git, rotate what it contains, and set the values here instead.", {
            files: detected.env.committed.join(", "),
          })}
        </p>
      )}
      {/* which files the deploy writes these into — a setup guide names each file apart */}
      {!application.staticBucket && (
        <p className="text-xs text-muted-foreground">
          {t("Written into {files} on every deploy — the same keys in each; the rest of what those files ship stays.", {
            files: (application.composeEnvFiles?.length ? application.composeEnvFiles : [".env"]).join(", "),
          })}
        </p>
      )}
      {!!detected?.env.production.length && (
        <p className="text-xs text-muted-foreground">
          {t("The repository's .env.production also sets {keys} at build time.", { keys: detected.env.production.join(", ") })}
        </p>
      )}

      {absent.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("In {file} but not set: {keys}", { file: detected?.env.example?.file ?? ".env.example", keys: absent.map((row) => row.key).join(", ") })}
          </span>
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
            disabled={saving}
            onClick={() => {
              setRows((prev) => mergeRows(prev, absent));
              setDirty(true);
            }}
          >
            {t("Add them")}
          </button>
        </p>
      )}

      <EnvEditor
        rows={rows}
        // only what is still to fill: a key saved empty on purpose is not flagged
        required={new Set(missing)}
        locked={locked}
        hints={hints}
        // an app without DATABASE_URL (Laravel's DB_*): its first database variable stays a field, the dialog beside it
        renderAction={(row) =>
          row.key === databaseAnchor && row.key !== "DATABASE_URL" ? (
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => setDbOpen(true)} disabled={saving}>
              <DatabaseIcon className="h-3.5 w-3.5 sm:mr-2" />
              <span className="hidden sm:inline">{t("Connect database")}</span>
            </Button>
          ) : null
        }
        // DATABASE_URL: what it is — one of ours by name, a custom URL by its host, or none — changed in the dialog only
        renderValue={(row) =>
          row.key === "DATABASE_URL" ? (
            <DatabaseValue value={row.value} dbName={managedDatabase(row.value)?.dbName} disabled={saving} onOpen={() => setDbOpen(true)} />
          ) : null
        }
        // the app's own https URL for NEXT_PUBLIC_BASE_URL and friends
        suggest={(row) => suggestAppUrl(row.key, row.value, hostsOf(application)[0] ?? '')}
        // a fresh secret for the ones the app mints itself (BETTER_AUTH_SECRET, APP_KEY…)
        generate={(row) => (row.value ? null : generateSecret(row.key))}
        // tried from the node the app runs on, with the value as typed
        verify={(row) => (isDatabaseUrl(row) ? () => testDatabaseUrl(application.id, row.key, row.value) : null)}
        urlOptions={urlOptions}
        disabled={saving}
        onChange={(next) => {
          setRows(next);
          setDirty(true);
        }}
      />

      {/* pinned to the dialog's bottom edge: Save is reachable without scrolling past a long env */}
      <div className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 border-t border-border/60 bg-background px-1 pt-3">
        {dirty && (
          <Button type="button" variant="ghost" onClick={() => { setRows(initial); setDirty(false); }} disabled={saving}>
            {t("Reset")}
          </Button>
        )}
        {/* never saved: saving it as it stands is the confirmation the setup checklist waits for.
            Anything still empty or likely wrong is said first — saved only once that was read */}
        <Button
          type="button"
          onClick={() => (missing.length || warnings.length ? setConfirmSave(true) : void save())}
          disabled={(!dirty && application.envConfirmed !== false) || saving}
        >
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
          {!dirty && application.envConfirmed === false ? t("Confirm environment") : t("Save environment")}
        </Button>
      </div>

      <AlertDialog open={confirmSave} onOpenChange={setConfirmSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Save with these left as they are?")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {missing.length > 0 && (
                  <p className="text-destructive">{t("{count} still empty: {keys}", { count: missing.length, keys: missing.join(", ") })}</p>
                )}
                {warnings.length > 0 && (
                  <p className="text-amber-600 dark:text-amber-400">
                    {t("{count} to check: {keys}", { count: warnings.length, keys: warnings.join(", ") })}
                  </p>
                )}
                <p>{t("The app may not work on the server with them. You can fix them later — they stay flagged on its checklist.")}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Fix them first")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmSave(false);
                void save();
              }}
            >
              {t("Save anyway")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
          await queryClient.invalidateQueries({ queryKey: ["databases", "application", application.id] });
        }}
        // a URL of its own: into the form, like anything typed — Save writes it
        onCustom={(url) => {
          setRows((prev) => mergeRows(prev, [{ key: "DATABASE_URL", value: url }], true));
          setDirty(true);
        }}
      />
    </div>
  );
}
