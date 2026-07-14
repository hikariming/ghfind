---
title: "Đo lường hoạt động đóng góp giả tạo trên GitHub: Bằng chứng từ 19.000 tài khoản được chấm điểm tất định"
description: "Một nghiên cứu thực nghiệm về tính xác thực của đóng góp trên GitHub. Chúng tôi chấm 18.947 tài khoản công khai bằng một engine tất định mã nguồn mở và phân tích phân phối điểm, mức độ phổ biến và cấu trúc của việc cày pull request, thành phần các cờ đỏ, và mối quan hệ giữa tuổi tài khoản và điểm số."
date: "2026-07-03"
tags: ["data", "github", "anti-abuse", "open-source"]
---

**Tóm tắt.** Lo ngại về hoạt động giả tạo trên GitHub — pull request theo khuôn mẫu, star mua, mạng lưới follow qua lại — rất phổ biến, nhưng bằng chứng định lượng về mức độ phổ biến và cấu trúc của nó lại khan hiếm. Chúng tôi chấm 18.947 tài khoản GitHub công khai bằng một bộ tiêu chí tất định, mã nguồn mở (không gọi model; đầu vào giống nhau cho ra điểm giống nhau) và lưu giữ snapshot đầy đủ các chỉ số thô cho một mẫu sâu gồm 3.444 tài khoản. Chúng tôi thấy rằng (i) giả tạo là hiếm trong mẫu của chúng tôi: chỉ 0,58% tài khoản vượt ngưỡng cày cuốc thận trọng của chúng tôi; (ii) khi nó xảy ra, nó cực đoan và tách biệt lưỡng cực khỏi hành vi thông thường — các tài khoản bị gắn cờ có tỷ lệ tiêu đề PR theo khuôn mẫu trên 50% (lên đến 97%), so với trung vị toàn mẫu là 7%; (iii) các đóng góp ít công sức là bình thường chứ không đáng ngờ: 58% lập trình viên có mẫu PR được merge gần đây có ít nhất một PR vụn vặt bên ngoài, trong khi chỉ 0,4% thể hiện mẫu hình đa số-vụn-vặt ở quy mô lớn; và (iv) kiểu profile "trông đáng ngờ" chiếm ưu thế là trống rỗng chứ không phải bị thao túng — các cờ đỏ dạng vắng-mặt nhiều hơn các cờ dạng thao-túng cả một bậc độ lớn. Điểm trung vị tăng đơn điệu theo tuổi tài khoản, từ 18 điểm dưới một năm lên 86 điểm sau mười năm, nhất quán với việc tính nhất quán dài hạn là tín hiệu khó làm giả nhất. Chúng tôi thảo luận các hàm ý cho việc thiết kế công cụ phát hiện spam, đặc biệt là việc cày cuốc là một thuộc tính cấp-mẫu-hình của lịch sử tài khoản chứ không phải thuộc tính cấp-sự-kiện của từng đóng góp riêng lẻ.

## 1. Giới thiệu

Việc đánh giá độ tin cậy của lập trình viên ngày càng dựa vào hoạt động GitHub công khai: quy trình tuyển dụng sàng lọc profile ứng viên, các maintainer mã nguồn mở phân loại pull request từ những người đóng góp chưa quen, và công cụ hạ nguồn xếp hạng tài khoản theo mức ảnh hưởng bề ngoài. Mỗi cách dùng đó tạo ra động cơ để làm giả các tín hiệu nền tảng. Các báo cáo mang tính giai thoại về chợ star, chiến dịch pull request theo khuôn mẫu, và các mưu đồ follow qua lại rất phổ biến; nhưng các phép đo có hệ thống về tần suất giả tạo và hình dạng thống kê của nó thì không.

Một ví dụ minh họa từ tập dữ liệu của chúng tôi cho thấy hiện tượng này. Một tài khoản trình ra thành tích merged-PR mà thông thường sẽ chỉ báo một người đóng góp mạnh: số lượng lớn pull request được merge (không chỉ được mở) với tỷ lệ chấp nhận gần hoàn hảo. Xem xét kỹ hơn cho thấy 97% tiêu đề PR gần đây của nó là các biến thể khuôn mẫu gần như y hệt nhau, và đa số nhắm vào một repository nổi tiếng duy nhất không thuộc sở hữu của tài khoản. Không pull request riêng lẻ nào bất thường; sự bất thường chỉ tồn tại ở cấp độ mẫu hình tổng hợp. Quan sát này — rằng giả tạo có thể vô hình từng-sự-kiện nhưng lộ liễu khi tổng hợp — là động lực cho nghiên cứu hiện tại.

Chúng tôi đặt ba câu hỏi:

1. **Mức độ phổ biến.** Hoạt động đóng góp giả tạo phổ biến đến đâu trong các tài khoản GitHub công khai?
2. **Cấu trúc.** Khi giả tạo xảy ra, nó khác biệt về mặt thống kê thế nào so với hành vi đóng góp thông thường?
3. **Thành phần.** Trong các tài khoản kích hoạt các heuristic về tính chính trực, tỷ lệ nào phản ánh thao túng chủ động so với chỉ đơn thuần là không hoạt động hoặc thiếu vắng công việc gốc?

Để trả lời, chúng tôi chấm 18.947 tài khoản công khai bằng một bộ tiêu chí tất định ([ghfind](https://ghfind.com)), có lõi chấm điểm là mã nguồn mở dưới giấy phép AGPL ([repository](https://github.com/hikariming/ghfind)), và phân tích một mẫu sâu gồm 3.444 tài khoản mà chúng tôi lưu giữ snapshot chỉ số thô đầy đủ, bao gồm mẫu ở cấp PR, các đặc trưng chất lượng repository, và thống kê hình dạng hoạt động. Toàn bộ dữ liệu tổng hợp đứng sau các hình vẽ được công bố kèm bài viết này ([data.json](/blog/we-scored-19000-github-accounts/data.json)).

Tóm lại, giả tạo trong mẫu này hiếm hơn đáng kể so với những gì dư luận gợi ý; khi hiện diện, nó cực đoan chứ không tinh vi; và nó có thể được tách khỏi hoạt động thông thường chỉ bằng các ngưỡng đơn giản ở cấp mẫu hình.

## 2. Dữ liệu và phương pháp

### 2.1 Bộ tiêu chí chấm điểm

Engine hiện thực một bộ tiêu chí tất định trên sáu chiều đo với tổng 100 điểm, cùng các mức phạt cộng dồn cho các tín hiệu cờ đỏ. Nó không gọi model nào; điểm số hoàn toàn tái lập được từ dữ liệu GitHub công khai. Cùng các đường code đó tạo ra điểm dùng cho website ghfind, các SDK trên npm/PyPI, và phân tích này.

| Chiều đo | Tối đa | Tín hiệu được thưởng |
|---|---|---|
| Chất lượng đóng góp | 27 | PR được merge (thang log), tỷ lệ chấp nhận, tham gia issue |
| Tác động hệ sinh thái | 20 | PR thực chất vào các repository nhiều star, độ sâu maintainer |
| Chất lượng dự án gốc | 18 | star có trọng số theo thực chất của repository |
| Tính xác thực của hoạt động | 17 | hoạt động gần đây bền vững, sự đa dạng của các loại hoạt động |
| Độ trưởng thành của tài khoản | 10 | tuổi tài khoản, số năm hoạt động thực tế |
| Ảnh hưởng cộng đồng | 8 | follower (thang log), tính hợp lý của tỷ lệ follower/following |

Mười hai quy tắc cờ đỏ tất định trừ điểm, bao gồm `templated_pr_flooding`, `trivial_pr_farming`, `follow_farming`, và `possible_star_inflation`. Các ngưỡng chính xác có trong repository. Bên cạnh điểm công khai, engine tính một điểm nội bộ về khả năng spam/bot trên thang 0–10, dùng để bảo vệ tính toàn vẹn của bảng xếp hạng; Mục 3.2 báo cáo phân phối của nó lần đầu tiên. Không dữ liệu phi-công-khai nào khác đi vào phân tích này.

**Định nghĩa.** Chúng tôi gọi một pull request là *vụn vặt* nếu nó thay đổi tối đa năm dòng và được merge vào một repository có ít nhất 200 star mà tác giả không sở hữu. *Tỷ lệ tiêu đề khuôn mẫu* của một tài khoản là phần các tiêu đề PR gần đây của nó là các biến thể khuôn mẫu gần như y hệt nhau.

### 2.2 Xây dựng mẫu và các thiên lệch đã biết

Mẫu gồm (a) người dùng tự nguyện chấm điểm tài khoản của chính họ qua website ghfind và (b) lập trình viên được thu nạp từ các tổ chức mã nguồn mở đang hoạt động. Hai đặc tính của thiết kế này ràng buộc cách diễn giải. Thứ nhất, mẫu là tự-chọn và nghiêng về các lập trình viên chân thật, đang hoạt động; do đó mọi tỷ lệ giả tạo báo cáo dưới đây nên được đọc là **cận dưới trong một quần thể đã được lọc sẵn**, không phải ước lượng cho toàn GitHub. Thứ hai, với 18.947 tài khoản được chấm (3.444 có chỉ số sâu), mẫu đủ lớn để mô tả hình dạng phân phối nhưng là một phần không đáng kể của GitHub; chúng tôi báo cáo hình dạng, không phải một cuộc điều tra dân số.

## 3. Kết quả

### 3.1 Phân phối điểm

![Phân phối điểm cuối trên 19k tài khoản](/blog/we-scored-19000-github-accounts/score-distribution.svg "Hình 1: Phân phối điểm cuối theo các nhóm 5 điểm (n = 18.947). Dải cam đánh dấu các hạng từ 70 trở lên.")

*Hình 1* cho thấy phân phối điểm cuối. Trung vị nằm ngay trên 40 điểm; **48,6%** tài khoản đạt dưới 40 (hạng mà bộ tiêu chí gắn nhãn giá-trị-thấp hoặc nghi độn số), trong khi chỉ **3,7%** vượt 90. Nhóm đông nhất là 0–5, gồm các tài khoản không có công việc gốc, không có pull request được merge, và không có hoạt động bền vững. Ngay cả trong một mẫu thiên về lập trình viên đang hoạt động, phần lớn profile công khai vẫn mỏng.

Để hiệu chuẩn, tài khoản trung vị trong mẫu sâu có **27 follower, 34 star tổng, và 20 PR được merge**, với tuổi tài khoản trung vị là bảy năm. Các chỉ số liên quan đến danh tiếng tập trung nặng ở đuôi trên: bách phân vị 90 là 1.275 follower và khoảng 5.900 star; bách phân vị 99 là 19.000 follower và khoảng 100.000 star.

### 3.2 Mức độ phổ biến và cấu trúc của việc cày cuốc

![Phân phối điểm spam ẩn](/blog/we-scored-19000-github-accounts/spam-score.svg "Hình 2: Phân phối điểm nội bộ 0–10 về khả năng spam (n = 18.934). 77% tài khoản đạt đúng 0.")

*Hình 2* báo cáo phân phối điểm nội bộ về khả năng spam trên 18.934 tài khoản mà nó được tính:

- **77%** tài khoản đạt đúng 0 — không có tín hiệu cày cuốc nào dưới bất kỳ hình thức nào.
- **0,58%** (110 tài khoản) đạt từ 3 trở lên, ngưỡng chúng tôi coi là cày cuốc rõ ràng.
- **12 tài khoản** đạt từ 7 trở lên.

Tính tách biệt của các tài khoản cày cuốc không đến từ khối lượng mà từ *độ tập trung* của chúng. Trong 2.122 lập trình viên có ít nhất mười pull request gần đây, tỷ lệ tiêu đề khuôn mẫu trung vị là **7%** — lập trình viên bình thường tự lặp lại ở mức khiêm tốn ("fix typo", "bump deps"). Mọi tài khoản bị gắn cờ lũ lụt khuôn mẫu đều có tỷ lệ trên **50%**, kéo dài đến **97%**, trong khi bách phân vị 99 của toàn mẫu là 72%. Phân phối thực chất là lưỡng cực: không có dải liên tục nào giữa lặp lại thông thường và sinh hàng loạt. Phát hiện các tài khoản này không cần model học máy — chỉ cần tổng hợp qua nhiều hơn một pull request cho mỗi tài khoản.

### 3.3 Pull request vụn vặt là bình thường; cày PR vụn vặt thì không

Trong 2.558 lập trình viên có mẫu PR được merge gần đây, **58%** có ít nhất một PR vụn vặt bên ngoài theo định nghĩa ở Mục 2.1. Các sửa tài liệu và lỗi chính tả nhỏ vào các repository nổi bật rõ ràng là một phần thường lệ của việc tham gia mã nguồn mở, kể cả với những người đóng góp vốn rất mạnh.

Ngược lại, các lập trình viên có PR được merge gần đây *đa số* là vụn vặt với ít nhất mười PR như vậy chiếm **0,4%** mẫu (11 tài khoản).

Khoảng cách giữa hai con số này có hệ quả thiết kế trực tiếp cho công cụ chống lạm dụng. Bất kỳ heuristic nào phạt pull request nhỏ chỉ vì nó nhỏ sẽ phạt luôn nhóm 58% — người mới, người đóng góp tài liệu, và người giúp đỡ tình cờ — để bắt được mười một tài khoản mà hành vi vốn đã lộ liễu ở cấp mẫu hình. Chúng tôi kết luận rằng cày cuốc là một **thuộc tính mẫu hình** của lịch sử đóng góp của tài khoản (độ tập trung, khuôn mẫu hóa, lặp lại nhắm vào một mục tiêu duy nhất) chứ không phải một **thuộc tính sự kiện** của bất kỳ diff riêng lẻ nào, và các bộ phát hiện hoạt động trên sự kiện đơn lẻ đang đo sai đại lượng.

Một kết quả song song đúng với tỷ lệ bị từ chối. Trong 2.003 lập trình viên có ít nhất mười PR đã có quyết định, tỷ lệ bị maintainer từ chối trung vị là **2%**, với bách phân vị 90 là 13%. Do đó tỷ lệ chấp nhận mang rất ít tín hiệu phân biệt — với điều kiện đã có PR được merge, gần như mọi thứ những người đóng góp như vậy gửi lên đều được merge — và chỉ các tỷ lệ từ chối cực đoan (bộ tiêu chí gắn cờ trên 50%) mới có thông tin.

### 3.4 Thành phần cờ đỏ: vắng mặt áp đảo thao túng

Chạy lại engine hiện tại trên toàn bộ 3.444 tài khoản mẫu sâu, **17%** kích hoạt ít nhất một cờ đỏ. *Hình 3* cho thấy thành phần.

![Mức phổ biến của cờ đỏ](/blog/we-scored-19000-github-accounts/red-flags.svg "Hình 3: Mức phổ biến của cờ đỏ trong mẫu sâu (n = 3.444). Cờ dạng vắng-mặt vượt cờ dạng thao-túng cả một bậc độ lớn.")

Ba cờ phổ biến nhất — `ghost_profile` (10%), `no_original_work` (8,2%), và `mostly_forks` (7,2%) — mô tả sự thiếu vắng thực chất chứ không phải thao túng. Các cờ lừa-dối-chủ-động hiếm hơn cả một bậc độ lớn: `templated_pr_flooding` ở mức 0,5%, `trivial_pr_farming` ở 0,3%, `follow_farming` ở 0,1%. Thổi star — số star cao với fork và issue gần bằng không — làm tròn về không trong mẫu này, dù tính tự-chọn có thể đè nén nó: các tài khoản mua star khó có khả năng tự nộp mình để chấm điểm.

Với công cụ tin cậy xây trên dữ liệu GitHub, thành phần này ngụ ý hai chế độ thất bại khác nhau về chất, đòi hỏi các bộ phát hiện khác nhau và mức chịu lỗi khác nhau: trường hợp thường gặp, rẻ ("ở đây chẳng có gì") và trường hợp hiếm, đắt ("thứ ở đây đã được chế tạo").

### 3.5 Tuổi tài khoản như một tín hiệu không thể làm giả

![Điểm trung vị theo tuổi tài khoản](/blog/we-scored-19000-github-accounts/age-vs-score.svg "Hình 4: Điểm cuối trung vị theo tuổi tài khoản. Mối quan hệ là đơn điệu qua mọi nhóm tuổi.")

Điểm trung vị tăng đơn điệu theo tuổi tài khoản, từ **18 điểm với tài khoản dưới một năm lên 86 với tài khoản qua năm thứ mười**, không có sự sụt giảm ở giữa (*Hình 4*). Hiệu ứng sống sót góp phần vào mối quan hệ này — các tài khoản cũ xuất hiện trong mẫu là các tài khoản cũ vẫn còn được dùng — nhưng chiều của hiệu ứng tự nó đã có thông tin. Mọi thành phần của tính nhất quán dài hạn (số năm hoạt động, các repository lâu năm với star tích lũy hữu cơ, lịch sử đóng góp trải qua nhiều bản phát hành) chính xác là thứ mà giả tạo không thể nén lại: star và follower có thể kiếm được trong vài giờ, trong khi một tài khoản từ 2015 với chín năm hoạt động không thể được đúc ra vào năm 2026. Sự bất đối xứng này biện minh cho trọng số mà bộ tiêu chí dành cho độ trưởng thành tài khoản và độ dài hoạt động, và nhất quán với quan sát của chúng tôi rằng các tài khoản lũ lụt bị gắn cờ tụ lại ở nhóm tài khoản trẻ.

Như một quan sát phụ, thành phần ngôn ngữ chính của các tài khoản điểm cao (điểm cuối ≥ 60) theo đúng các xu hướng hệ sinh thái quen thuộc: **TypeScript (520), Python (460), và JavaScript (395)** dẫn đầu, với Rust (225) trên Go (189), C (184), và Java (159) (*Hình 5*).

![Ngôn ngữ của nhóm điểm cao](/blog/we-scored-19000-github-accounts/languages.svg "Hình 5: Ngôn ngữ chính trong các tài khoản đạt từ 60 điểm trở lên.")

## 4. Thảo luận

Ba nguyên tắc thiết kế cho công cụ về tính chính trực của đóng góp rút ra từ các kết quả.

**Phát hiện mẫu hình, không phải sự kiện.** Sự tách biệt lưỡng cực ở Mục 3.2 và khoảng cách 58%-so-với-0,4% ở Mục 3.3 chỉ ra rằng các đóng góp riêng lẻ hầu như không mang tín hiệu giả tạo, trong khi các tổng hợp cấp tài khoản tách biệt gọn gàng. Heuristic trên sự kiện đơn lẻ tối đa hóa dương tính giả nhắm đúng vào những người đóng góp — người mới và người giúp đỡ khối lượng thấp — mà các dự án mã nguồn mở cần giữ lại nhất.

**Phân biệt vắng mặt với thao túng.** Phần lớn các tài khoản trượt kiểm tra tính chính trực là trống rỗng, không phải đối nghịch (Mục 3.4). Đánh đồng hai thứ này thổi phồng tỷ lệ gian lận bề ngoài và phân bổ sai công sức review.

**Đặt trọng số vào thời gian.** Tính nhất quán theo chiều dọc là tín hiệu duy nhất được khảo sát mà chi phí đạt được không thể giảm bằng tiền (Mục 3.5), khiến nó trở thành mỏ neo tự nhiên cho bất kỳ điểm tin cậy nào.

Được dẫn dắt bởi các nguyên tắc này, chúng tôi đang xây một GitHub App hỗ trợ maintainer phân loại pull request spam, kết hợp các đặc trưng cấp PR (kích thước diff, độ tương tự khuôn mẫu) với lịch sử cấp tác giả. Với rủi ro dương tính giả được ghi nhận ở Mục 3.3, công cụ sẽ không tự động đóng pull request; nó trưng ra bằng chứng để con người quyết định. Chúng tôi mời các maintainer của những repository bị ảnh hưởng chia sẻ ví dụ về spam họ nhận được.

## 5. Hạn chế

- **Mẫu tự-chọn.** Người dùng website cộng với thành viên các tổ chức mã nguồn mở đang hoạt động nghiêng về phía chân thật và tích cực. Tỷ lệ giả tạo trên toàn GitHub nhiều khả năng cao hơn những gì báo cáo ở đây; các phần trăm của chúng tôi là cận dưới trong một quần thể đã lọc.
- **Quy mô.** 18.947 tài khoản được chấm, 3.444 có chỉ số sâu. Hình dạng phân phối ổn định qua các lần chạy lại, nhưng mẫu không đại diện cho GitHub nói chung.
- **Chỉ báo cáo tổng hợp.** Mọi mẫu hình được báo cáo ở dạng tổng hợp; không tài khoản cá nhân nào bị nêu danh. Các ngưỡng cờ được công bố để maintainer có thể áp dụng chúng cùng ngữ cảnh.
- **Phiên bản engine.** Mức phổ biến của cờ đỏ được tính lại bằng bộ chấm điểm hiện tại trên snapshot thô mới nhất của mỗi tài khoản; điểm spam được lưu phản ánh phiên bản engine tại thời điểm quét. Cả hai đều có trong [dữ liệu tổng hợp đã công bố](/blog/we-scored-19000-github-accounts/data.json).

## 6. Khả năng tái lập

Toàn bộ logic chấm điểm là tất định và mã nguồn mở (AGPL) tại [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind). Đúng engine đó được phân phối qua `npm install ghfind` và `pip install ghfind`, và có thể chạy hoặc với API công khai ([đặc tả OpenAPI](https://ghfind.com/openapi.json)) hoặc hoàn toàn cục bộ với GitHub token do người dùng cung cấp. Các thống kê tổng hợp đứng sau mọi hình vẽ trong bài viết này có tại [data.json](/blog/we-scored-19000-github-accounts/data.json).

*Có thể chấm điểm các tài khoản cá nhân tại [ghfind.com](https://ghfind.com).*
