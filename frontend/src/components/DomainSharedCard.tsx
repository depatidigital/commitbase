import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { setDomainShared } from "@/lib/domains";
import { t } from "@/lib/i18n";
import type { Domain } from "@/types/domain";

/** Admin switch: offer this domain to every organization for free app addresses. */
export function DomainSharedCard({ domain }: { domain: Domain }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (shared: boolean) => setDomainShared(domain.id, shared),
    onSuccess: (message) => {
      toast({ title: message });
      void queryClient.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: t("Could not update the domain"), description: error.message }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{t("Shared platform domain")}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-start justify-between gap-4 pt-0">
        <p className="text-sm text-muted-foreground">
          {t(
            "Every organization can put apps under {name} (shop.{name}) without a domain of its own. The root and names that already exist stay yours. Turning it off leaves existing apps where they are.",
            { name: domain.name },
          )}
        </p>
        <Switch
          checked={!!domain.shared}
          disabled={toggle.isPending || (!domain.cfZoneId && !domain.shared)}
          onCheckedChange={(checked) => toggle.mutate(checked)}
          aria-label={t("Shared platform domain")}
        />
      </CardContent>
    </Card>
  );
}
