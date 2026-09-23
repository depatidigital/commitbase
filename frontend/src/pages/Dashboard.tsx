import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, Globe, Loader2, Plus, Rocket, Server, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageLayout } from "@/components/PageLayout";
import { locale, t } from "@/lib/i18n";
import { appStatus, getApplicationHealth, type Health } from "@/lib/health";
import { getProjects, projectPath } from "@/lib/projects";
import { getDomainsPage } from "@/lib/domains";
import { expiryTone, needsRenewal } from "@/lib/domainExpiry";
import { ago } from "./Projects";
import { isSuperAdmin } from "@/lib/auth";
import { getUsers } from "@/lib/admin";

function Stat({ label, value, icon: Icon, tone = "" }: { label: string; value: number | string; icon: typeof Boxes; tone?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className={`text-2xl font-semibold ${tone}`}>{value}</p>
        </div>
        <Icon className={`h-6 w-6 text-muted-foreground ${tone}`} />
      </CardContent>
    </Card>
  );
}

/**
 * The landing page: what needs a look now — apps down, domains running out,
 * the latest deploys — with the counts above. Everything links to its page.
 */
export default function Dashboard() {
  // ponytail: the first 100 projects (the API's page cap); a summary endpoint when orgs outgrow that
  const { data: projectsPage, isLoading } = useQuery({
    queryKey: ["projects", "dashboard"],
    queryFn: () => getProjects({ page: 1, limit: 100, search: "", sort: "createdAt", order: "desc" }),
    refetchInterval: 30_000,
  });
  const projects = projectsPage?.data ?? [];
  const apps = projects.flatMap((project) => project.applications.map((app) => ({ app, project })));

  const appIds = apps.map(({ app }) => app.id);
  const { data: healthById = {} } = useQuery({
    queryKey: ["applications", "health", appIds],
    queryFn: () => getApplicationHealth(appIds),
    enabled: appIds.length > 0,
    refetchInterval: 60_000,
  });

  // soonest first; expired sort before the rest, undated last
  const { data: domainsPage } = useQuery({
    queryKey: ["domains", "dashboard"],
    queryFn: () => getDomainsPage({ page: 1, limit: 20, search: "", sort: "expiresAt", order: "asc" }),
  });
  const renewals = (domainsPage?.data ?? []).filter(needsRenewal);

  // platform-wide counts: superadmin only
  const superAdmin = isSuperAdmin();
  const { data: usersPage } = useQuery({
    queryKey: ["users", "dashboard"],
    queryFn: () => getUsers({ page: 1, limit: 1, search: "" }),
    enabled: superAdmin,
  });

  const statuses = apps.map(({ app, project }) => ({ app, project, ...appStatus(app.status, healthById[app.id] as Health | undefined, app.disabled) }));
  const attention = statuses.filter((s) => s.rank === 0).sort((a, b) => a.app.name.localeCompare(b.app.name));
  const online = statuses.filter((s) => s.tone === "up").length;

  const deploys = projects
    .filter((project) => project.lastDeployment)
    .sort((a, b) => b.lastDeployment!.createdAt.localeCompare(a.lastDeployment!.createdAt))
    .slice(0, 8);

  return (
    <PageLayout
      title={t("Dashboard")}
      description={t("What needs a look, at a glance.")}
      actions={
        <Button asChild className="bg-gradient-primary shadow-glow transition-all duration-300 hover:shadow-elegant">
          <Link to="/add-project">
            <Plus className="mr-2 h-4 w-4" />
            {t("Add project")}
          </Link>
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className={`grid grid-cols-2 gap-4 ${superAdmin ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
            <Stat label={t("Projects")} value={projectsPage?.pagination.total ?? 0} icon={Boxes} />
            <Stat label={t("Apps online")} value={`${online}/${apps.length}`} icon={Server} />
            <Stat label={t("Need attention")} value={attention.length} icon={AlertTriangle} tone={attention.length ? "text-destructive" : ""} />
            <Stat label={t("Domains to renew")} value={renewals.length} icon={Globe} tone={renewals.length ? "text-warning" : ""} />
            {superAdmin && <Stat label={t("Total users")} value={usersPage?.pagination.total ?? "—"} icon={Users} />}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="h-4 w-4" />
                  {t("Need attention")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {attention.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    {t("All apps are fine.")}
                  </p>
                ) : (
                  <ul className="divide-y">
                    {attention.map(({ app, project, text, tone }) => {
                      const health = healthById[app.id] as Health | undefined;
                      return (
                        <li key={app.id}>
                          <Link to={`/application/${app.id}`} className="flex items-center gap-2 py-2 text-sm hover:text-primary">
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tone === "down" ? "bg-destructive" : "bg-warning"}`} />
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{app.domains[0]?.host ?? app.name}</span>
                              <span className="text-muted-foreground"> · {project.name}</span>
                            </span>
                            <span className={`shrink-0 text-xs ${tone === "down" ? "text-destructive" : "text-warning"}`} title={health?.lastError ?? undefined}>
                              {text}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Rocket className="h-4 w-4" />
                  {t("Recent deploys")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {deploys.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("No deploys yet.")}</p>
                ) : (
                  <ul className="divide-y">
                    {deploys.map((project) => {
                      const deploy = project.lastDeployment!;
                      const failed = deploy.status === "FAILED";
                      return (
                        <li key={project.id}>
                          <Link to={projectPath(project)} className="flex items-center gap-2 py-2 text-sm hover:text-primary">
                            <span className="min-w-0 flex-1 truncate">
                              <span className="font-medium">{project.name}</span>
                              {deploy.commitMessage && <span className="text-muted-foreground"> · {deploy.commitMessage}</span>}
                            </span>
                            {failed && <span className="shrink-0 text-xs font-medium text-destructive">{t("Failed")}</span>}
                            <span className="shrink-0 text-xs text-muted-foreground" title={new Date(deploy.createdAt).toLocaleString(locale)}>
                              {ago(deploy.createdAt)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>

            {renewals.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Globe className="h-4 w-4" />
                    {t("Domains to renew")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y">
                    {renewals.map((domain) => {
                      const tone = expiryTone(new Date(domain.expiresAt!));
                      return (
                        <li key={domain.id}>
                          <Link to={`/domains/${domain.id}`} className="flex items-center gap-2 py-2 text-sm hover:text-primary">
                            <span className="min-w-0 flex-1 truncate font-medium">{domain.name}</span>
                            <span className={`shrink-0 text-xs ${tone.className}`}>{tone.note}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>

          <div>
            <Button variant="ghost" asChild>
              <Link to="/projects">
                {t("All projects")}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </>
      )}
    </PageLayout>
  );
}
