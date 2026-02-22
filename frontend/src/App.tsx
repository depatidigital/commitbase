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
import { isAuthenticated } from "@/lib/auth";

const queryClient = new QueryClient();

// Protected Route component
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
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
            <Route path="integrations/domains" element={<RdashOverview />} />
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
