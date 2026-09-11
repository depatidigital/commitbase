// Settings, Logs, Databases, sign-in / password / invite pages, 404, auth + api fallbacks.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // shared
  "Try again": "Coba lagi",
  App: "Aplikasi",
  Version: "Versi",
  Created: "Dibuat",
  "Request failed": "Permintaan gagal",

  // Settings
  "Git account updated": "Akun Git diperbarui",
  "Git account disconnected": "Akun Git diputuskan",
  "Failed to disconnect git account": "Gagal memutuskan akun Git",
  "Display name cannot be empty": "Nama tampilan tidak boleh kosong",
  "Configure your deployment platform": "Konfigurasi platform deployment Anda",
  "Server Config": "Konfigurasi Server",
  "Configure server settings, domains, and SSL": "Atur pengaturan server, domain, dan SSL",
  Security: "Keamanan",
  "Manage authentication and access controls": "Kelola autentikasi dan kontrol akses",
  Notifications: "Notifikasi",
  "Configure alerts and monitoring": "Atur peringatan dan pemantauan",
  "Git Integrations": "Integrasi Git",
  "Manage connected GitHub and GitLab accounts.": "Kelola akun GitHub dan GitLab yang terhubung.",
  "No Git accounts connected yet. Connect from the Add App page when selecting a repository.":
    "Belum ada akun Git yang terhubung. Hubungkan dari halaman Tambah Aplikasi saat memilih repositori.",
  "Display name": "Nama tampilan",
  "Disconnect account": "Putuskan akun",
  "Disconnect Git account": "Putuskan akun Git",
  "Are you sure you want to disconnect your {provider} account {username}? You can reconnect later from the Add App page, but existing deployments will keep using their configured repositories.":
    "Apakah Anda yakin ingin memutuskan akun {provider} {username}? Anda dapat menghubungkannya kembali nanti dari halaman Tambah Aplikasi, tetapi deployment yang ada akan tetap memakai repositori yang sudah dikonfigurasi.",
  "Disconnecting...": "Memutuskan...",
  Disconnect: "Putuskan",

  // Logs
  "Error Loading Logs": "Gagal Memuat Log",
  "Monitor and debug your applications": "Pantau dan debug aplikasi Anda",
  "Export CSV": "Ekspor CSV",
  Filters: "Filter",
  "All Apps": "Semua Aplikasi",
  "All Levels": "Semua Level",
  "Search messages...": "Cari pesan...",
  "Last {count}": "{count} terakhir",
  Errors: "Error",
  Warnings: "Peringatan",
  Info: "Info",
  "Log Entries ({count})": "Entri Log ({count})",
  "No logs recorded yet.": "Belum ada log yang tercatat.",
  "No logs match the current filters.": "Tidak ada log yang cocok dengan filter saat ini.",
  platform: "platform",
  "Failed to fetch logs": "Gagal memuat log",
  "Failed to fetch build log status": "Gagal memuat status log build",
  "Failed to create test build log": "Gagal membuat log build uji",
  "Test build log created successfully": "Log build uji berhasil dibuat",
  "Failed to clear logs": "Gagal menghapus log",
  "Failed to export logs": "Gagal mengekspor log",

  // Databases
  Creating: "Sedang dibuat",
  "Error loading databases": "Gagal memuat database",
  "Databases provisioned for your applications.": "Database yang disediakan untuk aplikasi Anda.",
  "Search name or application…": "Cari nama atau aplikasi…",
  "Databases are created from an application's detail page.": "Database dibuat dari halaman detail aplikasi.",
  "Database created successfully": "Database berhasil dibuat",
  "Database updated successfully": "Database berhasil diperbarui",
  "Database deleted successfully": "Database berhasil dihapus",
  "Failed to fetch databases": "Gagal memuat database",
  "Failed to fetch database": "Gagal memuat database",
  "Failed to create database": "Gagal membuat database",
  "Failed to update database": "Gagal memperbarui database",
  "Failed to delete database": "Gagal menghapus database",

  // Login + auth
  "Invalid email address": "Alamat email tidak valid",
  "Password is required": "Kata sandi wajib diisi",
  "Checking authentication...": "Memeriksa autentikasi...",
  "Sign In": "Masuk",
  "Enter your credentials to access your dashboard": "Masukkan kredensial Anda untuk mengakses dasbor",
  "Enter your email": "Masukkan email Anda",
  "Enter your password": "Masukkan kata sandi Anda",
  "Signing in...": "Sedang masuk...",
  "Accounts are created by an administrator or through an organization invite link.":
    "Akun dibuat oleh administrator atau melalui tautan undangan organisasi.",
  "Validating user session...": "Memvalidasi sesi pengguna...",
  "Login successful": "Berhasil masuk",
  "Registration successful": "Pendaftaran berhasil",
  "Logged out successfully": "Berhasil keluar",
  "Login failed": "Gagal masuk",

  // Change password
  "Password updated": "Kata sandi diperbarui",
  "Change your password": "Ubah kata sandi Anda",
  "Your account was created with a temporary password that an administrator also knows. Choose your own before continuing.":
    "Akun Anda dibuat dengan kata sandi sementara yang juga diketahui administrator. Buat kata sandi Anda sendiri sebelum melanjutkan.",
  "Pick a new password for your account.": "Pilih kata sandi baru untuk akun Anda.",
  "Current password": "Kata sandi saat ini",
  "New password": "Kata sandi baru",
  "At least 8 characters": "Minimal 8 karakter",
  "Confirm new password": "Konfirmasi kata sandi baru",
  "Passwords do not match.": "Kata sandi tidak cocok.",
  "Update password": "Perbarui kata sandi",
  "Failed to change password": "Gagal mengubah kata sandi",

  // Accept invite
  Welcome: "Selamat datang",
  "You have joined {organization}.": "Anda telah bergabung dengan {organization}.",
  "You have joined the organization.": "Anda telah bergabung dengan organisasi.",
  "This invite link is missing its token. Ask for a new invite.":
    "Tautan undangan ini tidak memiliki token. Mintalah undangan baru.",
  "This invite is invalid, already used, or expired.": "Undangan ini tidak valid, sudah digunakan, atau kedaluwarsa.",
  "Go to sign in": "Ke halaman masuk",
  "Join {organization}": "Bergabung dengan {organization}",
  "Invited as {email}": "Diundang sebagai {email}",
  "Your name": "Nama Anda",
  "Choose a password": "Buat kata sandi",
  "You already have a {app} account with this email — accepting adds you to {organization}. Your password stays the same.":
    "Anda sudah memiliki akun {app} dengan email ini — menerima undangan akan menambahkan Anda ke {organization}. Kata sandi Anda tetap sama.",
  "Join organization": "Bergabung dengan organisasi",
  "This invite expires {date}.": "Undangan ini kedaluwarsa pada {date}.",

  // 404
  "No page at {path}": "Tidak ada halaman di {path}",
  "It may have moved, or you may not have access to it.":
    "Halaman mungkin telah dipindahkan, atau Anda tidak memiliki akses ke halaman tersebut.",
  "Back to applications": "Kembali ke aplikasi",
} satisfies Record<string, string>;
