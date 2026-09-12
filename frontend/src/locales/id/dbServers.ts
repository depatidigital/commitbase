// Database servers page and database placement on organizations.
export default {
  "Database Servers": "Server Database",
  "PostgreSQL and MySQL servers tenant databases are created on. Organizations are placed on one per engine from their organization page.":
    "Server PostgreSQL dan MySQL tempat database tenant dibuat. Organisasi ditempatkan di salah satunya per engine dari halaman organisasinya.",
  "Add database server": "Tambah server database",
  "Search name or host…": "Cari nama atau host…",
  "No database servers yet.": "Belum ada server database.",
  Connection: "Koneksi",
  "Tunnel via": "Tunnel melalui",
  "Direct · TLS {mode}": "Langsung · TLS {mode}",
  Online: "Online",
  Offline: "Offline",
  superuser: "superuser",
  "The admin login is a superuser. Prefer a login with only CREATEROLE and CREATEDB (Postgres) or CREATE USER, CREATE, DROP and GRANT OPTION (MySQL).":
    "Login admin ini adalah superuser. Sebaiknya gunakan login yang hanya punya CREATEROLE dan CREATEDB (Postgres) atau CREATE USER, CREATE, DROP dan GRANT OPTION (MySQL).",
  "Test connection": "Uji koneksi",
  "{name} is online": "{name} online",
  "{name} could not be reached": "{name} tidak dapat dijangkau",
  "Database server registered": "Server database terdaftar",
  "Database server updated": "Server database diperbarui",
  "Database server removed": "Server database dihapus",
  "Remove {name}?": "Hapus {name}?",
  Remove: "Hapus",
  "This only removes it from the panel — nothing on the server is touched. It is refused while organizations or databases still use it.":
    "Ini hanya menghapusnya dari panel — tidak ada yang diubah di server. Ditolak selama masih dipakai organisasi atau database.",

  // form
  "The engine runs on one of our nodes and listens only on its loopback or private address. The control plane reaches it through that node's SSH connection — no database port is public.":
    "Engine berjalan di salah satu node kita dan hanya mendengarkan di alamat loopback atau privat. Control plane menjangkaunya melalui koneksi SSH node tersebut — tidak ada port database yang publik.",
  "A managed service reached directly over the network, so always over TLS.":
    "Layanan terkelola yang dijangkau langsung lewat jaringan, jadi selalu melalui TLS.",
  Engine: "Engine",
  "Where it runs": "Lokasi berjalan",
  "On one of our nodes (SSH tunnel)": "Di salah satu node kita (tunnel SSH)",
  "Managed service (direct, TLS)": "Layanan terkelola (langsung, TLS)",
  "Choose a node…": "Pilih node…",
  TLS: "TLS",
  "Required (encrypted, certificate not checked)": "Wajib (terenkripsi, sertifikat tidak diperiksa)",
  "Verify certificate": "Verifikasi sertifikat",
  Host: "Host",
  "As seen from the node — usually 127.0.0.1.": "Dilihat dari node — biasanya 127.0.0.1.",
  "The address the control plane connects to.": "Alamat yang dihubungi control plane.",
  "Admin user": "Pengguna admin",
  "Admin password": "Kata sandi admin",
  "Give it CREATEROLE and CREATEDB — not superuser. Encrypted before it is stored and never returned by the API.":
    "Beri CREATEROLE dan CREATEDB — bukan superuser. Dienkripsi sebelum disimpan dan tidak pernah dikembalikan oleh API.",
  "Give it CREATE USER, CREATE and DROP on *.* WITH GRANT OPTION — not root. Encrypted before it is stored and never returned by the API.":
    "Beri CREATE USER, CREATE dan DROP pada *.* WITH GRANT OPTION — bukan root. Dienkripsi sebelum disimpan dan tidak pernah dikembalikan oleh API.",
  "Host apps connect to": "Host yang dihubungi aplikasi",
  "For apps on other nodes — a private IP they can reach. Apps on the same node connect over loopback on their own; left at loopback, other nodes get the node's public IP.":
    "Untuk aplikasi di node lain — IP privat yang bisa mereka jangkau. Aplikasi di node yang sama otomatis lewat loopback; bila dibiarkan loopback, node lain memakai IP publik node ini.",
  "CA certificate (optional)": "Sertifikat CA (opsional)",
  "PEM. Leave empty to verify against the system's trusted roots.":
    "PEM. Kosongkan untuk memverifikasi dengan root tepercaya sistem.",
  "Add and test": "Tambah dan uji",

  // client errors
  "Failed to fetch database servers": "Gagal memuat server database",
  "Failed to register the database server": "Gagal mendaftarkan server database",
  "Failed to update the database server": "Gagal memperbarui server database",
  "Failed to remove the database server": "Gagal menghapus server database",
  "Failed to place the organization": "Gagal menempatkan organisasi",

  // server detail: inventory
  "Databases and logins": "Database dan login",
  "Sync now": "Sinkronkan sekarang",
  Synced: "Tersinkron",
  Saved: "Tersimpan",
  "Tunnel via {node}": "Tunnel melalui {node}",
  "Apps connect to {host}": "Aplikasi terhubung ke {host}",
  "Last checked {date}": "Terakhir dicek {date}",
  "Failed to fetch the inventory": "Gagal memuat inventaris",
  Database: "Database",
  Size: "Ukuran",
  "found on the server": "ditemukan di server",
  "created by the panel": "dibuat oleh panel",
  "missing from the server": "tidak ada di server",
  "Logins with access": "Login dengan akses",
  "Only superusers can reach it.": "Hanya superuser yang dapat menjangkaunya.",
  Logins: "Login",
  Login: "Login",
  Access: "Akses",
  "cannot log in": "tidak bisa login",
  "all databases": "semua database",
  "Search databases…": "Cari database…",
  "Search logins…": "Cari login…",
  "No databases found yet — run a sync.": "Belum ada database — jalankan sinkronisasi.",
  "No logins found. MySQL needs SELECT on the mysql schema to list them.":
    "Tidak ada login. MySQL memerlukan SELECT pada skema mysql untuk menampilkannya.",

  // databases page: create, credentials, delete
  "Create database": "Buat database",
  "No databases yet.": "Belum ada database.",
  "Created on the organization's database server and owned by its own login there — nobody else can connect to it.":
    "Dibuat di server database organisasi dan dimiliki login organisasi itu sendiri — tidak ada pihak lain yang bisa terhubung.",
  "Lowercase letters, digits and underscores, starting with a letter.":
    "Huruf kecil, angka, dan garis bawah, diawali huruf.",
  "Created on the server as {name}": "Dibuat di server sebagai {name}",
  "The organization's name is added in front, so tenants never collide.":
    "Nama organisasi ditambahkan di depan, jadi antar-tenant tidak pernah bentrok.",
  "Database {name} created": "Database {name} dibuat",
  "Database is ready": "Database siap",
  "Database deleted": "Database dihapus",
  Retry: "Coba lagi",
  Credentials: "Kredensial",
  "Credentials for {name}": "Kredensial untuk {name}",
  "Viewing these is recorded in the audit log.": "Melihat kredensial ini tercatat di log audit.",
  Username: "Nama pengguna",
  Hide: "Sembunyikan",
  "Connection URL": "URL koneksi",
  "This server is reached over the network — connect with TLS.":
    "Server ini dijangkau lewat jaringan — hubungkan dengan TLS.",
  "Failed to fetch the credentials": "Gagal memuat kredensial",
  "Remove from panel": "Hapus dari panel",
  "Removed from the panel": "Dihapus dari panel",
  "Remove {name} from the panel?": "Hapus {name} dari panel?",
  "It was imported from its server and stays there untouched. The next sync lists it again, unassigned.":
    "Database ini diimpor dari servernya dan tetap utuh di sana. Sinkronisasi berikutnya akan menampilkannya lagi, belum ditetapkan.",
  "The database and all its data are dropped on the server. This cannot be undone.":
    "Database beserta seluruh datanya dihapus di server. Tindakan ini tidak dapat dibatalkan.",
  "Type {name} to confirm": "Ketik {name} untuk mengonfirmasi",

  // organization placement
  "Database placement": "Penempatan database",
  "Database placement saved": "Penempatan database disimpan",
  "Add a {engine} server": "Tambah server {engine}",
  "Databases of that engine are created on this server, owned by the organization's own login there. Moving is refused while the organization has databases on its current server.":
    "Database untuk engine tersebut dibuat di server ini, dimiliki oleh login organisasi sendiri di sana. Pemindahan ditolak selama organisasi masih punya database di server saat ini.",
} satisfies Record<string, string>;
