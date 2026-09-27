// AI API page, the AI Gateway integration page (settings, workspace balances) and lib/ai.ts fallbacks.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // page
  "AI API": "AI API",
  "One OpenAI-compatible API for many models, paid per token from the workspace balance.":
    "Satu API yang kompatibel dengan OpenAI untuk banyak model, dibayar per token dari saldo workspace.",
  "The AI API is not available on this platform yet.": "AI API belum tersedia di platform ini.",
  "The AI gateway did not answer: {error}": "AI gateway tidak menjawab: {error}",

  // balance
  Balance: "Saldo",
  "Calls are refused until the balance is topped up.": "Panggilan ditolak sampai saldo diisi ulang.",
  "Each call is charged from it, every minute.": "Setiap panggilan dipotong dari saldo ini, tiap menit.",
  "To top up, contact support.": "Untuk isi ulang, hubungi support.",
  "The AI API of this workspace is suspended.": "AI API workspace ini ditangguhkan.",

  // endpoint
  Endpoint: "Endpoint",
  "Use it as the base URL of any OpenAI SDK, with a key from here as the API key.":
    "Pakai sebagai base URL di SDK OpenAI mana pun, dengan key dari sini sebagai API key.",

  // turning on
  "Turn it on to create API keys. Nothing is charged until a key is used.":
    "Aktifkan untuk membuat API key. Tidak ada biaya sampai sebuah key dipakai.",
  "Turn on the AI API": "Aktifkan AI API",

  // keys
  Keys: "Key",
  Key: "Key",
  "Requests / min": "Request / menit",
  "Requests per minute": "Request per menit",
  "Last used": "Terakhir dipakai",
  "Search keys…": "Cari key…",
  "No keys yet. Create one for each app that calls the API.": "Belum ada key. Buat satu untuk tiap aplikasi yang memanggil API.",
  "One key per app, so one can be revoked without stopping the others.":
    "Satu key per aplikasi, supaya satu bisa dicabut tanpa menghentikan yang lain.",
  Done: "Selesai",
  "Revoke {name}?": "Cabut {name}?",
  "Apps using this key stop working at once.": "Aplikasi yang memakai key ini langsung berhenti bekerja.",

  // usage
  Updated: "Diperbarui",
  Description: "Keterangan",
  Amount: "Jumlah",
  "This month's AI use: {amount}. One line per day and model, added to as calls are billed.":
    "Pemakaian AI bulan ini: {amount}. Satu baris per hari dan model, bertambah saat panggilan ditagih.",
  "Nothing this month yet.": "Belum ada apa-apa bulan ini.",
  "Top-up": "Isi ulang",
  Adjustment: "Penyesuaian",
  "AI usage": "Pemakaian AI",

  // models
  Models: "Model",
  Model: "Model",
  "Off-peak price; more in the provider's peak hours": "Harga di luar jam sibuk; lebih mahal di jam sibuk penyedia",
  "By prompt size: up to {sizes} tokens": "Menurut ukuran prompt: sampai {sizes} token",
  Context: "Konteks",
  Input: "Input",
  "Cached input": "Input cache",
  Output: "Output",
  "Rupiah per 1 million tokens. Send the model name as `model`.": "Rupiah per 1 juta token. Kirim nama model sebagai `model`.",
  "Search models…": "Cari model…",
  "No models yet.": "Belum ada model.",

  // AI Gateway integration page (superadmin)
  "The AI gateway behind every workspace's AI API, and how its buy prices are sold.":
    "AI gateway di balik AI API setiap workspace, dan cara harga belinya dijual.",
  "AI gateway settings saved": "Pengaturan AI gateway disimpan",
  "Saved, but the gateway refused the call": "Tersimpan, tetapi gateway menolak panggilannya",
  "Providers & models": "Penyedia & model",
  "Admin key": "Admin key",
  "Admin path": "Admin path",
  Set: "Terisi",
  Rate: "Kurs",
  Markup: "Markup",
  "per dollar bought": "per dolar yang dibeli",
  "The gateway's ADMIN_KEY is stored encrypted. Saving checks it with one call to the gateway.":
    "ADMIN_KEY gateway disimpan terenkripsi. Saat disimpan, panel mengeceknya dengan satu panggilan ke gateway.",
  "Rate (IDR per USD)": "Kurs (IDR per USD)",
  "Every call is charged its buy price × rate × markup: {price} per dollar bought. Changing either moves every workspace's spend cap at once.":
    "Setiap panggilan dikenai harga beli × kurs × markup: {price} per dolar yang dibeli. Mengubah salah satunya langsung menggeser batas belanja semua workspace.",

  // workspace balances
  "Workspace balances": "Saldo workspace",
  "No balances yet.": "Belum ada saldo.",
  "Search workspaces…": "Cari workspace…",
  On: "Aktif",
  Credit: "Tambah saldo",
  Suspend: "Tangguhkan",
  Resume: "Lanjutkan",
  "Credit a workspace": "Tambah saldo workspace",
  "Rupiah added to its balance (negative takes it back). The note shows on its statement.":
    "Rupiah yang ditambahkan ke saldonya (angka negatif menariknya kembali). Catatan tampil di riwayat saldonya.",
  "Amount (Rp)": "Jumlah (Rp)",
  Note: "Catatan",
  "e.g. Top-up by bank transfer, 27 Sep": "mis. Isi ulang lewat transfer bank, 27 Sep",
  "Balance updated": "Saldo diperbarui",
  "AI API suspended": "AI API ditangguhkan",
  "AI API resumed": "AI API dilanjutkan",

  // setup guide
  "On the AI gateway's server, copy": "Di server AI gateway, salin",
  "Paste them here with the rate and markup, and save: the panel checks them with one call to the gateway.":
    "Tempel di sini bersama kurs dan markup, lalu simpan: panel mengeceknya dengan satu panggilan ke gateway.",
  "Add providers and models, with their buy prices, on the gateway's own dashboard (/dashboard).":
    "Tambahkan penyedia dan model, beserta harga belinya, di dasbor gateway itu sendiri (/dashboard).",
  "Credit a workspace below; it turns the AI API on and creates keys under AI API.":
    "Tambah saldo sebuah workspace di bawah; workspace itu lalu mengaktifkan AI API dan membuat key di menu AI API.",

  // lib/ai.ts fallbacks
  "Failed to fetch the AI API": "Gagal memuat AI API",
  "Failed to turn the AI API on": "Gagal mengaktifkan AI API",
  "Failed to fetch the AI models": "Gagal memuat model AI",
  "Failed to fetch the balance history": "Gagal memuat riwayat saldo",
  "Failed to fetch the AI gateway settings": "Gagal memuat pengaturan AI gateway",
  "Failed to save the AI gateway settings": "Gagal menyimpan pengaturan AI gateway",
  "Failed to fetch the wallets": "Gagal memuat saldo",
  "Failed to credit the wallet": "Gagal menambah saldo",
  "Failed to change the AI API": "Gagal mengubah AI API",
} satisfies Record<string, string>;
