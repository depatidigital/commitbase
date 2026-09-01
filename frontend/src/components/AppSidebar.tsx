import { Server, Database, Terminal, Globe, Link2, Users, ShieldCheck, Plus, Settings } from "lucide-react";
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
import { isAdmin } from "@/lib/auth";

const items = [
  { title: "Applications", url: "/", icon: Server },
  { title: "Deploy new app", url: "/add-app", icon: Plus },
  { title: "Databases", url: "/database", icon: Database },
  { title: "Domains", url: "/domains", icon: Globe },
  { title: "Logs", url: "/logs", icon: Terminal },
  { title: "Team", url: "/team", icon: Users },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const location = useLocation();
  const collapsed = state === "collapsed";
  const admin = isAdmin();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <Sidebar className={collapsed ? "w-14" : "w-60"} collapsible="icon">
      <SidebarContent className="bg-gradient-card">
        <div className="p-4 border-b border-border">
          <div className="flex items-center space-x-2">
            {!collapsed && (
              <>
                <div className="p-2 bg-gradient-primary rounded-lg shadow-glow">
                  <Server className="h-5 w-5 text-primary-foreground" />
                </div>
                <div>
                  <h1 className="text-lg font-bold bg-gradient-primary bg-clip-text text-transparent">
                    CommitBase
                  </h1>
                  <p className="text-xs text-muted-foreground">Self-hosted platform</p>
                </div>
              </>
            )}
            {collapsed && (
              <div className="p-2 bg-gradient-primary rounded-lg shadow-glow mx-auto">
                <Server className="h-5 w-5 text-primary-foreground" />
              </div>
            )}
          </div>
        </div>

        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild>
                    <NavLink
                      to={item.url}
                      className={({ isActive: navIsActive }) =>
                        `flex items-center space-x-2 transition-all duration-200 px-3 py-2 rounded-lg ${
                          navIsActive || isActive(item.url)
                            ? "bg-gradient-primary text-black shadow-elegant"
                            : "hover:bg-muted text-muted-foreground hover:text-foreground"
                        }`
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

              {admin && (
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={location.pathname.startsWith("/admin")}>
                  <NavLink to="/admin" className="flex items-center space-x-2 px-3 py-2 rounded-lg">
                    <ShieldCheck className="h-4 w-4" />
                    <span className={collapsed ? "sr-only" : undefined}>
                      Administration
                    </span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
              )}

              {admin && (
              <SidebarMenuItem>
                <div className="flex items-center space-x-2 px-3 py-2 text-muted-foreground">
                  <Link2 className="h-4 w-4" />
                  {!collapsed && <span className="text-xs font-medium uppercase tracking-wide">Integrations</span>}
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
