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
  // SQL restore (DatabaseImportDialog, AppDatabasesTab)
  "Restore DB (.sql)": "Restore DB (.sql)",
  "Restore {name} from a .sql file": "Pulihkan {name} dari berkas .sql",
  "Only this database is changed.": "Hanya database ini yang diubah.",
  "Tables now": "Tabel saat ini",
  "{count} tables": "{count} tabel",
  Empty: "Kosong",
  "Restoring {file}…": "Memulihkan {file}…",
  "Restored {file}": "{file} berhasil dipulihkan",
  "Restore of {file} failed": "Pemulihan {file} gagal",
  "Starting…": "Memulai…",
  "You can close this dialog — the restore keeps running.": "Dialog ini boleh ditutup — pemulihan tetap berjalan.",
  "SQL file": "Berkas SQL",
  "{engine} dump": "dump {engine}",
  "This is a {found} dump, but {name} is {engine}.": "Ini dump {found}, sedangkan {name} adalah {engine}.",
  "The file switches to database {other} — it would be refused. Export only the one database, without {flag}.":
    "Berkas ini berpindah ke database {other} — akan ditolak. Ekspor satu database saja, tanpa {flag}.",
  "MySQL can't undo table changes: if a statement fails, what ran before it stays. Back up first, or restore into an empty database.":
    "MySQL tidak bisa membatalkan perubahan tabel: jika satu perintah gagal, yang sudah berjalan tetap tersimpan. Cadangkan dulu, atau pulihkan ke database kosong.",
  "Runs in one transaction: if any statement fails, nothing is kept.":
    "Berjalan dalam satu transaksi: jika ada perintah yang gagal, tidak ada yang disimpan.",
  "{name} already has {count} tables.": "{name} sudah berisi {count} tabel.",
  'Type "{name}" to restore into it anyway': 'Ketik "{name}" untuk tetap memulihkan',
  "Empty the database first": "Kosongkan database dulu",
  "Dropped and made again before the restore, logins kept. A full dump (pg_dump --clean) fails over existing data otherwise.":
    "Dihapus dan dibuat ulang sebelum pemulihan, login tetap. Dump lengkap (pg_dump --clean) gagal di atas data yang ada kalau tidak.",
  "Uploading… {percent}%": "Mengunggah… {percent}%",
  "Restore another file": "Pulihkan berkas lain",
  "Pages the app built before the restore can still show the old data — redeploy the app to rebuild them.":
    "Halaman yang dibangun aplikasi sebelum pemulihan bisa masih menampilkan data lama — deploy ulang aplikasi untuk membangunnya kembali.",
  Restore: "Pulihkan",
  "No database connected to this app yet.": "Belum ada database yang terhubung ke aplikasi ini.",
  "Connect a database": "Hubungkan database",
  "Use a custom URL": "Pakai URL sendiri",
  "Download backup": "Unduh backup",
  "Backup failed": "Backup gagal",
  "A backup downloaded here, a .sql file, or a PostgreSQL backup (e.g. from DBeaver).":
    "Backup yang diunduh dari sini, berkas .sql, atau backup PostgreSQL (mis. dari DBeaver).",
  "What this app stores its data in": "Tempat aplikasi ini menyimpan datanya",
  "What the apps of this project store their data in": "Tempat aplikasi-aplikasi proyek ini menyimpan datanya",
  "No app of this project uses a database yet — connect one from an app's Environment tab.":
    "Belum ada aplikasi di proyek ini yang memakai database — hubungkan dari tab Environment aplikasi.",
  "Used by {apps}": "Dipakai oleh {apps}",
  "No app's environment names it": "Tidak disebut di environment aplikasi mana pun",
  "Named in this app's environment variables": "Disebut di variabel lingkungan aplikasi ini",
  "in use": "dipakai",
  "Could not reach the database": "Tidak bisa menjangkau database",
  "Failed to load imports": "Gagal memuat riwayat pemulihan",
  "Failed to upload the file": "Gagal mengunggah berkas",
  "The file is too large": "Berkas terlalu besar",
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
  // Git OAuth apps (superadmin)
  "Git OAuth apps": "Aplikasi OAuth Git",
  "The OAuth apps users connect their GitHub and GitLab accounts through.":
    "Aplikasi OAuth yang dipakai pengguna untuk menghubungkan akun GitHub dan GitLab.",
  "The service account that verifies domains and adds them to Search Console.":
    "Service account yang memverifikasi domain dan menambahkannya ke Search Console.",
  "Git OAuth settings saved": "Pengaturan OAuth Git disimpan",
  "Failed to save Git OAuth settings": "Gagal menyimpan pengaturan OAuth Git",
  "Client ID": "Client ID",
  "Client secret": "Client secret",
  "OAuth URL": "URL OAuth",
  "API URL": "URL API",
  "Callback URL": "URL callback",
  "Register an OAuth app with the callback URL below. The secret is stored encrypted. Leave the client ID blank to turn it off.":
    "Daftarkan aplikasi OAuth dengan URL callback di bawah. Secret disimpan terenkripsi. Kosongkan client ID untuk menonaktifkannya.",
  "Change both for a self-hosted GitLab.": "Ubah keduanya untuk GitLab self-hosted.",
  // Integration setup guides (components/IntegrationSteps.tsx)
  "How to set this up": "Cara mengaturnya",
  "Log in to your Rdash reseller dashboard and open its API settings.": "Masuk ke dashboard reseller Rdash Anda dan buka pengaturan API-nya.",
  "Copy the Reseller ID and the API key.": "Salin Reseller ID dan API key.",
  "If the API is restricted by IP, allow this server's public IP there.": "Jika API dibatasi per IP, izinkan IP publik server ini di sana.",
  "Click Edit in RDASH configuration below and paste both. Leave Base URL blank to use":
    "Klik Ubah pada konfigurasi RDASH di bawah dan tempel keduanya. Kosongkan Base URL untuk memakai",
  "Save. The overview loads once the credentials work, and domain registration becomes available.":
    "Simpan. Ringkasan akan muncul setelah kredensial berfungsi, dan pendaftaran domain bisa digunakan.",
  "API token (DNS and zones)": "API token (DNS dan zona)",
  "In the Cloudflare dashboard open": "Di dashboard Cloudflare buka",
  "and start from a Custom token.": "lalu mulai dari Custom token.",
  "Add these permissions:": "Tambahkan izin berikut:",
  "and, for static sites on R2,": "dan, untuk situs statis di R2,",
  "Resources: your account, and": "Resources: akun Anda, dan",
  "Create the token and copy it — Cloudflare shows it only once.": "Buat token lalu salin — Cloudflare hanya menampilkannya sekali.",
  "Click Edit in Cloudflare configuration below and paste the token. Leave API base blank for the public Cloudflare API.":
    "Klik Ubah pada konfigurasi Cloudflare di bawah dan tempel token. Kosongkan API base untuk memakai API Cloudflare publik.",
  "R2 storage (optional, for static sites)": "Penyimpanan R2 (opsional, untuk situs statis)",
  "Open": "Buka",
  "with Object Read & Write, scoped to that bucket.": "dengan izin Object Read & Write, khusus untuk bucket tersebut.",
  "Copy the Access Key ID and Secret Access Key, and the Account ID from the R2 overview page.":
    "Salin Access Key ID dan Secret Access Key, serta Account ID dari halaman ringkasan R2.",
  "Click Edit in Cloudflare R2 storage below and fill them in. Public URL is the custom domain connected to the bucket; Root folder is the prefix every site is uploaded under.":
    "Klik Ubah pada penyimpanan Cloudflare R2 di bawah dan isi semuanya. Public URL adalah domain kustom yang terhubung ke bucket; Folder root adalah prefix tempat setiap situs diunggah.",
  "Save. The settings are checked against the bucket right away.": "Simpan. Pengaturan langsung diuji ke bucket.",
  "and create or pick a project.": "lalu buat atau pilih sebuah project.",
  "In": "Di",
  "enable": "aktifkan",
  "and": "dan",
  "It needs no project roles.": "Tidak perlu role project apa pun.",
  "Open the service account, then": "Buka service account tersebut, lalu",
  "A key file downloads.": "File key akan terunduh.",
  "Click Edit below and paste the whole contents of the key file.": "Klik Ubah di bawah dan tempel seluruh isi file key.",
  "Under Default owners, list the Google accounts (comma-separated) that should see every added domain in their Search Console.":
    "Di Pemilik bawaan, isi akun Google (dipisah koma) yang harus melihat setiap domain yang ditambahkan di Search Console mereka.",
  "Save. The key is checked against Google right away.": "Simpan. Key langsung diuji ke Google.",
  "On GitHub open": "Di GitHub buka",
  "For an organization, use the same menu under the organization settings.": "Untuk organisasi, gunakan menu yang sama di pengaturan organisasi.",
  "Homepage URL: this panel's address. Authorization callback URL: the GitHub callback URL shown below, exactly.":
    "Homepage URL: alamat panel ini. Authorization callback URL: URL callback GitHub yang tertera di bawah, persis sama.",
  "Register the app, then Generate a new client secret.": "Daftarkan aplikasi, lalu klik Generate a new client secret.",
  "Click Edit on GitHub below, paste the Client ID and the client secret, and save.":
    "Klik Ubah pada GitHub di bawah, tempel Client ID dan client secret, lalu simpan.",
  "On GitLab open": "Di GitLab buka",
  "On a self-hosted GitLab an admin can use Admin area → Applications for an instance-wide app.":
    "Di GitLab self-hosted, admin dapat memakai Admin area → Applications untuk aplikasi seluruh instance.",
  "Redirect URI: the GitLab callback URL shown below, exactly. Keep Confidential checked. Scopes:":
    "Redirect URI: URL callback GitLab yang tertera di bawah, persis sama. Biarkan Confidential tercentang. Scopes:",
  "Save the application and copy the Application ID and the Secret.": "Simpan aplikasi lalu salin Application ID dan Secret.",
  "Click Edit on GitLab below: Application ID goes in Client ID, Secret in Client secret. For a self-hosted GitLab also set OAuth URL to":
    "Klik Ubah pada GitLab di bawah: Application ID ke Client ID, Secret ke Client secret. Untuk GitLab self-hosted, isi juga URL OAuth dengan",
  "and API URL to": "dan URL API dengan",
  "Save.": "Simpan.",
  "Users can now connect their GitHub and GitLab accounts from Add app and pick repositories from them.":
    "Pengguna kini dapat menghubungkan akun GitHub dan GitLab dari Tambah aplikasi dan memilih repositori darinya.",
} satisfies Record<string, string>;
