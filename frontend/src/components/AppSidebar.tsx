import { Server, Database, Terminal, Globe, Link2, Users, ShieldCheck, Settings, Building2, UserCog, HardDrive, DatabaseZap } from "lucide-react";
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
import { APP_NAME, APP_TAGLINE } from "@/lib/branding";
import { t } from "@/lib/i18n";

const items = [
  { title: t("Apps"), url: "/", icon: Server },
  { title: t("Databases"), url: "/database", icon: Database },
  { title: t("Domains"), url: "/domains", icon: Globe },
  { title: t("Logs"), url: "/logs", icon: Terminal },
  { title: t("Team"), url: "/team", icon: Users },
  { title: t("Settings"), url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const location = useLocation();
  const collapsed = state === "collapsed";
  const admin = isAdmin();
  const superadmin = isSuperAdmin();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    // whole segments: /database must not light up on /database-servers
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarContent className="bg-gradient-card">
        <div className={`border-b border-border ${collapsed ? "p-2" : "p-4"}`}>
          <div className="flex items-center space-x-2">
            {!collapsed && (
              <>
                <div className="p-2 bg-gradient-primary rounded-lg shadow-glow">
                  <Server className="h-5 w-5 text-primary-foreground" />
                </div>
                <div>
                  <h1 className="text-lg font-bold bg-gradient-primary bg-clip-text text-transparent">
                    {APP_NAME}
                  </h1>
                  <p className="text-xs text-muted-foreground">{APP_TAGLINE}</p>
                </div>
              </>
            )}
            {collapsed && (
              <div className="p-1.5 bg-gradient-primary rounded-lg shadow-glow mx-auto">
                <Server className="h-4 w-4 text-primary-foreground" />
              </div>
            )}
          </div>
        </div>

        <SidebarGroup>
          <SidebarGroupLabel>{t("Platform")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items
                .filter((item) => item.url !== "/team" || !admin)
                .map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <NavLink
                      to={item.url}
                      className={
                        isActive(item.url)
                          ? "flex items-center space-x-2 transition-all duration-200 px-3 py-2 rounded-lg bg-gradient-primary text-primary-foreground shadow-elegant"
                          : "flex items-center space-x-2 transition-all duration-200 px-3 py-2 rounded-lg text-sidebar-foreground hover:bg-primary hover:text-primary-foreground"
                      }
                    >
                      <item.icon className="h-4 w-4" />
                      <span className={collapsed ? "sr-only" : undefined}>
                        {item.title}
                      </span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}

              {superadmin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.pathname.startsWith("/servers")}>
                  <NavLink to="/servers" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <HardDrive className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      {t("Servers")}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {superadmin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.pathname.startsWith("/database-servers")}>
                  <NavLink to="/database-servers" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <DatabaseZap className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      {t("Database Servers")}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.pathname.startsWith("/organizations")}>
                  <NavLink to="/organizations" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <Building2 className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      {t("Organizations")}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.pathname.startsWith("/users")}>
                  <NavLink to="/users" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <UserCog className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      {t("Users")}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip={t("Administration")} isActive={location.pathname.startsWith("/admin")}>
                  <NavLink to="/admin" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <ShieldCheck className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      {t("Administration")}
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {superadmin && (
              <SidebarMenuItem>
                <div className="flex items-center space-x-2 px-3 py-2 text-muted-foreground">
                  <Link2 className="h-4 w-4" />
                  {!collapsed && <span className="text-xs font-medium uppercase tracking-wide">{t("Integrations")}</span>}
                </div>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location.pathname.startsWith("/integrations/rdash")}
                    >
                      <NavLink to="/integrations/rdash">
                        <span>Rdash</span>
                      </NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location.pathname.startsWith("/integrations/cloudflare")}
                    >
                      <NavLink to="/integrations/cloudflare">
                        <span>Cloudflare</span>
                      </NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
