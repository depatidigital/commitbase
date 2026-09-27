import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { createTopUp, getTopUps, type TopUp } from "@/lib/arusniaga";
import { fromMicro, rupiah } from "@/lib/ai";
import { locale, t } from "@/lib/i18n";

const PRESETS = [50_000, 100_000, 250_000, 500_000, 1_000_000];
const STATUS: Record<string, string> = { PENDING: "Waiting for payment", PAID: "Paid", CANCELLED: "Cancelled", EXPIRED: "Expired" };

/**
 * Top up the workspace's balance: an invoice in ArusNiaga, paid on its invoice page; the
 * balance follows within a minute of it being paid. The button, and the unpaid ones.
 */
export function TopUpButton() {
  const { data } = useQuery({ queryKey: ["billing", "topups"], queryFn: getTopUps, refetchInterval: (q) => (q.state.data?.topUps.some((x) => x.status === "PENDING") ? 20_000 : false) });
  const [open, setOpen] = useState(false);
  if (!data?.enabled) return <p className="mt-1 text-xs text-muted-foreground">{t("To top up, contact support.")}</p>;
  const pending = data.topUps.filter((x) => x.status === "PENDING");
  return (
    <div className="mt-2 space-y-2">
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-4 w-4" /> {t("Top up")}
      </Button>
      {pending.map((x) => (
        <PendingTopUp key={x.id} topUp={x} />
      ))}
      {open && <TopUpDialog min={data.min} max={data.max} onClose={() => setOpen(false)} />}
    </div>
  );
}

function PendingTopUp({ topUp }: { topUp: TopUp }) {
  return (
    <p className="text-xs text-muted-foreground">
      {t("{amount} waiting for payment", { amount: rupiah(fromMicro(topUp.amount)) })}
      {topUp.invoiceUrl && (
        <>
          {" · "}
          <a href={topUp.invoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            {t("Pay")} {topUp.invoiceRef} <ExternalLink className="h-3 w-3" />
          </a>
        </>
      )}
    </p>
  );
}

function TopUpDialog({ min, max, onClose }: { min: number; max: number; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(PRESETS[1]));
  const [issued, setIssued] = useState<TopUp | null>(null);
  const value = Number(amount);
  const valid = Number.isInteger(value) && value >= min && value <= max;

  const create = useMutation({
    mutationFn: () => createTopUp(value),
    onSuccess: (topUp) => {
      setIssued(topUp);
      void queryClient.invalidateQueries({ queryKey: ["billing", "topups"] });
      // the invoice page, where it is paid
      if (topUp.invoiceUrl) window.open(topUp.invoiceUrl, "_blank", "noopener");
    },
    onError: (error: Error) => toast({ title: t("Could not create the top-up"), description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Top up the balance")}</DialogTitle>
          <DialogDescription>{t("An invoice is issued for the amount. Pay it on its page; the balance follows within a minute of the payment.")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {issued ? (
            <div className="space-y-2 text-sm">
              <p>{t("Invoice {ref} for {amount} is ready.", { ref: issued.invoiceRef ?? "", amount: rupiah(issued.invoiceTotal ?? fromMicro(issued.amount)) })}</p>
              {issued.invoiceUrl && (
                <Button asChild variant="outline" size="sm">
                  <a href={issued.invoiceUrl} target="_blank" rel="noreferrer">
                    {t("Open the invoice to pay")} <ExternalLink className="ml-1 h-3.5 w-3.5" />
                  </a>
                </Button>
              )}
            </div>
          ) : (
            <form
              id="top-up"
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) create.mutate();
              }}
            >
              <div className="flex flex-wrap gap-2">
                {PRESETS.filter((p) => p >= min && p <= max).map((p) => (
                  <Button key={p} type="button" size="sm" variant={value === p ? "default" : "outline"} onClick={() => setAmount(String(p))}>
                    {rupiah(p)}
                  </Button>
                ))}
              </div>
              <div className="space-y-1">
                <Label htmlFor="top-up-amount">{t("Amount (Rp)")} *</Label>
                <Input id="top-up-amount" type="number" required min={min} max={max} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} />
                <p className="text-xs text-muted-foreground">
                  {t("From {min} to {max}.", { min: rupiah(min), max: rupiah(max) })}
                </p>
              </div>
            </form>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {issued ? t("Done") : t("Cancel")}
          </Button>
          {!issued && (
            <Button type="submit" form="top-up" disabled={!valid || create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Issue invoice")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A top-up's status, in words. */
export const topUpStatus = (status: string) => t(STATUS[status] ?? status);
export const topUpDate = (at: string | null) => (at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "—");
