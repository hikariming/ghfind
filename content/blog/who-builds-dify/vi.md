---
title: "Ai xây dựng Dify? Chúng tôi đã chấm điểm 100 người đóng góp hàng đầu của nó"
description: "Dify có 148.500 star và 458 người đóng góp code. Chúng tôi đưa 100 committer hàng đầu của nó qua một engine chấm điểm tất định: điểm trung vị 78 so với đường chuẩn toàn cục 42,5, 71% xếp hạng người đóng góp đáng tin cậy, và công việc được trải rộng cho nhiều người hơn hẳn thông thường."
date: "2026-07-12"
tags: ["data", "github", "open-source", "research"]
---

**Các phát hiện chính** (dữ liệu thu thập 2026-07-11, 100 committer hàng đầu của [langgenius/dify](https://github.com/langgenius/dify), chấm bằng [engine ghfind](/methodology) mã nguồn mở):

- **100 người đóng góp hàng đầu của Dify đạt điểm trung vị 78,2 / 100 — cao hơn 36 điểm so với trung vị 42,5 của đường chuẩn 18.947 tài khoản của chúng tôi.** 70,8% vượt ngưỡng "người đóng góp đáng tin cậy" (điểm ≥ 70) mà chỉ 20,1% quần thể chung đạt tới.
- **Họ trông như những lập trình viên bình thường cho đến khi bạn nhìn vào sản lượng của họ.** Follower trung vị: 31 (đường chuẩn: 27). Pull request được merge trung vị: 118 (đường chuẩn: 20). Dify được xây bởi những chuyên gia thầm lặng nhưng cực kỳ năng suất, không phải bởi ai đó bạn nhận ra từ mạng xã hội.
- **Không một cá nhân nào thống trị codebase — hiếm thấy với một dự án nổi tiếng cỡ này.** Committer tích cực nhất chỉ viết 8,4% số commit, ba người đứng đầu viết 21%, mười người đứng đầu chưa đến một nửa. Hãy so sánh với [các dự án AI viral mà phần lớn là công sức của một người](/blog/who-builds-openclaw).

## Vì sao là Dify

[Dify](https://github.com/langgenius/dify) là một trong những nền tảng ứng dụng LLM nhiều star nhất trên GitHub — 148.500 star, 458 người đóng góp code, ra đời tháng 4 năm 2023. Số star là cách mặc định người ta đánh giá sức khỏe của một dự án, và nó cũng là con số dễ thổi phồng nhất. Vậy nên chúng tôi đặt câu hỏi mà star không trả lời được: **ai thật sự viết ra thứ này, và họ có đứng vững khi bạn kiểm tra xem thành tích của họ có thật không?**

Chúng tôi lấy 100 người đóng góp hàng đầu theo số commit, loại 3 bot (`dependabot`, `github-actions`, và — một dấu hiệu của thời đại — `Copilot`), rồi chấm 97 con người còn lại bằng engine tất định của mình. 96 người phân giải thành công; 86 người có snapshot chỉ số thô đầy đủ. Engine chính là cái đứng sau mọi điểm số trên trang này: 100 điểm qua sáu chiều đo, không gọi model, đầu vào giống nhau cho đầu ra giống nhau.

## Chất lượng người đóng góp: vượt xa đường chuẩn

| | Dify top-100 | Đường chuẩn 19k |
|---|---|---|
| Điểm trung vị | **78,2** | 42,5 |
| Điểm ≥ 90 (hạng 夯) | **15,6%** | 3,7% |
| Điểm ≥ 70 (đáng tin cậy) | **70,8%** | 20,1% |
| Điểm < 40 (giá trị thấp) | **5,2%** | 48,6% |

Hai phân phối gần như không chồng lên nhau. Ngay cả người đóng góp ở bách phân vị 10 của Dify (56,1) cũng vượt trung vị toàn cục 13 điểm. Mười lăm trong số chín mươi sáu người đạt từ 90 trở lên — một ngưỡng mà trên toàn GitHub chỉ một tài khoản trong hai mươi bảy vượt qua.

Năm tài khoản dưới 40 cũng đáng một ghi chú: repository nổi tiếng nào cũng kéo theo một cái đuôi gồm những người đưa được một commit và gần như chẳng có gì khác trên profile. Ở một dự án lành mạnh, cái đuôi đó chiếm khoảng 5% danh sách người đóng góp hàng đầu. Trong quần thể đường chuẩn, gần một nửa số tài khoản nằm dưới 40.

## Những chuyên gia thầm lặng

Mẫu hình thú vị nhất là khoảng cách giữa độ nổi của những người này và lượng họ sản xuất ra:

| Trung vị, trên mỗi người đóng góp | Dify top-100 | Đường chuẩn 19k |
|---|---|---|
| Follower | 31 | 27 |
| Pull request được merge | **118** | 20 |
| Tuổi tài khoản | 9,0 năm | 7,4 năm |

Xét theo số follower, những người đóng góp cốt lõi của Dify không thể phân biệt với tài khoản GitHub trung bình. Xét theo pull request được merge, họ sản xuất gấp **sáu lần** đường chuẩn. Đây là hình ảnh trái ngược hoàn toàn với profile hoạt-động-giả mà [nghiên cứu 19k tài khoản](/blog/we-scored-19000-github-accounts) của chúng tôi đã ghi nhận — tài khoản chế tạo thì đánh bóng những con số ai cũng thấy và bỏ qua công việc thật. Người đóng góp của Dify làm công việc thật và bỏ qua khoản tự quảng bá.

Tuổi tài khoản kể cùng một câu chuyện: chỉ 4 trong 86 tài khoản có dữ liệu đầy đủ là trẻ hơn một năm. Đây không phải một đám tài khoản mới toanh chạy theo repository đang trending — người đóng góp điển hình đã ở trên GitHub từ năm 2017.

## Hoạt động giả xuất hiện cả ở đây

Hai tài khoản trong top 100 (2,1%) vượt ngưỡng mà engine của chúng tôi dùng cho cày cuốc — hành vi chế tạo một lịch sử đóng góp từ những pull request ít công sức, lặp đi lặp lại. Trong quần thể đường chuẩn, tỷ lệ đó là 0,58%. Chạy lại engine hiện tại trên các snapshot mới nhất gắn cờ một trong hai (1,2%). Tín hiệu cảnh báo dưới bất kỳ hình thức nào xuất hiện trên 13 trong 86 tài khoản (15,1%, đường chuẩn 17%), nhưng gần như tất cả đều nói "profile này mỏng" (`mostly_forks`: 12) chứ không phải "profile này giả": đúng một tài khoản cho thấy các tiêu đề PR sản xuất hàng loạt, và một tài khoản cho thấy lịch sử xây trên các PR vụn vặt.

Chúng tôi chỉ báo cáo điều này ở dạng tổng hợp, nhưng điểm khái quát vẫn đứng vững: **là một dự án nổi tiếng không giữ được danh sách top-100 người đóng góp của bạn sạch sẽ.** Độ nổi tiếng thu hút hành vi này, vì những PR khuôn mẫu tí hon được merge vào một repository nổi tiếng là dòng résumé rẻ nhất trên thị trường. Đó chính xác là vấn đề mà công cụ sắp ra mắt của chúng tôi dành cho maintainer được xây để bắt.

## Được xây bởi nhiều bàn tay

Tổng số commit trên mẫu top-100: 8.434.

| Tỷ trọng commit | |
|---|---|
| Người đóng góp tích cực nhất | 8,4% |
| Top 3 | 21,0% |
| Top 5 | 31,3% |
| Top 10 | 49,8% |

Hơn một nửa số commit đến từ **bên ngoài** top mười. Các dự án AI nổi tiếng thường tựa lên một hoặc hai maintainer kiệt sức, và ngừng chuyển động khi những người đó ngừng; việc Dify trải công việc rộng đến vậy khiến nó cực kỳ khó gãy. Phần đầu bảng trộn lẫn nhân viên LangGenius với các maintainer cộng đồng độc lập, và mức giảm từ #1 (708 commit) xuống #10 (249) là một con dốc thoải, không phải vách đứng.

## Năm người bị đánh giá thấp

Những người đóng góp mà engine của chúng tôi chấm cao nhất và gần như chẳng ai follow:

| Người đóng góp | Điểm | Hạng | Follower |
|---|---|---|---|
| [linw1995](/u/linw1995) | 96,4 | 夯 | 165 |
| [kurokobo](/u/kurokobo) | 94,3 | 夯 | 116 |
| [junjiem](/u/junjiem) | 93,8 | 夯 | 229 |
| [lin-snow](/u/lin-snow) | 92,3 | 夯 | 152 |
| [WH-2099](/u/WH-2099) | 89,6 | 顶级 | 31 |

Nhắc đặc biệt tới [bowenliang123](/u/bowenliang123) (94,0, #8 theo commit) và [hjlarry](/u/hjlarry) (93,6, #6 theo commit): committer top-mười trên một trong những dự án AI phổ biến nhất thế giới, mỗi người có chưa đến 170 follower. Nếu bạn đang tuyển dụng, hãy bắt đầu từ bảng này — những người này giỏi hơn nhiều so với những gì số follower của họ gợi ý.

## Phương pháp và hạn chế

Điểm số đến từ bộ tiêu chí tất định của ghfind — sáu chiều đo trên dữ liệu GitHub công khai, không gọi model, mã nguồn mở dưới AGPL. Bộ tiêu chí và các ngưỡng đầy đủ: [methodology](/methodology). Dữ liệu tổng hợp đứng sau mọi bảng: [data.json](/blog/who-builds-dify/data.json).

- **Top-100 theo commit không phải toàn bộ cộng đồng.** Dify có 458 người đóng góp code; chúng tôi chấm phần tích cực nhất. Cái đuôi dài gồm những người đóng góp thi thoảng nhiều khả năng đạt điểm thấp hơn.
- **Đây là một snapshot.** Dữ liệu thu thập 2026-07-11. Star và commit thay đổi hàng ngày; dữ liệu người đóng góp trực tiếp nằm trên [trang dự án Dify](/developers/repo/langgenius/dify).
- **Số commit đo khối lượng, không phải tầm quan trọng.** Bảng tỷ trọng commit nói ai commit nhiều nhất, không phải ai viết phần code mà mọi thứ khác phụ thuộc vào.
- **Các phát hiện về hoạt động giả chỉ được báo cáo ở dạng tổng hợp.** Chúng tôi chỉ nêu tên cá nhân khi đó là tin tốt.

---

*Xem [bảng người đóng góp trực tiếp của Dify](/developers/repo/langgenius/dify), đọc [nghiên cứu song hành về OpenClaw](/blog/who-builds-openclaw), hoặc [chấm điểm tài khoản GitHub của chính bạn](/) — cùng một engine, 20 giây.*
