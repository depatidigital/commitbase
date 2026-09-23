import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
    <Select value={current.id} onValueChange={pick}>
      {/* no wrapper span: the trigger line-clamps its direct spans, which stacks a flex row */}
      <SelectTrigger
        aria-label={t("Organization")}
        className="h-10 w-full justify-start gap-2 bg-card text-left [&>span]:min-w-0 [&>svg:last-child]:ml-auto [&>svg:last-child]:shrink-0"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {organizations.map((org) => (
          <SelectItem key={org.id} value={org.id}>
            {org.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
