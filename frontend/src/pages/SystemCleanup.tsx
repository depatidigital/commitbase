import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Loader2, Trash2 } from "lucide-react";
import { PageLayout } from "@/components/PageLayout";
import { ServerStorage } from "@/components/ServerStorage";
import { MailboxesCard } from "@/components/StalwartCards";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { diskTone, diskUsedPct, getServers } from "@/lib/servers";
import { getStalwartConfig } from "@/lib/stalwart";
import { t } from "@/lib/i18n";

/**
 * Every place the platform can be cleaned up, on one page (superadmin): each
 * node's disk — its apps' old releases and caches, and the node's own
 * leftovers — a tab per node, fullest first; and the mail server's mailboxes.
 * The same cards as on a server's Storage tab and the Stalwart page.
 */
export default function SystemCleanup() {
  const [params, setParams] = useSearchParams();
  const { data: servers = [], isLoading } = useQuery({ queryKey: ["servers"], queryFn: getServers });
  const { data: stalwart } = useQuery({ queryKey: ["integrations", "stalwart"], queryFn: getStalwartConfig, retry: false });
  const mail = !!stalwart?.passwordSet && !stalwart.error;
  // the one that needs it most leads
  const nodes = [...servers].sort((a, b) => diskUsedPct(b.disk) - diskUsedPct(a.disk));
  const tab = params.get("tab") ?? nodes[0]?.id ?? (mail ? "mail" : "");

  return (
    <PageLayout title={t("System cleanup")} description={t("Free disk on every node, and in the mailboxes, from one place.")} icon={Trash2}>
      {isLoading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : !nodes.length && !mail ? (
        <p className="text-sm text-muted-foreground">{t("No node to clean up yet.")}</p>
      ) : (
        <Tabs value={tab} onValueChange={(next) => setParams({ tab: next }, { replace: true })} className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start">
            {nodes.map((node) => (
              <TabsTrigger key={node.id} value={node.id} className="gap-1.5">
                {node.name}
                {node.disk && <span className={`text-xs tabular-nums ${diskTone(diskUsedPct(node.disk)).text}`}>{Math.round(diskUsedPct(node.disk))}%</span>}
              </TabsTrigger>
            ))}
            {mail && <TabsTrigger value="mail">{t("Mailboxes")}</TabsTrigger>}
          </TabsList>
          {/* only the open tab measures its node: a walk of every disk at once is what this page avoids */}
          {nodes.map((node) => (
            <TabsContent key={node.id} value={node.id}>
              {tab === node.id && <ServerStorage serverId={node.id} />}
            </TabsContent>
          ))}
          {mail && (
            <TabsContent value="mail">
              {tab === "mail" && <MailboxesCard />}
            </TabsContent>
          )}
        </Tabs>
      )}
    </PageLayout>
  );
}
