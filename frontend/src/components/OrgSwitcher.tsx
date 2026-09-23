import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { createOrganization, getOrganizations } from "@/lib/organizations";
import { getActiveOrg, setActiveOrg } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * The workspace (an organization in the API) every page works in. Sent as X-Organization-Id on each
 * request (lib/api), and the API narrows its lists to it — so pages need no
 * organization column or filter of their own.
 */
export function OrgSwitcher() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: organizations = [] } = useQuery({ queryKey: ["organizations", "mine"], queryFn: getOrganizations });
  // state, not a storage read per render: writing localStorage re-renders nothing, so the name stayed stale
  const [active, setActive] = useState(getActiveOrg);
  const current = organizations.find((org) => org.id === active) ?? organizations[0];

  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => createOrganization({ name: name.trim() }),
    onSuccess: (workspace) => {
      setCreating(false);
      setName("");
      pick(workspace.id);
      toast({ title: t("Workspace created"), description: workspace.name });
    },
    onError: (err: Error) => toast({ title: t("Failed to create workspace"), description: err.message, variant: "destructive" }),
  });

  const pick = (id: string) => {
    setActiveOrg(id);
    setActive(id);
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
              aria-label={t("Workspace")}
              className="border bg-card shadow-sm hover:bg-card data-[state=open]:bg-card"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Building2 className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 text-left leading-tight">
                <span className="block text-xs text-muted-foreground">{t("Workspace")}</span>
                <span className="block truncate font-medium">{current.name}</span>
              </span>
              <ChevronsUpDown className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[--radix-dropdown-menu-trigger-width] min-w-56 bg-popover">
            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("Workspace")}</DropdownMenuLabel>
            {organizations.map((org) => (
              <DropdownMenuItem key={org.id} onSelect={() => org.id !== current.id && pick(org.id)} className="gap-2">
                <span className="truncate">{org.name}</span>
                {org.id === current.id && <Check className="ml-auto h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              {t("New workspace")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("New workspace")}</DialogTitle>
              <DialogDescription>{t("One per client or business: its own projects, domains, databases and team.")}</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim().length >= 2) create.mutate();
              }}
              className="space-y-4"
            >
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("e.g. Warung Kopi Senja")} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setCreating(false)}>
                  {t("Cancel")}
                </Button>
                <Button type="submit" disabled={name.trim().length < 2 || create.isPending}>
                  {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("Create")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
