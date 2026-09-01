import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";

const NotFound = () => {
  const location = useLocation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="text-center">
        <Compass className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
        <h1 className="mb-2 text-4xl font-bold">404</h1>
        <p className="mb-1 text-muted-foreground">
          No page at <code className="font-mono">{location.pathname}</code>
        </p>
        <p className="mb-6 text-sm text-muted-foreground">
          It may have moved, or you may not have access to it.
        </p>
        <Button asChild>
          <Link to="/">Back to applications</Link>
        </Button>
      </div>
    </div>
  );
};

export default NotFound;
