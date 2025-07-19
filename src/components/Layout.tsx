import { Outlet } from "react-router-dom";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";

export function Layout() {
  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col">
          <header className="h-12 flex items-center border-b border-border bg-card">
            <SidebarTrigger className="ml-4" />
            <div className="flex items-center space-x-1 px-2 py-1 bg-success/10 rounded-full border border-success/20 ml-auto mr-4">
              <div className="h-2 w-2 bg-success rounded-full animate-pulse" />
              <span className="text-xs text-success font-medium">
                Platform Online
              </span>
            </div>
          </header>
          <main className="flex-1 p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}