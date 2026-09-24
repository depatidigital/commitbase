// Add App wizard, launch progress, and the git account/repository helpers.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // wizard
  "Detection failed": "Deteksi gagal",
  "Upload failed": "Unggah gagal",
  "Deployment did not start": "Deployment tidak dimulai",
  "Static site": "Situs statis",
  "HTML, CSS and JS files served from object storage.": "File HTML, CSS, dan JS yang disajikan dari object storage.",
  "PHP service served by the platform runtime.": "Layanan PHP yang dijalankan oleh runtime platform.",
  "Node service built and run as a service on the server.": "Layanan Node yang di-build dan dijalankan sebagai layanan di server.",
  "Service type": "Tipe layanan",
  Source: "Sumber",
  Configure: "Konfigurasi",
  "GitHub OAuth is not configured. A superadmin can set it up under Integrations → GitHub & GitLab.":
    "OAuth GitHub belum dikonfigurasi. Superadmin dapat mengaturnya di Integrasi → GitHub & GitLab.",
  "Could not start GitHub OAuth flow.": "Tidak dapat memulai alur OAuth GitHub.",
  "GitHub connection failed": "Koneksi GitHub gagal",
  "GitLab OAuth is not configured. A superadmin can set it up under Integrations → GitHub & GitLab.":
    "OAuth GitLab belum dikonfigurasi. Superadmin dapat mengaturnya di Integrasi → GitHub & GitLab.",
  "Could not start GitLab OAuth flow.": "Tidak dapat memulai alur OAuth GitLab.",
  "GitLab connection failed": "Koneksi GitLab gagal",
  "{domain} is being set up.": "{domain} sedang disiapkan.",
  "Loading domains...": "Memuat domain...",
  "Error Loading Domains": "Gagal Memuat Domain",
  "Failed to load domains. Please try again.": "Gagal memuat domain. Silakan coba lagi.",
  "No Active Domains": "Tidak Ada Domain Aktif",
  "You need to have at least one active domain to deploy services. Please add a domain first.":
    "Anda memerlukan setidaknya satu domain aktif untuk men-deploy layanan. Silakan tambahkan domain terlebih dahulu.",
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
  "Service Name": "Nama Layanan",
  "Domain Configuration": "Konfigurasi Domain",
  "Select a domain": "Pilih domain",
  "Full domain:": "Domain lengkap:",
  "No domains found.": "Domain tidak ditemukan.",
  Unused: "Belum dipakai",
  "{count} service": "{count} layanan",
  "{count} services": "{count} layanan",
  "Filled from the domain": "Terisi dari domain",
  "Follows the domain — change it for a friendlier label.":
    "Mengikuti domain — ubah jika ingin label yang lebih mudah dibaca.",
  "Leave the subdomain empty to use the root domain.":
    "Kosongkan subdomain untuk memakai domain utama (root).",
  "Inspecting the app…": "Memeriksa aplikasi…",
  "{error} — fill the build settings by hand.": "{error} — isi pengaturan build secara manual.",
  "Detected: {label}": "Terdeteksi: {label}",
  "Install:": "Instal:",
  "Build:": "Build:",
  "Start:": "Start:",
  "Service type and commands were filled from this. Change them if the guess is wrong.":
    "Tipe layanan dan perintah diisi berdasarkan hasil ini. Ubah jika tebakannya salah.",
  "Could not tell what this app is — pick its type.":
    "Jenis aplikasi ini tidak terdeteksi — pilih tipenya.",
  "Build & Runtime Configuration": "Konfigurasi Build & Runtime",
  "(assigned automatically — set only if the service ignores $PORT)":
    "(ditetapkan otomatis — isi hanya jika layanan mengabaikan $PORT)",
  auto: "otomatis",
  "One variable per line in KEY=value format": "Satu variabel per baris dengan format KEY=value",
  Back: "Kembali",
  Continue: "Lanjutkan",
  "Create Service": "Buat Layanan",
  "Creating…": "Membuat…",
  "Uploading…": "Mengunggah…",
  "Deploying...": "Sedang deploy...",
  "Deploy Service": "Deploy Layanan",

  // launch progress
  "Setting up {domain}": "Menyiapkan {domain}",
  "Service created": "Layanan dibuat",
  "Hostname pointed at the platform": "Hostname diarahkan ke platform",
  "Repoint it here": "Arahkan ulang ke sini",
  "Source files": "File sumber",
  "Build and deploy": "Build dan deploy",
  "The deployment failed — open the service to read its build log":
    "Deployment gagal — buka layanan untuk membaca log build-nya",
  "Building on the server": "Build sedang berjalan di server",
  "Live over HTTPS": "Aktif melalui HTTPS",
  "Answering with HTTP {status}": "Merespons dengan HTTP {status}",
  "Waiting for DNS to propagate and the certificate to be issued":
    "Menunggu propagasi DNS dan penerbitan sertifikat",
  "Back to dashboard": "Kembali ke dasbor",
  "Open service": "Buka layanan",
  "Visit site": "Kunjungi situs",

  // git fallbacks (lib/git.ts)
  "Failed to delete git account": "Gagal menghapus akun git",
  "Failed to fetch GitHub accounts": "Gagal mengambil akun GitHub",
  "Failed to fetch GitLab accounts": "Gagal mengambil akun GitLab",
  "Failed to get GitHub OAuth URL": "Gagal mendapatkan URL OAuth GitHub",
  "Failed to get GitLab OAuth URL": "Gagal mendapatkan URL OAuth GitLab",
  "Pre-deploy:": "Pra-deploy:",
  "Environment variables": "Variabel environment",
  "{count} still empty — fill them to deploy now, or finish on the next page.":
    "{count} masih kosong — isi untuk deploy sekarang, atau selesaikan di halaman berikutnya.",
  "Paste a whole .env into any name field.": "Tempel seluruh .env ke kolom nama mana saja.",
  "No database yet? Leave DATABASE_URL empty — the next page creates and connects one.":
    "Belum punya database? Biarkan DATABASE_URL kosong — halaman berikutnya membuat dan menghubungkannya.",
  "Starting deploy…": "Memulai deploy…",
  "Create & finish setup": "Buat & selesaikan pengaturan",
  "Could not start the deploy": "Gagal memulai deploy",
  "Python service run as a service, in a virtualenv of its own.": "Layanan Python yang dijalankan sebagai service, dalam virtualenv sendiri.",
  "Compose stack": "Stack compose",
  "Containers the server brings up from the repository's compose file.": "Container yang dijalankan server dari file compose repositori.",
} satisfies Record<string, string>;
