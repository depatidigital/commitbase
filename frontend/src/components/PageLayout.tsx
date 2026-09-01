import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";

interface PageLayoutProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Buttons or filters that belong beside the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Standard page frame: title block on the left, actions on the right, content below. */
export function PageLayout({
  title,
  description,
  icon: Icon,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {Icon && <Icon className="h-5 w-5" />}
            {title}
          </h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {children}
    </div>
  );
}
