// Shell and shared components: sidebar, top bar, breadcrumbs, DataTable.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // navigation
  Home: "Beranda",
  Platform: "Platform",
  Apps: "Aplikasi",
  "Add App": "Tambah Aplikasi",
  Databases: "Database",
  Domains: "Domain",
  Logs: "Log",
  Team: "Tim",
  Settings: "Pengaturan",
  Servers: "Server",
  Organizations: "Organisasi",
  Users: "Pengguna",
  Administration: "Administrasi",
  Integrations: "Integrasi",
  Detail: "Detail",

  // top bar
  "Platform Online": "Platform Aktif",
  "Platform Unreachable": "Platform Tidak Terjangkau",
  "Signing out...": "Sedang keluar...",
  "Sign out": "Keluar",
  "No user data available": "Data pengguna tidak tersedia",

  // DataTable
  Show: "Tampilkan",
  entries: "entri",
  "Search…": "Cari…",
  "No results.": "Tidak ada hasil.",
  "0 entries": "0 entri",
  "Showing {from}–{to} of {total}": "Menampilkan {from}–{to} dari {total}",
  Previous: "Sebelumnya",
  Next: "Berikutnya",
  "Page {page} of {pages}": "Halaman {page} dari {pages}",
} satisfies Record<string, string>;
