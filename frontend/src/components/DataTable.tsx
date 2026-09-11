import { ReactNode, useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  Loader2,
  Search,
} from "lucide-react";

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: PageMeta;
}

export interface Column<T> {
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Server-side sort field. Set it and the header becomes a sort toggle. */
  sortKey?: string;
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Server-side table state. `params` goes straight to the list endpoint;
 * `search` is debounced so typing does not fire a request per keystroke.
 */
export function useTableQuery(
  initialLimit = 10,
  /** the order a list opens in; omit for the endpoint's own default */
  initialSort?: { sort: string; order: "asc" | "desc" },
) {
  const [page, setPage] = useState(1);
  const [limit, setLimitState] = useState(initialLimit);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [organizationId, setOrganizationIdState] = useState("");
  const [sort, setSort] = useState(initialSort?.sort ?? "");
  const [order, setOrder] = useState<"asc" | "desc">(initialSort?.order ?? "asc");

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(input.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [input]);

  const setLimit = (next: number) => {
    setLimitState(next);
    setPage(1);
  };

  /** First click sorts ascending, clicking the same column flips direction. */
  const toggleSort = (key: string) => {
    if (sort === key) {
      setOrder(order === "asc" ? "desc" : "asc");
    } else {
      setSort(key);
      setOrder("asc");
    }
    setPage(1);
  };

  const setOrganizationId = (next: string) => {
    setOrganizationIdState(next);
    setPage(1);
  };

  return {
    page,
    setPage,
    limit,
    setLimit,
    search,
    input,
    setInput,
    organizationId,
    setOrganizationId,
    sort,
    order,
    toggleSort,
    params: { page, limit, search, organizationId, sort, order },
  };
}

export type TableQuery = ReturnType<typeof useTableQuery>;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  query: TableQuery;
  /** Server-paged lists pass this. Omit it and the rows are filtered/paged in the browser. */
  pagination?: PageMeta;
  /** Local mode only: which rows survive the search box. */
  filter?: (row: T, search: string) => boolean;
  isLoading?: boolean;
  searchPlaceholder?: string;
  empty?: ReactNode;
  toolbar?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  query,
  pagination,
  filter,
  isLoading,
  searchPlaceholder = t("Search…"),
  empty = t("No results."),
  toolbar,
}: DataTableProps<T>) {
  const { page, setPage, limit, setLimit, input, setInput, search, sort, order, toggleSort } =
    query;

  const local = !pagination;
  const matched =
    local && search && filter ? rows.filter((r) => filter(r, search)) : rows;
  const total = pagination?.total ?? matched.length;
  const totalPages =
    pagination?.totalPages ?? Math.max(1, Math.ceil(total / limit));
  const firstRowNumber = (page - 1) * limit;
  const visible = local
    ? matched.slice(firstRowNumber, firstRowNumber + limit)
    : matched;

  return (
    // data-fill: PageLayout bounds its height when it holds this. The floor keeps
    // a few rows visible when there is a lot above it; past that main scrolls.
    <div data-fill className="flex min-h-[20rem] flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t("Show")}</span>
          <Select
            value={String(limit)}
            onValueChange={(v) => setLimit(Number(v))}
          >
            <SelectTrigger className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>{t("entries")}</span>
        </div>

        <div className="flex items-center gap-2">
          {toolbar}
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={searchPlaceholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* The rows scroll, not the page: this box shrinks to the height left in
          main and Table's own overflow div scrolls inside it, so the header
          sticks and the pagination below stays on screen. Where the parent is
          not a flex column it just grows and the page scrolls as before. */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-md border bg-card">
        <Table className="table-fixed [&_td]:py-2.5 [&_th]:h-9 [&_th]:py-0">
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_hsl(var(--border))]">
            <TableRow className="hover:bg-transparent">
              {columns.map((c, i) => (
                <TableHead
                  key={i}
                  className={`text-xs uppercase tracking-wide ${c.className ?? ""}`}
                >
                  {c.sortKey ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sortKey as string)}
                      className="flex items-center gap-1 uppercase hover:text-foreground"
                    >
                      {c.header}
                      {sort !== c.sortKey ? (
                        <ChevronsUpDown className="h-3 w-3 opacity-50" />
                      ) : order === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-8 text-center"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : visible.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="py-8 text-center text-muted-foreground"
                >
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((c, ci) => (
                    <TableCell key={ci} className={c.className}>
                      {c.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? t("0 entries")
            : t("Showing {from}–{to} of {total}", { from: firstRowNumber + 1, to: firstRowNumber + visible.length, total })}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1 || isLoading}
          >
            <ChevronLeft className="h-4 w-4" /> {t("Previous")}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("Page {page} of {pages}", { page, pages: Math.max(1, totalPages) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages || isLoading}
          >
            {t("Next")} <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
