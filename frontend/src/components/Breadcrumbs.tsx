import { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Home } from "lucide-react";

const LABELS: Record<string, string> = {
  application: "Applications",
  "add-app": "Deploy new app",
  database: "Databases",
  domains: "Domains",
  logs: "Logs",
  settings: "Settings",
  team: "Team",
  admin: "Administration",
  organizations: "Organizations",
  users: "Users",
  integrations: "Integrations",
  rdash: "Rdash",
  cloudflare: "Cloudflare",
};

// cuid/uuid route params get a generic label — the page itself shows the real name
const isId = (segment: string) => /^(c[a-z0-9]{20,}|[0-9a-f-]{16,})$/i.test(segment);

const label = (segment: string) =>
  LABELS[segment] ??
  (isId(segment) ? "Detail" : segment.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()));

export function Breadcrumbs() {
  const segments = useLocation().pathname.split("/").filter(Boolean);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {segments.length === 0 ? (
            <BreadcrumbPage className="flex items-center gap-1.5">
              <Home className="h-3.5 w-3.5" /> Home
            </BreadcrumbPage>
          ) : (
            <BreadcrumbLink asChild>
              <Link to="/" className="flex items-center gap-1.5">
                <Home className="h-3.5 w-3.5" /> Home
              </Link>
            </BreadcrumbLink>
          )}
        </BreadcrumbItem>

        {segments.map((segment, i) => {
          const last = i === segments.length - 1;
          const href = `/${segments.slice(0, i + 1).join("/")}`;
          return (
            <Fragment key={href}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {last ? (
                  <BreadcrumbPage>{label(segment)}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={href}>{label(segment)}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
