import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProvisionBadge } from "@/components/ProvisionBadge";
import { isProvisionPending, type OrgNode } from "@/lib/organizations";
import { t } from "@/lib/i18n";

/**
 * An organization's nodes, one badge each. An org is provisioned only on the
 * nodes its apps run on, so this is the whole picture of where it exists.
 * Clicking a badge opens that node's provisioning output.
 */
export function OrgNodeBadges({ nodes, onOpen }: { nodes: OrgNode[]; onOpen?: (node: OrgNode) => void }) {
  if (nodes.length === 0) return <span className="text-xs text-muted-foreground">{t("On no server yet")}</span>;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
      {nodes.map((node) => (
        <span key={node.id} className="flex min-w-0 items-center gap-1 text-xs">
          <span className="truncate">{node.server.name}</span>
          <ProvisionBadge
            state={node.state}
            error={node.error}
            at={node.provisionedAt}
            onClick={onOpen && (node.log || isProvisionPending(node.state)) ? () => onOpen(node) : undefined}
          />
        </span>
      ))}
    </div>
  );
}

/** True while any node of any of these orgs is being provisioned — the pages poll while it is. */
export const anyNodePending = (orgs: Array<{ nodes: OrgNode[] }> | undefined) =>
  !!orgs?.some((o) => o.nodes.some((n) => isProvisionPending(n.state)));

/**
 * One node's provisioning output. `node` comes from the page's polled data, so
 * the output grows while the run is going; it follows the tail unless the
 * reader scrolled up.
 */
export function OrgNodeLogDialog({ orgName, node, onClose }: { orgName: string; node: OrgNode | null; onClose: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [node?.log]);

  return (
    <Dialog open={!!node} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t("Provisioning output — {name}", { name: `${orgName} @ ${node?.server.name ?? ""}` })}
            {node && <ProvisionBadge state={node.state} />}
          </DialogTitle>
          {node?.error && <DialogDescription className="text-destructive">{node.error}</DialogDescription>}
        </DialogHeader>
        <pre ref={ref} className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
          {node?.log || (node?.state === "QUEUED" ? t("Waiting to start…") : t("Waiting for output…"))}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
