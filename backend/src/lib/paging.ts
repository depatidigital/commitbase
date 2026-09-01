import { AuthenticatedRequest } from '../middleware/auth';

/** `?page=&limit=&search=` for the list endpoints. */
export const paging = (req: AuthenticatedRequest) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 10));
  const search = ((req.query.search as string) || '').trim();
  // some lists still serve the full array to pickers — they page only when asked
  const paged = req.query.page !== undefined || req.query.limit !== undefined;
  return { page, limit, skip: (page - 1) * limit, search, paged };
};

export const paginated = <T>(rows: T[], total: number, page: number, limit: number) => ({
  success: true,
  data: { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
});

export const contains = (search: string) => ({ contains: search, mode: 'insensitive' as const });
