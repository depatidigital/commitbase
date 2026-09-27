// Pricing page: apps, domains, WhatsApp, AI, and the monthly estimator.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  Pricing: "Harga",
  "Pay only for what you use. Prices in rupiah, no minimum contract.": "Bayar hanya yang Anda pakai. Harga dalam rupiah, tanpa kontrak minimum.",

  // apps & databases
  "Apps & databases": "Aplikasi & database",
  "Metered every five minutes from what your services and databases actually use. Nothing is charged for what they don't use.":
    "Diukur tiap lima menit dari pemakaian nyata layanan dan database Anda. Yang tidak dipakai tidak ditagih.",
  "Per vCPU in use": "Per vCPU yang dipakai",
  "Per GB held": "Per GB yang ditempati",
  Disk: "Disk",
  "Files, databases and logs on the server; charged by the day": "File, database, dan log di server; ditagih per hari",
  "Static sites' files": "File situs statis",
  "See your usage": "Lihat pemakaian Anda",
  month: "bulan",

  // domains
  "Registration and renewal at each extension's price, shown when you search for a domain.":
    "Pendaftaran dan perpanjangan sesuai harga tiap ekstensi, tampil saat Anda mencari domain.",
  "Search a domain": "Cari domain",

  // WhatsApp
  "Per number: the days it is linked and what it sends. Receiving is free.": "Per nomor: hari-hari nomor itu tertaut dan pesan yang dikirim. Menerima gratis.",
  "Linked number": "Nomor tertaut",
  "Only the days it is linked": "Hanya hari-hari saat tertaut",
  day: "hari",
  "Text messages": "Pesan teks",
  "First {count} per number per day": "{count} pertama per nomor per hari",
  Free: "Gratis",
  "then {price} each": "lalu {price} per pesan",
  "Media messages": "Pesan media",
  "Images, video, audio, documents": "Gambar, video, audio, dokumen",
  message: "pesan",
  "Incoming messages & webhooks": "Pesan masuk & webhook",
  "Own WA node": "WA node sendiri",
  "Your own PC running WhatsApp sessions": "PC Anda sendiri yang menjalankan sesi WhatsApp",
  "node-month": "node-bulan",
  "Runs on WhatsApp linked devices, not the official Business API: a number WhatsApp bans is not refunded. Daily sending limits stay on to protect your numbers.":
    "Berjalan di perangkat tertaut WhatsApp, bukan Business API resmi: nomor yang diblokir WhatsApp tidak dikembalikan dananya. Batas kirim harian tetap aktif untuk melindungi nomor Anda.",

  // AI
  "One OpenAI-compatible API for many models, charged per token from the workspace balance.":
    "Satu API yang kompatibel dengan OpenAI untuk banyak model, ditagih per token dari saldo workspace.",

  // estimator
  "Estimate a month": "Perkiraan sebulan",
  "Average use over the month, not the peak.": "Rata-rata pemakaian selama sebulan, bukan puncaknya.",
  vCPU: "vCPU",
  "Memory (GB)": "Memori (GB)",
  "Disk (GB)": "Disk (GB)",
  "WA numbers": "Nomor WA",
  "Texts / day each": "Teks / hari per nomor",
  "Media / day each": "Media / hari per nomor",
  "Per month": "Per bulan",
} satisfies Record<string, string>;
