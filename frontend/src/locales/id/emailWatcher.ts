// Email Watcher pages (list, mailbox, rule dialog, events), its Pricing rows and lib/emailWatcher.ts fallbacks.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  "Email Watcher": "Pantau Email",

  // statuses
  Watching: "Memantau",
  "No rule yet": "Belum ada rule",
  "Login refused": "Login ditolak",
  Reconnecting: "Menyambung ulang",
  Paused: "Dijeda",

  // password guides
  "Gmail needs an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords and paste its 16 characters here.":
    "Gmail butuh sandi aplikasi: aktifkan Verifikasi 2 Langkah, lalu buat sandi aplikasi di myaccount.google.com/apppasswords dan tempel 16 karakternya di sini.",
  "Google Workspace needs an app password: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords. Your admin may have to allow app passwords.":
    "Google Workspace butuh sandi aplikasi: aktifkan Verifikasi 2 Langkah, lalu buat di myaccount.google.com/apppasswords. Admin Anda mungkin perlu mengizinkan sandi aplikasi.",
  "Yahoo needs an app password: Account security → Generate app password, at login.yahoo.com/account/security.":
    "Yahoo butuh sandi aplikasi: Keamanan akun → Buat sandi aplikasi, di login.yahoo.com/account/security.",
  "iCloud needs an app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords.":
    "iCloud butuh sandi khusus app: appleid.apple.com → Masuk dan Keamanan → Sandi Khusus App.",
  "Turn on IMAP access in Zoho Mail's settings. With two-factor sign-in on, use an application-specific password.":
    "Aktifkan akses IMAP di pengaturan Zoho Mail. Jika login dua faktor aktif, gunakan sandi khusus aplikasi.",
  "Use the mailbox's own password. The server is usually mail.<your domain> — your hosting's email settings show it.":
    "Gunakan sandi mailbox itu sendiri. Servernya biasanya mail.<domain Anda> — lihat di pengaturan email hosting Anda.",

  // quick start
  Mailboxes: "Mailbox",
  "Connect the inbox your notifications arrive in": "Hubungkan inbox tempat notifikasi Anda masuk",
  "Gmail, Yahoo and iCloud need an app password (2-step verification on); email on your own domain uses its normal password. Larika only reads, and never stores an email your rules do not match.":
    "Gmail, Yahoo, dan iCloud butuh sandi aplikasi (Verifikasi 2 Langkah aktif); email di domain sendiri memakai sandi biasanya. Larika hanya membaca, dan tidak pernah menyimpan email yang tidak cocok dengan rule Anda.",
  "Make a rule and try it on real emails": "Buat rule dan coba pada email asli",
  "Pick emails by sender and subject (or start from the BNI Merchant preset), add the fields to read — a regular expression each — and press Try: the last 30 days of your inbox show what the rule would read out.":
    "Pilih email berdasarkan pengirim dan subjek (atau mulai dari preset BNI Merchant), tambahkan field yang dibaca — masing-masing sebuah regular expression — lalu tekan Coba: email 30 hari terakhir di inbox Anda menunjukkan apa yang akan dibaca rule itu.",
  "Receive it in your app with a webhook": "Terima di aplikasi Anda lewat webhook",
  "Set a webhook URL on the rule. Each matched email is POSTed there as JSON within seconds, with the rule's webhook key in":
    "Isi webhook URL pada rule. Setiap email yang cocok dikirim (POST) ke sana sebagai JSON dalam hitungan detik, dengan webhook key rule itu di",
  "Failed sends are retried for about 9 hours.": "Pengiriman yang gagal dicoba ulang selama sekitar 9 jam.",
  "Or get it on WhatsApp": "Atau terima di WhatsApp",
  "With a number on Whatsapp Gateway API, a rule can message you for each match — like “Masuk Rp {amount} dari {source}” — using the fields it read.":
    "Dengan nomor di Whatsapp Gateway API, rule bisa mengirim pesan untuk setiap email yang cocok — seperti “Masuk Rp {amount} dari {source}” — memakai field yang dibacanya.",

  // list page
  "Reads incoming emails, like bank notifications, and sends their data to your app or WhatsApp.":
    "Membaca email masuk, seperti notifikasi bank, lalu mengirim datanya ke aplikasi atau WhatsApp Anda.",
  "Add mailbox": "Tambah mailbox",
  Mailbox: "Mailbox",
  Rules: "Rule",
  "Last checked": "Terakhir dicek",
  "Search mailboxes…": "Cari mailbox…",
  "No mailboxes yet. Add the inbox your bank or payment notifications arrive in.":
    "Belum ada mailbox. Tambahkan inbox tempat notifikasi bank atau pembayaran Anda masuk.",

  // add mailbox
  "Larika logs in over IMAP and only reads. Emails your rules do not match are never stored.":
    "Larika login lewat IMAP dan hanya membaca. Email yang tidak cocok dengan rule Anda tidak pernah disimpan.",
  "Email address": "Alamat email",
  "IMAP server": "Server IMAP",
  "App password": "Sandi aplikasi",
  "Test and add": "Tes dan tambahkan",
  "Could not look up the mail server": "Tidak bisa mencari server email",

  // mailbox page
  Pause: "Jeda",
  "Delete mailbox": "Hapus mailbox",
  "Login for {email}": "Login untuk {email}",
  "Tested before it is saved. The watcher reconnects with it and reads what arrived meanwhile.":
    "Dites sebelum disimpan. Pemantau menyambung ulang dengannya dan membaca email yang masuk selama terputus.",
  "Password or app password": "Sandi atau sandi aplikasi",
  "Test and save": "Tes dan simpan",
  "Larika stops reading it and deletes its rules and events. The emails stay in the mailbox.":
    "Larika berhenti membacanya dan menghapus rule serta event-nya. Email tetap ada di mailbox.",
  "Its events are deleted with it.": "Event-nya ikut terhapus.",

  // rules
  Rule: "Rule",
  "Extracted data": "Data diekstrak",
  "Sends to": "Kirim ke",
  nowhere: "tidak ke mana pun",
  "Rule on": "Rule aktif",
  "New rule": "Rule baru",
  "Add a mailbox first; its rules show here.": "Tambahkan mailbox dulu; rule-nya muncul di sini.",
  "Rule saved": "Rule tersimpan",
  "Search rules…": "Cari rule…",
  "No rules yet. A rule picks emails by sender and subject and reads values out of them.":
    "Belum ada rule. Rule memilih email berdasarkan pengirim dan subjek, lalu membaca nilai dari email itu.",
  "Field name": "Nama field",
  Text: "Teks",
  "Add field": "Tambah field",
  Subject: "Subjek",
  "Verified sender": "Pengirim terverifikasi",
  "Sender not verified": "Pengirim tidak terverifikasi",
  "not found": "tidak ditemukan",
  "Only verified senders": "Hanya pengirim terverifikasi",
  "Webhook URL (optional)": "URL webhook (opsional)",
  "Webhook key — sent in x-larika-webhook-key; check it in your app:":
    "Webhook key — dikirim di x-larika-webhook-key; cek di aplikasi Anda:",
  "WhatsApp (optional)": "WhatsApp (opsional)",
  "Add a number under Whatsapp Gateway API to be notified on WhatsApp.":
    "Tambahkan nomor di Whatsapp Gateway API untuk menerima notifikasi WhatsApp.",
  "Send from": "Kirim dari",
  "No WhatsApp": "Tanpa WhatsApp",
  "Send from {name}": "Kirim dari {name}",
  "Send to": "Kirim ke",
  "{rule}: {subject} — or use your fields, like {amount}": "{rule}: {subject} — atau pakai field Anda, seperti {amount}",
  "Failed to try the rule": "Gagal mencoba rule",
  "Failed to save the rule": "Gagal menyimpan rule",
  "Failed to delete the rule": "Gagal menghapus rule",

  // messages from the server, shown through t()
  "Paused: the balance does not cover today. Top up, then resume.":
    "Dijeda: saldo tidak cukup untuk hari ini. Isi saldo, lalu lanjutkan.",
  "Outlook and Hotmail only allow sign-in with Microsoft, which is not supported yet":
    "Outlook dan Hotmail hanya mengizinkan login lewat Microsoft, yang belum didukung",
  "Microsoft 365 only allows sign-in with Microsoft, which is not supported yet":
    "Microsoft 365 hanya mengizinkan login lewat Microsoft, yang belum didukung",

  // rule editor
  "no filter yet": "belum ada filter",
  "Name it and pick its mailbox; the editor opens next, with the mailbox's emails to try it on.":
    "Beri nama dan pilih mailbox-nya; editor terbuka setelahnya, dengan email dari mailbox itu untuk mencobanya.",
  "Start from": "Mulai dari",
  Blank: "Kosong",
  "Create and edit": "Buat dan ubah",
  "Rule not found": "Rule tidak ditemukan",
  Off: "Mati",
  "Not a valid regular expression": "Bukan regular expression yang valid",
  "Failed to fetch the rule": "Gagal mengambil rule",

  // rule editor, live matching
  Rename: "Ganti nama",
  Filter: "Filter",
  Sender: "Pengirim",
  "Ignores forged emails (DKIM/DMARC).": "Abaikan email palsu (DKIM/DMARC).",
  "Letters, digits and _ only, like amount or source": "Hanya huruf, angka, dan _, seperti amount atau source",
  Template: "Template",
  "Pattern (regex)": "Pola (regex)",
  "Amount (Rp …)": "Jumlah (Rp …)",
  "Date (20/09/2026, 20 Sep 2026)": "Tanggal (20/09/2026, 20 Sep 2026)",
  "Reference number": "Nomor referensi",
  "Value after a label": "Nilai setelah label",
  "Word after a word": "Kata setelah kata",
  Word: "Kata",
  Body: "Isi",
  "First number": "Angka pertama",
  "Live matching": "Pencocokan langsung",
  Emails: "Email",
  Last: "Terakhir",
  Days: "Hari",
  "days, up to": "hari, maksimal",
  emails: "email",

  // conditions
  Field: "Bagian",
  Operator: "Operator",
  "Add condition": "Tambah kondisi",
  contains: "mengandung",
  "does not contain": "tidak mengandung",
  equals: "sama dengan",
  "is one of": "salah satu dari",
  "is none of": "bukan salah satu dari",
  "matches regex": "cocok regex",
  or: "atau",
  "{passed} of {taken} taken by the rule": "{passed} dari {taken} diambil rule ini",
  "not taken by the rule": "tidak diambil rule ini",

  // editor tabs, conditions as cards, extract
  Extract: "Ekstrak",
  Delivery: "Pengiriman",
  "Values read out of each email and sent as its data. A pattern's first group (…) is the value.":
    "Nilai yang dibaca dari tiap email dan dikirim sebagai datanya. Grup pertama (…) pola menjadi nilainya.",
  "Nothing extracted yet. Start from a template:": "Belum ada yang diekstrak. Mulai dari template:",
  "Its colour in the email": "Warnanya di email",
  "Emails taken by the rule this field reads a value from": "Email yang diambil rule dan berhasil dibaca field ini",
  OR: "ATAU",
  AND: "DAN",
  "Take an email when": "Ambil email jika",
  "all conditions hold": "semua kondisi terpenuhi",
  "any condition holds": "salah satu kondisi terpenuhi",
  "Swap AND / OR": "Tukar DAN / ATAU",
  "Emails in the preview this condition takes": "Email di preview yang memenuhi kondisi ini",
  "Takes an email when": "Mengambil email jika",
  "{taken} of {total} emails in the preview.": "{taken} dari {total} email di preview.",
  "add…": "tambah…",

  // security, field source
  "This rule does not check the sender's email address. Anyone can send an email named “BNI Merchant”: check the address the bank sends from.":
    "Rule ini tidak memeriksa alamat email pengirim. Siapa pun bisa mengirim email bernama “BNI Merchant”: periksa alamat yang dipakai bank.",
  "Sender equals {address}": "Pengirim sama dengan {address}",
  "Off: a forged email that copies the bank's address is sent on too. Keep it on for payments.":
    "Mati: email palsu yang meniru alamat bank ikut diteruskan. Biarkan aktif untuk pembayaran.",
  "Read from": "Baca dari",
  "Add a filter to narrow them.": "Tambah filter untuk menyaring.",

  // extract with AI
  "Extract with AI": "Ekstrak dengan AI",
  "Set a filter that takes some emails first": "Atur filter yang mengambil beberapa email dulu",
  "Failed to extract with AI": "Gagal mengekstrak dengan AI",
  "Show the AI which values to read; it writes the patterns and checks them on these emails.":
    "Tunjukkan ke AI nilai mana yang dibaca; AI membuat polanya dan mengeceknya pada email-email ini.",
  "Select a value": "Blok nilai",
  "Give it a name": "Beri nama",
  "The AI writes the pattern": "AI membuat pola",
  "Previous email": "Email sebelumnya",
  "Email {n} of {total}": "Email {n} dari {total}",
  "Next email": "Email berikutnya",
  Label: "Label",
  "Select text in the email to label it. Mark it in a second email too: the AI learns what stays the same.":
    "Blok teks di email untuk memberinya label. Tandai juga di email kedua: AI jadi tahu bagian mana yang tetap.",
  "No pattern for {name}. Label it in another email and try again.": "Tidak ada pola untuk {name}. Labeli juga di email lain lalu coba lagi.",
  "Free, up to 100 a day. Parts of these emails are sent to the AI to write the patterns.":
    "Gratis, maksimal 100 per hari. Sebagian isi email ini dikirim ke AI untuk membuat pola.",
  "{left} left today.": "Sisa {left} hari ini.",
  "Apply {n} field(s)": "Terapkan {n} field",
  "Generate again": "Generate ulang",

  // field types
  "Pick a type": "Pilih tipe",
  "Free text": "Teks bebas",
  Numeric: "Angka",
  Money: "Uang",
  Date: "Tanggal",
  "Code / ID": "Kode / ID",

  // events
  Received: "Diterima",
  Read: "Terbaca",
  "Logged only": "Hanya dicatat",
  "Kept {days} days. Failed sends are retried for about 9 hours.": "Disimpan {days} hari. Gagal kirim dicoba ulang ±9 jam.",
  "Search subject or sender…": "Cari subjek atau pengirim…",
  "Nothing matched yet. New emails show here within seconds of arriving.":
    "Belum ada yang cocok. Email baru muncul di sini beberapa detik setelah masuk.",
  "Failed to send the event again": "Gagal mengirim ulang event",
  "Failed to fetch events": "Gagal mengambil event",

  // lib fallbacks
  "Failed to add the mailbox": "Gagal menambahkan mailbox",
  "Failed to update the mailbox": "Gagal memperbarui mailbox",
  "Failed to delete the mailbox": "Gagal menghapus mailbox",
  "Failed to fetch mailboxes": "Gagal mengambil daftar mailbox",
  "Failed to fetch the rules": "Gagal mengambil daftar rule",

  // Pricing page
  "Reads your inbox and sends matched emails to your app or WhatsApp.":
    "Membaca inbox Anda dan mengirim email yang cocok ke aplikasi atau WhatsApp Anda.",
  "Watched mailbox": "Mailbox yang dipantau",
  "Only the days it is watched; paid up front each day": "Hanya hari saat dipantau; dibayar di muka tiap hari",
};
