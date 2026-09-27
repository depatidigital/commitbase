import { Fragment } from "react";
import { Check } from "lucide-react";

/**
 * Where someone is in a few-screen flow: numbered steps on a line, the done
 * ones ticked, the current one lit. Display only — each screen is its own page.
 */
export function Stepper({ steps, current }: { steps: string[]; /** 0-based */ current: number }) {
  return (
    // kept together in the middle, not spread over the page
    <ol className="mx-auto flex max-w-md items-center gap-3">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <Fragment key={label}>
            {i > 0 && <li aria-hidden className={`h-px flex-1 ${done || active ? "bg-primary" : "bg-border"}`} />}
            <li className="flex shrink-0 items-center gap-2" aria-current={active ? "step" : undefined}>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                  done ? "bg-primary text-primary-foreground" : active ? "border-2 border-primary text-primary" : "border border-border text-muted-foreground"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <span className={`text-sm ${active ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
