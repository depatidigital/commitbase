import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Box, ChevronDown, ChevronRight, Eye, EyeOff, Hammer, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getStackServices, type StackService } from "@/lib/applications";
import { isSecret } from "@/lib/env";
import { t } from "@/lib/i18n";

// the container side of the first published port: what Caddy should dial
const portOf = (service: StackService) => service.ports[0]?.split(":").pop() ?? "";

/** The stack's services, as the node reads them; the picker and the list share one read. */
const useStackServices = (applicationId: string) =>
  useQuery({
    queryKey: ["application", applicationId, "compose-services"],
    queryFn: () => getStackServices(applicationId),
    retry: false,
    staleTime: 60_000,
  });

/**
 * Which service takes the hosts' traffic — only one can, so a dropdown of
 * the services that publish a port (not db, redis…). Compose files not
 * readable yet: a plain name box when `typeable` (a form saved by hand, the
 * port left to its own field), else the error.
 */
export function ComposeServiceSelect({
  applicationId,
  value,
  onPick,
  className = "",
  typeable = false,
}: {
  applicationId: string;
  value: string;
  onPick: (service: string, port: string) => void;
  className?: string;
  typeable?: boolean;
}) {
  const { data, error } = useStackServices(applicationId);
  if (error && !typeable) return <span className="min-w-0 truncate text-xs text-destructive">{(error as Error).message}</span>;
  if (error) {
    return <Input value={value} onChange={(e) => onPick(e.target.value, "")} placeholder="web" className={`font-mono ${className}`} />;
  }
  const web = data?.filter((service) => portOf(service)) ?? [];
  return (
    <Select
      value={value}
      disabled={!data}
      onValueChange={(name) => {
        const service = web.find((s) => s.name === name);
        if (service) onPick(service.name, portOf(service));
      }}
    >
      <SelectTrigger className={`font-mono ${className}`}>
        <SelectValue placeholder={data ? t("Pick a service") : t("Reading the compose files…")} />
      </SelectTrigger>
      <SelectContent>
        {/* saved before its port went away: still shown, so the value is not blank */}
        {value && !web.some((s) => s.name === value) && <SelectItem value={value}>{value}</SelectItem>}
        {web.map((service) => (
          <SelectItem key={service.name} value={service.name}>
            {t("{service} (port {port})", { service: service.name, port: portOf(service) })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * What a compose stack defines — every service, built or pulled, what it
 * publishes and waits on — read on the node from the saved compose files.
 * Shows which one serves traffic; picking it is ComposeServiceSelect's.
 */
export function ComposePreview({ applicationId, selected }: { applicationId: string; selected: string }) {
  const { data, error, isFetching, refetch } = useStackServices(applicationId);
  // the service whose env is open, one at a time
  const [openEnv, setOpenEnv] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{t("Services in the stack")}</span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" disabled={isFetching} onClick={() => void refetch()}>
          {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{(error as Error).message}</span>
        </p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">{t("Reading the compose files…")}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {data.map((service) => {
            const envCount = Object.keys(service.environment ?? {}).length;
            const envOpen = openEnv === service.name;
            return (
              <Fragment key={service.name}>
                <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
                  <span className="min-w-24 font-mono font-medium">{service.name}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
                    {service.build ? <Hammer className="h-3 w-3 shrink-0" /> : <Box className="h-3 w-3 shrink-0" />}
                    <span className="truncate font-mono">{service.build ? t("built from the repository") : service.image}</span>
                  </span>
                  {service.ports.map((p) => (
                    <Badge key={p} variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
                      {p}
                    </Badge>
                  ))}
                  {service.dependsOn.length > 0 && (
                    <span className="text-muted-foreground">{t("needs {services}", { services: service.dependsOn.join(", ") })}</span>
                  )}
                  {/* what this container gets — from which files, with what values */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-xs"
                    aria-expanded={envOpen}
                    disabled={envCount === 0}
                    onClick={() => setOpenEnv(envOpen ? null : service.name)}
                  >
                    {envOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    {t("Env ({count})", { count: envCount })}
                  </Button>
                  {selected === service.name && <Badge className="px-1.5 py-0 text-[10px]">{t("Serves traffic")}</Badge>}
                </li>
                {envOpen && <ServiceEnv service={service} />}
              </Fragment>
            );
          })}
        </ul>
      )}
      <p className="text-[11px] text-muted-foreground">{t("From the saved compose files — save a change to them to see it here.")}</p>
    </div>
  );
}

/** One service's environment as its container gets it; secrets hidden until asked. */
function ServiceEnv({ service }: { service: StackService }) {
  const [reveal, setReveal] = useState(false);
  const entries = Object.entries(service.environment).sort(([a], [b]) => a.localeCompare(b));
  return (
    <li className="space-y-1.5 bg-muted/30 px-2 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
        <span>
          {service.envFiles.length
            ? t("From {files}, then the compose file's environment:", { files: service.envFiles.join(", ") })
            : t("From the compose file's environment:")}
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => setReveal(!reveal)}>
          {reveal ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          {reveal ? t("Hide values") : t("Show values")}
        </Button>
      </div>
      <div className="max-h-60 overflow-auto rounded border border-border/60 bg-background">
        <table className="w-full font-mono text-[11px]">
          <tbody className="divide-y divide-border/60">
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td className="whitespace-nowrap px-2 py-0.5 align-top">{key}</td>
                <td className="break-all px-2 py-0.5 text-muted-foreground">
                  {value === "" ? <span className="italic">{t("(empty)")}</span> : !reveal && isSecret(key) ? "••••••••" : value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </li>
  );
}
