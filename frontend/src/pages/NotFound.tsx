import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";
import { t } from "@/lib/i18n";

const NotFound = () => {
  const location = useLocation();
  // {path} is left in by t() so it can be set as code
  const [before, after] = t("No page at {path}").split("{path}");

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="text-center">
        <Compass className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="mb-2 text-4xl font-bold">404</h1>
        <p className="mb-1 text-muted-foreground">
          {before}<code className="font-mono">{location.pathname}</code>{after}
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          {t("It may have moved, or you may not have access to it.")}
        </p>
        <Button asChild>
          <Link to="/">{t("Back to applications")}</Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
