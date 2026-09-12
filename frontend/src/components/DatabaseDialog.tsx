import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database as DatabaseIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { attachDatabase, createDatabase, getAllDatabases } from "@/lib/databases";
import { ENV_NAME } from "@/lib/env";
import { t } from "@/lib/i18n";

interface DatabaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: { id: string; domain: string; organizationId?: string | null };
  /** after the URL is in the app's env */
  onConnected: (envKey: string) => void;
}

/** a database name from the app's hostname: `shop.acme.id` → `shop` */
const nameFrom = (domain: string) =>
  (domain.split(".")[0] || "app").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);

/**
 * Give an app a database: a new one on its organization's database server, or
 * one the organization already has. Either way its URL lands in the app's env
 * server-side (DATABASE_URL by default) — the password never reaches this page.
 */
export function DatabaseDialog({ open, onOpenChange, application, onConnected }: DatabaseDialogProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"create" | "existing">("create");
  const [name, setName] = useState(() => nameFrom(application.domain));
  const [engine, setEngine] = useState<"POSTGRESQL" | "MYSQL">("POSTGRESQL");
  const [existingId, setExistingId] = useState("");
  const [envKey, setEnvKey] = useState("DATABASE_URL");
  const [busy, setBusy] = useState(false);

  const existing = useQuery({
    queryKey: ["databases", "org", application.organizationId],
    queryFn: () => getAllDatabases({ page: 1, limit: 100, search: "", organizationId: application.organizationId ?? undefined }),
    enabled: open && !!application.organizationId,
  });
  const choices = (existing.data?.data ?? []).filter((db) => db.type === "POSTGRESQL" || db.type === "MYSQL");

  const valid = ENV_NAME.test(envKey) && (mode === "create" ? /^[a-z0-9_]{1,40}$/.test(name) : !!existingId);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const databaseId =
        mode === "create" ? (await createDatabase({ name, type: engine, applicationId: application.id })).id : existingId;
      await attachDatabase(databaseId, application.id, envKey);
      toast({ title: t("Database connected"), description: t("{key} is set in the app's environment.", { key: envKey }) });
      onConnected(envKey);
      onOpenChange(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Could not connect the database"),
        description: error instanceof Error ? error.message : "",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DatabaseIcon className="h-5 w-5 text-primary" />
            {t("Connect a database")}
          </DialogTitle>
          <DialogDescription>
            {t("Its connection URL is written to the app's environment. The password never leaves the server.")}
          </DialogDescription>
        </DialogHeader>

        <form id="database-connect" onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {(["create", "existing"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                  mode === value ? "border-primary bg-primary/5 font-medium text-primary" : "border-border/60 hover:border-primary/40"
                }`}
              >
                {value === "create" ? t("Create new") : t("Use existing")}
              </button>
            ))}
          </div>

          {mode === "create" ? (
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
              <div className="space-y-1">
                <Label htmlFor="db-name">{t("Name")}</Label>
                <Input id="db-name" className="font-mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
                <p className="text-xs text-muted-foreground">{t("Lowercase letters, digits and underscores.")}</p>
              </div>
              <div className="space-y-1">
                <Label>{t("Engine")}</Label>
                <Select value={engine} onValueChange={(value) => setEngine(value as "POSTGRESQL" | "MYSQL")}>
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POSTGRESQL">PostgreSQL</SelectItem>
                    <SelectItem value="MYSQL">MySQL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <Label>{t("Database")}</Label>
              {existing.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
              ) : choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("This organization has no databases yet — create a new one.")}</p>
              ) : (
                <Select value={existingId} onValueChange={setExistingId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("Choose a database")} />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((db) => (
                      <SelectItem key={db.id} value={db.id}>
                        {db.dbName || db.name} · {db.type === "POSTGRESQL" ? "PostgreSQL" : "MySQL"}
                        {db.application && db.application.id !== application.id && ` · ${t("used by {app}", { app: db.application.name })}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="db-env-key">{t("Environment variable")}</Label>
            <Input
              id="db-env-key"
              className={`font-mono ${ENV_NAME.test(envKey) ? "" : "border-destructive"}`}
              value={envKey}
              onChange={(e) => setEnvKey(e.target.value.trim())}
            />
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("Cancel")}
          </Button>
          <Button type="submit" form="database-connect" disabled={!valid || busy}>
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {mode === "create" ? t("Create & connect") : t("Connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
