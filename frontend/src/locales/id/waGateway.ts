// Whatsapp Gateway API page (numbers, quick start, dialogs) and lib/waGateway.ts fallbacks.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  // statuses
  "Waiting for QR scan": "Menunggu scan QR",
  Connecting: "Menghubungkan",
  "Not on the gateway": "Tidak ada di gateway",

  // page, list
  "Link a WhatsApp number by QR, then send and receive messages from your apps with its API key.":
    "Tautkan nomor WhatsApp lewat QR, lalu kirim dan terima pesan dari aplikasi Anda dengan API key nomor itu.",
  "Add number": "Tambah nomor",
  "The gateway did not answer: {error}": "Gateway tidak menjawab: {error}",
  Numbers: "Nomor",
  Number: "Nomor",
  "Sent 24 h": "Terkirim 24 jam",
  "API access from": "Akses API dari",
  "any IP": "semua IP",
  "Scan QR": "Scan QR",
  Test: "Tes",
  "API & keys": "API & key",
  "Access & webhook": "Akses & webhook",
  "Search numbers…": "Cari nomor…",
  "No WhatsApp numbers yet.": "Belum ada nomor WhatsApp.",

  // add number
  "After adding, scan the QR code with WhatsApp on the phone (Linked devices → Link a device).":
    "Setelah ditambahkan, scan kode QR dengan WhatsApp di HP (Perangkat tertaut → Tautkan perangkat).",
  "Pick a workspace": "Pilih workspace",
  "Allowed IPs": "IP yang diizinkan",
  "The servers allowed to call the API with this number's key, separated by commas. * allows any IP (the key is still required).":
    "Server yang boleh memanggil API dengan key nomor ini, dipisah koma. * mengizinkan semua IP (key tetap wajib).",
  "Incoming messages, receipts and status changes are POSTed here, signed with the webhook secret.":
    "Pesan masuk, tanda terima, dan perubahan status dikirim (POST) ke sini, ditandatangani dengan webhook secret.",

  // quick start
  "Quick start": "Mulai cepat",
  "Base URL": "Base URL",
  "Every call goes to": "Setiap panggilan ke",
  "with the number's own API key.": "dengan API key milik nomor itu.",
  "Full API reference": "Referensi API lengkap",
  "Add a number and link WhatsApp": "Tambah nomor dan tautkan WhatsApp",
  "Name the number and choose which servers may call the API, then scan the QR code on the phone: WhatsApp → Linked devices → Link a device. Its first API key is made with it.":
    "Beri nama nomor dan tentukan server mana yang boleh memanggil API, lalu scan kode QR di HP: WhatsApp → Perangkat tertaut → Tautkan perangkat. API key pertamanya dibuat sekalian.",
  "Get an API key": "Ambil API key",
  "A key is shown once, when it is made. Send it with every request; either header works:":
    "Key hanya ditampilkan sekali, saat dibuat. Kirim di setiap request; header mana pun bisa:",
  "Send your first message": "Kirim pesan pertama",
  "Write numbers the way people type them (0812…, +62 812…). Messages are queued and sent at a safe pace.":
    "Tulis nomor seperti biasa diketik orang (0812…, +62 812…). Pesan masuk antrean dan dikirim dengan jeda aman.",
  "Send a test message": "Kirim pesan tes",
  "Receive messages with a webhook": "Terima pesan lewat webhook",
  "Set a webhook URL on the number. Incoming messages, receipts and status changes are POSTed there as JSON, signed with the webhook secret in":
    "Isi webhook URL pada nomor. Pesan masuk, tanda terima, dan perubahan status dikirim (POST) ke sana sebagai JSON, ditandatangani dengan webhook secret di",

  // scan QR
  Linked: "Tertaut",
  "On the phone: WhatsApp → Linked devices → Link a device, then scan this code.":
    "Di HP: WhatsApp → Perangkat tertaut → Tautkan perangkat, lalu scan kode ini.",
  "Preparing the QR code on the WA node…": "Menyiapkan kode QR di WA node…",
  "New QR code": "Kode QR baru",

  // test message
  "Test message from Larika": "Pesan tes dari Larika",
  "Sent through the gateway like an app's message, and counts toward the number's daily limit.":
    "Dikirim lewat gateway seperti pesan dari aplikasi, dan dihitung ke batas harian nomor.",
  To: "Ke",
  "Ctrl+Enter to send": "Ctrl+Enter untuk kirim",
  Sent: "Terkirim",
  "Queued ({status}) — it is sent as soon as the number's turn comes.":
    "Dalam antrean ({status}) — dikirim begitu giliran nomor ini tiba.",
  Send: "Kirim",

  // API & keys
  "Send the key as": "Kirim key sebagai",
  "API reference": "Referensi API",
  "API keys": "API key",
  "New key": "Key baru",
  "Copy it now — it is not shown again.": "Salin sekarang — tidak akan ditampilkan lagi.",
  "Last used {date}": "Terakhir dipakai {date}",
  "Never used": "Belum pernah dipakai",
  Revoked: "Dicabut",
  Revoke: "Cabut",
  "No keys yet.": "Belum ada key.",

  // access & webhook
  "Webhook secret": "Webhook secret",
  "New secret": "Secret baru",
  "Each webhook carries": "Setiap webhook membawa",

  // delete
  "WhatsApp is logged out on the phone, and the number's messages, media and API keys are deleted from the gateway.":
    "WhatsApp di HP akan logout, dan pesan, media, serta API key nomor ini dihapus dari gateway.",

  // lib/waGateway.ts fallbacks
  "Failed to fetch gateway settings": "Gagal mengambil pengaturan gateway",
  "Failed to save gateway settings": "Gagal menyimpan pengaturan gateway",
  "Failed to fetch WA nodes": "Gagal mengambil WA node",
  "Failed to pair the node": "Gagal memasangkan node",
  "Failed to fetch the connect string": "Gagal mengambil connect string",
  "Failed to revoke the node": "Gagal mencabut node",
  "Failed to delete the node": "Gagal menghapus node",
  "Failed to ask the nodes to update": "Gagal meminta node untuk update",
  "Failed to fetch WhatsApp numbers": "Gagal mengambil nomor WhatsApp",
  "Failed to add the number": "Gagal menambah nomor",
  "Failed to fetch the number": "Gagal mengambil nomor",
  "Failed to fetch the gateway URL": "Gagal mengambil URL gateway",
  "Failed to save the number": "Gagal menyimpan nomor",
  "Failed to relink the number": "Gagal menautkan ulang nomor",
  "Failed to restart the number": "Gagal me-restart nomor",
  "Failed to delete the number": "Gagal menghapus nomor",
  "Failed to fetch API keys": "Gagal mengambil API key",
  "Failed to create an API key": "Gagal membuat API key",
  "Failed to revoke the key": "Gagal mencabut key",
  "Failed to fetch the webhook secret": "Gagal mengambil webhook secret",
  "Failed to rotate the webhook secret": "Gagal mengganti webhook secret",
  "Failed to send the test message": "Gagal mengirim pesan tes",
  "Failed to call the API": "Gagal memanggil API",

  // API reference, Playground
  "All calls go to": "Semua panggilan ke",
  "with the number's API key in": "dengan API key nomor di",
  "Delete or move the number from the Numbers tab.": "Hapus atau pindahkan nomor dari tab Nomor.",
  "Add a number you manage first; the Playground calls the API as that number.":
    "Tambahkan dulu nomor yang Anda kelola; Playground memanggil API sebagai nomor itu.",
  Method: "Method",
  "Body (JSON)": "Body (JSON)",
  "Send request": "Kirim request",
  "This changes the real number.": "Ini mengubah nomor yang sebenarnya.",
  "Request URL": "URL request",
  "The code uses your app's API key (API & keys on the number); the Playground itself needs none.":
    "Kode memakai API key aplikasi Anda (API & key pada nomor); Playground sendiri tidak perlu key.",
  "Example response": "Contoh respons",
  "Target number: 0812…, +62 812… or 62812…": "Nomor tujuan: 0812…, +62 812… atau 62812…",
  "Chat JID or a plain number. Empty = the phone's chat": "JID chat atau nomor biasa. Kosong = chat nomor tujuan",
  "Group JID (Groups → List groups)": "JID grup (Groups → List groups)",
  "The id of a message you sent (fills itself after Send)": "Id pesan yang Anda kirim (terisi sendiri setelah Send)",
  "WhatsApp's message id (fills itself from Chat messages)": "Id pesan WhatsApp (terisi sendiri dari Chat messages)",
  "Variables are shared by every call and remembered in this browser.": "Variabel dipakai bersama semua panggilan dan diingat di browser ini.",
  "Really send?": "Yakin kirim?",
  "Fill {vars} first.": "Isi {vars} dulu.",
  Code: "Kode",
  "WA instance": "WA instance",
  "The Playground calls the API as this number; the code uses its URL.": "Playground memanggil API sebagai nomor ini; kode memakai URL-nya.",
  "No numbers yet": "Belum ada nomor",
  "Failed to fetch the API catalog": "Gagal mengambil katalog API",
} satisfies Record<string, string>;
