import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthGuard } from "./components/AuthGuard";
import Application from "./pages/Application";
import ApplicationDetail from "./pages/ApplicationDetail";
import AddApp from "./pages/AddApp";
import Database from "./pages/Database";
import Domains from "./pages/Domains";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import RdashOverview from "./pages/RdashOverview";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";
import Team from "./pages/Team";
import Admin from "./pages/Admin";
import Organizations from "./pages/Organizations";
import Users from "./pages/Users";
import AcceptInvite from "./pages/AcceptInvite";
import ChangePassword from "./pages/ChangePassword";
import { isAdmin, isSuperAdmin, isAuthenticated, mustChangePassword } from "@/lib/auth";

const queryClient = new QueryClient();

// Protected Route component
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  // an admin-issued temporary password must be rotated before anything else
  if (mustChangePassword()) {
    return <Navigate to="/change-password" replace />;
  }
  return <>{children}</>;
};

// UI gating only — every admin endpoint is also behind requireRole(['ADMIN']) server-side.
const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  if (!isAdmin()) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};

// Team is the org-member view. Platform admins manage membership from /organizations.
const UserRoute = ({ children }: { children: React.ReactNode }) => {
  if (isAdmin()) {
    return <Navigate to="/organizations" replace />;
  }
  return <>{children}</>;
};

const SuperAdminRoute = ({ children }: { children: React.ReactNode }) => {
  if (!isSuperAdmin()) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AuthGuard>
                  <Layout />
                </AuthGuard>
              </ProtectedRoute>
            }
          >
            <Route index element={<Application />} />
            <Route path="application/:id" element={<ApplicationDetail />} />
            <Route path="add-app" element={<AddApp />} />
            <Route path="database" element={<Database />} />
            <Route path="domains" element={<Domains />} />
            <Route path="domains/:id" element={<Domains />} />
            <Route path="team" element={<UserRoute><Team /></UserRoute>} />
            <Route path="admin" element={<AdminRoute><Admin /></AdminRoute>} />
            <Route path="organizations" element={<AdminRoute><Organizations /></AdminRoute>} />
            <Route path="users" element={<AdminRoute><Users /></AdminRoute>} />
            <Route path="integrations/rdash" element={<SuperAdminRoute><RdashOverview /></SuperAdminRoute>} />
            <Route path="integrations/cloudflare" element={<SuperAdminRoute><RdashOverview /></SuperAdminRoute>} />
            <Route path="logs" element={<Logs />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
