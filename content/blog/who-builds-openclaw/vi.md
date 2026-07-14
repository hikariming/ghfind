---
title: "382.000 star, một đôi tay: Ai thật sự xây dựng OpenClaw?"
description: "OpenClaw trở thành repository tăng trưởng nhanh nhất trong lịch sử GitHub. Chúng tôi chấm điểm 100 người đóng góp hàng đầu của nó bằng một engine tất định: một người viết 57% số commit, không người đóng góp nào có dấu hiệu hoạt động giả, và một phần năm trong số họ tham gia GitHub chưa đầy một năm."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Các phát hiện chính** (dữ liệu thu thập 2026-07-11, 100 committer hàng đầu của [openclaw/openclaw](https://github.com/openclaw/openclaw), chấm bằng [engine ghfind](/methodology) mã nguồn mở):

- **Repository tăng trưởng nhanh nhất trong lịch sử GitHub, đo theo commit, phần lớn là một người.** Người sáng lập [steipete](/u/steipete) viết 33.482 trong tổng 58.487 commit của mẫu hàng đầu — **57,2%**. Ba người đóng góp đứng đầu chiếm 81,5%, mười người đứng đầu chiếm 90,2%.
- **Không có hoạt động giả nào.** Không một ai trong 96 người đóng góp top-100 là con người cho thấy mẫu hình đóng-góp-chế-tạo mà engine của chúng tôi gắn cờ — mẫu hình xuất hiện ở 0,58% tài khoản ngay cả trong đường chuẩn 18.947 tài khoản đã lọc kỹ của chúng tôi. Cơn sốt thì khổng lồ; những người đứng sau nó là thật.
- **Cơn bùng nổ AI-agent đang kéo người mới vào mã nguồn mở.** 19,6% người đóng góp hàng đầu có tài khoản GitHub chưa đầy một năm tuổi (ở Dify, một dự án lâu đời hơn với độ nổi tiếng tương đương, con số là 4,7%). Vài người đã xuất sắc sẵn: committer #3 dùng một tài khoản 2,3 năm tuổi đạt 94,1 điểm.

## Vì sao là OpenClaw

[OpenClaw](https://github.com/openclaw/openclaw) chẳng cần giới thiệu nhiều: được tạo ngày 2025-11-24 bởi Peter Steinberger ([steipete](/u/steipete), nhà sáng lập PSPDFKit), đổi tên hai lần trong đúng một tuần của tháng 1 năm 2026 (Clawdbot → Moltbot → OpenClaw), và là dự án nhanh nhất từ trước đến nay đạt 100.000 star GitHub. Tính đến 2026-07-11 nó đứng ở mức **382.580 star, 80.292 fork, và 368 người đóng góp code** — khoảng bảy tháng rưỡi sau commit đầu tiên.

Một đường cong star như vậy chính xác là thứ engine của chúng tôi được xây để trả lời: khi một con số leo nhanh đến thế, bên dưới có gì thật không? Chúng tôi lấy 100 người đóng góp hàng đầu theo số commit, loại 4 bot (bao gồm `clawsweeper` và `openclaw-clownfish` của chính dự án), và chấm cả 96 con người. 92 người có snapshot chỉ số thô đầy đủ.

## Chất lượng người đóng góp: phần đầu danh sách rất xuất sắc

| | OpenClaw top-100 | Dify top-100 | Đường chuẩn 19k |
|---|---|---|---|
| Điểm trung vị | **79,7** | 78,2 | 42,5 |
| Điểm ≥ 90 (hạng 夯) | **21,9%** | 15,6% | 3,7% |
| Điểm ≥ 70 (đáng tin cậy) | **69,8%** | 70,8% | 20,1% |
| Điểm < 40 (giá trị thấp) | **9,4%** | 5,2% | 48,6% |

(Cột Dify đến từ [nghiên cứu song hành của chúng tôi](/blog/who-builds-dify), chấm cùng tuần với cùng engine.)

Một phần năm người đóng góp hàng đầu của OpenClaw đạt từ 90 trở lên; trên toàn GitHub, chỉ khoảng một tài khoản trong hai mươi bảy làm được. Khi một dự án có sự chú ý của cả ngành, các lập trình viên xuất sắc kéo đến để xây nó. Nhưng hãy nhìn cả đầu kia: 9,4% đạt dưới 40, gần gấp đôi tỷ lệ của Dify. Toàn bộ sự chú ý đó cũng hút vào những tài khoản mới toanh gần như trống trơn — phần về tuổi tài khoản bên dưới giải thích họ đến từ đâu.

## Một đôi tay

Tổng số commit trên mẫu top-100: 58.487 — gấp bảy lần con số 8.434 của Dify, được tạo ra trong một phần năm thời gian lịch.

| Tỷ trọng commit | OpenClaw | Dify |
|---|---|---|
| Người đóng góp tích cực nhất | **57,2%** | 8,4% |
| Top 3 | **81,5%** | 21,0% |
| Top 5 | **86,0%** | 31,3% |
| Top 10 | **90,2%** | 49,8% |

33.482 commit của [steipete](/u/steipete) trong 229 ngày tương đương **146 commit mỗi ngày**. Không ai gõ nhanh đến thế — nhưng một người chỉ huy cả một đội coding agent và review những gì chúng tạo ra thì có thể merge nhanh đến thế, và đó chính xác là cách OpenClaw nổi tiếng được xây. Engine chấm tài khoản này **100/100**: lịch sử GitHub 17 năm, 52.067 follower, 2.772 PR được merge — xa một tài khoản giả hết mức có thể. Sản lượng là thật. Nó chỉ đơn giản tập trung vào một đôi tay đến mức chưa dự án nào cỡ này từng cho thấy.

Bậc kế tiếp bên dưới nhỏ nhưng nghiêm túc: [vincentkoc](/u/vincentkoc) (10.502 commit, điểm 96,5), [shakkernerd](/u/shakkernerd) (3.688, điểm 94,1), [obviyus](/u/obviyus) (1.771, điểm 93,2). Dưới vị trí thứ mười, không ai chiếm nổi nửa phần trăm số commit.

Cả hai cách xây đều chạy được: Dify được viết bởi một cộng đồng thật sự rộng; OpenClaw là một người ra mọi quyết định và di chuyển nhanh hơn bất kỳ dự án nào trước đó. Nhưng rủi ro thì khác nhau — nếu người duy nhất đó dừng, mọi thứ dừng — và số star 148k so với 382k chẳng nói gì cho bạn về việc bạn đang gánh rủi ro nào.

## Không có hoạt động giả — và vì sao điều đó vẫn đáng nói

Trên toàn bộ 96 con người: **không** tài khoản nào đạt hoặc vượt ngưỡng của engine về đóng góp chế tạo, dù dùng điểm đã lưu hay tính lại bằng engine hiện tại. Tín hiệu cảnh báo xuất hiện trên 19 trong 92 tài khoản (20,7%), nhưng tất cả đều thuộc loại "profile mỏng" hoặc "nhiều PR bị từ chối" — `mostly_forks` (15), `no_original_work` (10), `high_pr_rejection` (4). Không ai cho thấy các tiêu đề PR sản xuất hàng loạt; không ai cho thấy lịch sử độn bằng PR vụn vặt. Để so sánh, ngay cả top-100 của Dify cũng chứa hai tài khoản như vậy, và tỷ lệ đường chuẩn là 0,58%.

Một lưu ý thẳng thắn: xếp hạng theo số commit tự nhiên giữ những kẻ làm giả ra khỏi mẫu này. Chiêu quen thuộc của họ là một hai PR vụn vặt cho mỗi repository, mà người đóng góp #100 của OpenClaw đã có 24 commit — bạn không thể vào đây bằng sửa lỗi chính tả. Nếu hoạt động giả tồn tại quanh OpenClaw, nó nằm ở cái đuôi dài của 368 người đóng góp và [hơn 2.800 danh tính email ẩn danh](https://github.com/openclaw/openclaw/graphs/contributors) ngoài họ, phần mà nghiên cứu này không bao phủ. Điều mà kết quả này loại trừ được là một cáo buộc nghiêm trọng hơn: rằng các con số kinh ngạc của OpenClaw được chống đỡ bởi một đội quân tài khoản giả. Không phải vậy. Những người ở đỉnh dự án này đều vượt qua kiểm chứng, từng người một.

## Làn sóng người mới

Tuổi tài khoản là nơi OpenClaw ngừng giống Dify hoàn toàn:

| | OpenClaw | Dify |
|---|---|---|
| Tài khoản < 1 năm tuổi | **19,6%** | 4,7% |
| Tài khoản < 2 năm tuổi | **26,1%** | 9,3% |
| Tuổi tài khoản trung vị | 8,7 năm | 9,0 năm |

Những người đóng góp rơi vào hai nhóm rõ rệt: một lõi kỳ cựu tham gia GitHub quanh năm 2017, và một phần năm với tài khoản gần như chưa tồn tại một năm trước. Những người mới này được cơn bùng nổ AI-agent kéo vào mã nguồn mở — và họ không chỉ ghé qua. Gương mặt nổi bật là [shakkernerd](/u/shakkernerd): tài khoản 2,3 năm tuổi, 362 follower, và vị trí commit #3 trên repository lớn nhất của năm, đạt 94,1 điểm. Nhóm điểm thấp (9,4% dưới 40 điểm) là mặt kia của cùng làn sóng: những tài khoản mới toanh mà hoạt động mã nguồn mở đầu tiên trong đời là một bản sửa nhỏ cho OpenClaw. Một năm nữa họ hoặc sẽ xây được lịch sử thật hoặc lặng tiếng — chúng tôi sẽ chạy lại các con số và tìm ra câu trả lời.

## Năm người bị đánh giá thấp

Điểm hàng đầu, lượng theo dõi tí hon — những gương mặt quen của OpenClaw mà chẳng ai để mắt:

| Người đóng góp | Điểm | Hạng | Follower | Commit tại đây |
|---|---|---|---|---|
| [RomneyDa](/u/RomneyDa) | 98,4 | 夯 | 169 | 290 |
| [altaywtf](/u/altaywtf) | 97,7 | 夯 | 273 | 66 |
| [osolmaz](/u/osolmaz) | 97,2 | 夯 | 290 | 76 |
| [ngutman](/u/ngutman) | 96,0 | 夯 | 91 | 143 |
| [omarshahine](/u/omarshahine) | 93,4 | 夯 | 60 | 57 |

Nhắc đặc biệt tới [joshavant](/u/joshavant): #7 theo commit (558), điểm 95,7, 160 follower. Khoảng cách giữa những gì người ta đóng góp và bao nhiêu người theo dõi họ là chủ đề xuyên suốt của loạt bài này — những người làm việc thật hiếm khi là những người được follow.

## Phương pháp và hạn chế

Điểm số đến từ bộ tiêu chí tất định của ghfind — sáu chiều đo trên dữ liệu GitHub công khai, không gọi model, mã nguồn mở dưới AGPL. Bộ tiêu chí và các ngưỡng đầy đủ: [methodology](/methodology). Dữ liệu tổng hợp đứng sau mọi bảng: [data.json](/blog/who-builds-openclaw/data.json).

- **Top-100 theo commit là phần đầu của dự án, không phải toàn bộ cộng đồng.** OpenClaw đếm được 368 người đóng góp code cộng khoảng 2.800 danh tính email ẩn danh; nếu hoạt động giả tồn tại, nó sẽ nằm ở cái đuôi đó, phần chúng tôi không chấm.
- **Số commit thô phụ thuộc vào quy trình làm việc.** Phong cách agent-điều-khiển, commit-thẳng của OpenClaw tạo ra nhiều commit hơn hẳn cho cùng một lượng công việc so với một dự án squash-and-merge như Dify. Phần trăm trong nội bộ một repository là có ý nghĩa; so sánh tổng commit thô giữa các repository thì không.
- **Đây là một snapshot.** Dữ liệu thu thập 2026-07-11, trên một dự án di chuyển nhanh hơn mọi dự án trước nó. Dữ liệu trực tiếp: [trang dự án OpenClaw](/developers/repo/openclaw/openclaw).
- **Các phát hiện về hoạt động giả chỉ được báo cáo ở dạng tổng hợp.** Chúng tôi chỉ nêu tên cá nhân khi đó là tin tốt.

---

*Xem [bảng người đóng góp trực tiếp của OpenClaw](/developers/repo/openclaw/openclaw), đọc [nghiên cứu song hành về Dify](/blog/who-builds-dify), hoặc [chấm điểm tài khoản GitHub của chính bạn](/) — cùng một engine, 20 giây.*
