import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { 
  Server, 
  Plus, 
  Activity, 
  Settings, 
  Terminal,
  Zap,
  LogOut,
  User
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getCurrentUser, logout } from "@/lib/auth";
import { useLogout } from "@/hooks/useAuth";

const navigation = [
  { name: "Application", href: "/", icon: Server },
  { name: "Add App", href: "/add-app", icon: Plus },
  { name: "Logs", href: "/logs", icon: Terminal },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Navbar() {
  const location = useLocation();
  const logoutMutation = useLogout();
  const currentUser = getCurrentUser();

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  return (
    <nav className="bg-card border-b border-border shadow-elegant">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center space-x-2 group">
            <div className="p-2 bg-gradient-primary rounded-lg shadow-glow group-hover:animate-pulse-glow transition-all duration-300">
              <Zap className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-primary bg-clip-text text-transparent">
                CommitBase
              </h1>
              <p className="text-xs text-muted-foreground">Deployment platform</p>
            </div>
          </Link>

          {/* Navigation */}
          <div className="flex items-center space-x-1">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link key={item.name} to={item.href}>
                  <Button
                    variant={isActive ? "default" : "ghost"}
                    className={cn(
                      "flex items-center space-x-2 transition-all duration-200",
                      isActive ? "bg-gradient-primary shadow-elegant" : "hover:bg-muted"
                    )}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="hidden sm:inline">{item.name}</span>
                  </Button>
                </Link>
              );
            })}
          </div>

          {/* User Info & Actions */}
          <div className="flex items-center space-x-2">
            {/* Status Indicator */}
            <div className="flex items-center space-x-1 px-2 py-1 bg-success/10 rounded-full border border-success/20">
              <Activity className="h-3 w-3 text-success animate-pulse" />
              <span className="text-xs text-success font-medium hidden sm:inline">
                Platform Online
              </span>
            </div>

            {/* User Info */}
            {currentUser && (
              <div className="flex items-center space-x-2 px-3 py-1 bg-muted rounded-full">
                <User className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {currentUser.name || currentUser.email}
                </span>
              </div>
            )}

            {/* Logout Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              disabled={logoutMutation.isPending}
              className="h-8 w-8 p-0"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </nav>
  );
}