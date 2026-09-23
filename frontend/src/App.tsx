import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams, type Params } from "react-router-dom";
import { Layout } from "./components/Layout";
import { AuthGuard } from "./components/AuthGuard";
import Application from "./pages/Application";
import Projects from "./pages/Projects";
import Dashboard from "./pages/Dashboard";
import ComingSoon from "./pages/ComingSoon";
import { Mail } from "lucide-react";
import ProjectDetail from "./pages/ProjectDetail";
import ApplicationDetail from "./pages/ApplicationDetail";
import AddProject from "./pages/AddProject";
import Database from "./pages/Database";
import Domains from "./pages/Domains";
import DomainRegister from "./pages/DomainRegister";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import RdashOverview from "./pages/RdashOverview";
import IntegrationCardPage from "./pages/IntegrationCardPage";
import { t } from "./lib/i18n";
import { SearchConsoleSettingsCard } from "./components/SearchConsoleSettingsCard";
import { GitOAuthSettingsCard } from "./components/GitOAuthSettingsCard";
import { GIT_GUIDE, GOOGLE_GUIDE } from "./components/IntegrationSteps";
import NotFound from "./pages/NotFound";
import Login from "./pages/Login";
import Team from "./pages/Team";
import Admin from "./pages/Admin";
import Organizations from "./pages/Organizations";
import OrganizationDetail from "./pages/OrganizationDetail";
import Users from "./pages/Users";
import Servers from "./pages/Servers";
import ServerDetail from "./pages/ServerDetail";
import DatabaseServers from "./pages/DatabaseServers";
import DatabaseServerDetail from "./pages/DatabaseServerDetail";
import AcceptInvite from "./pages/AcceptInvite";
import ChangePassword from "./pages/ChangePassword";
import {
  isAdmin,
  isSuperAdmin,
  isAuthenticated,
  mustChangePassword,
} from "@/lib/auth";

import { APP_NAME } from "@/lib/branding";

const queryClient = new QueryClient();

document.title = APP_NAME;

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

// An old URL (links, bookmarks) to its new one, query and all.
const Moved = ({ to }: { to: (params: Params) => string }) => {
  const params = useParams();
  const { search, hash } = useLocation();
  return <Navigate to={`${to(params)}${search}${hash}`} replace />;
};

// /add-app from before the split, links and bookmarks: ?project= to that app's, else a new app
const LegacyAddApp = () => {
  const params = new URLSearchParams(useLocation().search);
  const project = params.get("project");
  params.delete("project");
  const rest = params.toString();
  return <Navigate to={`${project ? `/apps/${project}/services/new` : "/apps/new"}${rest ? `?${rest}` : ""}`} replace />;
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
            {/* the dashboard; the projects and the flat list of every hostname one click away */}
            <Route index element={<Dashboard />} />
            {/* an app (API: source) and the services (API: applications) it runs */}
            <Route path="apps" element={<Projects />} />
            <Route path="apps/new" element={<AddProject />} />
            <Route path="apps/:id" element={<ProjectDetail />} />
            <Route path="apps/:id/services/new" element={<AddProject />} />
            <Route path="services" element={<Application />} />
            <Route path="services/:id" element={<ApplicationDetail />} />
            {/* the URLs before the rename */}
            <Route path="projects" element={<Moved to={() => "/apps"} />} />
            <Route path="project/:id" element={<Moved to={({ id }) => `/apps/${id}`} />} />
            <Route path="project/:id/add-app" element={<Moved to={({ id }) => `/apps/${id}/services/new`} />} />
            <Route path="add-project" element={<Moved to={() => "/apps/new"} />} />
            <Route path="applications" element={<Moved to={() => "/services"} />} />
            <Route path="application/:id" element={<Moved to={({ id }) => `/services/${id}`} />} />
            {/* on the menu, built next */}
            <Route path="email" element={<ComingSoon icon={Mail} title="Email" description={t("Email addresses on your own domain.")} />} />
            <Route path="add-app" element={<LegacyAddApp />} />
            <Route path="database" element={<Database />} />
            <Route path="domains" element={<Domains />} />
            <Route path="domains/register" element={<DomainRegister />} />
            <Route path="domains/:id" element={<Domains />} />
            <Route
              path="team"
              element={
                <UserRoute>
                  <Team />
                </UserRoute>
              }
            />
            <Route
              path="admin"
              element={
                <AdminRoute>
                  <Admin />
                </AdminRoute>
              }
            />
            <Route
              path="servers"
              element={
                <SuperAdminRoute>
                  <Servers />
                </SuperAdminRoute>
              }
            />
            <Route
              path="database-servers"
              element={
                <SuperAdminRoute>
                  <DatabaseServers />
                </SuperAdminRoute>
              }
            />
            <Route
              path="database-servers/:id"
              element={
                <SuperAdminRoute>
                  <DatabaseServerDetail />
                </SuperAdminRoute>
              }
            />
            <Route
              path="servers/:id"
              element={
                <SuperAdminRoute>
                  <ServerDetail />
                </SuperAdminRoute>
              }
            />
            <Route
              path="organizations"
              element={
                <AdminRoute>
                  <Organizations />
                </AdminRoute>
              }
            />
            <Route
              path="organizations/:id"
              element={
                <AdminRoute>
                  <OrganizationDetail />
                </AdminRoute>
              }
            />
            <Route
              path="users"
              element={
                <AdminRoute>
                  <Users />
                </AdminRoute>
              }
            />
            <Route
              path="integrations/rdash"
              element={
                <SuperAdminRoute>
                  <RdashOverview />
                </SuperAdminRoute>
              }
            />
            <Route
              path="integrations/cloudflare"
              element={
                <SuperAdminRoute>
                  <RdashOverview />
                </SuperAdminRoute>
              }
            />
            <Route
              path="integrations/google"
              element={
                <SuperAdminRoute>
                  <IntegrationCardPage title="Google Search Console" description={t("The service account that verifies domains and adds them to Search Console.")} guide={GOOGLE_GUIDE}>
                    <SearchConsoleSettingsCard />
                  </IntegrationCardPage>
                </SuperAdminRoute>
              }
            />
            <Route
              path="integrations/git"
              element={
                <SuperAdminRoute>
                  <IntegrationCardPage title="GitHub & GitLab" description={t("The OAuth services users connect their GitHub and GitLab accounts through.")} guide={GIT_GUIDE}>
                    <GitOAuthSettingsCard />
                  </IntegrationCardPage>
                </SuperAdminRoute>
              }
            />
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
