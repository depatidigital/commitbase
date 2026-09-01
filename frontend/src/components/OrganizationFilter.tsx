import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableQuery } from "@/components/DataTable";
import { isAdmin } from "@/lib/auth";
import { getOrganizations } from "@/lib/organizations";

const ALL = "__all__";

/** Tenant filter for the platform-wide lists. Renders nothing for non-admins. */
export function OrganizationFilter({ query }: { query: TableQuery }) {
  const admin = isAdmin();

  const { data: organizations = [] } = useQuery({
    queryKey: ["organizations"],
    queryFn: getOrganizations,
    enabled: admin,
  });

  if (!admin) return null;

  return (
    <Select
      value={query.organizationId || ALL}
      onValueChange={(v) => query.setOrganizationId(v === ALL ? "" : v)}
    >
      <SelectTrigger className="w-52">
        <SelectValue placeholder="All organizations" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All organizations</SelectItem>
        {organizations.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
