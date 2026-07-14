---
title: "Mengukur Aktivitas Kontribusi Palsu di GitHub: Bukti dari 19.000 Akun yang Dinilai Secara Deterministik"
description: "Studi empiris tentang keaslian kontribusi di GitHub. Kami menilai 18.947 akun publik dengan mesin deterministik open-source dan menganalisis distribusi skor, prevalensi dan struktur pull-request farming, komposisi bendera merah, serta hubungan antara umur akun dan skor."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

**Abstrak.** Kekhawatiran tentang aktivitas palsu di GitHub — pull request bertemplat, star yang dibeli, jaringan follow timbal-balik — tersebar luas, tetapi bukti kuantitatif tentang prevalensi dan strukturnya langka. Kami menilai 18.947 akun GitHub publik dengan rubrik deterministik open-source (tanpa panggilan model; input yang identik menghasilkan skor yang identik) dan menyimpan snapshot metrik-mentah lengkap untuk sampel dalam sebanyak 3.444 akun. Kami menemukan bahwa (i) pemalsuan jarang terjadi dalam sampel kami: hanya 0,58% akun yang melampaui ambang farming konservatif kami; (ii) ketika terjadi, ia bersifat ekstrem dan terpisah secara bimodal dari perilaku biasa — akun yang ditandai memiliki rasio judul-PR-bertemplat di atas 50% (hingga 97%), berbanding median populasi sebesar 7%; (iii) kontribusi berusaha-rendah itu normal, bukan mencurigakan: 58% developer dengan sampel merged-PR terkini memiliki setidaknya satu PR eksternal trivial, sedangkan hanya 0,4% yang menunjukkan pola mayoritas-trivial dalam volume besar; dan (iv) profil "tampak mencurigakan" yang dominan adalah kosong, bukan dimanipulasi — bendera merah tipe-ketiadaan melampaui bendera tipe-manipulasi dengan selisih satu orde besaran. Skor median naik secara monoton seiring umur akun, dari 18 poin untuk akun di bawah satu tahun hingga 86 poin untuk akun di atas sepuluh tahun, konsisten dengan konsistensi jangka-panjang sebagai sinyal yang paling sulit dipalsukan. Kami membahas implikasinya bagi desain perkakas deteksi spam, khususnya bahwa farming adalah properti tingkat-pola dari riwayat sebuah akun, bukan properti tingkat-peristiwa dari kontribusi individual.

## 1. Pendahuluan

Penilaian kredibilitas developer semakin bergantung pada aktivitas GitHub publik: pipeline rekrutmen menyaring profil kandidat, maintainer open-source melakukan triase pull request dari kontributor tak dikenal, dan perkakas hilir memeringkat akun berdasarkan dampak yang tampak. Setiap penggunaan itu menciptakan insentif untuk memalsukan sinyal-sinyal yang mendasarinya. Laporan anekdotal tentang pasar star, kampanye pull-request bertemplat, dan skema follow timbal-balik sudah umum; pengukuran sistematis tentang seberapa sering pemalsuan semacam itu terjadi, dan bentuk statistik apa yang diambilnya, belum ada.

Sebuah contoh yang memotivasi dari dataset kami mengilustrasikan fenomena ini. Satu akun menampilkan rekam merged-PR yang biasanya menandakan kontributor kuat: sejumlah besar pull request yang di-merge (bukan sekadar dibuka) dengan tingkat penerimaan nyaris sempurna. Pemeriksaan lebih dekat menunjukkan bahwa 97% judul PR terkininya adalah varian templat yang nyaris identik, dan bahwa mayoritasnya menyasar satu repositori populer yang bukan milik akun tersebut. Tidak ada pull request individual yang anomali; anomalinya hanya ada di tingkat pola agregat. Pengamatan ini — bahwa pemalsuan bisa tak terlihat peristiwa-demi-peristiwa namun mencolok secara agregat — memotivasi studi ini.

Kami mengajukan tiga pertanyaan:

1. **Prevalensi.** Seberapa umum aktivitas kontribusi palsu di antara akun GitHub publik?
2. **Struktur.** Ketika pemalsuan terjadi, bagaimana ia berbeda secara statistik dari perilaku kontribusi biasa?
3. **Komposisi.** Di antara akun yang memicu heuristik integritas, berapa fraksi yang mencerminkan manipulasi aktif versus sekadar ketidakaktifan atau ketiadaan karya orisinal?

Untuk menjawabnya, kami menilai 18.947 akun publik dengan rubrik deterministik ([ghfind](https://ghfind.com)), yang inti penilaiannya bersifat open source di bawah AGPL ([repositori](https://github.com/hikariming/ghfind)), dan menganalisis sampel dalam sebanyak 3.444 akun yang untuknya kami menyimpan snapshot metrik-mentah lengkap, termasuk sampel tingkat-PR, fitur kualitas repositori, dan statistik bentuk-aktivitas. Semua data agregat yang mendasari gambar-gambar dipublikasikan bersama artikel ini ([data.json](/blog/we-scored-19000-github-accounts/data.json)).

Ringkasnya, pemalsuan jauh lebih jarang dalam sampel ini daripada yang disiratkan wacana publik; ketika hadir, ia ekstrem alih-alih halus; dan ia dapat dipisahkan dari aktivitas biasa hanya dengan ambang sederhana di tingkat pola.

## 2. Data dan Metodologi

### 2.1 Rubrik penilaian

Mesin ini mengimplementasikan rubrik deterministik atas enam dimensi yang berjumlah 100 poin, dengan penalti aditif untuk sinyal bendera merah. Ia tidak melakukan panggilan model; skor sepenuhnya dapat direproduksi dari data GitHub publik. Jalur kode yang sama menghasilkan skor yang digunakan situs ghfind, SDK npm/PyPI, dan analisis ini.

| Dimensi | Maks | Sinyal yang dihargai |
|---|---|---|
| Kualitas kontribusi | 27 | merged PR (skala log), tingkat penerimaan, partisipasi issue |
| Dampak ekosistem | 20 | PR substantif ke repositori ber-star tinggi, kedalaman maintainer |
| Kualitas proyek orisinal | 18 | star yang dibobot berdasarkan substansi repositori |
| Keaslian aktivitas | 17 | aktivitas terkini yang berkelanjutan, keragaman jenis aktivitas |
| Kematangan akun | 10 | umur akun, tahun-tahun aktivitas aktual |
| Pengaruh komunitas | 8 | follower (skala log), kewajaran rasio follower/following |

Dua belas aturan bendera merah deterministik mengurangi poin, termasuk `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming`, dan `possible_star_inflation`. Ambang persisnya tersedia di repositori. Selain skor publik, mesin ini menghitung skor internal kemiripan-spam/bot pada skala 0–10, yang digunakan untuk melindungi integritas leaderboard; Bagian 3.2 melaporkan distribusinya untuk pertama kalinya. Tidak ada data non-publik lain yang masuk ke analisis ini.

**Definisi.** Kami menyebut sebuah pull request *trivial* jika ia mengubah paling banyak lima baris dan di-merge ke repositori dengan setidaknya 200 star yang bukan milik penulisnya. *Rasio judul-bertemplat* sebuah akun adalah fraksi judul PR terkininya yang merupakan varian templat yang nyaris identik satu sama lain.

### 2.2 Konstruksi sampel dan bias yang diketahui

Sampel terdiri atas (a) pengguna yang secara sukarela menilai akunnya sendiri melalui situs ghfind dan (b) developer yang diambil dari organisasi open-source yang aktif. Dua sifat desain ini membatasi interpretasi. Pertama, sampelnya self-selected dan condong ke arah developer asli yang aktif; setiap angka pemalsuan yang dilaporkan di bawah karenanya harus dibaca sebagai **batas bawah dalam populasi yang sudah tersaring**, bukan sebagai estimasi seluruh GitHub. Kedua, dengan 18.947 akun yang dinilai (3.444 dengan metrik dalam), sampel ini cukup besar untuk mengkarakterisasi bentuk distribusi tetapi merupakan fraksi yang dapat diabaikan dari GitHub; kami melaporkan bentuk, bukan sensus.

## 3. Hasil

### 3.1 Distribusi skor

![Distribusi skor akhir pada 19k akun](/blog/we-scored-19000-github-accounts/score-distribution.svg "Gambar 1: Distribusi skor akhir dalam bucket 5-poin (n = 18.947). Pita oranye menandai tingkatan 70+.")

*Gambar 1* menunjukkan distribusi skor akhir. Mediannya berada sedikit di atas 40 poin; **48,6%** akun mendapat skor di bawah 40 (tingkatan yang oleh rubrik dilabeli bernilai-rendah atau diduga digelembungkan), sementara hanya **3,7%** yang melampaui 90. Bucket dengan populasi terbanyak adalah 0–5, terdiri dari akun tanpa karya orisinal, tanpa pull request yang di-merge, dan tanpa aktivitas berkelanjutan. Bahkan dalam sampel yang bias ke arah developer aktif, kebanyakan profil publik tipis.

Sebagai kalibrasi, akun median dalam sampel dalam memiliki **27 follower, 34 total star, dan 20 merged PR**, pada umur akun median tujuh tahun. Metrik yang relevan dengan reputasi terkonsentrasi berat di ekor atas: persentil ke-90 adalah 1.275 follower dan sekitar 5.900 star; persentil ke-99 adalah 19.000 follower dan sekitar 100.000 star.

### 3.2 Prevalensi dan struktur farming

![Distribusi skor spam tersembunyi](/blog/we-scored-19000-github-accounts/spam-score.svg "Gambar 2: Distribusi skor internal kemiripan-spam 0–10 (n = 18.934). 77% akun mendapat skor persis 0.")

*Gambar 2* melaporkan distribusi skor internal kemiripan-spam pada 18.934 akun yang untuknya skor itu dihitung:

- **77%** akun mendapat skor persis 0 — tidak ada sinyal farming dalam bentuk apa pun.
- **0,58%** (110 akun) mendapat skor 3 atau lebih, ambang yang kami perlakukan sebagai farming yang jelas.
- **12 akun** mendapat skor 7 atau lebih.

Keterpisahan akun-akun farming berasal bukan dari volumenya melainkan dari *konsentrasinya*. Di antara 2.122 developer dengan setidaknya sepuluh pull request terkini, median rasio judul-bertemplat adalah **7%** — developer biasa mengulang dirinya secukupnya ("fix typo", "bump deps"). Setiap akun yang ditandai karena banjir templat memiliki rasio di atas **50%**, membentang hingga **97%**, sementara persentil ke-99 dari seluruh populasi adalah 72%. Distribusinya secara efektif bimodal: tidak ada kontinum antara pengulangan biasa dan produksi massal. Mendeteksi akun-akun ini tidak memerlukan model yang dilatih — hanya agregasi atas lebih dari satu pull request per akun.

### 3.3 Pull request trivial itu normal; ternak PR trivial tidak

Dari 2.558 developer dengan sampel merged-PR terkini, **58%** memiliki setidaknya satu PR eksternal trivial sebagaimana didefinisikan di Bagian 2.1. Perbaikan kecil dokumentasi dan typo ke repositori terkemuka jelas merupakan bagian rutin dari partisipasi open-source, termasuk bagi kontributor yang sebenarnya kuat.

Sebaliknya, developer yang merged PR terkininya *mayoritas* trivial dengan setidaknya sepuluh PR semacam itu berjumlah **0,4%** dari sampel (11 akun).

Kesenjangan antara kedua angka ini punya konsekuensi desain langsung bagi perkakas anti-abuse. Heuristik apa pun yang menghukum pull request kecil begitu saja akan menghukum yang 58% — pendatang baru, kontributor dokumentasi, dan penolong insidental — demi menangkap sebelas akun yang perilakunya sudah mencolok di tingkat pola. Kami menyimpulkan bahwa farming adalah **properti pola** dari riwayat kontribusi sebuah akun (konsentrasi, templat, pengulangan terhadap satu sasaran) alih-alih **properti peristiwa** dari satu diff individual, dan bahwa detektor yang beroperasi pada peristiwa tunggal mengukur kuantitas yang salah.

Hasil paralel berlaku untuk tingkat penolakan. Di antara 2.003 developer dengan setidaknya sepuluh PR yang telah diputuskan, median tingkat penolakan-maintainer adalah **2%**, dengan persentil ke-90 sebesar 13%. Tingkat penerimaan karenanya membawa sedikit sinyal diskriminatif — dengan syarat sudah punya merged PR sama sekali, hampir semua yang diajukan kontributor semacam itu di-merge — dan hanya tingkat penolakan ekstrem (rubrik menandai di atas 50%) yang informatif.

### 3.4 Komposisi bendera merah: ketiadaan mendominasi manipulasi

Menjalankan ulang mesin terkini atas seluruh 3.444 akun sampel-dalam, **17%** memicu setidaknya satu bendera merah. *Gambar 3* menunjukkan komposisinya.

![Prevalensi bendera merah](/blog/we-scored-19000-github-accounts/red-flags.svg "Gambar 3: Prevalensi bendera merah dalam sampel dalam (n = 3.444). Bendera tipe-ketiadaan melampaui bendera tipe-manipulasi dengan selisih satu orde besaran.")

Tiga bendera paling lazim — `ghost_profile` (10%), `no_original_work` (8,2%), dan `mostly_forks` (7,2%) — menggambarkan ketiadaan substansi alih-alih manipulasi. Bendera penipuan-aktif lebih jarang dengan selisih satu orde besaran: `templated_pr_flooding` di 0,5%, `trivial_pr_farming` di 0,3%, `follow_farming` di 0,1%. Inflasi star — jumlah star tinggi dengan fork dan issue nyaris nol — membulat ke nol dalam sampel ini, meskipun self-selection masuk akal menekannya: akun dengan star yang dibeli kecil kemungkinan mengajukan dirinya untuk dinilai.

Bagi perkakas kepercayaan yang dibangun di atas data GitHub, komposisi ini menyiratkan dua mode kegagalan yang berbeda secara kualitatif dan memerlukan detektor berbeda serta toleransi kesalahan berbeda: kasus yang sering dan murah ("tidak ada apa-apa di sini") dan kasus yang jarang dan mahal ("sesuatu di sini dibuat-buat").

### 3.5 Umur akun sebagai sinyal yang tak dapat dipalsukan

![Skor median berdasarkan umur akun](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Gambar 4: Skor akhir median berdasarkan umur akun. Hubungannya monoton di semua bucket umur.")

Skor median naik secara monoton seiring umur akun, dari **18 poin untuk akun di bawah satu tahun hingga 86 untuk akun yang melewati tahun kesepuluhnya**, tanpa penurunan di tengah (*Gambar 4*). Survivorship berkontribusi pada hubungan ini — akun tua yang muncul dalam sampel adalah akun tua yang masih dipakai — tetapi arah efeknya sendiri informatif. Setiap komponen konsistensi jangka-panjang (tahun-tahun aktivitas, repositori berumur dengan star yang terakumulasi organik, riwayat kontribusi yang membentang banyak rilis) persis merupakan hal yang tak dapat dimampatkan oleh pemalsuan: star dan follower bisa diperoleh dalam hitungan jam, sedangkan akun 2015 dengan sembilan tahun aktivitas tidak bisa dicetak pada 2026. Asimetri ini membenarkan pembobotan rubrik atas kematangan akun dan rentang aktivitas, dan konsisten dengan pengamatan kami bahwa akun banjir-templat yang ditandai mengelompok di antara akun-akun muda.

Sebagai pengamatan sekunder, komposisi bahasa-utama akun berskor tinggi (skor akhir ≥ 60) mengikuti tren ekosistem yang familiar: **TypeScript (520), Python (460), dan JavaScript (395)** memimpin, dengan Rust (225) di depan Go (189), C (184), dan Java (159) (*Gambar 5*).

![Bahasa para pencetak skor tinggi](/blog/we-scored-19000-github-accounts/languages.svg "Gambar 5: Bahasa utama di antara akun berskor 60 atau lebih.")

## 4. Diskusi

Tiga prinsip desain untuk perkakas integritas-kontribusi mengikuti dari hasil-hasil ini.

**Deteksi pola, bukan peristiwa.** Pemisahan bimodal di Bagian 3.2 dan kesenjangan 58%-versus-0,4% di Bagian 3.3 menunjukkan bahwa kontribusi individual hampir tidak membawa sinyal pemalsuan, sementara agregat tingkat-akun terpisah dengan bersih. Heuristik peristiwa-tunggal memaksimalkan positif palsu justru terhadap para kontributor — pendatang baru dan penolong bervolume rendah — yang paling perlu dipertahankan oleh proyek open-source.

**Bedakan ketiadaan dari manipulasi.** Kebanyakan akun yang gagal pemeriksaan integritas itu kosong, bukan adversarial (Bagian 3.4). Mencampuradukkan keduanya menggelembungkan angka penipuan yang tampak dan salah mengalokasikan upaya review.

**Beri bobot pada waktu.** Konsistensi longitudinal adalah satu-satunya sinyal yang diperiksa yang biaya perolehannya tidak dapat diturunkan dengan pengeluaran uang (Bagian 3.5), menjadikannya jangkar alami bagi skor kredibilitas apa pun.

Dipandu prinsip-prinsip ini, kami sedang membangun sebuah GitHub App untuk membantu maintainer melakukan triase pull request spam, menggabungkan fitur tingkat-PR (ukuran diff, kemiripan templat) dengan riwayat tingkat-penulis. Mengingat risiko positif palsu yang didokumentasikan di Bagian 3.3, alat ini tidak akan menutup pull request secara otomatis; ia menyajikan bukti untuk keputusan manusia. Kami mengundang maintainer repositori yang terdampak untuk berbagi contoh spam yang mereka terima.

## 5. Keterbatasan

- **Sampel self-selected.** Pengguna situs plus anggota organisasi open-source yang aktif condong ke arah yang asli dan aktif. Tingkat pemalsuan seluruh GitHub masuk akal lebih tinggi daripada yang dilaporkan di sini; persentase kami adalah batas bawah dalam populasi yang tersaring.
- **Skala.** 18.947 akun dinilai, 3.444 dengan metrik dalam. Bentuk distribusi stabil antar-jalankan ulang, tetapi sampelnya tidak representatif untuk GitHub secara keseluruhan.
- **Hanya pelaporan agregat.** Semua pola dilaporkan secara agregat; tidak ada akun individual yang diidentifikasi. Ambang bendera dipublikasikan agar maintainer bisa menerapkannya dengan konteks.
- **Versi mesin.** Prevalensi bendera merah dihitung ulang dengan penilai terkini atas snapshot mentah terbaru tiap akun; skor spam yang tersimpan mencerminkan versi mesin saat pemindaian. Keduanya disertakan dalam [agregat yang dipublikasikan](/blog/we-scored-19000-github-accounts/data.json).

## 6. Reproduksibilitas

Semua logika penilaian bersifat deterministik dan open source (AGPL) di [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind). Mesin yang identik didistribusikan lewat `npm install ghfind` dan `pip install ghfind`, dan dapat dijalankan baik terhadap API publik ([spesifikasi OpenAPI](https://ghfind.com/openapi.json)) maupun sepenuhnya lokal dengan token GitHub yang disediakan pengguna. Statistik agregat di balik setiap gambar dalam artikel ini tersedia sebagai [data.json](/blog/we-scored-19000-github-accounts/data.json).

*Akun individual dapat dinilai di [ghfind.com](https://ghfind.com).*
