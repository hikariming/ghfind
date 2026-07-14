---
title: "Bagaimana Kami Menilai Akun GitHub, dalam Bahasa yang Sederhana"
description: "Penjelasan tanpa jargon tentang mesin open-source di balik ghfind: enam hal yang diukurnya, mengapa PR yang di-merge jauh lebih berharga daripada star, pola bot yang dikenai penalti, dan cara menjalankan seluruh penilai ini sendiri."
date: "2026-07-13"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Dalam satu kalimat:** skor ini menjawab satu pertanyaan praktis — *apakah akun GitHub ini developer sungguhan yang bernilai, atau sesuatu yang digelembungkan agar terlihat seperti itu?* — dan menjawabnya dengan cara yang sama setiap saat, hanya menggunakan data publik, dengan semua aturannya dipublikasikan secara terbuka. Tulisan ini menjelaskan, tanpa jargon, persis bagaimana angka itu dibangun.

## Mengapa perlu skor sama sekali

Semakin banyak keputusan yang bergantung pada sekilas pandang ke GitHub seseorang. Rekruter membaca cepat sebuah profil sebelum panggilan telepon. Maintainer memutuskan apakah pull request dari orang asing layak di-review. Sebuah direktori memeringkat akun berdasarkan seberapa mengesankan tampilannya. Setiap penggunaan itu menciptakan alasan untuk *memalsukan* sinyalnya — dan memalsukan itu mudah untuk sinyal yang murah. Star bisa dibeli. Follower bisa dipertukarkan. Anda bisa membuka seratus pull request satu-baris dalam satu sore dan menyebut diri Anda "kontributor open-source".

Jadi skor yang berguna tidak bisa sekadar menjumlahkan angka-angka besar yang berkilau. Ia harus bersandar pada hal-hal yang benar-benar sulit dipalsukan, dan mengabaikan hal-hal yang tidak. Satu gagasan itulah yang mendorong setiap pilihan desain di bawah ini.

## Satu prinsip utama: beri bobot pada yang sulit dipalsukan

Bagi setiap sinyal GitHub ke dalam dua kelompok.

- **Murah untuk dipalsukan:** star, follower. Beberapa dolar atau lingkaran follow-balas-follow sudah cukup untuk menghasilkannya.
- **Mahal untuk dipalsukan:** pull request yang di-merge ke proyek nyata yang dikelola *orang lain*, aktivitas stabil selama bertahun-tahun, kode yang benar-benar diterima oleh maintainer yang sibuk.

Mesin ini memberi bobot besar pada kelompok kedua dan bobot ringan pada kelompok pertama. Star dan follower tetap dihitung — proyek yang benar-benar populer *memang seharusnya* membantu Anda — tetapi dibatasi cukup rendah sehingga membelinya nyaris tidak menggerakkan jarum. Sementara itu, berhasil me-merge kode nyata ke repo terkenal, yang mengharuskan Anda meyakinkan seorang manusia yang tidak punya alasan untuk membantu Anda, bernilai poin paling besar di papan.

Itulah keseluruhan filosofinya. Sisanya hanyalah cara filosofi itu disebar ke enam kategori.

## Enam hal yang diukur

Skor berjalan dari 0 sampai 100, terbagi ke enam dimensi. Berikut masing-masing dalam bahasa sederhana, beserta poin maksimumnya.

| Dimensi | Maks | Apa yang sebenarnya ditanyakan |
|---|---|---|
| **Kualitas kontribusi** | 27 | Apakah pull request Anda yang nyata di-merge ke proyek nyata, dan apakah maintainer menerimanya? |
| **Dampak ekosistem** | 20 | Apakah kode Anda pernah mendarat di repositori yang benar-benar populer — yang bukan milik Anda? |
| **Kualitas proyek orisinal** | 18 | Apakah Anda pernah membangun sesuatu yang benar-benar dipakai orang (diukur dengan star, tapi dibatasi)? |
| **Keaslian aktivitas** | 17 | Apakah Anda aktif secara stabil dari waktu ke waktu, dengan cara yang beragam — atau hanya satu ledakan lalu sunyi? |
| **Kematangan akun** | 10 | Sudah berapa lama akun ini ada dan tetap aktif? |
| **Pengaruh komunitas** | 8 | Apakah Anda punya pengikut yang nyata, dengan rasio yang sehat? |

![Ke mana 100 poin itu pergi, per dimensi](/blog/how-we-score-github-accounts/weight-breakdown.svg "Enam dimensi dan poin maksimumnya. Oranye = sinyal yang sulit dipalsukan; abu-abu = yang bisa dibeli.")

Perhatikan bahwa dua irisan terbesar — kualitas kontribusi (27) dan dampak ekosistem (20) — persis merupakan sinyal yang sulit dipalsukan. Star (18) dan follower (8), yang bisa dibeli, jika digabungkan pun nilainya masih kurang dari pull request yang di-merge saja. Urutan itulah intinya.

### Sinyal yang paling penting: kode siapa, di repo siapa

Angka tunggal yang paling penting adalah **dampak ekosistem** (20 poin), dan layak dijelaskan alasannya, karena inilah bagian paling cerdiknya.

Ia menghitung pull request yang substansial — lebih dari lima baris, bukan perbaikan typo — yang berhasil di-merge ke **repositori populer yang bukan milik Anda**. Bayangkan seorang developer yang karya nyatanya hidup di dalam codebase proyek terkenal, bukan di repo ber-star miliknya sendiri. Ini tidak bisa dipalsukan. Me-merge perubahan nyata ke proyek dengan 50.000 star berarti seorang maintainer yang tidak punya insentif untuk membantu Anda telah melihat kode Anda dan berkata ya. Itulah hal terdekat dengan kredensial peer-review yang dimiliki GitHub.

Ada satu pengecualian yang disengaja. Jika repo populer itu milik Anda *sendiri* — tetapi benar-benar populer, dengan 1.000 star atau lebih — itu tetap dihitung, karena menangkap sosok kreator yang menghabiskan waktunya membangun proyek terkenalnya sendiri alih-alih berkontribusi ke proyek orang lain. Yang **tidak** dihitung adalah pull request ke repo kecil milik Anda sendiri. Membuka PR ke proyek yang Anda buat kemarin dan tidak di-star siapa pun adalah cara klasik untuk menggelembungkan jumlah kontribusi, jadi itu dikecualikan di sini (dan dikenai penalti di tempat lain).

## Mengapa angka besar tidak bisa lari sendirian

Skor yang naif akan membiarkan satu repo viral, atau satu akun dengan 100.000 follower, mendominasi segalanya. Skor ini tidak, dan alasannya adalah satu pilihan desain: setiap angka "berapa banyak" dilewatkan melalui **kurva hasil yang semakin menurun** (diminishing returns) sebelum menjadi poin.

![Kurva diminishing returns: poin yang diperoleh vs. star](/blog/how-we-score-github-accounts/diminishing-returns.svg "Poin naik cepat sampai beberapa ribu star, lalu mendatar — sehingga mega-repo atau star yang dibeli tidak bisa mendominasi.")

Dalam bahasa sederhana: naik dari 0 ke 1.000 star memberi Anda banyak poin. Naik dari 50.000 ke 51.000 hampir tidak memberi apa-apa — Anda sudah berada dekat puncak. Kurva ini menghargai pencapaian ambang yang bermakna tanpa membiarkan segelintir mega-angka menenggelamkan yang lain. Developer solid dengan beberapa ribu star dan riwayat yang stabil tidak terkubur di bawah satu repositori viral milik satu orang. Ini juga berarti membeli star punya nilai yang menurun tajam: star pertama yang dibeli tidak berbuah banyak, dan membeli jalan Anda menaiki kurva menjadi mahal dengan cepat untuk imbal hasil yang nyaris nol.

## Bendera merah: menangkap yang palsu

Di atas enam dimensi positif itu, mesin ini mengurangi poin untuk pola-pola kecurangan dan usaha-rendah yang spesifik dan sudah dikenal luas. Ini adalah tanda tangan bot, spam, dan akun ternak (farmed). Beberapa yang utama, dalam bahasa sederhana:

- **Banjir PR bertemplat** — puluhan pull request hasil generate otomatis yang nyaris identik, biasanya diarahkan ke repo yang sama. Ini pertanda terkuat dari riwayat kontribusi yang diternakkan.
- **Ternak PR trivial** — setumpuk pull request satu-baris "fix typo" yang menggemukkan jumlah kontribusi tanpa pekerjaan nyata.
- **Ternak PR ke diri sendiri** — membuka dan me-merge pull request Anda sendiri ke repo tanpa-star milik sendiri demi menggelembungkan angka. Me-merge kode sendiri tidak membuktikan apa-apa.
- **Ternak follow** — mem-follow ribuan akun untuk memancing follow-balik, meninggalkan rasio follower/following yang timpang.
- **Repo massal di akun yang baru lahir** — akun yang dibuat bulan lalu dengan lima puluh repositori hampir tidak pernah merupakan developer sungguhan.
- **Profil hantu** — tanpa bio, nyaris tanpa follower, tanpa star, hampir tanpa hasil kerja yang di-merge. Bukan jahat, hanya kosong.
- **Kemungkinan inflasi star** — repo dengan banyak star tetapi hampir tanpa fork atau issue, yang persis seperti penampilan star yang dibeli.

Penalti-penalti ini menumpuk, sampai batas tertentu, sehingga akun yang tersandung beberapa di antaranya akan mendarat di dekat dasar tak peduli sebagus apa angka mentahnya. Yang krusial, pola-pola ini hidup di tingkat *riwayat* sebuah akun, bukan pada satu aksi tunggal — satu PR satu-baris itu sepenuhnya normal; seratus PR seperti itu yang diarahkan ke satu repo tidak.

## Apa arti angka akhirnya

Jumlahkan enam dimensi, kurangi bendera merah, dan Anda mendarat di salah satu dari empat tingkatan:

| Skor | Tingkatan | Arti |
|---|---|---|
| 90–100 | **夯 (Solid)** | Developer kelas atas — nilai tinggi, kepercayaan tinggi. |
| 70–89 | **人上人 (Standout)** | Kontributor berkualitas — layak dipercaya. |
| 40–69 | **NPC** | Akun biasa — sinyalnya biasa-biasa saja atau tidak jelas. |
| 0–39 | **拉完了 (Cooked)** | Nilai rendah — kemungkinan tidak aktif, kosong, atau hasil ternak. |

Nama tingkatannya sengaja dibuat agak jenaka — semua ini bermula sebagai alat roast — tetapi rentang di baliknya adalah matematika deterministik yang sama untuk semua orang.

## Catatan jujur tentang apa yang *bukan* skor ini

- **Ia hanya melihat aktivitas publik.** Seseorang yang bekerja sangat baik di repo privat perusahaan bisa terlihat tipis di sini. Skor rendah adalah pernyataan tentang jejak *publik*, bukan vonis atas orangnya.
- **Ia titik awal, bukan hakim.** Angka ini dimaksudkan untuk membantu manusia memprioritaskan — PR orang asing mana yang dilihat dulu, profil mana yang layak dibaca lebih dekat — bukan untuk menolak siapa pun secara otomatis. Bukti di balik skor lebih penting daripada skornya.
- **Perilaku terkini dihitung lebih besar daripada sejarah lampau.** Sinyal dampak-ekosistem melihat pull request terkini, sehingga seseorang yang kontribusi besarnya semuanya bertahun-tahun lalu akan mendapat skor lebih rendah daripada yang disiratkan résumé-nya. Itu disengaja: ia mengukur apa yang Anda lakukan *sekarang*.

## Ini open source — jalankan sendiri

Tidak ada satu pun dari ini yang merupakan kotak hitam, dan itulah intinya. Tidak ada model dalam prosesnya, tidak ada pembobotan tersembunyi, tidak ada "percayalah pada kami". Input yang sama selalu menghasilkan skor yang sama, dan setiap aturan yang dijelaskan di atas — setiap bobot, setiap ambang, setiap pemicu bendera merah — dipublikasikan di bawah lisensi AGPL.

- **Baca kodenya:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind)
- **Pasang mesinnya:** `npm install ghfind` atau `pip install ghfind`
- **Jalankan secara lokal** dengan token GitHub Anda sendiri — tidak ada yang keluar dari mesin Anda — atau panggil API publiknya ([spesifikasi OpenAPI](https://ghfind.com/openapi.json)).
- **Nilai satu akun** di browser Anda di [ghfind.com](https://ghfind.com).

Jika Anda tidak setuju dengan sebuah bobot atau ambang, Anda bisa membaca persis apa nilainya, mengubahnya, dan melihat efeknya. Skor kepercayaan yang tidak bisa diperiksa orang tidak banyak nilainya — maka kami membuat yang satu ini bisa Anda periksa.
