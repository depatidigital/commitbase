import { ReactNode, useEffect, useState } from "react";
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
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";

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
}

const PAGE_SIZES = [10, 25, 50, 100];

/**
 * Server-side table state. `params` goes straight to the list endpoint;
 * `search` is debounced so typing does not fire a request per keystroke.
 */
export function useTableQuery(initialLimit = 10) {
  const [page, setPage] = useState(1);
  const [limit, setLimitState] = useState(initialLimit);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");

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

  return {
    page,
    setPage,
    limit,
    setLimit,
    search,
    input,
    setInput,
    params: { page, limit, search },
  };
}

export type TableQuery = ReturnType<typeof useTableQuery>;

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  query: TableQuery;
  pagination?: PageMeta;
  isLoading?: boolean;
  searchPlaceholder?: string;
  empty?: ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  query,
  pagination,
  isLoading,
  searchPlaceholder = "Search…",
  empty = "No results.",
}: DataTableProps<T>) {
  const { page, setPage, limit, setLimit, input, setInput } = query;
  const totalPages = pagination?.totalPages ?? 1;
  const total = pagination?.total ?? rows.length;
  const firstRowNumber = (page - 1) * limit;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Show</span>
          <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
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
          <span>entries</span>
        </div>

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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">#</TableHead>
            {columns.map((c, i) => (
              <TableHead key={i} className={c.className}>
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={columns.length + 1} className="py-8 text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columns.length + 1}
                className="py-8 text-center text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, i) => (
              <TableRow key={rowKey(row)}>
                <TableCell className="text-muted-foreground">{firstRowNumber + i + 1}</TableCell>
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "0 entries"
            : `Showing ${firstRowNumber + 1}–${firstRowNumber + rows.length} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1 || isLoading}
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.max(1, totalPages)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage(page + 1)}
            disabled={page >= totalPages || isLoading}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
