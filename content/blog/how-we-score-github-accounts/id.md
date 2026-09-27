---
title: "Bagaimana Kami Menilai Akun GitHub, dalam Bahasa yang Sederhana"
description: "Penjelasan tanpa jargon tentang devscore, mesin open-source di balik ghfind: mengapa ia menimbang kerja nyata alih-alih star dan follower, bagaimana ia menentukan nilai sebuah proyek dan seberapa besar bagian Anda di dalamnya, pola ternak yang dibatasinya, dan arti enam dimensi di sebuah profil."
date: "2026-07-13"
updated: "2026-09-28"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Dalam satu kalimat:** skor ini menjawab satu pertanyaan praktis — *seberapa banyak kerja nyata dan bernilai yang telah dilakukan developer ini secara publik?* — dan menjawabnya dengan cara yang sama setiap saat, hanya menggunakan data publik, dengan semua aturannya dipublikasikan secara terbuka. Tulisan ini menjelaskan, tanpa jargon, bagaimana angka itu dibangun.

## Mengapa perlu skor sama sekali

Semakin banyak keputusan yang bergantung pada sekilas pandang ke GitHub seseorang. Rekruter membaca cepat sebuah profil sebelum panggilan telepon. Maintainer memutuskan apakah pull request dari orang asing layak di-review. Sebuah direktori memeringkat akun berdasarkan seberapa mengesankan tampilannya. Setiap penggunaan itu menciptakan alasan untuk *memalsukan* sinyalnya — dan sinyal yang populer justru paling mudah dipalsukan. Star bisa dibeli. Follower bisa dipertukarkan. Anda bisa membuka seratus pull request satu-baris dalam satu sore dan menyebut diri Anda "kontributor open-source".

Jadi skor yang berguna tidak bisa sekadar menjumlahkan angka-angka besar yang berkilau. Ia harus mengukur kerja itu sendiri, dan mengabaikan angka-angka yang bisa dibeli. Satu gagasan itulah yang mendorong setiap pilihan desain di bawah ini.

## Satu prinsip utama: timbang kerjanya, bukan tepuk tangannya

Mesin di balik skor ini bernama **devscore**. Aturannya singkat: *nilai apa yang benar-benar dibangun seorang developer, dibobot menurut seberapa penting hal itu dan seberapa besar bagiannya yang merupakan karyanya.*

- **Star dan follower tidak pernah dihitung.** Bukan sedikit, bukan dibatasi — nol. Keduanya mengukur perhatian, dan perhatian murah untuk dibeli.
- **Jumlah pull request juga tidak dihitung.** Mesin mengukur commit yang Anda tulis dan apa yang diubahnya, sehingga seratus PR satu-baris tetaplah seratus perubahan satu-baris.
- **Yang dihitung adalah kode yang mendarat di proyek yang dipakai orang.** Proyek milik Anda dihitung ketika orang lain memakainya; kerja Anda di proyek orang lain dihitung ketika maintainer independen menerimanya.

## Berapa nilai sebuah proyek

Untuk setiap repositori, devscore pertama-tama bertanya seberapa penting proyek itu. Ia tidak pernah melihat star. Ia melihat sinyal yang sulit dipalsukan karena mengharuskan orang lain *melakukan* sesuatu:

- **kontributor lain** yang menulis kode di dalamnya,
- **dependen hilir** — paket yang bergantung padanya,
- **penulis issue dari luar** — orang yang cukup sering memakainya sampai melaporkan masalah,
- **fork**, yang didiskon karena paling murah untuk diternak di antara semuanya.

Setiap kenaikan adopsi sepuluh kali lipat menambahkan jumlah yang sama, sehingga sebuah kernel dengan ribuan kontributor berdiri jauh di atas library dengan dua puluh kontributor, sementara proyek yang hanya dipakai penulisnya dan beberapa teman tetap berada di dekat dasar. Proyek yang tidak dipakai orang lain hanya mempertahankan sebagian kecil kerja yang dilakukan di dalamnya — membangun sesuatu untuk diri sendiri itu wajar, tetapi itu belum menjadi sesuatu yang diandalkan orang lain.

Proyek yang isinya hanya star tanpa pengguna mendapat perlakuan khusus. Sebuah **proyek hype** — banyak star, tetapi hampir tanpa kontributor, penulis issue, atau dependen, atau lonjakan promosi mendadak yang diikuti kesunyian — tidak mendapat kredit proyek sama sekali.

## Seberapa besar bagian Anda

Selanjutnya, devscore bertanya seberapa besar kerja di proyek itu yang merupakan milik Anda. Ia menggabungkan porsi commit Anda dengan kedudukan Anda dibandingkan penulis utama, sehingga co-lead sebuah proyek besar tetap dihitung sebagai penulis meski porsinya sedang, sementara kontributor yang jauh tertinggal di belakang penulis utama yang dominan tidak. Ribuan commit milik Anda sendiri dihitung sebagai kepengarangan berapa pun ukuran proyeknya.

Lalu ia mengukur kerja itu sendiri: berapa banyak commit yang Anda daratkan, apa yang diubahnya (kode inti dihitung lebih besar daripada dokumentasi atau pekerjaan rutin; perubahan besar yang diterima maintainer dihitung lebih besar daripada yang kecil), dan berapa bulan kerja itu berlangsung. Riwayat commit yang terlihat dihasilkan mesin — setiap commit di jam yang sama, setiap perubahan berbentuk sama — didiskon.

## Proyek orang lain: hanya kerja yang diterima yang dihitung

Kerja di repositori orang lain adalah hal terdekat dengan peer review yang dimiliki GitHub — tetapi hanya jika seseorang yang independen benar-benar me-review-nya. Karena itu devscore menghitung kerja eksternal **hanya sejauh diterima oleh maintainer independen**:

- PR yang di-merge oleh penulis utama proyek dihitung penuh;
- PR yang diloloskan oleh seseorang yang tidak menulis kode apa pun di proyek itu dihitung setengah;
- PR yang Anda merge sendiri, atau yang di-merge oleh rekan barter yang PR-nya Anda merge sebagai balasan, tidak dihitung sama sekali;
- puluhan PR besar yang berdiri sendiri dan di-merge sekaligus selama kampanye berhadiah didiskon.

Me-review dan me-merge kode orang lain juga merupakan kerja nyata. Seorang **maintainer** — diverifikasi lewat catatan GitHub sendiri tentang peran Anda di repositori itu, bukan klaim sendiri — mendapat kredit atas kerja itu, dan code review yang Anda berikan di proyek orang lain juga dihitung.

## Waktu: tahun-tahun yang berkelanjutan, bukan ledakan sesaat

Terakhir, devscore menghargai melakukan semua ini selama bertahun-tahun. Ia menghitung **tahun coding yang berkelanjutan**: setiap tahun kalender dihitung sekali, dibatasi dua belas bulan coding, sehingga menyebar satu tahun ke enam puluh repositori kecil tetaplah satu tahun. Kerja lama memudar dengan waktu paruh tiga tahun (sampai batas bawah tertentu, sehingga karier panjang tidak pernah terhapus).

Semua ini digabungkan menjadi satu kurva mulus dari 0 sampai 100, dengan ruang di puncak agar yang terbaik tetap terpisah alih-alih sama-sama di angka 100. Peran terkuat yang menang: seseorang dinilai sebagai developer sekaligus sebagai maintainer, dan yang lebih baik dari keduanya yang dihitung.

## Menangkap yang palsu

Sebagian besar ternak tidak pernah memerlukan penalti, karena sinyal yang dihasilkannya — star, follower, jumlah PR, merge sendiri — memang sudah bernilai nol. Dua pola mendapat **batas** eksplisit, yang diterapkan paling akhir:

- **PR berkualitas rendah secara massal.** Dalam dua belas bulan terburuk, banyak PR ke proyek orang lain ditolak atau ditarik — setidaknya sebanyak yang di-merge secara independen — disertai setidaknya dua dari: judul bertemplat, pengiriman duplikat, ledakan seminggu di banyak repositori, atau PR raksasa berisi ribuan baris.
- **Pola influencer.** Ratusan follower, jauh tidak sebanding dengan kerja engineering yang diterima orang lain, tanpa proyek yang dipelihara dan tanpa proyek substansial milik sendiri.

Skor yang dibatasi ditekan ke rentang 20–35, tetap diurutkan menurut kerja yang mendasarinya. Yang krusial, kedua batas ini terpicu oleh *pola* di sepanjang riwayat — satu PR yang ditolak, atau akun populer yang juga merilis kode nyata, sepenuhnya normal.

## Enam angka di sebuah profil

Totalnya adalah skor devscore. Agar mudah dibaca, setiap profil juga menampilkan enam **dimensi tampilan** yang diturunkan dari faktor-faktor devscore. Dimensi-dimensi ini menjelaskan skor; mereka tidak dijumlahkan untuk membentuknya.

| Dimensi | Maks | Apa yang ditunjukkan |
|---|---|---|
| **Kualitas kontribusi** | 27 | Kerja yang diterima secara independen di proyek orang lain, ditambah code review yang Anda berikan di sana |
| **Dampak ekosistem** | 20 | Bobot kerja Anda di seluruh repositori, atau peran maintainer yang terverifikasi — mana pun yang lebih tinggi |
| **Kualitas proyek orisinal** | 18 | Proyek andalan Anda: proyek engineering terkuat yang Anda miliki atau pimpin |
| **Keaslian aktivitas** | 17 | Seberapa banyak kerja Anda yang baru; dipangkas tajam saat batas ternak diterapkan |
| **Kematangan akun** | 10 | Tahun-tahun coding yang berkelanjutan |
| **Pengaruh komunitas** | 8 | Seberapa sering maintainer me-merge alih-alih menolak PR Anda, ditambah review yang diberikan — tidak pernah follower |

## Apa arti angka akhirnya

| Skor | Tingkatan | Arti |
|---|---|---|
| 90–100 | **夯 (God)** | Legendaris — karya kelas hall of fame. |
| 80–89 | **顶级 (Elite)** | Developer kelas atas. |
| 70–79 | **人上人 (Solid)** | Kontributor berkualitas — layak dipercaya. |
| 40–69 | **NPC** | Akun biasa — sinyalnya biasa-biasa saja atau tidak jelas. |
| 0–39 | **拉完了 (Trash)** | Sedikit kerja publik — atau pola ternak yang dibatasi. |

Nama tingkatannya sengaja dibuat agak jenaka — semua ini bermula sebagai alat roast — tetapi matematika di baliknya sama untuk semua orang.

## Catatan jujur tentang apa yang *bukan* skor ini

- **Ia hanya melihat aktivitas publik.** Seseorang yang bekerja sangat baik di repo privat perusahaan bisa terlihat tipis di sini. Skor rendah adalah pernyataan tentang jejak *publik*, bukan vonis atas orangnya. Setiap skor membawa tingkat keyakinan yang menyatakan seberapa banyak bukti publik yang menjadi dasarnya.
- **Ia titik awal, bukan hakim.** Angka ini dimaksudkan untuk membantu manusia memprioritaskan — PR orang asing mana yang dilihat dulu, profil mana yang layak dibaca lebih dekat — bukan untuk menolak siapa pun secara otomatis. Bukti di balik skor lebih penting daripada skornya.
- **Kerja lama memudar, perlahan.** Tahun-tahun terakhir dihitung lebih besar daripada sejarah lampau, tetapi rekam jejak yang panjang tidak pernah terhapus.

## Ini open source — jalankan sendiri

Tidak ada satu pun dari ini yang merupakan kotak hitam. Tidak ada model dalam prosesnya dan tidak ada pembobotan tersembunyi: data publik yang sama selalu menghasilkan skor yang sama, dan setiap aturan yang dijelaskan di atas — setiap bobot, setiap ambang, setiap batas — dipublikasikan di bawah lisensi AGPL.

- **Baca kodenya:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind) (mesinnya ada di `src/lib/devscore`)
- **Jalankan secara lokal** dengan `npx @hikariming/ghfind score <user> --local` dan token GitHub Anda sendiri — tidak ada yang keluar dari mesin Anda — atau panggil API publiknya ([spesifikasi OpenAPI](https://ghfind.com/openapi.json)).
- **Nilai satu akun** di browser Anda di [ghfind.com](https://ghfind.com).

Jika Anda tidak setuju dengan sebuah bobot atau ambang, Anda bisa membaca persis apa nilainya, mengubahnya, dan melihat efeknya. Skor kepercayaan yang tidak bisa diperiksa orang tidak banyak nilainya — maka kami membuat yang satu ini bisa Anda periksa.
