import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import apiRequest from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * `a "b c" d` → ["a", "b c", "d"]: the command as the list the endpoint takes.
 * Quotes group, nothing else is special — it reaches a real exec, not a shell.
 */
export const splitArgv = (line: string): string[] =>
  [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);

type ExecOutput = { stdout: string; stderr: string; code?: number };

/**
 * One command inside a service of a compose stack — a migration, `ckan ...
 * initdb`, a user. No TTY: a command that asks a question hangs until its
 * timeout, so pass answers as arguments. Org admins only, and every run is logged.
 */
export function StackExecCard({ applicationId, defaultService }: { applicationId: string; defaultService: string | null }) {
  const [service, setService] = useState(defaultService ?? "");
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<ExecOutput | null>(null);

  const exec = useMutation({
    mutationFn: async () => {
      const res = await apiRequest<ExecOutput>(`/applications/${applicationId}/exec`, {
        method: "POST",
        body: JSON.stringify({ service: service.trim() || undefined, argv: splitArgv(command) }),
      });
      // a non-zero exit comes back with its output — show it, it is the answer
      if (res.data) return { ...res.data, ...(res.success ? {} : { code: res.data.code ?? 1 }) };
      throw new Error(res.error || t("Command failed"));
    },
    onSuccess: setOutput,
    onError: (error: Error) => setOutput({ stdout: "", stderr: error.message, code: 1 }),
  });

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-medium">{t("Run a command in the stack")}</p>
        <p className="text-xs text-muted-foreground">
          {t("compose exec, without a terminal: pass answers as arguments, a prompt would wait until it times out.")}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
        <Input value={service} onChange={(e) => setService(e.target.value)} placeholder={t("service")} className="font-mono" />
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && command.trim() && exec.mutate()}
          placeholder="ckan -c production.ini resourceauthorizer initdb"
          className="font-mono"
        />
        <Button type="button" onClick={() => exec.mutate()} disabled={!command.trim() || exec.isPending}>
          {exec.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          {t("Run")}
        </Button>
      </div>
      {output && (
        <pre className={`max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs ${output.code ? "text-destructive" : ""}`}>
          {output.code ? `${t("Exited {code}", { code: String(output.code) })}\n` : ""}
          {output.stdout}
          {output.stderr}
        </pre>
      )}
    </div>
  );
}
