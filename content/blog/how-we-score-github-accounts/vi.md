---
title: "Chúng tôi chấm điểm một tài khoản GitHub như thế nào, nói bằng ngôn ngữ thường"
description: "Một bài giải thích không thuật ngữ về devscore, engine mã nguồn mở đứng sau ghfind: vì sao nó cân đo công việc thật thay vì star và follower, cách nó xác định một dự án đáng giá bao nhiêu và bao nhiêu phần trong đó là của bạn, các mẫu cày ảo bị áp trần, và ý nghĩa của sáu chiều trên một profile."
date: "2026-07-13"
updated: "2026-09-28"
tags: ["scoring", "github", "open-source", "trust", "explainer"]
---

**Tóm gọn trong một câu:** điểm số trả lời đúng một câu hỏi thực tế — *lập trình viên này đã làm được bao nhiêu công việc thật, có giá trị, ở nơi công khai?* — và nó trả lời theo cùng một cách mọi lúc, chỉ dùng dữ liệu công khai, với toàn bộ quy tắc được công bố công khai. Bài viết này giải thích, không dùng thuật ngữ, con số đó được xây dựng ra sao.

## Vì sao lại cần một điểm số

Ngày càng nhiều quyết định dựa vào một cái liếc nhìn GitHub của ai đó. Một nhà tuyển dụng lướt qua profile trước cuộc gọi. Một maintainer quyết định xem pull request của một người lạ có đáng review không. Một trang danh bạ xếp hạng tài khoản theo độ "hoành tráng" bề ngoài. Mỗi cách dùng đó đều tạo ra lý do để *làm giả* các tín hiệu — và những tín hiệu phổ biến lại dễ làm giả nhất. Star có thể mua. Follower có thể trao đổi. Bạn có thể mở một trăm pull request một dòng trong một buổi chiều và tự xưng là "người đóng góp mã nguồn mở."

Vì vậy một điểm số hữu ích không thể cộng dồn những con số to đẹp. Nó phải đo chính công việc, và phớt lờ những con số có thể mua được. Chính ý tưởng duy nhất đó dẫn dắt mọi lựa chọn thiết kế bên dưới.

## Nguyên tắc duy nhất: cân đo công việc, không phải tiếng vỗ tay

Engine đứng sau điểm số có tên là **devscore**. Quy tắc của nó rất ngắn: *chấm những gì một lập trình viên thực sự xây dựng, có trọng số theo mức độ quan trọng của nó và bao nhiêu phần trong đó là của họ.*

- **Star và follower không bao giờ được tính.** Không phải tính một chút, không phải có trần — mà là bằng không. Chúng đo sự chú ý, và sự chú ý thì mua rẻ.
- **Số lượng pull request cũng không được tính.** Engine đo các commit bạn viết và những gì chúng thay đổi, nên một trăm PR một dòng vẫn chỉ là một trăm thay đổi một dòng.
- **Thứ được tính là code đã vào được những dự án người ta thật sự dùng.** Dự án của chính bạn được tính khi người khác dùng chúng; công việc của bạn trong dự án của người khác được tính khi một maintainer độc lập đã chấp nhận nó.

## Một dự án đáng giá bao nhiêu

Với mỗi repository, trước tiên devscore hỏi dự án đó quan trọng đến mức nào. Nó không bao giờ nhìn vào star. Nó nhìn vào những tín hiệu khó làm giả vì chúng đòi hỏi người khác phải *làm* điều gì đó:

- **những người đóng góp khác** đã viết code trong đó,
- **các dự án phụ thuộc ở hạ nguồn** — những package phụ thuộc vào nó,
- **người mở issue bên ngoài** — những người dùng nó đủ nhiều để báo lỗi,
- **fork**, bị giảm trọng số vì đây là tín hiệu rẻ nhất để cày trong số này.

Mỗi bước tăng gấp mười lần về mức độ được sử dụng cộng thêm một lượng như nhau, nên một kernel với hàng nghìn người đóng góp đứng cao hơn hẳn một thư viện có hai mươi người, trong khi một dự án chỉ được tác giả và vài người bạn dùng thì nằm sát đáy. Một dự án không ai khác dùng chỉ giữ lại một phần nhỏ công việc làm trong đó — tự xây thứ gì đó cho mình thì hoàn toàn ổn, nhưng nó chưa phải là thứ người khác phụ thuộc vào.

Những dự án toàn star mà không có người dùng được đối xử đặc biệt. Một **dự án thổi phồng** — nhiều star nhưng gần như không có người đóng góp, người mở issue hay dự án phụ thuộc, hoặc một đợt tăng vọt nhờ quảng bá rồi im bặt — không nhận được chút điểm dự án nào.

## Bao nhiêu phần trong đó là của bạn

Tiếp theo, devscore hỏi bao nhiêu phần công việc của dự án đó là của bạn. Nó kết hợp tỷ lệ commit của bạn với vị thế của bạn so với tác giả chính, nên một đồng dẫn dắt của một dự án lớn được tính là tác giả dù tỷ lệ khiêm tốn, còn một người đóng góp xa phía sau một tác giả chính áp đảo thì không. Hàng nghìn commit của chính bạn được tính là quyền tác giả bất kể dự án lớn nhỏ thế nào.

Sau đó nó đo chính công việc: bạn đã đưa vào bao nhiêu commit, chúng thay đổi những gì (code lõi được tính nhiều hơn tài liệu hay việc vặt; một thay đổi lớn được maintainer chấp nhận được tính nhiều hơn một thay đổi nhỏ xíu), và công việc kéo dài bao nhiêu tháng. Những lịch sử commit trông như do máy sinh ra — mọi commit cùng một giờ, mọi thay đổi cùng một hình dạng — bị giảm trọng số.

## Dự án của người khác: chỉ công việc được chấp nhận mới được tính

Công việc trong repository của người khác là thứ gần nhất với bình duyệt mà GitHub có — nhưng chỉ khi có ai đó độc lập thật sự review nó. Vì vậy devscore tính công việc bên ngoài **chỉ trong phạm vi một maintainer độc lập đã chấp nhận nó**:

- một PR được tác giả chính của dự án merge được tính đầy đủ;
- một PR được cho qua bởi người không hề viết dòng code nào trong dự án được tính một nửa;
- một PR bạn tự merge, hoặc được merge bởi một đối tác trao đổi — người mà bạn cũng merge PR cho họ — không được tính gì;
- hàng chục PR độc lập cỡ lớn được merge theo lô trong một chiến dịch thưởng bị giảm trọng số.

Review và merge code của người khác cũng là công việc thật. Một **maintainer** — được xác minh bằng chính hồ sơ của GitHub về vai trò của bạn trong repository đó, không bao giờ tự khai — được ghi nhận cho công việc đó, và các code review bạn thực hiện trong dự án của người khác cũng được tính.

## Thời gian: nhiều năm bền bỉ, không phải những đợt bùng nổ

Cuối cùng, devscore thưởng cho việc làm điều này trong nhiều năm. Nó đếm **số năm viết code bền bỉ**: mỗi năm dương lịch được tính một lần, tối đa mười hai tháng viết code, nên rải một năm ra sáu mươi repository nhỏ thì vẫn chỉ là một năm. Công việc cũ phai dần với chu kỳ bán rã ba năm (xuống đến một mức sàn, nên một sự nghiệp dài không bao giờ bị xóa sạch).

Tất cả những thứ này được kết hợp thành một đường cong mượt từ 0 đến 100, có chừa khoảng trống ở đỉnh để những người giỏi nhất tách ra thay vì cùng hòa ở 100. Vai trò mạnh nhất sẽ thắng: một người được đánh giá cả với tư cách lập trình viên lẫn maintainer, và cái nào tốt hơn sẽ được tính.

## Bắt đồ giả

Hầu hết hoạt động cày ảo chẳng cần đến điểm phạt, vì những tín hiệu nó tạo ra — star, follower, số lượng PR, tự merge — vốn đã không được điểm nào. Hai mẫu hành vi bị áp **trần** rõ ràng, áp dụng sau cùng:

- **PR chất lượng thấp hàng loạt.** Trong mười hai tháng tệ nhất, nhiều PR vào dự án của người khác bị từ chối hoặc rút lại — ít nhất bằng số PR được merge độc lập — đi kèm ít nhất hai trong số: tiêu đề theo template, bản gửi trùng lặp, những đợt dồn dập trong một tuần trên nhiều repository, hoặc PR khổng lồ hàng nghìn dòng.
- **Mẫu hành vi influencer.** Hàng trăm follower, vượt xa công việc kỹ thuật mà người khác đã chấp nhận, không có dự án nào đang bảo trì và không có dự án đáng kể nào của riêng mình.

Một điểm số bị áp trần sẽ bị ép vào khoảng 20–35, vẫn được sắp xếp theo công việc thực chất bên dưới. Điều then chốt: cả hai mức trần đều kích hoạt trên một *mẫu hành vi* xuyên suốt lịch sử — một PR bị từ chối đơn lẻ, hay một tài khoản nổi tiếng mà cũng làm ra code thật, là hoàn toàn bình thường.

## Sáu con số trên một profile

Tổng điểm là điểm của devscore. Để dễ đọc, mỗi profile còn hiển thị sáu **chiều hiển thị** được suy ra từ các hệ số của devscore. Chúng giải thích điểm số; chúng không được cộng lại để tạo ra điểm số.

| Chiều đo | Tối đa | Nó cho thấy gì |
|---|---|---|
| **Chất lượng đóng góp** | 27 | Công việc được chấp nhận độc lập trong dự án của người khác, cộng với các code review bạn thực hiện ở đó |
| **Tác động lên hệ sinh thái** | 20 | Trọng lượng công việc của bạn trên các repository, hoặc vai trò maintainer được xác minh — tùy cái nào cao hơn |
| **Chất lượng dự án gốc** | 18 | Dự án chủ lực của bạn: dự án kỹ thuật mạnh nhất mà bạn sở hữu hoặc dẫn dắt |
| **Tính xác thực của hoạt động** | 17 | Bao nhiêu phần công việc của bạn là gần đây; bị cắt mạnh khi một mức trần cày ảo được áp dụng |
| **Độ trưởng thành của tài khoản** | 10 | Số năm viết code bền bỉ |
| **Ảnh hưởng cộng đồng** | 8 | Các maintainer merge thay vì từ chối PR của bạn thường xuyên đến đâu, cộng với các review bạn thực hiện — không bao giờ là follower |

## Con số cuối cùng nghĩa là gì

| Điểm | Hạng | Ý nghĩa |
|---|---|---|
| 90–100 | **夯 (Cứng cựa)** | Huyền thoại — công việc đáng vào đại sảnh danh vọng. |
| 80–89 | **顶级 (Tinh hoa)** | Lập trình viên hàng đầu. |
| 70–79 | **人上人 (Nổi bật)** | Người đóng góp chất lượng — đáng tin cậy. |
| 40–69 | **NPC** | Tài khoản bình thường — không có gì nổi bật hoặc tín hiệu không rõ ràng. |
| 0–39 | **拉完了 (Hết cứu)** | Ít công việc công khai — hoặc một mẫu cày ảo bị áp trần. |

Tên các hạng cố ý hơi đùa cợt — thứ này khởi đầu là một công cụ "roast" — nhưng phép toán đứng sau chúng là như nhau với tất cả mọi người.

## Một ghi chú thẳng thắn về những gì điểm số *không* phải

- **Nó chỉ thấy hoạt động công khai.** Ai đó làm việc xuất sắc trong repo riêng của công ty có thể trông mỏng ở đây. Điểm thấp là một nhận định về dấu chân *công khai*, không phải phán quyết về con người. Mỗi điểm số đi kèm một mức độ tin cậy cho biết nó dựa trên bao nhiêu bằng chứng công khai.
- **Nó là điểm khởi đầu, không phải quan tòa.** Con số này nhằm giúp một con người sắp xếp ưu tiên — PR của người lạ nào nên xem trước, profile nào đáng đọc kỹ hơn — chứ không phải để tự động từ chối ai. Bằng chứng đứng sau điểm số quan trọng hơn điểm số.
- **Công việc cũ phai dần, một cách chậm rãi.** Những năm gần đây được tính nhiều hơn lịch sử xa xưa, nhưng một thành tích dài hơi không bao giờ bị xóa sạch.

## Nó là mã nguồn mở — bạn tự chạy được

Không có gì ở đây là hộp đen. Không có model nào trong vòng lặp và không có trọng số ẩn: cùng dữ liệu công khai luôn cho ra cùng một điểm, và mọi quy tắc được mô tả ở trên — mọi trọng số, mọi ngưỡng, mọi mức trần — đều được công bố dưới giấy phép AGPL.

- **Đọc code:** [github.com/hikariming/ghfind](https://github.com/hikariming/ghfind) (engine nằm trong `src/lib/devscore`)
- **Chạy cục bộ** với `npx @hikariming/ghfind score <user> --local` và GitHub token của riêng bạn — không gì rời khỏi máy bạn — hoặc gọi API công khai ([OpenAPI spec](https://ghfind.com/openapi.json)).
- **Chấm điểm một tài khoản** ngay trong trình duyệt tại [ghfind.com](https://ghfind.com).

Nếu bạn không đồng ý với một trọng số hay một ngưỡng nào đó, bạn có thể đọc chính xác nó là gì, thay đổi nó, và xem hiệu ứng. Một điểm tin cậy mà người ta không thể soi vào thì chẳng đáng giá bao nhiêu — nên chúng tôi làm ra một điểm số mà bạn soi được.
