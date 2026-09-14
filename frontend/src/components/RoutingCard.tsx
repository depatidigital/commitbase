import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, Loader2, Plus, Route, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { type Application, type RoutingPart, hostList, setAppRouting } from "@/lib/applications";
import { t } from "@/lib/i18n";

type Row = { path: string | null; kind: "port" | "folder"; port: string; root: string; spa: boolean };

/** What the app is routed as now: its split, else one target — its port, or its folder. */
function rowsOf(application: Application): Row[] {
  const toRow = (part: { path: string | null; proxy?: string; root?: string; spa?: boolean }): Row => {
    const port = part.proxy?.match(/:(\d+)$/)?.[1];
    return port
      ? { path: part.path, kind: "port", port, root: "", spa: false }
      : { path: part.path, kind: "folder", port: "", root: part.root ?? "", spa: !!part.spa };
  };
  if (application.routing?.length) {
    // the hostname's own part (no path) last — the order Caddy tries them
    const parts = [...application.routing].sort((a, b) => Number(a.path === null) - Number(b.path === null));
    return parts.map(toRow);
  }
  return application.port
    ? [{ path: null, kind: "port", port: String(application.port), root: "", spa: false }]
    : [{ path: null, kind: "folder", port: "", root: application.rootPath ?? "", spa: false }];
}

/**
 * An imported app's routing by path — `/api/*` to its port, the rest a folder —
 * in the order Caddy tries it. Saved into Caddy at once (asked first), and
 * handed back as Caddyfile text to keep the server's own file in step.
 */
export function RoutingCard({ application }: { application: Application }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => rowsOf(application));
  const [confirming, setConfirming] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caddyfile, setCaddyfile] = useState<string | null>(null);

  const update = (index: number, patch: Partial<Row>) => setRows((all) => all.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((all) => {
      const next = [...all];
      [next[index], next[index + by]] = [next[index + by]!, next[index]!];
      return next;
    });
  // a new path goes before "everything else", which stays last
  const add = () => setRows((all) => [...all.slice(0, -1), { path: "/", kind: "port", port: "", root: "", spa: false }, all[all.length - 1]!]);

  const parts = (): RoutingPart[] =>
    rows.map((row) => ({
      path: row.path,
      ...(row.kind === "port" ? { port: Number(row.port) } : { root: row.root.trim(), spa: row.spa }),
    }));

  const save = async (ok: boolean) => {
    setSaving(true);
    try {
      const result = await setAppRouting(application.id, parts(), ok);
      setCaddyfile(result.caddyfile);
      toast({ title: t("Routing updated"), description: t("Visitors get it now.") });
      void queryClient.invalidateQueries({ queryKey: ["application", application.id] });
      void queryClient.invalidateQueries({ queryKey: ["deployments"] });
    } catch (error) {
      toast({ variant: "destructive", title: t("Could not update the routing"), description: error instanceof Error ? error.message : "" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Route className="h-5 w-5 text-primary" />
          {t("Routing")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("How {hosts} is served, by path — tried top to bottom.", { hosts: hostList(application) })}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {rows.map((row, index) => {
            const last = index === rows.length - 1;
            return (
              <div key={index} className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-2">
                {last ? (
                  <span className="w-40 shrink-0 text-sm text-muted-foreground">{t("everything else")}</span>
                ) : (
                  <Input className="w-40 shrink-0 font-mono text-sm" value={row.path ?? ""} placeholder="/api/*" onChange={(e) => update(index, { path: e.target.value })} />
                )}
                <span className="text-muted-foreground">→</span>
                <Select value={row.kind} onValueChange={(kind) => update(index, { kind: kind as Row["kind"] })}>
                  <SelectTrigger className="h-9 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="port">{t("Port")}</SelectItem>
                    <SelectItem value="folder">{t("Folder")}</SelectItem>
                  </SelectContent>
                </Select>
                {row.kind === "port" ? (
                  <Input className="w-28 font-mono text-sm" inputMode="numeric" value={row.port} placeholder="9200" onChange={(e) => update(index, { port: e.target.value })} />
                ) : (
                  <>
                    <Input className="min-w-[12rem] flex-1 font-mono text-sm" value={row.root} placeholder="/var/www/html/app/dist" onChange={(e) => update(index, { root: e.target.value })} />
                    <label className="flex items-center gap-1.5 text-xs" title={t("Unknown paths get index.html — for a front end with its own router.")}>
                      <Checkbox checked={row.spa} onCheckedChange={(checked) => update(index, { spa: checked === true })} />
                      SPA
                    </label>
                  </>
                )}
                {!last && (
                  <span className="ml-auto flex items-center">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("Move up")}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={index >= rows.length - 2} onClick={() => move(index, 1)} aria-label={t("Move down")}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setRows((all) => all.filter((_, i) => i !== index))}
                      aria-label={t("Remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" size="sm" onClick={add}>
            <Plus className="mr-2 h-4 w-4" />
            {t("Add path")}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setRows(rowsOf(application))} disabled={saving}>
              {t("Reset")}
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("Save routing")}
            </Button>
          </div>
        </div>

        {/* the same, for the server's Caddyfile — a reload from it would otherwise bring the old routing back */}
        {caddyfile && (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">{t("Copy this into the server's Caddyfile too, or a caddy reload from it brings the old routing back:")}</p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{caddyfile}</pre>
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1 h-7 w-7 p-0"
                aria-label={t("Copy")}
                onClick={() => {
                  void navigator.clipboard?.writeText(caddyfile);
                  toast({ title: t("Copied") });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          setConsent(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Change the routing of {hosts}?", { hosts: hostList(application) })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Caddy serves it this way as soon as it is saved. A wrong port or folder makes those paths answer with errors.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={consent} onCheckedChange={(checked) => setConsent(checked === true)} className="mt-0.5" />
            <span>{t("I understand visitors get the new routing at once.")}</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
            {/* taken at the click: closing the dialog clears the tick */}
            <AlertDialogAction disabled={!consent} onClick={() => void save(consent)}>
              {t("Save routing")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
