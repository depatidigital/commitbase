import type { ReactNode } from "react";
import { CheckCircle2 } from "lucide-react";

/** One numbered step of a Quick start guide, ticked once `done`. */
export function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-4 rounded-lg border bg-card p-4 shadow-sm sm:p-5">
      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${done ? "bg-success/15 text-success" : "bg-primary/10 text-primary"}`}>
        {done ? <CheckCircle2 className="h-4 w-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="font-medium leading-7">{title}</h3>
        {children}
      </div>
    </section>
  );
}
