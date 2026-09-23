import { Mail, Database, Globe, Link2, Users, ShieldCheck, Building2, UserCog, HardDrive, DatabaseZap, AppWindow, LayoutDashboard, type LucideIcon } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Sidebar,
  SidebarContent,
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
import { APP_NAME } from "@/lib/branding";
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
    if (path === "/projects") return /^\/(projects?|applications?|add-project)(\/|$)/.test(location.pathname);
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
        { title: t("Apps"), url: "/projects", icon: AppWindow },
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
      items: [{ title: t("Team"), url: "/team", icon: Users, show: !admin }],
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
    </Sidebar>
  );
}
