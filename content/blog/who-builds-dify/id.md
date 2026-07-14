---
title: "Siapa yang Membangun Dify? Kami Menilai 100 Kontributor Teratasnya"
description: "Dify punya 148.500 star dan 458 kontributor kode. Kami menjalankan 100 committer teratasnya melalui mesin penilai deterministik: skor median 78 vs. baseline global 42,5, 71% masuk kategori kontributor tepercaya, dan pekerjaannya tersebar ke jauh lebih banyak orang daripada biasanya."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Temuan utama** (data dikumpulkan 2026-07-11, 100 committer teratas [langgenius/dify](https://github.com/langgenius/dify), dinilai dengan [mesin ghfind](/methodology) yang open-source):

- **100 kontributor teratas Dify mencetak skor median 78,2 / 100 — 36 poin di atas median 42,5 dari baseline 18.947 akun kami.** 70,8% melewati ambang "kontributor tepercaya" (skor ≥ 70) yang hanya dicapai 20,1% populasi umum.
- **Mereka terlihat seperti developer biasa sampai Anda melihat output-nya.** Median follower: 31 (baseline: 27). Median pull request yang di-merge: 118 (baseline: 20). Dify dibangun oleh para profesional yang pendiam tapi sangat produktif, bukan oleh siapa pun yang Anda kenali dari media sosial.
- **Tidak ada satu orang pun yang mendominasi codebase — langka untuk proyek seterkenal ini.** Committer paling aktif hanya menulis 8,4% dari seluruh commit, tiga teratas menulis 21%, sepuluh teratas hanya kurang dari setengah. Bandingkan dengan [proyek AI viral yang sebagian besar adalah karya satu orang](/blog/who-builds-openclaw).

## Mengapa Dify

[Dify](https://github.com/langgenius/dify) adalah salah satu platform aplikasi LLM dengan star terbanyak di GitHub — 148.500 star, 458 kontributor kode, dibuat pada April 2023. Jumlah star adalah cara default orang menilai kesehatan sebuah proyek, dan sekaligus angka yang paling mudah digelembungkan. Maka kami mengajukan pertanyaan yang tidak bisa dijawab star: **siapa yang sebenarnya menulis semua ini, dan apakah mereka tahan uji ketika rekam jejaknya diperiksa keasliannya?**

Kami mengambil 100 kontributor teratas berdasarkan jumlah commit, mengecualikan 3 bot (`dependabot`, `github-actions`, dan — tanda zaman — `Copilot`), lalu menilai 97 manusia yang tersisa dengan mesin deterministik kami. 96 berhasil di-resolve; 86 memiliki snapshot metrik-mentah lengkap. Mesinnya sama dengan yang ada di balik setiap skor di situs ini: 100 poin atas enam dimensi, tanpa panggilan model, input identik memberi output identik.

## Kualitas kontributor: jauh di atas baseline

| | Dify top-100 | Baseline 19k |
|---|---|---|
| Skor median | **78,2** | 42,5 |
| Skor ≥ 90 (tingkatan 夯) | **15,6%** | 3,7% |
| Skor ≥ 70 (tepercaya) | **70,8%** | 20,1% |
| Skor < 40 (bernilai rendah) | **5,2%** | 48,6% |

Kedua distribusi nyaris tidak bertumpang tindih. Bahkan kontributor persentil ke-10 milik Dify (56,1) mengungguli median global sebesar 13 poin. Lima belas dari sembilan puluh enam mencetak skor 90 atau lebih — ambang yang hanya dilewati satu dari dua puluh tujuh akun GitHub.

Lima akun di bawah 40 juga layak dicatat: setiap repositori populer memungut ekor berupa orang-orang yang menyumbang satu commit dan hampir tidak punya apa-apa lagi di profilnya. Pada proyek yang sehat, ekor itu sekitar 5% dari daftar kontributor teratas. Dalam populasi baseline, hampir setengah dari semua akun berada di bawah 40.

## Para profesional yang pendiam

Pola paling menarik adalah kesenjangan antara seberapa terlihatnya orang-orang ini dan seberapa banyak yang mereka hasilkan:

| Median, per kontributor | Dify top-100 | Baseline 19k |
|---|---|---|
| Follower | 31 | 27 |
| Pull request yang di-merge | **118** | 20 |
| Umur akun | 9,0 tahun | 7,4 tahun |

Berdasarkan jumlah follower, kontributor inti Dify tak bisa dibedakan dari akun GitHub rata-rata. Berdasarkan pull request yang di-merge, mereka memproduksi **enam kali** baseline. Ini kebalikan persis dari profil aktivitas-palsu yang didokumentasikan [studi 19k akun kami](/blog/we-scored-19000-github-accounts) — akun buatan memoles angka-angka yang terlihat semua orang dan melewatkan pekerjaan sesungguhnya. Kontributor Dify mengerjakan pekerjaannya dan melewatkan promosi dirinya.

Umur akun menceritakan kisah yang sama: hanya 4 dari 86 akun dengan data lengkap yang berumur kurang dari satu tahun. Ini bukan kerumunan akun baru yang mengejar repositori yang sedang tren — kontributor tipikal sudah berada di GitHub sejak 2017.

## Aktivitas palsu tetap muncul bahkan di sini

Dua akun di top 100 (2,1%) melampaui ambang yang mesin kami gunakan untuk farming — praktik memproduksi riwayat kontribusi dari pull request repetitif berusaha-rendah. Dalam populasi baseline angka itu 0,58%. Menjalankan ulang mesin terkini atas snapshot terbaru menandai satu dari keduanya (1,2%). Sinyal peringatan dalam bentuk apa pun muncul pada 13 dari 86 akun (15,1%, baseline 17%), tetapi hampir semuanya berkata "profil ini tipis" (`mostly_forks`: 12) alih-alih "profil ini palsu": tepat satu akun menunjukkan judul PR yang diproduksi massal, dan satu menunjukkan riwayat yang dibangun di atas PR trivial.

Kami melaporkan ini hanya secara agregat, tetapi poin umumnya tetap berlaku: **menjadi proyek terkenal tidak membuat daftar 100 kontributor teratas Anda tetap bersih.** Popularitas menarik perilaku ini, karena PR templat mungil yang di-merge ke repositori terkenal adalah baris résumé termurah di pasaran. Persis itulah masalah yang akan ditangkap oleh alat kami untuk maintainer yang segera hadir.

## Dibangun oleh banyak tangan

Total commit di seluruh sampel top-100: 8.434.

| Porsi commit | |
|---|---|
| Kontributor paling aktif | 8,4% |
| Top 3 | 21,0% |
| Top 5 | 31,3% |
| Top 10 | 49,8% |

Lebih dari setengah seluruh commit datang dari **luar** sepuluh besar. Proyek AI terkenal biasanya bertumpu pada satu atau dua maintainer yang kelelahan, dan berhenti bergerak ketika mereka berhenti; Dify yang menyebar pekerjaannya seluas ini membuatnya luar biasa sulit untuk rusak. Puncak tabelnya mencampur karyawan LangGenius dengan maintainer komunitas independen, dan penurunan dari #1 (708 commit) ke #10 (249) adalah lereng landai, bukan tebing.

## Lima yang paling diremehkan

Para kontributor yang dinilai paling tinggi oleh mesin kami dan hampir tidak di-follow siapa pun:

| Kontributor | Skor | Tingkatan | Follower |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96,4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94,3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93,8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92,3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89,6 | 顶级 | 31 |

Sebutan khusus untuk [bowenliang123](/u/bowenliang123) (94,0, #8 berdasarkan commit) dan [hjlarry](/u/hjlarry) (93,6, #6 berdasarkan commit): committer sepuluh besar di salah satu proyek AI terpopuler di dunia, masing-masing dengan follower kurang dari 170. Jika Anda sedang merekrut, mulailah dari tabel ini — orang-orang ini jauh lebih baik daripada yang disiratkan jumlah follower mereka.

## Metode dan keterbatasan

Skor berasal dari rubrik deterministik ghfind — enam dimensi atas data GitHub publik, tanpa panggilan model, open source di bawah AGPL. Rubrik dan ambang lengkap: [metodologi](/methodology). Agregat di balik setiap tabel: [data.json](/blog/who-builds-dify/data.json).

- **Top-100 berdasarkan commit bukan keseluruhan komunitas.** Dify punya 458 kontributor kode; kami menilai ujung yang paling aktif. Ekor panjang kontributor sesekali kemungkinan mendapat skor lebih rendah.
- **Ini sebuah snapshot.** Data dikumpulkan 2026-07-11. Star dan commit bergerak setiap hari; data kontributor langsung ada di [halaman proyek Dify](/developers/repo/langgenius/dify).
- **Jumlah commit mengukur volume, bukan kepentingan.** Tabel porsi commit menyatakan siapa yang paling banyak commit, bukan siapa yang menulis kode yang menjadi tumpuan segalanya.
- **Temuan aktivitas-palsu hanya dilaporkan secara agregat.** Kami menyebut nama individu hanya ketika kabarnya baik.

---

*Telusuri [papan kontributor langsung Dify](/developers/repo/langgenius/dify), baca [studi pendamping OpenClaw](/blog/who-builds-openclaw), atau [nilai akun GitHub Anda sendiri](/) — mesin yang sama, 20 detik.*
