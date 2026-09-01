import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageLayoutProps {
  title: ReactNode;
  /** Detail pages: renders a back arrow left of the title. */
  backTo?: string;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Buttons or filters that belong beside the title. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Standard page frame: title block on the left, actions on the right, content below. */
export function PageLayout({
  title,
  backTo,
  description,
  icon: Icon,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-2">
          {backTo && (
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="mt-0.5 h-8 w-8 shrink-0"
              aria-label="Back"
            >
              <Link to={backTo}>
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
          )}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              {Icon && <Icon className="h-5 w-5" />}
              {title}
            </h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>

      {children}
    </div>
  );
}
