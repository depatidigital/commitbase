import { useState, type ReactNode } from "react";
import { Database } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import type { StartOptions } from "@/lib/applications";
import { t } from "@/lib/i18n";

type MigratingApp = { id: string; name: string; preDeployCommand?: string | null };

/**
 * One row per app with a pre-deploy step (its migrations): on by default,
 * unticked = that app's step is left out this once. Used in the deploy
 * confirmations (one app, or the whole project).
 */
export function MigrationChoices({ apps, skip, onChange }: { apps: MigratingApp[]; skip: Set<string>; onChange: (skip: Set<string>) => void }) {
  return (
    <div className="space-y-2">
      {apps.map((app) => (
        <label key={app.id} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
          <Checkbox
            checked={!skip.has(app.id)}
            onCheckedChange={(checked) => {
              const next = new Set(skip);
              if (checked === true) next.delete(app.id);
              else next.add(app.id);
              onChange(next);
            }}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium">
              <Database className="h-3.5 w-3.5" />
              {apps.length > 1 ? t("Migrate the database of {name}", { name: app.name }) : t("Migrate the database")}
            </span>
            <span className="block text-xs text-muted-foreground">{t("Runs the pre-deploy step before the build. Unticked, the code goes live on the schema as it is.")}</span>
            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{app.preDeployCommand}</code>
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * A deploy of apps with a pre-deploy step is asked first; apps without one
 * deploy straight away. `deploy` is what buttons call; `dialog` is rendered
 * once. `run` gets the ids whose step is to be left out.
 */
export function useMigrationsConfirm(
  title: string,
  apps: MigratingApp[],
  run: (skipFor: string[]) => void,
): { deploy: () => void; dialog: ReactNode } {
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const migrating = apps.filter((app) => app.preDeployCommand);

  const deploy = () => {
    if (migrating.length === 0) return run([]);
    setSkip(new Set());
    setOpen(true);
  };

  const dialog = (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{t("The new release builds beside the running one and takes over once it answers.")}</AlertDialogDescription>
        </AlertDialogHeader>
        <MigrationChoices apps={migrating} skip={skip} onChange={setSkip} />
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setOpen(false);
              run([...skip]);
            }}
          >
            {t("Deploy")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { deploy, dialog };
}

/** The one-app form: a deploy a failure's fix already shaped (reset, resolve, skip) is not asked again. */
export function useDeployConfirm(
  app: MigratingApp | undefined,
  run: (options: StartOptions) => void,
): { deploy: (options?: StartOptions) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<StartOptions>({});
  const confirm = useMigrationsConfirm(t("Deploy {name}?", { name: app?.name ?? "" }), app ? [app] : [], (skipFor) =>
    run(skipFor.length > 0 ? { ...pending, skipPreDeploy: true } : pending),
  );
  const deploy = (options: StartOptions = {}) => {
    if (options.skipPreDeploy || options.resetDatabase || options.resolveMigration || options.acceptDataLoss) return run(options);
    setPending(options);
    confirm.deploy();
  };
  return { deploy, dialog: confirm.dialog };
}
