---
title: "382.000 Star, Sepasang Tangan: Siapa Sebenarnya yang Membangun OpenClaw?"
description: "OpenClaw menjadi repositori dengan pertumbuhan tercepat dalam sejarah GitHub. Kami menilai 100 kontributor teratasnya dengan mesin deterministik: satu orang menulis 57% dari seluruh commit, nol kontributor menunjukkan tanda aktivitas palsu, dan seperlima dari mereka bergabung ke GitHub kurang dari setahun lalu."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Temuan utama** (data dikumpulkan 2026-07-11, 100 committer teratas [openclaw/openclaw](https://github.com/openclaw/openclaw), dinilai dengan [mesin ghfind](/methodology) yang open-source):

- **Repositori dengan pertumbuhan tercepat dalam sejarah GitHub, diukur dari commit, sebagian besar adalah satu orang.** Sang kreator, [steipete](/u/steipete), menulis 33.482 dari 58.487 commit sampel teratas — **57,2%**. Tiga kontributor teratas mencakup 81,5%, sepuluh teratas 90,2%.
- **Nol aktivitas palsu.** Tidak satu pun dari 96 manusia di top-100 kontributor menunjukkan pola kontribusi-buatan yang ditandai mesin kami — pola yang muncul pada 0,58% akun bahkan dalam baseline 18.947 akun kami yang sudah disaring dengan cermat. Hype-nya luar biasa besar; orang-orang di baliknya nyata.
- **Ledakan AI-agent sedang menarik pendatang baru ke open source.** 19,6% kontributor teratas memiliki akun GitHub yang berumur kurang dari satu tahun (di Dify, proyek lebih tua dengan ketenaran sebanding, angkanya 4,7%). Sebagian sudah luar biasa: committer #3 memakai akun berumur 2,3 tahun yang mencetak skor 94,1.

## Mengapa OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) hampir tak perlu perkenalan: dibuat pada 2025-11-24 oleh Peter Steinberger ([steipete](/u/steipete), pendiri PSPDFKit), berganti nama dua kali dalam satu minggu di Januari 2026 (Clawdbot → Moltbot → OpenClaw), dan menjadi proyek tercepat sepanjang masa yang mencapai 100.000 star GitHub. Per 2026-07-11 ia berdiri di **382.580 star, 80.292 fork, dan 368 kontributor kode** — sekitar tujuh setengah bulan setelah commit pertama.

Kurva star seperti itu persis untuk apa mesin kami dibangun: ketika sebuah angka menanjak secepat itu, adakah sesuatu yang nyata di bawahnya? Kami mengambil 100 kontributor teratas berdasarkan jumlah commit, mengecualikan 4 bot (termasuk `clawsweeper` dan `openclaw-clownfish` milik proyek itu sendiri), dan menilai semua 96 manusianya. 92 memiliki snapshot metrik-mentah lengkap.

## Kualitas kontributor: puncak daftarnya luar biasa

| | OpenClaw top-100 | Dify top-100 | Baseline 19k |
|---|---|---|---|
| Skor median | **79,7** | 78,2 | 42,5 |
| Skor ≥ 90 (tingkatan 夯) | **21,9%** | 15,6% | 3,7% |
| Skor ≥ 70 (tepercaya) | **69,8%** | 70,8% | 20,1% |
| Skor < 40 (bernilai rendah) | **9,4%** | 5,2% | 48,6% |

(Kolom Dify berasal dari [studi pendamping kami](/blog/who-builds-dify), yang dinilai pada minggu yang sama dengan mesin yang sama.)

Satu dari lima kontributor teratas OpenClaw mencetak skor 90 atau lebih; di GitHub secara luas, hanya sekitar satu akun dari dua puluh tujuh yang mencapainya. Ketika sebuah proyek mendapat perhatian seluruh industri, developer hebat datang untuk membangunnya. Tapi lihat juga ujung satunya: 9,4% mendapat skor di bawah 40, hampir dua kali lipat angka Dify. Semua perhatian itu juga menarik akun-akun baru lahir yang nyaris tidak punya apa-apa — bagian tentang umur akun di bawah menjelaskan dari mana mereka datang.

## Sepasang tangan

Total commit di seluruh sampel top-100: 58.487 — tujuh kali angka 8.434 milik Dify, diproduksi dalam seperlima waktu kalendernya.

| Porsi commit | OpenClaw | Dify |
|---|---|---|
| Kontributor paling aktif | **57,2%** | 8,4% |
| Top 3 | **81,5%** | 21,0% |
| Top 5 | **86,0%** | 31,3% |
| Top 10 | **90,2%** | 49,8% |

33.482 commit milik [steipete](/u/steipete) selama 229 hari setara dengan **146 commit per hari**. Tidak ada yang mengetik secepat itu — tetapi seseorang yang mengarahkan armada coding agent dan me-review hasilnya bisa me-merge secepat itu, dan persis begitulah OpenClaw terkenal dibangun. Mesin kami memberi akun itu **100/100**: riwayat GitHub 17 tahun, 52.067 follower, 2.772 merged PR — sejauh mungkin dari akun palsu. Output-nya nyata. Ia hanya terkonsentrasi di sepasang tangan sampai tingkat yang belum pernah ditunjukkan proyek sebesar ini.

Lapisan berikutnya kecil tapi serius: [vincentkoc](/u/vincentkoc) (10.502 commit, skor 96,5), [shakkernerd](/u/shakkernerd) (3.688, skor 94,1), [obviyus](/u/obviyus) (1.771, skor 93,2). Di bawah posisi kesepuluh, tidak ada yang mencakup bahkan setengah persen dari commit.

Kedua cara membangun sama-sama berhasil: Dify ditulis oleh komunitas yang benar-benar luas; OpenClaw adalah satu orang yang mengambil setiap keputusan dan bergerak lebih cepat dari proyek mana pun sebelumnya. Tetapi risikonya berbeda — jika satu orang itu berhenti, semuanya berhenti — dan jumlah star 148k versus 382k tidak memberi tahu Anda apa-apa tentang risiko mana yang sedang Anda ambil.

## Tidak ada aktivitas palsu — dan mengapa itu tetap layak dikatakan

Di antara seluruh 96 manusia: **nol** akun yang berada di atau melampaui ambang mesin untuk kontribusi buatan, baik memakai skor tersimpan maupun menghitung ulang dengan mesin terkini. Sinyal peringatan muncul pada 19 dari 92 akun (20,7%), tetapi semuanya berjenis "profil tipis" atau "banyak PR ditolak" — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4). Tidak ada yang menunjukkan judul PR produksi massal; tidak ada yang menunjukkan riwayat yang digemukkan dengan PR trivial. Sebagai perbandingan, bahkan top-100 milik Dify memuat dua akun semacam itu, dan angka baseline-nya 0,58%.

Satu catatan jujur: memeringkat berdasarkan jumlah commit secara alami menjauhkan para pemalsu dari sampel ini. Jurus khas mereka adalah satu atau dua PR trivial per repositori, dan kontributor #100 OpenClaw punya 24 commit — Anda tidak bisa sampai ke sini dengan perbaikan typo. Jika aktivitas palsu ada di sekitar OpenClaw, ia hidup di ekor panjang 368 kontributor dan [2.800+ identitas email anonim](https://github.com/openclaw/openclaw/graphs/contributors) di luar mereka, yang tidak dicakup studi ini. Yang benar-benar disingkirkan oleh hasil ini adalah tuduhan yang lebih serius: bahwa angka-angka menakjubkan OpenClaw ditopang oleh pasukan akun palsu. Tidak. Orang-orang di puncak proyek ini lolos pemeriksaan, satu per satu.

## Gelombang pendatang baru

Umur akun adalah titik di mana OpenClaw berhenti menyerupai Dify sama sekali:

| | OpenClaw | Dify |
|---|---|---|
| Akun < 1 tahun | **19,6%** | 4,7% |
| Akun < 2 tahun | **26,1%** | 9,3% |
| Umur akun median | 8,7 tahun | 9,0 tahun |

Para kontributornya terbelah menjadi dua kelompok yang berbeda: inti veteran yang bergabung ke GitHub sekitar 2017, dan seperlima yang akunnya nyaris belum ada setahun lalu. Para pendatang baru ini ditarik ke open source oleh ledakan AI-agent — dan mereka bukan sekadar numpang lewat. Yang paling menonjol adalah [shakkernerd](/u/shakkernerd): akun berumur 2,3 tahun, 362 follower, dan posisi commit #3 di repositori terbesar tahun ini, dengan skor 94,1. Para pencetak skor rendah (9,4% di bawah 40 poin) adalah sisi lain dari gelombang yang sama: akun-akun baru lahir yang aktivitas open-source pertamanya adalah sebuah perbaikan kecil di OpenClaw. Setahun dari sekarang mereka entah sudah membangun riwayat nyata atau menjadi sunyi — kami akan menjalankan ulang angkanya dan mencari tahu.

## Lima yang paling diremehkan

Skor kelas atas, pengikut mungil — para langganan OpenClaw yang tidak diperhatikan siapa pun:

| Kontributor | Skor | Tingkatan | Follower | Commit di sini |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98,4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97,7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97,2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96,0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93,4 | 夯 | 60 | 57 |

Sebutan khusus untuk [joshavant](/u/joshavant): #7 berdasarkan commit (558), skor 95,7, 160 follower. Kesenjangan antara apa yang orang kontribusikan dan berapa banyak orang yang memperhatikan mereka adalah tema berulang seri ini — mereka yang mengerjakan pekerjaannya jarang menjadi yang di-follow.

## Metode dan keterbatasan

Skor berasal dari rubrik deterministik ghfind — enam dimensi atas data GitHub publik, tanpa panggilan model, open source di bawah AGPL. Rubrik dan ambang lengkap: [metodologi](/methodology). Agregat di balik setiap tabel: [data.json](/blog/who-builds-openclaw/data.json).

- **Top-100 berdasarkan commit adalah kepala proyek, bukan keseluruhan komunitas.** OpenClaw mencatat 368 kontributor kode plus ~2.800 identitas email anonim; jika aktivitas palsu ada, ia akan berada di ekor itu, yang tidak kami nilai.
- **Jumlah commit mentah bergantung pada alur kerja.** Gaya OpenClaw yang digerakkan agent dan commit-langsung menghasilkan jauh lebih banyak commit untuk jumlah kerja yang sama dibanding proyek squash-and-merge seperti Dify. Persentase di dalam satu repositori bermakna; membandingkan total commit mentah antar-repositori tidak.
- **Ini sebuah snapshot.** Data dikumpulkan 2026-07-11, pada proyek yang bergerak lebih cepat dari proyek mana pun sebelumnya. Data langsung: [halaman proyek OpenClaw](/developers/repo/openclaw/openclaw).
- **Temuan aktivitas-palsu hanya dilaporkan secara agregat.** Kami menyebut nama individu hanya ketika kabarnya baik.

---

*Telusuri [papan kontributor langsung OpenClaw](/developers/repo/openclaw/openclaw), baca [studi pendamping Dify](/blog/who-builds-dify), atau [nilai akun GitHub Anda sendiri](/) — mesin yang sama, 20 detik.*
