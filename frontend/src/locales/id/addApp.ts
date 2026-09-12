// Add App wizard, launch progress, and the git account/repository helpers.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // wizard
  "Detection failed": "Deteksi gagal",
  "Upload failed": "Unggah gagal",
  "Deployment did not start": "Deployment tidak dimulai",
  "Static site": "Situs statis",
  "HTML, CSS and JS files served from object storage.": "File HTML, CSS, dan JS yang disajikan dari object storage.",
  "PHP application served by the platform runtime.": "Aplikasi PHP yang dijalankan oleh runtime platform.",
  "Node app built and run as a service on the server.": "Aplikasi Node yang di-build dan dijalankan sebagai layanan di server.",
  "App type": "Tipe aplikasi",
  Source: "Sumber",
  Configure: "Konfigurasi",
  "GitHub OAuth is not configured on the server. Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.":
    "OAuth GitHub belum dikonfigurasi di server. Silakan atur GITHUB_CLIENT_ID dan GITHUB_CLIENT_SECRET.",
  "Could not start GitHub OAuth flow.": "Tidak dapat memulai alur OAuth GitHub.",
  "GitHub connection failed": "Koneksi GitHub gagal",
  "GitLab OAuth is not configured on the server. Please set GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET.":
    "OAuth GitLab belum dikonfigurasi di server. Silakan atur GITLAB_CLIENT_ID dan GITLAB_CLIENT_SECRET.",
  "Could not start GitLab OAuth flow.": "Tidak dapat memulai alur OAuth GitLab.",
  "GitLab connection failed": "Koneksi GitLab gagal",
  "{domain} is being set up.": "{domain} sedang disiapkan.",
  "Loading domains...": "Memuat domain...",
  "Error Loading Domains": "Gagal Memuat Domain",
  "Failed to load domains. Please try again.": "Gagal memuat domain. Silakan coba lagi.",
  "No Active Domains": "Tidak Ada Domain Aktif",
  "You need to have at least one active domain to deploy applications. Please add a domain first.":
    "Anda memerlukan setidaknya satu domain aktif untuk men-deploy aplikasi. Silakan tambahkan domain terlebih dahulu.",
  "Manage Domains": "Kelola Domain",
  "Point at the code, then name it — the type is detected.":
    "Tentukan sumber kode, lalu beri nama — tipenya terdeteksi otomatis.",
  "Where does the code come from?": "Dari mana asal kodenya?",
  "Git repository": "Repositori Git",
  "Clone from GitHub, GitLab, or any repository URL.": "Clone dari GitHub, GitLab, atau URL repositori apa pun.",
  "Upload files or folder": "Unggah file atau folder",
  "Send files straight from this machine. No repository needed.":
    "Kirim file langsung dari perangkat ini. Tidak perlu repositori.",
  "Drop files or a folder here": "Tarik file atau folder ke sini",
  "Choose files": "Pilih file",
  "Choose folder": "Pilih folder",
  "Could not read the branches": "Gagal membaca branch",
  default: "default",
  "{count} files": "{count} file",
  Collapse: "Tutup",
  Expand: "Buka",
  "{count} file ready — {size} MB": "{count} file siap — {size} MB",
  "{count} files ready — {size} MB": "{count} file siap — {size} MB",
  "Pick the files or the folder to deploy.": "Pilih file atau folder yang akan di-deploy.",
  "Static uploads go straight to object storage and are served from there — nothing is built.":
    "Unggahan statis langsung masuk ke object storage dan disajikan dari sana — tidak ada proses build.",
  Repository: "Repositori",
  "Select a repository or paste a URL": "Pilih repositori atau tempel URL",
  "Search your repositories, or paste a Git URL…": "Cari repositori Anda, atau tempel URL Git…",
  "Use this URL: {url}": "Pakai URL ini: {url}",
  "Loading repositories…": "Memuat repositori…",
  "No repositories found — paste the URL instead.": "Repositori tidak ditemukan — tempel URL-nya saja.",
  "No GitHub or GitLab account connected. Connect one below, or paste a public repository URL.":
    "Belum ada akun GitHub atau GitLab yang terhubung. Hubungkan di bawah, atau tempel URL repositori publik.",
  "Failed to list repositories": "Gagal memuat daftar repositori",
  "Connect GitHub": "Hubungkan GitHub",
  "Connect GitLab": "Hubungkan GitLab",
  "Checking the repository…": "Memeriksa repositori…",
  "This repository cannot be read. Check the URL — a private repository has to be on GitHub or GitLab.":
    "Repositori ini tidak bisa dibaca. Periksa URL-nya — repositori privat harus ada di GitHub atau GitLab.",
  "This repository has no branches yet — push a commit first.":
    "Repositori ini belum punya branch — push commit terlebih dahulu.",
  "Private repository": "Repositori privat",
  "Private repository — read and deployed through your connected account.":
    "Repositori privat — dibaca dan di-deploy lewat akun Anda yang terhubung.",
  "This repository is private or does not exist. Connect {provider} so it can be read and deployed.":
    "Repositori ini privat atau tidak ada. Hubungkan {provider} agar bisa dibaca dan di-deploy.",
  "None of your connected {provider} accounts can read this repository. Connect an account that has access, or check the URL.":
    "Tidak ada akun {provider} Anda yang bisa membaca repositori ini. Hubungkan akun yang punya akses, atau periksa URL-nya.",
  "App Name": "Nama Aplikasi",
  "Domain Configuration": "Konfigurasi Domain",
  "Select a domain": "Pilih domain",
  "Full domain:": "Domain lengkap:",
  "No domains found.": "Domain tidak ditemukan.",
  Unused: "Belum dipakai",
  "{count} app": "{count} aplikasi",
  "{count} apps": "{count} aplikasi",
  "Filled from the domain": "Terisi dari domain",
  "Follows the domain — change it for a friendlier label.":
    "Mengikuti domain — ubah jika ingin label yang lebih mudah dibaca.",
  "Leave the subdomain empty to use the root domain.":
    "Kosongkan subdomain untuk memakai domain utama (root).",
  "Inspecting the project…": "Memeriksa proyek…",
  "{error} — fill the build settings by hand.": "{error} — isi pengaturan build secara manual.",
  "Detected: {label}": "Terdeteksi: {label}",
  "Install:": "Instal:",
  "Build:": "Build:",
  "Start:": "Start:",
  "App type and commands were filled from this. Change them if the guess is wrong.":
    "Tipe aplikasi dan perintah diisi berdasarkan hasil ini. Ubah jika tebakannya salah.",
  "Could not tell what this project is — pick its type.":
    "Jenis proyek ini tidak terdeteksi — pilih tipenya.",
  "Build & Runtime Configuration": "Konfigurasi Build & Runtime",
  "(assigned automatically — set only if the app ignores $PORT)":
    "(ditetapkan otomatis — isi hanya jika aplikasi mengabaikan $PORT)",
  auto: "otomatis",
  "One variable per line in KEY=value format": "Satu variabel per baris dengan format KEY=value",
  Back: "Kembali",
  Continue: "Lanjutkan",
  "Create App": "Buat Aplikasi",
  "Creating…": "Membuat…",
  "Uploading…": "Mengunggah…",
  "Deploying...": "Sedang deploy...",
  "Deploy App": "Deploy Aplikasi",

  // launch progress
  "Setting up {domain}": "Menyiapkan {domain}",
  "Application created": "Aplikasi dibuat",
  "Hostname pointed at the platform": "Hostname diarahkan ke platform",
  "Repoint it here": "Arahkan ulang ke sini",
  "Source files": "File sumber",
  "Build and deploy": "Build dan deploy",
  "The deployment failed — open the app to read its build log":
    "Deployment gagal — buka aplikasi untuk membaca log build-nya",
  "Building on the server": "Build sedang berjalan di server",
  "Live over HTTPS": "Aktif melalui HTTPS",
  "Answering with HTTP {status}": "Merespons dengan HTTP {status}",
  "Waiting for DNS to propagate and the certificate to be issued":
    "Menunggu propagasi DNS dan penerbitan sertifikat",
  "Back to dashboard": "Kembali ke dasbor",
  "Open app": "Buka aplikasi",
  "Visit site": "Kunjungi situs",

  // git fallbacks (lib/git.ts)
  "Failed to delete git account": "Gagal menghapus akun git",
  "Failed to fetch GitHub accounts": "Gagal mengambil akun GitHub",
  "Failed to fetch GitLab accounts": "Gagal mengambil akun GitLab",
  "Failed to get GitHub OAuth URL": "Gagal mendapatkan URL OAuth GitHub",
  "Failed to get GitLab OAuth URL": "Gagal mendapatkan URL OAuth GitLab",
} satisfies Record<string, string>;
