import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { APP_NAME, SUPPORT_URL } from '@/lib/branding';

// ponytail: Indonesian only on purpose — UU 24/2009 wants agreements with Indonesian parties in Indonesian.
const OPERATOR = 'CV Depati Digital Media';
const UPDATED = '1 Oktober 2026';

type Section = { h: string; p: string[] };

const TERMS: Section[] = [
  {
    h: 'Tentang layanan',
    p: [
      `${APP_NAME} adalah layanan yang dioperasikan oleh ${OPERATOR} ("kami") untuk menjalankan aplikasi, database, domain, WhatsApp gateway, Email Watcher, AI gateway dan layanan terkait ("Layanan"). Dengan mendaftar atau memakai Layanan, Anda setuju dengan syarat ini.`,
    ],
  },
  {
    h: 'Akun dan tanggung jawab',
    p: [
      'Anda wajib memberi data yang benar, menjaga kerahasiaan password, dan bertanggung jawab penuh atas semua aktivitas di akun serta workspace Anda, termasuk oleh anggota tim yang Anda undang.',
      'Anda bertanggung jawab atas aplikasi, kode dan konten yang Anda jalankan atau unggah. Kami tidak memeriksa dan tidak bertanggung jawab atas akurasi atau legalitas konten tersebut.',
      'Hal yang berhubungan dengan pihak ketiga, seperti Google, Cloudflare, registrar domain, WhatsApp/Meta, penyedia AI, atau developer aplikasi Anda, diselesaikan dengan pihak yang bersangkutan dan bukan tanggung jawab kami.',
    ],
  },
  {
    h: 'Penggunaan yang dilarang',
    p: [
      'Anda tidak boleh memakai Layanan untuk: konten atau kegiatan yang melanggar hukum Indonesia (termasuk perjudian, pornografi, penipuan dan konten SARA); melanggar hak kekayaan intelektual atau privasi orang lain; phishing, malware, botnet, penambangan kripto, pemindaian atau serangan ke sistem lain; atau membebani server secara tidak wajar sehingga mengganggu pengguna lain.',
      'Spam dilarang: email massal atau pesan WhatsApp massal kepada penerima yang tidak memberi persetujuan. Penggunaan WhatsApp gateway juga tunduk pada ketentuan WhatsApp/Meta, dan risiko nomor diblokir oleh WhatsApp sepenuhnya tanggung jawab Anda.',
    ],
  },
  {
    h: 'Penangguhan dan penghentian',
    p: [
      'Jika ada pelanggaran syarat ini, laporan penyalahgunaan, atau perintah dari pihak berwenang, kami berhak menangguhkan atau menghentikan layanan, workspace atau akun Anda, dengan atau tanpa pemberitahuan terlebih dahulu. Penangguhan karena pelanggaran tidak memberi hak atas pengembalian saldo.',
      'Untuk membuka penangguhan, hubungi kami. Kami akan menjelaskan penyebabnya dan apa yang perlu Anda perbaiki.',
      'Anda dapat berhenti memakai Layanan kapan saja dengan menghapus aplikasi Anda atau menghubungi kami untuk menutup akun.',
    ],
  },
  {
    h: 'Saldo, harga dan pembayaran',
    p: [
      'Layanan dibayar di muka dengan saldo. Pemakaian dipotong dari saldo sesuai harga di halaman Harga. Kami dapat mengubah harga dengan pemberitahuan sebelumnya; harga baru berlaku untuk pemakaian setelah tanggal berlaku.',
      'Kami mengirim pengingat lewat email saat saldo menipis. Saldo boleh minus sampai batas tertentu (kira-kira 7 hari pemakaian, minimal Rp 10.000) agar layanan tidak langsung berhenti. Melewati batas itu, aplikasi Anda dihentikan sampai saldo kembali positif. Saldo minus wajib dilunasi dan dipotong dari top-up berikutnya.',
      'Kredit sambutan (welcome credit) dan kredit hadiah tidak dapat diuangkan, dan dapat kami tarik jika didapat dengan cara curang, misalnya membuat banyak akun.',
    ],
  },
  {
    h: 'Pengembalian dana (refund)',
    p: [
      'Saldo hasil top-up pada dasarnya tidak dapat diuangkan kembali. Pengembalian dana hanya untuk kesalahan transaksi: jumlah yang salah, pembayaran ganda, atau jika kami menghentikan Layanan tanpa kesalahan Anda (sisa saldo top-up dikembalikan).',
      'Ajukan refund lewat kontak kami dengan bukti transaksi serta nama, nomor rekening dan nama bank penerima. Refund diproses paling lambat 14 hari kerja; biaya transfer dapat dipotong dari jumlah refund.',
      'Biaya domain yang sudah didaftarkan atau diperpanjang tidak dapat dikembalikan.',
    ],
  },
  {
    h: 'Data, cadangan dan penghapusan',
    p: [
      'Kode, data, database dan konten yang Anda simpan tetap milik Anda. Anda memberi kami izin sebatas yang diperlukan untuk menjalankan Layanan.',
      'Anda bertanggung jawab membuat cadangan (backup) data penting Anda sendiri. Kami berupaya menjaga data, tetapi tidak menjamin bebas dari kehilangan.',
      'Aplikasi yang dihentikan karena saldo minus selama lebih dari 30 hari, atau akun yang ditutup, beserta datanya dapat kami hapus permanen tanpa pemberitahuan lebih lanjut.',
    ],
  },
  {
    h: 'Domain',
    p: [
      'Pendaftaran, transfer dan perpanjangan domain dilakukan melalui registrar mitra dan tunduk pada kebijakan registrar serta pengelola domain (misalnya PANDI untuk .id, termasuk kewajiban dokumen). Domain yang tidak diperpanjang sebelum masa berlakunya habis dapat hilang.',
    ],
  },
  {
    h: 'Ketersediaan dan batas tanggung jawab',
    p: [
      'Layanan disediakan "sebagaimana adanya". Kami berupaya menjaga Layanan tetap tersedia, tetapi tidak menjanjikan uptime tertentu dan tidak memberi kompensasi atas gangguan, kecuali disepakati tertulis.',
      'Kami dapat melakukan pemeliharaan terjadwal maupun darurat yang membuat Layanan sementara tidak tersedia.',
      'Sejauh diizinkan hukum, tanggung jawab kami atas kerugian apa pun terbatas pada jumlah yang Anda bayarkan dalam 3 bulan terakhir, dan kami tidak bertanggung jawab atas kerugian tidak langsung seperti kehilangan keuntungan atau data. Kami tidak bertanggung jawab atas gangguan karena keadaan kahar (force majeure), seperti bencana alam, gangguan listrik atau jaringan pihak ketiga, dan kebijakan pemerintah.',
    ],
  },
  {
    h: 'Perubahan syarat',
    p: ['Kami dapat mengubah syarat ini. Perubahan penting akan diberitahukan lewat email atau panel. Terus memakai Layanan berarti Anda menyetujui perubahan.'],
  },
  {
    h: 'Perselisihan dan hukum yang berlaku',
    p: ['Syarat ini tunduk pada hukum Republik Indonesia. Perselisihan diselesaikan secara musyawarah terlebih dahulu, dan jika dalam 30 hari tidak tercapai kesepakatan, melalui pengadilan negeri di wilayah domisili kami.'],
  },
];

const PRIVACY: Section[] = [
  {
    h: 'Data yang kami kumpulkan',
    p: [
      'Data akun: nama, email, password (disimpan dalam bentuk hash), dan data dari Google jika Anda masuk dengan Google (nama dan email).',
      'Data layanan: kode aplikasi, variabel lingkungan, database, domain, log, nomor WhatsApp yang terhubung beserta pesan yang lewat gateway, serta isi email yang dipantau Email Watcher sesuai aturan yang Anda buat.',
      'Data teknis: alamat IP, jenis browser, dan catatan aktivitas untuk keamanan dan penagihan.',
      'Data pembayaran: riwayat top-up dan tagihan. Data kartu atau rekening diproses oleh penyedia pembayaran, tidak disimpan oleh kami.',
    ],
  },
  {
    h: 'Untuk apa data dipakai',
    p: [
      'Menjalankan dan memelihara Layanan, menghitung pemakaian dan tagihan, mengirim email penting (undangan, reset password, tagihan), mencegah penyalahgunaan, dan memenuhi kewajiban hukum. Kami tidak menjual data Anda.',
    ],
  },
  {
    h: 'Pihak ketiga',
    p: [
      'Kami berbagi data seperlunya dengan penyedia yang membantu menjalankan Layanan: penyedia server dan jaringan (termasuk Cloudflare), registrar domain, penyedia pembayaran dan penagihan, penyedia email, Google (untuk masuk dengan Google), dan penyedia model AI (untuk permintaan lewat AI gateway). Sebagian penyedia dapat memproses data di luar Indonesia.',
      'Kami dapat membuka data jika diwajibkan oleh hukum atau perintah aparat yang berwenang.',
    ],
  },
  {
    h: 'Data pelanggan Anda',
    p: [
      'Untuk data orang lain yang Anda proses lewat Layanan (misalnya pelanggan Anda di aplikasi atau WhatsApp), Anda adalah pengendali data dan kami adalah pemroses data. Anda bertanggung jawab memiliki dasar hukum dan persetujuan yang diperlukan menurut UU No. 27 Tahun 2022 tentang Pelindungan Data Pribadi.',
    ],
  },
  {
    h: 'Penyimpanan dan keamanan',
    p: [
      'Data disimpan selama akun aktif dan selama diperlukan untuk kewajiban hukum dan penagihan. Kami memakai enkripsi koneksi, hash password, dan pembatasan akses, tetapi tidak ada sistem yang aman sepenuhnya.',
      'Jika terjadi kegagalan pelindungan data yang berdampak pada Anda, kami akan memberi tahu sesuai ketentuan hukum.',
    ],
  },
  {
    h: 'Hak Anda',
    p: [
      'Anda berhak meminta akses, perbaikan, salinan, atau penghapusan data pribadi Anda, serta menarik persetujuan, sesuai UU Pelindungan Data Pribadi. Hubungi kami lewat kontak di bawah.',
    ],
  },
  {
    h: 'Cookie dan penyimpanan browser',
    p: ['Panel memakai penyimpanan browser (localStorage) untuk sesi login dan preferensi seperti bahasa. Kami tidak memakai cookie iklan.'],
  },
];

/** Public /terms and /privacy: one plain reading page, linked from sign-up. */
export default function Legal({ doc }: { doc: 'terms' | 'privacy' }) {
  const terms = doc === 'terms';
  const sections = terms ? TERMS : PRIVACY;

  return (
    <div className="min-h-screen bg-muted/40 px-4 py-10">
      <Card className="mx-auto w-full max-w-3xl">
        <CardHeader className="space-y-1">
          <Link to="/login">
            <img src="/favicon.svg" alt={APP_NAME} className="mb-2 h-10 w-10" />
          </Link>
          <CardTitle className="text-2xl font-bold">{terms ? 'Syarat dan Ketentuan' : 'Kebijakan Privasi'}</CardTitle>
          <CardDescription>
            {APP_NAME} · Berlaku sejak {UPDATED}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-sm leading-relaxed">
          {sections.map((s, i) => (
            <section key={s.h} className="space-y-2">
              <h2 className="text-base font-semibold">
                {i + 1}. {s.h}
              </h2>
              {s.p.map((p) => (
                <p key={p} className="text-muted-foreground">
                  {p}
                </p>
              ))}
            </section>
          ))}
          <section className="space-y-2 border-t pt-6">
            <h2 className="text-base font-semibold">Kontak</h2>
            <p className="text-muted-foreground">
              {OPERATOR} ·{' '}
              <a href={SUPPORT_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                Hubungi kami
              </a>
            </p>
          </section>
          <p className="text-muted-foreground">
            <Link to={terms ? '/privacy' : '/terms'} className="text-primary hover:underline">
              {terms ? 'Kebijakan Privasi' : 'Syarat dan Ketentuan'}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
