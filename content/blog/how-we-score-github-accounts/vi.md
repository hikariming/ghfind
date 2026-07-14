---
title: "Chúng tôi chấm điểm một tài khoản GitHub như thế nào, nói bằng ngôn ngữ thường"
description: "Một bài giải thích không thuật ngữ về engine mã nguồn mở đứng sau ghfind: sáu thứ nó đo lường, vì sao pull request được merge đáng giá hơn star rất nhiều, các mẫu hành vi bot bị trừ điểm, và cách bạn tự chạy toàn bộ bộ chấm điểm."
date: "2026-07-13"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Tóm gọn trong một câu:** điểm số trả lời đúng một câu hỏi thực tế — *tài khoản GitHub này là một lập trình viên thật, có giá trị, hay là thứ được thổi phồng để trông giống như vậy?* — và nó trả lời theo cùng một cách mọi lúc, chỉ dùng dữ liệu công khai, với toàn bộ quy tắc được công bố công khai. Bài viết này giải thích, không dùng thuật ngữ, chính xác con số đó được xây dựng ra sao.

## Vì sao lại cần một điểm số

Ngày càng nhiều quyết định dựa vào một cái liếc nhìn GitHub của ai đó. Một nhà tuyển dụng lướt qua profile trước cuộc gọi. Một maintainer quyết định xem pull request của một người lạ có đáng review không. Một trang danh bạ xếp hạng tài khoản theo độ "hoành tráng" bề ngoài. Mỗi cách dùng đó đều tạo ra lý do để *làm giả* các tín hiệu — và làm giả những tín hiệu rẻ tiền thì rất dễ. Star có thể mua. Follower có thể trao đổi. Bạn có thể mở một trăm pull request một dòng trong một buổi chiều và tự xưng là "người đóng góp mã nguồn mở."

Vì vậy một điểm số hữu ích không thể chỉ cộng dồn những con số to đẹp. Nó phải dựa vào những thứ thật sự khó làm giả, và phớt lờ những thứ không khó. Chính ý tưởng duy nhất đó dẫn dắt mọi lựa chọn thiết kế bên dưới.

## Nguyên tắc duy nhất: đặt trọng số vào thứ khó làm giả

Chia mọi tín hiệu GitHub thành hai nhóm.

- **Rẻ để làm giả:** star, follower. Vài đô la hoặc một vòng follow-đổi-follow là có ngay.
- **Đắt để làm giả:** pull request được merge vào các dự án thật do người *khác* maintain, nhiều năm hoạt động đều đặn, code mà một maintainer bận rộn thật sự đã chấp nhận.

Engine đặt trọng số nặng cho nhóm thứ hai và nhẹ cho nhóm thứ nhất. Star và follower vẫn được tính — một dự án thật sự được ưa chuộng *nên* giúp ích cho bạn — nhưng chúng bị giới hạn trần đủ thấp để việc mua chúng gần như không nhích được kim. Trong khi đó, đưa được code thật vào một repo nổi tiếng — việc đòi hỏi thuyết phục một con người chẳng có lý do gì để giúp bạn — đáng giá nhiều điểm nhất trên bảng.

Toàn bộ triết lý là vậy. Phần còn lại chỉ là cách nó được phân bổ qua sáu hạng mục.

## Sáu thứ nó đo lường

Điểm số chạy từ 0 đến 100, chia cho sáu chiều đo. Đây là từng chiều nói bằng ngôn ngữ thường, kèm số điểm tối đa.

| Chiều đo | Tối đa | Câu hỏi thật sự nó đặt ra |
|---|---|---|
| **Chất lượng đóng góp** | 27 | Bạn có pull request thật được merge vào dự án thật không, và maintainer có chấp nhận chúng không? |
| **Tác động lên hệ sinh thái** | 20 | Code của bạn đã vào được những repository thật sự nổi tiếng — mà bạn không sở hữu — chưa? |
| **Chất lượng dự án gốc** | 18 | Bạn đã xây được thứ gì đó người ta thật sự dùng chưa (đo bằng star, nhưng có trần)? |
| **Tính xác thực của hoạt động** | 17 | Bạn hoạt động đều đặn theo thời gian, với nhiều dạng khác nhau — hay chỉ bùng lên một đợt rồi im lặng? |
| **Độ trưởng thành của tài khoản** | 10 | Tài khoản này đã tồn tại và duy trì hoạt động bao lâu? |
| **Ảnh hưởng cộng đồng** | 8 | Bạn có lượng người theo dõi thật, với tỷ lệ lành mạnh không? |

![100 điểm được phân bổ thế nào, theo chiều đo](/blog/how-we-score-github-accounts/weight-breakdown.svg "Sáu chiều đo và số điểm tối đa của chúng. Cam = tín hiệu khó làm giả; xám = tín hiệu mua được.")

Để ý hai phần lớn nhất — chất lượng đóng góp (27) và tác động hệ sinh thái (20) — chính xác là những phần khó làm giả. Star (18) và follower (8), những thứ mua được, cộng lại còn ít giá trị hơn riêng pull request được merge. Thứ tự đó chính là điểm mấu chốt.

### Tín hiệu quan trọng nhất: code của ai, trong repo của ai

Con số quan trọng nhất là **tác động hệ sinh thái** (20 điểm), và đáng để giải thích vì sao, bởi đây là phần khéo léo nhất.

Nó đếm các pull request thực chất — nhiều hơn năm dòng, không phải sửa lỗi chính tả — được merge vào **các repository nổi tiếng mà bạn không sở hữu**. Hãy hình dung một lập trình viên mà công việc thật của họ nằm bên trong codebase của một dự án nổi tiếng thay vì trong các repo nhiều star của chính họ. Bạn không thể làm giả điều này. Merge được một thay đổi thật vào một dự án 50.000 star nghĩa là một maintainer chẳng có động cơ gì giúp bạn đã nhìn vào code của bạn và nói đồng ý. Đó là thứ gần nhất với một chứng chỉ được bình duyệt mà GitHub có.

Có một ngoại lệ có chủ đích. Nếu repo nổi tiếng đó là của *chính bạn* — nhưng thật sự nổi tiếng, từ 1.000 star trở lên — thì vẫn được tính, vì nó ghi nhận kiểu người sáng tạo dành thời gian xây dự án nổi tiếng của riêng mình thay vì đóng góp cho dự án của người khác. Thứ **không** được tính là pull request vào các repo tí hon của chính bạn. Mở PR vào một dự án bạn tạo hôm qua mà chẳng ai star là chiêu kinh điển để thổi phồng số lượng đóng góp, nên chúng bị loại ở đây (và bị phạt ở chỗ khác).

## Vì sao những con số khổng lồ không chiếm hết

Một điểm số ngây thơ sẽ để một repo viral, hoặc một tài khoản có 100.000 follower, thống trị tất cả. Điểm số này thì không, và lý do là một lựa chọn thiết kế duy nhất: mọi con số dạng "bao nhiêu" đều được đưa qua một **đường cong lợi ích giảm dần** trước khi trở thành điểm.

![Đường cong lợi ích giảm dần: điểm nhận được so với số star](/blog/how-we-score-github-accounts/diminishing-returns.svg "Điểm tăng nhanh đến vài nghìn star, rồi phẳng dần — nên một mega-repo hay star mua không thể thống trị.")

Nói đơn giản: đi từ 0 lên 1.000 star mang về cho bạn rất nhiều điểm. Đi từ 50.000 lên 51.000 gần như chẳng thêm gì — bạn đã ở gần đỉnh rồi. Đường cong thưởng cho việc vượt qua một ngưỡng có ý nghĩa mà không để một nhúm con số khổng lồ lấn át mọi thứ khác. Một lập trình viên vững vàng với vài nghìn star và lịch sử đều đặn không bị chôn vùi dưới một repository viral duy nhất của ai đó. Nó cũng có nghĩa là mua star có giá trị giảm rất nhanh: những star mua đầu tiên chẳng giúp mấy, và mua để leo lên đường cong nhanh chóng trở nên đắt đỏ mà gần như chẳng thu về gì.

## Cờ đỏ: bắt đồ giả

Bên trên sáu chiều đo tích cực, engine trừ điểm cho các mẫu gian lận và lười biếng cụ thể, đã được biết rõ. Đây là dấu vân tay của bot, spam, và tài khoản nuôi. Vài mẫu chính, nói bằng ngôn ngữ thường:

- **Lũ lụt PR theo khuôn mẫu** — hàng chục pull request gần như y hệt nhau, tự động sinh ra, thường nhắm vào cùng một repo. Đây là dấu hiệu mạnh nhất của một lịch sử đóng góp được nuôi.
- **Cày PR vụn vặt** — một đống pull request một dòng kiểu "fix typo" độn số lượng đóng góp mà chẳng có việc thật nào.
- **Cày PR tự thân** — mở và merge pull request của chính mình vào các repo không star của chính mình để thổi phồng con số. Merge code của chính mình chẳng chứng minh điều gì.
- **Cày follow** — follow hàng nghìn tài khoản để câu follow lại, để lại tỷ lệ follower/following lệch hẳn.
- **Repo hàng loạt trên tài khoản mới tinh** — một tài khoản tạo tháng trước với năm mươi repository gần như chắc chắn không phải lập trình viên thật.
- **Profile ma** — không bio, gần như không follower, không star, gần như không có việc gì được merge. Không xấu xa, chỉ là trống rỗng.
- **Nghi ngờ thổi star** — một repo có nhiều star nhưng gần như không có fork hay issue, đó chính là hình dạng của star mua.

Các mức phạt cộng dồn, đến một giới hạn, nên một tài khoản dính vài mẫu trong số này sẽ rơi xuống gần đáy bất kể các con số thô của nó trông đẹp thế nào. Điều then chốt: các mẫu này tồn tại ở cấp độ *lịch sử* của tài khoản, không phải ở một hành động đơn lẻ nào — một PR một dòng đơn độc là hoàn toàn bình thường; một trăm cái nhắm vào một repo thì không.

## Con số cuối cùng nghĩa là gì

Cộng sáu chiều đo, trừ đi các cờ đỏ, và bạn rơi vào một trong bốn hạng:

| Điểm | Hạng | Ý nghĩa |
|---|---|---|
| 90–100 | **夯 (Cứng cựa)** | Lập trình viên hàng đầu — giá trị cao, độ tin cậy cao. |
| 70–89 | **人上人 (Nổi bật)** | Người đóng góp chất lượng — đáng tin cậy. |
| 40–69 | **NPC** | Tài khoản bình thường — không có gì nổi bật hoặc tín hiệu không rõ ràng. |
| 0–39 | **拉完了 (Hết cứu)** | Giá trị thấp — nhiều khả năng không hoạt động, trống rỗng, hoặc được nuôi. |

Tên các hạng cố ý hơi đùa cợt — thứ này khởi đầu là một công cụ "roast" — nhưng các khoảng điểm đứng sau chúng là cùng một phép toán tất định cho tất cả mọi người.

## Một ghi chú thẳng thắn về những gì điểm số *không* phải

- **Nó chỉ thấy hoạt động công khai.** Ai đó làm việc xuất sắc trong repo riêng của công ty có thể trông mỏng ở đây. Điểm thấp là một nhận định về dấu chân *công khai*, không phải phán quyết về con người.
- **Nó là điểm khởi đầu, không phải quan tòa.** Con số này nhằm giúp một con người sắp xếp ưu tiên — PR của người lạ nào nên xem trước, profile nào đáng đọc kỹ hơn — chứ không phải để tự động từ chối ai. Bằng chứng đứng sau điểm số quan trọng hơn điểm số.
- **Hành vi gần đây được tính nhiều hơn lịch sử xa xưa.** Tín hiệu tác động hệ sinh thái nhìn vào các pull request gần đây, nên ai đó có các đóng góp lớn đều từ nhiều năm trước sẽ đạt điểm thấp hơn những gì résumé của họ gợi ý. Đó là cố ý: nó đo những gì bạn đang làm *bây giờ*.

## Nó là mã nguồn mở — bạn tự chạy được

Không có gì ở đây là hộp đen, và đó chính là điểm mấu chốt. Không có model nào trong vòng lặp, không có trọng số ẩn, không có kiểu "cứ tin chúng tôi." Cùng một đầu vào luôn cho ra cùng một điểm, và mọi quy tắc được mô tả ở trên — mọi trọng số, mọi ngưỡng, mọi điều kiện kích hoạt cờ đỏ — đều được công bố dưới giấy phép AGPL.

- **Đọc code:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind)
- **Cài engine:** `npm install ghfind` hoặc `pip install ghfind`
- **Chạy cục bộ** với GitHub token của riêng bạn — không gì rời khỏi máy bạn — hoặc gọi API công khai ([OpenAPI spec](https://ghfind.com/openapi.json)).
- **Chấm điểm một tài khoản** ngay trong trình duyệt tại [ghfind.com](https://ghfind.com).

Nếu bạn không đồng ý với một trọng số hay một ngưỡng nào đó, bạn có thể đọc chính xác nó là gì, thay đổi nó, và xem hiệu ứng. Một điểm tin cậy mà người ta không thể soi vào thì chẳng đáng giá bao nhiêu — nên chúng tôi làm ra một điểm số mà bạn soi được.
