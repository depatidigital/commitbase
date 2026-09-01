import { Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { getCurrentUser } from "@/lib/auth";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Link } from "react-router-dom";
import { Settings, LogOut, ChevronDown } from "lucide-react";

import { useLogout } from "@/hooks/useAuth";
import { API_BASE_URL } from "@/lib/api";
export function Layout() {
  const logoutMutation = useLogout();

  // real health signal instead of a decorative always-green pill
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
  const currentUser = getCurrentUser();
  const handleLogout = () => {
    logoutMutation.mutate();
  };
  const getUserInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word.charAt(0))
      .join('')
      .toUpperCase()
  }
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col">
          <header className="h-12 flex items-center border-b border-border bg-card">
            <SidebarTrigger className="ml-4" />
            <div
              className={`flex items-center space-x-1 px-2 py-1 rounded-full border ml-auto mr-4 ${
                healthy === false
                  ? "bg-destructive/10 border-destructive/20"
                  : "bg-success/10 border-success/20"
              }`}
            >
              <div
                className={`h-2 w-2 rounded-full ${
                  healthy === false ? "bg-destructive" : "bg-success animate-pulse"
                }`}
              />
              <span
                className={`text-xs font-medium ${
                  healthy === false ? "text-destructive" : "text-success"
                }`}
              >
                {healthy === false ? "Platform Unreachable" : "Platform Online"}
              </span>
            </div>

            {/* User Dropdown */}
            {currentUser ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="flex items-center space-x-2 h-8">
                    <Avatar className="h-6 w-6">
                      <AvatarFallback className="text-xs">
                        {getUserInitials(currentUser.name || currentUser.email)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm font-medium hidden sm:inline">
                      {currentUser.name || currentUser.email.split('@')[0]}
                    </span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="flex flex-col space-y-1">
                      <p className="text-sm font-medium leading-none">
                        {currentUser.name || 'User'}
                      </p>
                      <p className="text-xs leading-none text-muted-foreground">
                        {currentUser.email}
                      </p>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings" className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      <span>Settings</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleLogout}
                    disabled={logoutMutation.isPending}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>
                      {logoutMutation.isPending ? 'Signing out...' : 'Sign out'}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="text-sm text-muted-foreground">
                No user data available
              </div>
            )}
          </header>
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}