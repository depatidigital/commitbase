import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Gift, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { giftCredit } from "@/lib/organizations";
import { fromMicro, rupiah } from "@/lib/ai";
import { t } from "@/lib/i18n";

const PRESETS = [25_000, 50_000, 100_000, 250_000, 500_000];
const MIN = 1_000;
const MAX = 10_000_000;

/** A platform admin gives a workspace credit: a "Gift" on its statement, with who gave it. */
export function GiftCreditDialog({ organizationId, name, onClose }: { organizationId: string; name: string; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState(String(PRESETS[1]));
  const [note, setNote] = useState("");
  const value = Number(amount);
  const valid = Number.isInteger(value) && value >= MIN && value <= MAX;

  const gift = useMutation({
    mutationFn: () => giftCredit(organizationId, value, note),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["organizations", organizationId] });
      void queryClient.invalidateQueries({ queryKey: ["billing"] });
      toast({ title: t("Credit gifted"), description: t("{name} now has {balance}.", { name, balance: rupiah(fromMicro(r.balance)) }) });
      onClose();
    },
    onError: (error: Error) => toast({ title: t("Could not gift the credit"), description: error.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Gift credit to {name}", { name })}</DialogTitle>
          <DialogDescription>{t("Added to its balance at once, shown on its statement as a gift. It cannot be taken back here.")}</DialogDescription>
        </DialogHeader>
        <form
          id="gift-credit"
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) gift.mutate();
          }}
        >
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button key={p} type="button" size="sm" variant={value === p ? "default" : "outline"} onClick={() => setAmount(String(p))}>
                {rupiah(p)}
              </Button>
            ))}
          </div>
          <div className="space-y-1">
            <Label htmlFor="gift-amount">{t("Amount (Rp)")} *</Label>
            <Input id="gift-amount" type="number" required min={MIN} max={MAX} step={1000} value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("From {min} to {max}.", { min: rupiah(MIN), max: rupiah(MAX) })}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="gift-note">{t("Note")}</Label>
            <Input id="gift-note" maxLength={200} placeholder={t("e.g. Beta tester, sorry for the downtime")} value={note} onChange={(e) => setNote(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("Shown on the workspace's statement.")}</p>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={gift.isPending}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="gift-credit" disabled={!valid || gift.isPending}>
            {gift.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Gift className="mr-2 h-4 w-4" />}
            {t("Gift {amount}", { amount: valid ? rupiah(value) : "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
