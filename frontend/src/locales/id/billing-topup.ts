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
} satisfies Record<string, string>;
