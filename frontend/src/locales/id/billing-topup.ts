// Top-ups (Usage page) and the ArusNiaga integration page (superadmin).
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  "Top up": "Isi ulang",
  "Top up the balance": "Isi ulang saldo",
  "An invoice is issued for the amount. Pay it on its page; the balance follows within a minute of the payment.":
    "Tagihan dibuat sebesar jumlah itu. Bayar di halaman tagihannya; saldo bertambah dalam satu menit setelah pembayaran.",
  "Invoice {ref} for {amount} is ready.": "Tagihan {ref} sebesar {amount} sudah siap.",
  "Open the invoice to pay": "Buka tagihan untuk membayar",
  "From {min} to {max}.": "Dari {min} sampai {max}.",
  "Issue invoice": "Buat tagihan",
  "{amount} waiting for payment": "{amount} menunggu pembayaran",
  Pay: "Bayar",
  "Waiting for payment": "Menunggu pembayaran",
  Paid: "Lunas",
  Cancelled: "Dibatalkan",
  Expired: "Kedaluwarsa",
  "Could not read the top-ups": "Gagal memuat isi ulang",
  "Could not create the top-up": "Gagal membuat isi ulang",

  // ArusNiaga integration page
  "The ERP that issues Larika's invoices: workspace top-ups are invoiced and paid there.":
    "ERP yang menerbitkan tagihan Larika: isi ulang workspace ditagih dan dibayar di sana.",
  Connected: "Terhubung",
  "Not reachable": "Tidak terjangkau",
  "API key": "API key",
  "Invoices as": "Menagih atas nama",
  "Open ArusNiaga": "Buka ArusNiaga",
  "An API key from ArusNiaga (Admin → Pengaturan → API Keys), scoped to the business that invoices. Stored encrypted; saving checks it with one call.":
    "API key dari ArusNiaga (Admin → Pengaturan → API Keys), dibatasi ke entitas bisnis yang menagih. Disimpan terenkripsi; saat disimpan dicek dengan satu panggilan.",
  "ArusNiaga settings saved": "Pengaturan ArusNiaga disimpan",
  "Saved, but ArusNiaga refused the call": "Tersimpan, tetapi ArusNiaga menolak panggilannya",
  "Failed to save the ArusNiaga settings": "Gagal menyimpan pengaturan ArusNiaga",
  "Failed to fetch the ArusNiaga settings": "Gagal memuat pengaturan ArusNiaga",
  "Top-ups": "Isi ulang",
  Created: "Dibuat",
  Invoice: "Tagihan",
  Open: "Buka",
  "No top-ups yet.": "Belum ada isi ulang.",
  "Check payments now": "Cek pembayaran sekarang",
  "The check failed": "Pengecekan gagal",
  "In ArusNiaga, open": "Di ArusNiaga, buka",
  "and create a key scoped to the business that invoices.": "lalu buat key yang dibatasi ke entitas bisnis yang menagih.",
  "Paste it here and save: the panel checks it by reading that business.": "Tempel di sini lalu simpan: panel mengeceknya dengan membaca entitas bisnis itu.",
  "Workspaces top up from their Usage page: each top-up is an invoice in ArusNiaga, paid on its invoice page.":
    "Workspace mengisi ulang dari halaman Pemakaian: setiap isi ulang adalah tagihan di ArusNiaga, dibayar di halaman tagihannya.",
  "When ArusNiaga shows it paid, the balance is credited within a minute. Unpaid invoices stop being checked after 14 days.":
    "Setelah ArusNiaga mencatatnya lunas, saldo bertambah dalam satu menit. Tagihan yang belum dibayar berhenti dicek setelah 14 hari.",

  // gift credit (workspace detail, platform admins)
  Gift: "Hadiah",
  "Gift credit": "Beri saldo",
  "Gift credit to {name}": "Beri saldo ke {name}",
  "Added to its balance at once, shown on its statement as a gift. It cannot be taken back here.":
    "Langsung masuk ke saldonya, tampil di riwayatnya sebagai hadiah. Tidak bisa ditarik kembali dari sini.",
  "e.g. Beta tester, sorry for the downtime": "mis. Penguji beta, permintaan maaf atas gangguan",
  "Shown on the workspace's statement.": "Tampil di riwayat saldo workspace.",
  "Gift {amount}": "Beri {amount}",
  "Credit gifted": "Saldo diberikan",
  "{name} now has {balance}.": "{name} sekarang punya {balance}.",
  "Could not gift the credit": "Gagal memberi saldo",

  // Usage page: the wallet (one per payer, shared by their workspaces)
  CPU: "CPU",
  Statement: "Riwayat saldo",
  "Services imported from a server (pm2 of another user) are not metered.": "Layanan yang diimpor dari server (pm2 milik user lain) tidak diukur.",
  "{n} days": "{n} hari",
  "Could not change who pays": "Gagal mengganti pembayar",
  "Your balance, shared by the {n} workspaces you pay for.": "Saldo Anda, dipakai bersama oleh {n} workspace yang Anda bayar.",
  "{name}'s balance, shared by the {n} workspaces they pay for.": "Saldo {name}, dipakai bersama oleh {n} workspace yang dia bayar.",
  "At the current pace": "Dengan pemakaian saat ini",
  "{amount} a day": "{amount} per hari",
  "This workspace: {amount} a day": "Workspace ini: {amount} per hari",
  "Hosting is not charged yet: only AI use comes off the balance.": "Hosting belum ditagih: hanya pemakaian AI yang memotong saldo.",
  "The balance is used up and the apps are stopped. Nothing was deleted: top up and they start again.":
    "Saldo habis dan aplikasi dihentikan. Tidak ada yang dihapus: isi ulang dan aplikasi berjalan lagi.",
  "Below zero: the apps stop in about {days}, at {limit}.": "Di bawah nol: aplikasi berhenti dalam sekitar {days}, pada {limit}.",
  "Lasts about {days}. After that it may go down to {limit} before the apps stop.":
    "Cukup untuk sekitar {days}. Setelah itu boleh turun sampai {limit} sebelum aplikasi berhenti.",
  "Billed to": "Ditagihkan ke",
  "An owner of the workspace: their balance pays for it, and balance warnings are mailed to them.":
    "Pemilik workspace: saldonya yang membayar, dan peringatan saldo dikirim ke emailnya.",
  "Could not read the usage": "Gagal memuat pemakaian",
  "Could not read the prices": "Gagal memuat harga",
  "Could not read the balance": "Gagal memuat saldo",

  // AI: key spending limits, whose balance
  "Paid from {name}'s balance, shared by the workspaces they pay for.": "Dibayar dari saldo {name}, dipakai bersama oleh workspace yang dia bayar.",
  "Failed to change the limit": "Gagal mengubah batas",
  "Spent / limit": "Terpakai / batas",
  "no limit": "tanpa batas",
  "Spending limit": "Batas belanja",
  "Spending limit (Rp, optional)": "Batas belanja (Rp, opsional)",
  "No limit": "Tanpa batas",
  "The key is refused once it has spent this much in a day or month (WIB), so a leaked key or a runaway loop cannot drain the balance.":
    "Key ditolak setelah memakai sebanyak ini dalam sehari atau sebulan (WIB), supaya key yang bocor atau loop yang lepas kendali tidak menghabiskan saldo.",
  "Spending limit for {name}": "Batas belanja untuk {name}",
  "Spent this period: {amount}. The key is refused once it reaches the limit, until the next day or month (WIB); empty means no limit.":
    "Terpakai periode ini: {amount}. Key ditolak setelah mencapai batas, sampai hari atau bulan berikutnya (WIB); kosong berarti tanpa batas.",
  "Limit (Rp)": "Batas (Rp)",
  "/ day": "/ hari",
  "/ month": "/ bulan",
  Per: "Per",
  "per day": "per hari",
  "per month": "per bulan",

  // gifts (Users page) and balances (superadmin)
  "Added to their balance at once — shared by every workspace they pay for — and shown on their statement as a gift. It cannot be taken back here.":
    "Langsung masuk ke saldonya — dipakai bersama oleh semua workspace yang dia bayar — dan tampil di riwayatnya sebagai hadiah. Tidak bisa ditarik kembali dari sini.",
  "Shown on their statement.": "Tampil di riwayat saldonya.",
  Adjust: "Koreksi",
  Balances: "Saldo",
  "Search users…": "Cari user…",
  "Adjust the balance of {name}": "Koreksi saldo {name}",
  "A correction in rupiah (negative takes it back). The note shows on their statement. To give credit, use Gift on the Users page.":
    "Koreksi dalam rupiah (negatif menariknya kembali). Catatan tampil di riwayat saldonya. Untuk memberi saldo, pakai Beri saldo di halaman Users.",
} satisfies Record<string, string>;
