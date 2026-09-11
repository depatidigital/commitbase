import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { TableQuery } from "@/components/DataTable";
import { isAdmin } from "@/lib/auth";
import { t } from "@/lib/i18n";

/**
 * Tenant filter for the platform-wide lists. Renders nothing for non-admins.
 * `unassigned` adds an entry for rows with no organization — only for lists
 * whose endpoint reads `organizationId=unassigned` (applications).
 */
export function OrganizationFilter({ query, unassigned }: { query: TableQuery; unassigned?: boolean }) {
  if (!isAdmin()) return null;

  return (
    <OrganizationCombobox
      value={query.organizationId || null}
      onChange={(id) => query.setOrganizationId(id ?? "")}
      noneLabel={t("All organizations")}
      extraOptions={unassigned ? [{ value: "unassigned", label: t("Unassigned") }] : []}
      className="w-52"
    />
  );
}
