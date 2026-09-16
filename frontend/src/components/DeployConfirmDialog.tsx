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

/**
 * A deploy of an app with a pre-deploy step (its migrations) is asked first:
 * the step is on by default and can be left out this once. An app without one
 * deploys straight away, and so does a deploy a failure's fix already shaped
 * (reset, resolve, skip). `deploy` is what buttons call; `dialog` is rendered once.
 */
export function useDeployConfirm(
  app: { name: string; preDeployCommand?: string | null } | undefined,
  run: (options: StartOptions) => void,
): { deploy: (options?: StartOptions) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<StartOptions | null>(null);
  const [migrate, setMigrate] = useState(true);

  const deploy = (options: StartOptions = {}) => {
    if (!app?.preDeployCommand || options.skipPreDeploy || options.resetDatabase || options.resolveMigration) return run(options);
    setMigrate(true);
    setPending(options);
  };

  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Deploy {name}?", { name: app?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{t("The new release builds beside the running one and takes over once it answers.")}</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
          <Checkbox checked={migrate} onCheckedChange={(checked) => setMigrate(checked === true)} className="mt-0.5" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium">
              <Database className="h-3.5 w-3.5" />
              {t("Migrate the database")}
            </span>
            <span className="block text-xs text-muted-foreground">{t("Runs the pre-deploy step before the build. Unticked, the code goes live on the schema as it is.")}</span>
            <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{app?.preDeployCommand}</code>
          </span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const options = pending ?? {};
              setPending(null);
              run(migrate ? options : { ...options, skipPreDeploy: true });
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
