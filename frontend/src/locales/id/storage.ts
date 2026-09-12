// App and node storage: disk use of releases, build cache and logs, and cleanup.
// Keys are the English source text — see src/lib/i18n.ts.
export default {
  Storage: "Penyimpanan",
  "For rollback": "Cadangan rollback",
  "Not used": "Tidak dipakai",
  "Clean up": "Bersihkan",
  "Clean up all": "Bersihkan semua",
  "Cleaned up": "Sudah dibersihkan",
  "{size} freed.": "{size} dibebaskan.",
  "Could not clean up": "Gagal membersihkan",
  "Could not read the disk usage": "Pemakaian disk tidak bisa dibaca",
  "A deployment is running — clean up once it has finished": "Deployment sedang berjalan — bersihkan setelah selesai",
  "Measuring…": "Mengukur…",
  "No releases on the server.": "Tidak ada release di server.",
  "Build cache (Next.js)": "Cache build (Next.js)",
  "Source checkout": "Salinan source",
  "Files shared between releases (node_modules while the lockfile is unchanged) are counted once, on the live release.":
    "File yang dipakai bersama antar-release (node_modules selama lockfile tidak berubah) dihitung sekali, di release yang aktif.",
  "{size} can be freed now.": "{size} bisa dibebaskan sekarang.",
  "Nothing unused right now.": "Tidak ada yang bisa dibersihkan saat ini.",
  "Clean up this app's storage?": "Bersihkan penyimpanan aplikasi ini?",
  "Releases marked Not used are deleted. The live release and the ones kept for rollback stay.":
    "Release bertanda Tidak dipakai dihapus. Release aktif dan cadangan rollback tetap disimpan.",
  "Also delete the build cache": "Hapus juga cache build",
  "{size} more — the next build is slower while it rebuilds the cache.":
    "{size} lagi — build berikutnya lebih lambat karena cache dibangun ulang.",
  "About {size} will be freed.": "Sekitar {size} akan dibebaskan.",
  "Skipped while deploying: {apps}": "Dilewati karena sedang deploy: {apps}",
  "{used} of {size} used": "{used} dari {size} terpakai",
  "{free} free": "{free} tersisa",
  "The node did not report its disk.": "Node tidak melaporkan disknya.",
  "No panel apps keep files on this node.": "Tidak ada aplikasi panel yang menyimpan file di node ini.",
  "{size} unused": "{size} tidak dipakai",
  "cache {size}": "cache {size}",
  "Clean up every app on this node?": "Bersihkan semua aplikasi di node ini?",
  "Unused releases are deleted on each app. Live releases and the ones kept for rollback stay; apps that are deploying are skipped.":
    "Release yang tidak dipakai dihapus di setiap aplikasi. Release aktif dan cadangan rollback tetap disimpan; aplikasi yang sedang deploy dilewati.",
  "Also delete the build caches": "Hapus juga cache build",
  "Each app's next build is slower while it rebuilds its cache.": "Build berikutnya tiap aplikasi lebih lambat karena cache dibangun ulang.",
} satisfies Record<string, string>;
