import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Circle, Database as DatabaseIcon, Loader2, MinusCircle, Trash2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteApplication } from "@/hooks/useApplications";
import { getTeardownPlan, hostList, runtimeLabel, type Application, type TeardownStepId } from "@/lib/applications";
import { getAppDatabases } from "@/lib/databases";
import { isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";

// functions, so t() reads the dictionary at render, not at import
const STEP_LABEL: Record<TeardownStepId, () => string> = {
  process: () => t("Stop and remove the process"),
  route: () => t("Remove the Caddy route"),
  dns: () => t("Remove the DNS record"),
  files: () => t("Delete the service folder"),
};

/**
 * Deleting an app, kept away from the everyday buttons and made deliberate:
 * open the dialog, type the domain, tick that you understand — only then does
 * the button work. A misclick cannot take a site down.
 */
export function DangerZoneCard({ application }: { application: Application }) {
  const navigate = useNavigate();
  const deleteApp = useDeleteApplication();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [understood, setUnderstood] = useState(false);
  // its name: an app of several hostnames has no one of them to type
  const ready = typed.trim() === application.name && understood;
  // same key as the Database tab: already cached when the user got here
  const { data: databases } = useQuery({
    queryKey: ["databases", "application", application.id],
    queryFn: () => getAppDatabases(application.id),
    enabled: open,
  });

  // imported by the server sync: deleting it removes it from the server too,
  // all of it or nothing — one step that cannot run keeps the app
  const imported = !!application.runtime;
  const superAdmin = isSuperAdmin();
  const plan = useQuery({
    queryKey: ["application", application.id, "teardown"],
    queryFn: () => getTeardownPlan(application.id),
    enabled: open && imported && superAdmin,
  });
  const blocked = imported && (!superAdmin || !plan.data || plan.data.some((step) => step.blocked));

  const close = (next: boolean) => {
    if (deleteApp.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped("");
      setUnderstood(false);
    }
  };

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center space-x-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span>{t("Danger zone")}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{t("Delete this service")}</p>
          <p className="text-muted-foreground">
            {imported
              ? t("Removes it from the panel and from the server. If anything cannot be removed, nothing is deleted.")
              : t("{domain} stops being served and the service is removed from the panel. This cannot be undone.", {
                  domain: hostList(application),
                })}
          </p>
        </div>
        <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("Delete service…")}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete {name}?", { name: application.name })}</DialogTitle>
            <DialogDescription>
              {imported
                ? t("Set up by hand on {runtime}. All of this is removed from the server — if any of it cannot be, the service is not deleted.", {
                    runtime: runtimeLabel(application.runtime),
                  })
                : t("Its route, DNS record, files and deployment history go with it. There is no undo.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {imported && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">{t("Removed from the server")}</p>
                {!superAdmin ? (
                  <p className="text-muted-foreground">{t("Only a superadmin can remove things from the server.")}</p>
                ) : plan.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  (plan.data ?? []).map((step) => (
                    <div key={step.id} className="flex items-start gap-2">
                      {step.blocked ? (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                      ) : step.kept ? (
                        <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : step.satisfied ? (
                        <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                      ) : (
                        <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0">
                        {STEP_LABEL[step.id]()}
                        {step.command && (
                          <span className="block break-all font-mono text-xs text-muted-foreground">{step.command}</span>
                        )}
                        {step.detail && (
                          <span className="block break-all text-xs text-muted-foreground">{t(step.detail.text, step.detail.params)}</span>
                        )}
                        {step.kept && (
                          <span className="block text-xs text-muted-foreground">{t(step.kept.text, step.kept.params)}</span>
                        )}
                        {step.satisfied && (
                          <span className="block text-xs text-success">{t(step.satisfied.text, step.satisfied.params)}</span>
                        )}
                        {step.blocked && (
                          <span className="block text-xs text-destructive">{t(step.blocked.text, step.blocked.params)}</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
                {superAdmin && plan.data?.some((step) => step.blocked) && (
                  <p className="text-xs text-destructive">
                    {t("Sort out what is marked above first — until then the service cannot be deleted.")}
                  </p>
                )}
              </div>
            )}
            {!!databases?.length && (
              <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  {t("Kept: {names}. The data stays on its server — connect it to another service or delete it from Databases.", {
                    names: databases.map((db) => db.dbName ?? db.name).join(", "),
                  })}
                </span>
              </p>
            )}
            <label className="block space-y-2 text-sm">
              <span>{t("Type {domain} to confirm", { domain: application.name })}</span>
              <Input
                value={typed}
                placeholder={application.name}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                // pasting the name defeats the point of typing it
                onPaste={(e) => e.preventDefault()}
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={understood}
                onCheckedChange={(checked) => setUnderstood(checked === true)}
                className="mt-0.5"
              />
              <span>
                {t("I understand the site goes offline and this cannot be undone.")}
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={deleteApp.isPending}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!ready || blocked || deleteApp.isPending}
              onClick={() => deleteApp.mutate(application.id, { onSuccess: () => navigate("/apps") })}
            >
              {deleteApp.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t("Delete permanently")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
