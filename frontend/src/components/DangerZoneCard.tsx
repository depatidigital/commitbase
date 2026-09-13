import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Database as DatabaseIcon, Loader2, Trash2 } from "lucide-react";
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
import { getTeardownPlan, runtimeLabel, type Application, type TeardownStepId } from "@/lib/applications";
import { getAppDatabases } from "@/lib/databases";
import { isSuperAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";

// functions, so t() reads the dictionary at render, not at import
const STEP_LABEL: Record<TeardownStepId, () => string> = {
  process: () => t("Stop and remove the process"),
  route: () => t("Remove the Caddy route"),
  dns: () => t("Remove the DNS record"),
  files: () => t("Delete the app folder"),
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
  const ready = typed.trim() === application.domain && understood;
  // same key as the Database tab: already cached when the user got here
  const { data: databases } = useQuery({
    queryKey: ["databases", "application", application.id],
    queryFn: () => getAppDatabases(application.id),
    enabled: open,
  });

  // imported by the server sync: the pieces on the box were set up by hand, so
  // each one is removed only when ticked
  const imported = !!application.runtime;
  const superAdmin = isSuperAdmin();
  const [remove, setRemove] = useState<TeardownStepId[]>([]);
  const plan = useQuery({
    queryKey: ["application", application.id, "teardown"],
    queryFn: () => getTeardownPlan(application.id),
    enabled: open && imported && superAdmin,
  });

  const close = (next: boolean) => {
    if (deleteApp.isPending) return;
    setOpen(next);
    if (!next) {
      setTyped("");
      setUnderstood(false);
      setRemove([]);
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
          <p className="font-medium">{t("Delete this app")}</p>
          <p className="text-muted-foreground">
            {imported
              ? t("Removes it from the panel. You choose what is also removed from the server.")
              : t("{domain} stops being served and the app is removed from the panel. This cannot be undone.", {
                  domain: application.domain,
                })}
          </p>
        </div>
        <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          <Trash2 className="mr-2 h-4 w-4" />
          {t("Delete app…")}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Delete {name}?", { name: application.name })}</DialogTitle>
            <DialogDescription>
              {imported
                ? t("Set up by hand on {runtime}. Nothing on the server is touched unless you tick it below.", {
                    runtime: runtimeLabel(application.runtime),
                  })
                : t("Its route, DNS record, files and deployment history go with it. There is no undo.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {imported && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p className="font-medium">{t("Also remove from the server")}</p>
                {!superAdmin ? (
                  <p className="text-muted-foreground">{t("Only a superadmin can remove things from the server.")}</p>
                ) : plan.isLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  (plan.data ?? []).map((step) => (
                    <label key={step.id} className={`flex items-start gap-2 ${step.blocked ? "opacity-60" : ""}`}>
                      <Checkbox
                        checked={remove.includes(step.id)}
                        disabled={!!step.blocked}
                        onCheckedChange={(checked) =>
                          setRemove((prev) => (checked === true ? [...prev, step.id] : prev.filter((id) => id !== step.id)))
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        {STEP_LABEL[step.id]()}
                        {step.command && (
                          <span className="block break-all font-mono text-xs text-muted-foreground">{step.command}</span>
                        )}
                        {step.detail && (
                          <span className="block break-all text-xs text-muted-foreground">{t(step.detail.text, step.detail.params)}</span>
                        )}
                        {step.blocked && (
                          <span className="block text-xs text-warning">{t(step.blocked.text, step.blocked.params)}</span>
                        )}
                      </span>
                    </label>
                  ))
                )}
                {remove.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("Nothing ticked: only the panel forgets it, and the next server sync brings it back while it is still there.")}
                  </p>
                )}
              </div>
            )}
            {!!databases?.length && (
              <p className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm">
                <DatabaseIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <span>
                  {t("Kept: {names}. The data stays on its server — connect it to another app or delete it from Databases.", {
                    names: databases.map((db) => db.dbName ?? db.name).join(", "),
                  })}
                </span>
              </p>
            )}
            <label className="block space-y-2 text-sm">
              <span>{t("Type {domain} to confirm", { domain: application.domain })}</span>
              <Input
                value={typed}
                placeholder={application.domain}
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
                {imported && remove.length === 0
                  ? t("I understand the site keeps running on the server.")
                  : t("I understand the site goes offline and this cannot be undone.")}
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={deleteApp.isPending}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!ready || deleteApp.isPending}
              onClick={() => deleteApp.mutate({ id: application.id, remove }, { onSuccess: () => navigate("/") })}
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
