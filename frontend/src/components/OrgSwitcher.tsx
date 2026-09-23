import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { getOrganizations } from "@/lib/organizations";
import { getActiveOrg, setActiveOrg } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * The organization every page works in. Sent as X-Organization-Id on each
 * request (lib/api), and the API narrows its lists to it — so pages need no
 * organization column or filter of their own.
 */
export function OrgSwitcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: organizations = [] } = useQuery({ queryKey: ["organizations", "mine"], queryFn: getOrganizations });
  const active = getActiveOrg();
  const current = organizations.find((org) => org.id === active) ?? organizations[0];

  const pick = (id: string) => {
    setActiveOrg(id);
    // a detail page may belong to the org just left: back to the dashboard; a list stays and reloads
    if (pathname.split("/").filter(Boolean).length > 1) navigate("/");
    void queryClient.resetQueries();
  };

  // nothing stored (first visit) or an org left since: settle on one, so the lists match the switch
  useEffect(() => {
    if (current && current.id !== active) pick(current.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, active]);

  if (!current) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={t("Organization")}
              className="border bg-card shadow-sm hover:bg-card data-[state=open]:bg-card"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Building2 className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block text-xs text-muted-foreground">{t("Organization")}</span>
                <span className="block truncate font-medium">{current.name}</span>
              </span>
              <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56 bg-popover">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("Organization")}</DropdownMenuLabel>
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} onSelect={() => org.id !== current.id && pick(org.id)} className="gap-2">
                <span className="truncate">{org.name}</span>
                {org.id === current.id && <Check className="ml-auto h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
