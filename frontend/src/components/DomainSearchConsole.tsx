import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { addToSearchConsole, SearchConsoleResult } from "@/lib/domains";
import { t } from "@/lib/i18n";
import type { Domain } from "@/types/domain";

/**
 * Overview row: open the domain in Google Search Console, or (admins) add it.
 * On Cloudflare the TXT record is published for them; otherwise the dialog
 * shows the record to add at the registrar and "Verify" retries.
 */
export function DomainSearchConsole({ domain, admin }: { domain: Domain; admin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [owners, setOwners] = useState("");
  const [pending, setPending] = useState<Extract<SearchConsoleResult, { verified: false }> | null>(null);

  const siteUrl: string | undefined = domain.customConfig?.searchConsole?.siteUrl;

  const add = useMutation({
    mutationFn: () => addToSearchConsole(domain.id, owners),
    onSuccess: (result) => {
      if (!result.verified) {
        setPending(result);
        return;
      }
      setOpen(false);
      setPending(null);
      void queryClient.invalidateQueries({ queryKey: ["domains"] });
      toast({ title: t("Added to Google Search Console"), description: result.owners.join(", ") });
    },
    onError: (error: Error) =>
      toast({ variant: "destructive", title: t("Failed to add to Search Console"), description: error.message }),
  });

  if (!siteUrl && !admin) return null;

  return (
    <div className="flex items-center justify-between gap-2 border-t pt-2 text-sm">
      <span className="text-muted-foreground">Search Console</span>
      {siteUrl ? (
        <a
          className="inline-flex items-center gap-1 text-primary hover:underline"
          href={`https://search.google.com/search-console?resource_id=${encodeURIComponent(siteUrl)}`}
          target="_blank"
          rel="noreferrer"
        >
          {t("Open")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : (
        <Button variant="outline" size="sm" className="h-7" onClick={() => setOpen(true)}>
          {t("Add to Search Console")}
        </Button>
      )}

      <Dialog open={open} onOpenChange={(next) => !add.isPending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Add {name} to Google Search Console", { name: domain.name })}</DialogTitle>
            <DialogDescription>
              {domain.cfZoneId
                ? t("The verification TXT record is added to Cloudflare for you.")
                : t("This domain is not on Cloudflare, so you will add the verification TXT record at the registrar yourself.")}
            </DialogDescription>
          </DialogHeader>

          <form
            id="search-console"
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="sc-owners">{t("Google accounts to give owner access")}</Label>
              <Input
                id="sc-owners"
                placeholder="you@gmail.com, client@example.com"
                value={owners}
                onChange={(e) => setOwners(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("Optional. Added on top of the defaults set under Integrations.")}
              </p>
            </div>

            {pending && (
              <div className="space-y-2 rounded-md border border-warning/50 p-3 text-xs">
                <p>{t("Google has not seen the record yet. Add it (if it is not there), wait a minute, then verify again.")}</p>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <span className="text-muted-foreground">{t("Type")}</span>
                  <span className="font-mono">TXT</span>
                  <span className="text-muted-foreground">{t("Name")}</span>
                  <span className="font-mono break-all">@ ({pending.record.name})</span>
                  <span className="text-muted-foreground">{t("Value")}</span>
                  <span className="font-mono break-all select-all">{pending.record.content}</span>
                </div>
                <p className="text-muted-foreground">{pending.reason}</p>
              </div>
            )}
          </form>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={add.isPending}>
              {t("Cancel")}
            </Button>
            <Button type="submit" form="search-console" disabled={add.isPending}>
              {add.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {pending ? t("Verify again") : t("Add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
