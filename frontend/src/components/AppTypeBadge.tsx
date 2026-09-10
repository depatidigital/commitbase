import { Code2, FileCode, Hexagon, Layers, Globe } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/**
 * What kind of app a row is, and — for the ones that have it — the loopback
 * port its proxy dials.
 *
 * The port lives here rather than beside the hostname on purpose: it is a
 * property of how the app runs, not of how it is reached. Written next to the
 * domain it read as `example.com:2400`, which looks like a public socket
 * anybody could connect to, and it is not one.
 */

const TYPES: Record<
  string,
  { label: string; icon: typeof Hexagon; className: string }
> = {
  NODEJS: { label: "Node.js", icon: Hexagon, className: "text-success" },
  PHP: { label: "PHP", icon: FileCode, className: "text-primary" },
  PYTHON: { label: "Python", icon: Code2, className: "text-warning" },
  STATIC: { label: "Static", icon: Globe, className: "text-muted-foreground" },
};

export const AppTypeBadge = ({
  type,
  port,
}: {
  type: string;
  /** Loopback port on the node, when the app is a proxied runtime. */
  port?: number | null;
}) => {
  const meta = TYPES[type] ?? {
    label: type.toLowerCase(),
    icon: Layers,
    className: "text-muted-foreground",
  };
  const Icon = meta.icon;

  return (
    <div className="space-y-0.5">
      <Badge variant="secondary" className="gap-1">
        <Icon className={`h-3 w-3 ${meta.className}`} />
        {meta.label}
      </Badge>
      {port ? (
        <span
          className="block font-mono text-xs text-muted-foreground"
          title={`Internal only — the proxy dials 127.0.0.1:${port} on the node`}
        >
          :{port}
        </span>
      ) : null}
    </div>
  );
};

export default AppTypeBadge;
