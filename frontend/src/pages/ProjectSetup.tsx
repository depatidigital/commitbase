import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle, Globe, Loader2 } from "lucide-react";
import { PageLayout } from "@/components/PageLayout";
import { AppTypeBadge } from "@/components/AppTypeBadge";
import { RoutingCard } from "@/components/RoutingCard";
import { Stepper } from "@/components/Stepper";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApplication } from "@/hooks/useApplications";
import { useToast } from "@/hooks/use-toast";
import { bindingLabel, updateApplication } from "@/lib/applications";
import { getProject, updateProject, type ProjectApp } from "@/lib/projects";
import { t } from "@/lib/i18n";

/**
 * Right after "Create now": the new app's host for each of its services, then
 * its name (filled in for it) — nothing else. Every service needs one before it
 * goes on; the rest (env, build, deploy) is the app page's setup checklist.
 */
export default function ProjectSetup() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: project, isLoading, refetch } = useQuery({ queryKey: ["project", id], queryFn: () => getProject(id), enabled: !!id });
  // null: untouched — the name it was created with
  const [name, setName] = useState<string | null>(null);
  const shown = name ?? project?.name ?? "";
  const apps = project?.applications ?? [];
  const missing = apps.filter((app) => app.domains.length === 0).length;

  const save = useMutation({
    mutationFn: async () => {
      const next = shown.trim();
      if (project && next !== project.name) {
        await updateProject(id, { name: next });
        // one service: it is the app, so it carries the same name
        if (apps.length === 1) await updateApplication(apps[0].id, { name: next });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", id] });
      navigate(`/apps/${id}`);
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not save"), description: error.message }),
  });

  return (
    <PageLayout title={t("Almost done")} description={t("Give it an address and a name — then it can go online.")}>
      <div className="mx-auto w-full max-w-2xl space-y-8">
        <Stepper steps={[t("Upload & pick the source"), t("Finish")]} current={1} />
        <Card className="bg-gradient-card border-border/50 shadow-elegant">
          <CardContent className="space-y-6 pt-6">
            {isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("Loading…")}
              </p>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>{apps.length > 1 ? t("Address for each service") : t("Address")}</Label>
                  <div className="divide-y rounded-md border border-border/60 bg-card">
                    {apps.map((app) => (
                      <ServiceHost key={app.id} app={app} showName={apps.length > 1} onChange={() => void refetch()} />
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="name">{t("Name")}</Label>
                  <Input id="name" value={shown} onChange={(e) => setName(e.target.value)} required />
                  <p className="text-xs text-muted-foreground">{t("Filled in for you. You can change it.")}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          {missing > 0 && (
            <span className="text-right text-xs text-muted-foreground">
              {apps.length > 1 ? t("Every service needs an address first.") : t("Add an address first.")}
            </span>
          )}
          <Button
            type="button"
            className="bg-gradient-primary"
            onClick={() => save.mutate()}
            disabled={isLoading || missing > 0 || !shown.trim() || save.isPending}
          >
            {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
            {t("Continue")}
          </Button>
        </div>
      </div>
    </PageLayout>
  );
}

/** One service: its hosts, and the hosts dialog the app page uses — the same checks, DNS and all. */
function ServiceHost({ app, showName, onChange }: { app: ProjectApp; showName: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  // the dialog needs the whole app; read once it is asked for
  const { data: application } = useApplication(open ? app.id : "");
  const done = app.domains.length > 0;

  const dialog = application && <RoutingCard application={application} dialogOnly editOpen={open} onEditOpenChange={setOpen} onChange={onChange} />;
  const icon = open && !application ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Globe className="mr-2 h-4 w-4" />;

  // none yet: the one thing to do, as the page's main button
  if (!done) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        {showName && (
          <p className="flex items-center gap-2 text-sm font-medium">
            {app.name}
            <AppTypeBadge type={app.type} />
          </p>
        )}
        <Button type="button" className={`bg-gradient-primary ${showName ? "" : "w-full"}`} onClick={() => setOpen(true)}>
          {icon}
          {t("Choose a domain address")}
        </Button>
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <CheckCircle className="h-5 w-5 shrink-0 text-green-600" />
      <div className="min-w-0 flex-1 space-y-0.5">
        {showName && (
          <p className="flex items-center gap-2 text-sm font-medium">
            {app.name}
            <AppTypeBadge type={app.type} />
          </p>
        )}
        <p className="truncate font-mono text-sm">{app.domains.map(bindingLabel).join(", ")}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {icon}
        {t("Change")}
      </Button>
      {dialog}
    </div>
  );
}
