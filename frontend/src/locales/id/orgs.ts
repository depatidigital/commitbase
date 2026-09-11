// Organizations, organization detail, team, users, platform administration.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // shared bits (same values as elsewhere, kept here so these pages stand alone)
  Create: "Buat",
  Invite: "Undang",
  server: "server",
  Slug: "Slug",
  User: "Pengguna",
  Members: "Anggota",
  "Members ({count})": "Anggota ({count})",
  Role: "Peran",
  Accepted: "Diterima",
  "Expires {date}": "Kedaluwarsa {date}",
  Disabled: "Nonaktif",
  none: "tidak ada",
  "no organization": "tanpa organisasi",
  "this organization": "organisasi ini",
  "Copied to clipboard": "Tersalin ke papan klip",

  // roles
  Owner: "Pemilik",
  Admin: "Admin",
  Member: "Anggota",
  Client: "Klien",
  "Platform role": "Peran platform",

  // organization picker / filter
  "All organizations": "Semua organisasi",
  "Select an organization": "Pilih organisasi",
  "Select organization": "Pilih organisasi",
  "Search organizations…": "Cari organisasi…",
  "Searching…": "Mencari…",
  "No organizations found.": "Organisasi tidak ditemukan.",
  "Showing {count} of {total} — keep typing to narrow.":
    "Menampilkan {count} dari {total} — lanjutkan mengetik untuk mempersempit.",

  // Organizations
  "Client tenants. Domain ownership lives on the Administration page.":
    "Tenant klien. Kepemilikan domain diatur di halaman Administrasi.",
  "New organization": "Organisasi baru",
  "Creates a client tenant. Assign domains to it from the Administration page.":
    "Membuat tenant klien. Tetapkan domain ke organisasi ini dari halaman Administrasi.",
  "Client name": "Nama klien",
  "Admin email (optional)": "Email admin (opsional)",
  "Joins as ADMIN if the account exists, otherwise gets an invite emailed to them. You can also invite members later from the organization page.":
    "Bergabung sebagai Admin jika akunnya sudah ada; jika belum, undangan dikirim ke email tersebut. Anda juga dapat mengundang anggota nanti dari halaman organisasi.",
  "Organization created": "Organisasi dibuat",
  "Invite emailed to {email}.": "Undangan dikirim ke {email}.",
  "Invite created, but the email failed — check the SMTP settings.":
    "Undangan dibuat, tetapi email gagal dikirim — periksa pengaturan SMTP.",
  "Admin added.": "Admin ditambahkan.",
  "Search name or slug…": "Cari nama atau slug…",
  "No organizations yet.": "Belum ada organisasi.",
  "Not placed": "Belum ditempatkan",

  // Organization detail / Team
  "Organization not found.": "Organisasi tidak ditemukan.",
  "{members} members · {domains} domains · {apps} apps":
    "{members} anggota · {domains} domain · {apps} aplikasi",
  "Placed on {server}": "Ditempatkan di {server}",
  "Server placement": "Penempatan server",
  "Choose a server…": "Pilih server…",
  "Placement is fixed once set: this tenant's OS user, home and apps live on that node. Moving the row would not move the files.":
    "Penempatan tidak dapat diubah setelah ditetapkan: pengguna OS, direktori home, dan aplikasi tenant ini berada di node tersebut. Memindahkan datanya tidak akan memindahkan berkasnya.",
  "Provisioning and deploys refuse to run until this organization is placed on a node.":
    "Provisioning dan deploy tidak dapat dijalankan sebelum organisasi ini ditempatkan di sebuah node.",
  "Invite to {name}": "Undang ke {name}",
  "An existing account joins {name} straight away. Anyone else is emailed an invite link.":
    "Akun yang sudah ada langsung bergabung ke {name}. Selain itu, tautan undangan dikirim lewat email.",
  "Invite someone": "Undang seseorang",
  "Send invite": "Kirim undangan",
  "The invite link is emailed to the address you enter. It is stored hashed, so it cannot be retrieved or resent later — revoke and invite again instead.":
    "Tautan undangan dikirim ke alamat email yang Anda masukkan. Tautan disimpan dalam bentuk hash sehingga tidak dapat diambil atau dikirim ulang — cabut lalu undang kembali.",
  "Member added": "Anggota ditambahkan",
  "That account already existed.": "Akun tersebut sudah ada.",
  "Invite sent": "Undangan terkirim",
  "An email is on its way to {email}.": "Email sedang dikirim ke {email}.",
  "Invite created, but the email failed": "Undangan dibuat, tetapi email gagal dikirim",
  "Check the SMTP settings, then revoke and re-send the invite.":
    "Periksa pengaturan SMTP, lalu cabut dan kirim ulang undangan.",
  "Member updated": "Anggota diperbarui",
  "Member removed": "Anggota dikeluarkan",
  "Invite revoked": "Undangan dicabut",
  "Remove {email}": "Keluarkan {email}",
  "Revoke invite for {email}": "Cabut undangan untuk {email}",
  "Search members…": "Cari anggota…",
  "No members yet.": "Belum ada anggota.",
  "Pending invites": "Undangan tertunda",
  "Search invites…": "Cari undangan…",
  "No invites.": "Tidak ada undangan.",
  "Remove this member?": "Keluarkan anggota ini?",
  "{member} will lose access to {name}, including its domains and applications. They can be added back later.":
    "{member} akan kehilangan akses ke {name}, termasuk domain dan aplikasinya. Anggota ini dapat ditambahkan kembali nanti.",
  "{member} will lose access to {name}, including its domains and applications. They can be invited back later.":
    "{member} akan kehilangan akses ke {name}, termasuk domain dan aplikasinya. Anggota ini dapat diundang kembali nanti.",
  "Remove member": "Keluarkan anggota",
  "You are not a member of any organization yet.": "Anda belum menjadi anggota organisasi mana pun.",
  "People who can manage this organization's domains and applications.":
    "Orang-orang yang dapat mengelola domain dan aplikasi organisasi ini.",

  // Users
  "Client accounts on the platform and their organization memberships.":
    "Akun klien di platform beserta keanggotaan organisasinya.",
  "New user": "Pengguna baru",
  "New client account": "Akun klien baru",
  "They sign in with this temporary password and must change it on first login.":
    "Pengguna masuk dengan kata sandi sementara ini dan wajib menggantinya saat login pertama.",
  "Temporary password": "Kata sandi sementara",
  "min 8 characters": "minimal 8 karakter",
  "User created": "Pengguna dibuat",
  "Invite them to an organization from the Team page.":
    "Undang pengguna ini ke organisasi dari halaman Tim.",
  "User updated": "Pengguna diperbarui",
  "Search email or name…": "Cari email atau nama…",
  "No users found.": "Pengguna tidak ditemukan.",

  // Administration
  "Platform administration": "Administrasi platform",
  "Domain ownership and per-organization OS isolation.":
    "Kepemilikan domain dan isolasi OS per organisasi.",
  "Provisioning log": "Log provisioning",
  "Search domain…": "Cari domain…",
  "No domains yet.": "Belum ada domain.",
  "Domain ownership updated": "Kepemilikan domain diperbarui",
  "Its applications moved with it.": "Aplikasinya ikut dipindahkan.",
  "Move this domain to another organization?": "Pindahkan domain ini ke organisasi lain?",
  "{domain} and its {count} application will move to {organization}.":
    "{domain} beserta {count} aplikasinya akan dipindahkan ke {organization}.",
  "{domain} and its {count} applications will move to {organization}.":
    "{domain} beserta {count} aplikasinya akan dipindahkan ke {organization}.",
  "The previous organization loses access immediately.":
    "Organisasi sebelumnya langsung kehilangan akses.",
  "Move domain": "Pindahkan domain",
  Isolation: "Isolasi",
  "Not provisioned": "Belum diprovisi",
  "No resource limits": "Tanpa batas sumber daya",
  Provisioned: "Terprovisi",
  Provision: "Provisi",
  "Re-provision": "Provisi ulang",
  "Search organization…": "Cari organisasi…",
  "OS isolation is switched off on this server.": "Isolasi OS dinonaktifkan di server ini.",
  "Set {setting} in the backend environment and restart it before provisioning.":
    "Atur {setting} di environment backend lalu mulai ulang sebelum melakukan provisioning.",
  "{user} now has its own OS user, home and cgroup slice.":
    "{user} kini memiliki pengguna OS, direktori home, dan cgroup slice sendiri.",
  "OS user provisioned.": "Pengguna OS berhasil diprovisi.",
  "Re-run provisioning?": "Jalankan ulang provisioning?",
  "Provision this organization?": "Provisi organisasi ini?",
  "Creates the OS user {user}, its home, disk quota, cgroup slice and PHP-FPM pool.":
    "Membuat pengguna OS {user} beserta direktori home, kuota disk, cgroup slice, dan pool PHP-FPM-nya.",
  "Re-running also repairs file ownership and re-applies the resource limits — it does not restart running applications.":
    "Menjalankan ulang juga memperbaiki kepemilikan berkas dan menerapkan ulang batas sumber daya — aplikasi yang sedang berjalan tidak dimulai ulang.",
  "Nothing provisioned yet.": "Belum ada yang diprovisi.",
  When: "Waktu",
  Message: "Pesan",
  Trigger: "Pemicu",
  By: "Oleh",

  // lib fallback errors
  "Failed to fetch users": "Gagal memuat pengguna",
  "Failed to create user": "Gagal membuat pengguna",
  "Failed to update user": "Gagal memperbarui pengguna",
  "Failed to assign domain": "Gagal menetapkan domain",
  "Failed to unassign domain": "Gagal melepas domain",
  "Failed to fetch organizations": "Gagal memuat organisasi",
  "Failed to fetch organization": "Gagal memuat organisasi",
  "Failed to provision organization": "Gagal memprovisi organisasi",
  "Failed to fetch provisioning logs": "Gagal memuat log provisioning",
  "Failed to add member": "Gagal menambahkan anggota",
  "Failed to create organization": "Gagal membuat organisasi",
  "Failed to fetch members": "Gagal memuat anggota",
  "Failed to update member": "Gagal memperbarui anggota",
  "Failed to remove member": "Gagal mengeluarkan anggota",
  "Failed to fetch invites": "Gagal memuat undangan",
  "Failed to create invite": "Gagal membuat undangan",
  "Failed to revoke invite": "Gagal mencabut undangan",
  "This invite link is invalid or has expired": "Tautan undangan ini tidak valid atau sudah kedaluwarsa",
  "Failed to accept invite": "Gagal menerima undangan",
} satisfies Record<string, string>;
