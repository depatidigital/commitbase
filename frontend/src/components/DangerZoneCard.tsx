import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
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
import type { Application } from "@/lib/applications";
import { t } from "@/lib/i18n";

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
          <p className="font-medium">{t("Delete this app")}</p>
          <p className="text-muted-foreground">
            {t("{domain} stops being served and the app is removed from the panel. This cannot be undone.", {
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
              {t("Its route, DNS record, files and deployment history go with it. There is no undo.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <label className="block space-y-2 text-sm">
              <span>
                {t("Type")} <span className="font-mono font-semibold">{application.domain}</span> {t("to confirm")}
              </span>
              <Input
                value={typed}
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
              <span>{t("I understand the site goes offline and this cannot be undone.")}</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => close(false)} disabled={deleteApp.isPending}>
              {t("Cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!ready || deleteApp.isPending}
              onClick={() => deleteApp.mutate(application.id, { onSuccess: () => navigate("/") })}
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
