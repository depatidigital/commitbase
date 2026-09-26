import { ArrowUpCircle, Wallet, Mail, Database, Globe, Link2, Users, ShieldCheck, Building2, UserCog, HardDrive, DatabaseZap, AppWindow, LayoutDashboard, LifeBuoy, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/lib/api";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { isAdmin, isSuperAdmin } from "@/lib/auth";
import { APP_NAME, SUPPORT_URL } from "@/lib/branding";
import { t } from "@/lib/i18n";
import { OrgSwitcher } from "./OrgSwitcher";

type Item = { title: string; url: string; icon: LucideIcon; show?: boolean };

// the active item says where you are, it does not shout: a tint and a hairline
const ACTIVE = "data-[active=true]:bg-primary/10 data-[active=true]:text-primary data-[active=true]:ring-1 data-[active=true]:ring-primary/30";

export function AppSidebar() {
  const { state } = useSidebar();
  const location = useLocation();
  const collapsed = state === "collapsed";
  const admin = isAdmin();
  const superadmin = isSuperAdmin();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    // projects, the apps in them and the flat app list are one section
    if (path === "/apps") return /^\/(apps|services)(\/|$)/.test(location.pathname);
    // whole segments: /database must not light up on /database-servers
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  // Grouped by what the user is after: the services they use, what those run
  // on, then the organization. Settings and logs live elsewhere (the account menu,
  // the project and app pages).
  const groups: Array<{ label?: string; items: Item[] }> = [
    // an app is the main thing here: straight under the dashboard, no heading of its own
    {
      items: [
        { title: t("Dashboard"), url: "/", icon: LayoutDashboard },
        { title: t("Apps"), url: "/apps", icon: AppWindow },
      ],
    },
    {
      label: t("Infrastructure"),
      items: [
        { title: t("Databases"), url: "/database", icon: Database },
        { title: t("Domains"), url: "/domains", icon: Globe },
        { title: "Email", url: "/email", icon: Mail },
      ],
    },
    {
      label: t("Workspace"),
      items: [
        { title: t("Team"), url: "/team", icon: Users, show: !admin },
        { title: t("Usage"), url: "/usage", icon: Wallet, show: !admin },
      ],
    },
    // ponytail: the admin side as it was, restyled only — to be narrowed to organizations, users and billing
    {
      label: t("Administration"),
      items: [
        { title: t("Servers"), url: "/servers", icon: HardDrive, show: superadmin },
        { title: t("Database Servers"), url: "/database-servers", icon: DatabaseZap, show: superadmin },
        { title: t("Workspaces"), url: "/organizations", icon: Building2, show: admin },
        { title: t("Users"), url: "/users", icon: UserCog, show: admin },
        { title: t("Administration"), url: "/admin", icon: ShieldCheck, show: admin },
        { title: t("Update Larika"), url: "/system/update", icon: ArrowUpCircle, show: superadmin },
      ],
    },
  ];

  const integrations = [
    { title: "Rdash", url: "/integrations/rdash" },
    { title: "Cloudflare", url: "/integrations/cloudflare" },
    { title: "Google Search Console", url: "/integrations/google" },
    { title: "GitHub & GitLab", url: "/integrations/git" },
  ];

  return (
    <Sidebar collapsible="icon">
      <SidebarContent className="bg-gradient-card">
        <div className={`border-b border-border ${collapsed ? "p-2" : "p-4"}`}>
          <div className="flex items-center space-x-2">
            {!collapsed && (
              <>
                {/* the favicon is the logo — one file for both */}
                <img src="/favicon.svg" alt="" className="h-9 w-9 rounded-lg shadow-glow" />
                <h1 className="text-lg font-bold bg-gradient-primary bg-clip-text text-transparent">
                  {APP_NAME}
                </h1>
              </>
            )}
            {collapsed && (
              <img src="/favicon.svg" alt="" className="mx-auto h-7 w-7 rounded-lg shadow-glow" />
            )}
          </div>
        </div>

        {/* tenants work inside one organization at a time; platform admins see them all */}
        {!admin && !collapsed && (
          <div className="px-2 pt-3">
            <OrgSwitcher />
          </div>
        )}

        {groups.map((group, index) => {
          const items = group.items.filter((item) => item.show !== false);
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label ?? index}>
              {group.label && <SidebarGroupLabel className="uppercase tracking-wide">{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.url}>
                      <SidebarMenuButton asChild tooltip={item.title} isActive={isActive(item.url)} className={ACTIVE}>
                        <NavLink to={item.url}>
                          <item.icon />
                          <span>{item.title}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}

        {superadmin && (
          <SidebarGroup>
            <SidebarGroupLabel className="uppercase tracking-wide">
              <Link2 className="mr-2 h-3 w-3" />
              {t("Integrations")}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenuSub>
                {integrations.map((item) => (
                  <SidebarMenuSubItem key={item.url}>
                    <SidebarMenuSubButton asChild isActive={isActive(item.url)} className={ACTIVE}>
                      <NavLink to={item.url}>
                        <span>{item.title}</span>
                      </NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={t("Technical support")}>
              <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">
                <LifeBuoy />
                <span>{t("Technical support")}</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <PlatformStatus collapsed={collapsed} />
      </SidebarFooter>
    </Sidebar>
  );
}

/** Is the panel's API answering? A real signal, not a decorative always-green pill. */
function PlatformStatus({ collapsed }: { collapsed: boolean }) {
  const { data: healthy } = useQuery({
    queryKey: ["platform-health"],
    queryFn: async () => {
      const base = (API_BASE_URL || "").replace(/\/api\/?$/, "");
      const res = await fetch(`${base}/health`);
      return res.ok;
    },
    refetchInterval: 30000,
    retry: false,
  });
  const down = healthy === false;
  const label = down ? t("Platform Unreachable") : t("Platform Online");
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 text-xs font-medium ${down ? "text-destructive" : "text-success"}`} title={label}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${down ? "bg-destructive" : "bg-success animate-pulse"}`} />
      {!collapsed && label}
    </div>
  );
}
