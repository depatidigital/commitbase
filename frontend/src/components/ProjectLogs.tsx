import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, EyeOff, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLogStream } from "@/hooks/useLogs";
import { parseAnsi, stripAnsi } from "@/lib/ansi";
import { t } from "@/lib/i18n";

const ALL = "all";

/**
 * A project's log, live: every app of it in one stream — each line names its
 * app (pm2's `0|name |`, or `name |`) — or one app picked. Open only while the
 * tab is: it holds an SSH channel on the project's node.
 */
export function ProjectLogs({ projectId, apps }: { projectId: string; apps: Array<{ id: string; name: string }> }) {
  const { toast } = useToast();
  const [app, setApp] = useState(ALL);
  const [type, setType] = useState("combined");
  const [lines, setLines] = useState(100);
  const [raw, setRaw] = useState(false);
  const query = new URLSearchParams({ type, lines: String(lines), ...(app !== ALL && { app }) });
  const { text, error } = useLogStream(`/logs/project/${projectId}/stream?${query}`, true);
  const segments = useMemo(() => (text && !raw ? parseAnsi(text) : []), [text, raw]);
  // follows the newest line — the box only, never the page
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);

  return (
    <Card className="bg-gradient-card border-border/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-primary" />
          {t("Logs")}
          {!error && (
            <Badge variant="outline" className="gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-green-500" />
              {t("Live")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={app} onValueChange={setApp}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All apps")}</SelectItem>
              {apps.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="combined">{t("Combined Logs")}</SelectItem>
              <SelectItem value="out">{t("Output Logs")}</SelectItem>
              <SelectItem value="error">{t("Error Logs")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(lines)} onValueChange={(value) => setLines(Number(value))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 100, 200, 500].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t("{n} lines", { n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={() => setRaw(!raw)}>
            {raw ? <EyeOff className="mr-2 h-4 w-4" /> : <Eye className="mr-2 h-4 w-4" />}
            {raw ? t("Formatted") : t("Raw")}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(stripAnsi(text));
              toast({ title: t("Copied"), description: t("Text copied to clipboard") });
            }}
          >
            <Copy className="mr-2 h-4 w-4" />
            {t("Copy")}
          </Button>
        </div>

        <div ref={box} className="h-[32rem] overflow-auto rounded-md border">
          <div className="p-4">
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : text ? (
              <pre className="whitespace-pre-wrap font-mono text-sm">
                {raw
                  ? stripAnsi(text)
                  : segments.map((segment, i) => (
                      <span key={i} className={segment.className}>
                        {segment.text}
                      </span>
                    ))}
              </pre>
            ) : (
              <div className="py-8 text-center text-muted-foreground">
                <Terminal className="mx-auto mb-2 h-8 w-8" />
                <p>{t("Waiting for log lines…")}</p>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
