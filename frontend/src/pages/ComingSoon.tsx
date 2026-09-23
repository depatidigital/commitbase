import type { LucideIcon } from "lucide-react";
import { PageLayout } from "@/components/PageLayout";
import { t } from "@/lib/i18n";

/** A service on the menu before it is built: its name, its one goal, and that it is on the way. */
export default function ComingSoon({ title, description, icon: Icon }: { title: string; description: string; icon: LucideIcon }) {
  return (
    <PageLayout icon={Icon} title={title} description={description}>
      <div className="flex h-64 flex-col items-center justify-center rounded-md border border-dashed text-center">
        <Icon className="mb-3 h-10 w-10 text-muted-foreground" />
        <p className="font-medium">{t("Coming soon")}</p>
      </div>
    </PageLayout>
  );
}
