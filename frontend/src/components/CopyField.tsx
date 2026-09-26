import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/** A secret or connect string to hand on: shown in full, one click to copy. */
export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 shrink-0 p-0"
        aria-label={t("Copy")}
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
