import { useState, type ReactNode } from "react";
import { Globe } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";

/**
 * The site's icon — what its page declares, else /favicon.ico — found and served
 * by the panel (the browser cannot read another site's HTML); the fallback (a
 * globe) when it has none or is down. A badge sits on its corner — only over a real favicon.
 */
export function Favicon({ host, className = "h-4 w-4", fallback, badge }: { host: string; className?: string; fallback?: ReactNode; badge?: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback ?? <Globe className={`${className} shrink-0 text-muted-foreground`} />}</>;
  const img = <img src={`${API_BASE_URL}/favicon/${encodeURIComponent(host)}`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className={`${className} shrink-0 rounded-sm`} />;
  if (!badge) return img;
  return (
    <span className="relative inline-flex shrink-0">
      {img}
      <span className="absolute -bottom-1.5 -right-1.5">{badge}</span>
    </span>
  );
}
