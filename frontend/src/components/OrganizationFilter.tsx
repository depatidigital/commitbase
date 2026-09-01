import { OrganizationCombobox } from "@/components/OrganizationCombobox";
import { TableQuery } from "@/components/DataTable";
import { isAdmin } from "@/lib/auth";

/** Tenant filter for the platform-wide lists. Renders nothing for non-admins. */
export function OrganizationFilter({ query }: { query: TableQuery }) {
  if (!isAdmin()) return null;

  return (
    <OrganizationCombobox
      value={query.organizationId || null}
      onChange={(id) => query.setOrganizationId(id ?? "")}
      noneLabel="All organizations"
      className="w-52"
    />
  );
}
