# PRD delta — Worker tự quyết nhiều hơn, mức phân loại theo hệ quả

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260924-worker-autonomy` |
| PRD gốc | [paseo-bm-prd.md](./paseo-bm-prd.md) (Accepted). **Không sửa tại chỗ.** Delta này thay các ý được nêu dưới đây của REQ-022, REQ-024, REQ-026, REQ-036, REQ-037 và REQ-045 |
| Status | **Accepted** — 2026-09-24, chủ repo |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |
| Thiết kế | [design-delta-20260924-worker-autonomy](../design/paseo-bm-delta-20260924-worker-autonomy.md) |
| Yêu cầu của chủ repo | "Tôi muốn trao quyền quyết nhiều hơn cho worker để hạn chế hỏi đáp vô nghĩa"; "để Model AI tự hiểu thế nào là large, medium, small"; "Hãy thực hiện thay đổi như tôi mong muốn" (2026-09-24), sau khi đồng ý các chỉnh sửa ở [thiết kế §1](../design/paseo-bm-delta-20260924-worker-autonomy.md) |

## 1. Vì sao

Đo trên trace thật từ 2026-09-18 tới 2026-09-24:

- Người dùng chọn đúng phương án Worker khuyến nghị ở **78%** trong 285 câu hỏi. Khoảng **31%** là câu về chính quy trình (review, cổng, xác nhận, trạng thái tài liệu, bead), và ở nhóm này tỉ lệ chọn khuyến nghị là 82%.
- Một request Large hỏi trung bình **12–17 câu** và kéo dài 10–20 giờ. Thời gian chờ người trả lời gấp 3–5 lần thời gian Worker thực sự làm.
- Có **209** báo cáo mang mức `Large`, gấp khoảng 3 lần `Medium`. Worker tự ghi rằng nó lên Large *"đúng rule 1"* cho cả những thay đổi nội bộ.
- Worker chiếm khoảng 90% token ngữ cảnh. Lượt bị đánh thức khi Reviewer trả kết quả chiếm 38–53% phần đó.

Chi tiết và lệnh tái lập: [thiết kế §2](../design/paseo-bm-delta-20260924-worker-autonomy.md).

## 2. Các ý bị thay

### REQ-036 — Phân loại quy mô

Thay (a)–(d). (e) và (f) giữ nguyên.

- **(a)** Ngay khi nhận việc, Worker xếp yêu cầu vào một trong ba mức bằng **phán đoán của chính nó về hệ quả**, và nói mức đó cho người dùng kèm lý do trong một câu. **Lớn** = khó hoàn tác, hoặc chạm tới người ngoài repo: hành vi đã phát hành, dữ liệu thật, xác thực hay phân quyền, hợp đồng của team khác. **Nhỏ** = một thay đổi rõ, không cần tài liệu. **Vừa** = còn lại. Không còn danh sách điều kiện "khớp đầu tiên thắng", không còn ví dụ.
- **(b)** Mức Nhỏ không tạo tài liệu mới.
- **(c)** Ở mọi mức, tài liệu chỉ được viết hay sửa **khi thay đổi đụng tới thứ người khác đang dựa vào** (quyết định đã ghi, hợp đồng, schema, hành vi đã phát hành). Không viết vì nhãn mức.
- **(d)** Không còn bước bắt buộc hỏi người dùng xác nhận trước khi implement ở mức Lớn. Việc đi ra ngoài hoặc không hoàn tác được vẫn phải hỏi trước, theo REQ-026(a).

### REQ-022(f) và REQ-026(d) — Khi nào hỏi

Thay REQ-022(f) và REQ-026(d) bằng:

- Worker **tự quyết mọi thứ hoàn tác được và nằm trong phạm vi yêu cầu**, rồi ghi mỗi quyết định thành một dòng `Decided: …` trong báo cáo `finished` để người dùng đảo lại được.
- Worker **chỉ hỏi** khi:
  1. muốn mở rộng hoặc thu hẹp phạm vi, hoặc thêm yêu cầu ngoài lời người dùng;
  2. trước việc REQ-026(a) bắt phải hỏi, hoặc trước khi sửa tài liệu đã đóng băng, đi lệch khỏi tài liệu đã duyệt, xoá hay gộp bead có sẵn;
  3. cần sự thật hay lựa chọn chỉ người dùng có: thứ họ phải tự nhập hay tự làm, môi trường, đánh đổi bảo mật, đổi hành vi mà người dùng hiện tại đang dựa vào;
  4. khi bị kẹt: cùng một lỗi ba lần sau ba cách sửa khác nhau.
- Các câu hỏi thấy trước được **gom thành một vòng, ngay sau khi phân mức**. Vòng sau chỉ dành cho điều mà chính công việc làm lộ ra.
- Không còn các "thời điểm hỏi bắt buộc".

### REQ-024 và REQ-037 — Review

- **REQ-024(a)(b)** được thay. Review mặc định là **một lô cho phần implement**. Lô review tài liệu cộng beads trước khi implement chỉ bắt buộc ở mức **Lớn**. Ở các mức khác, lô này chỉ làm khi người dùng yêu cầu.
- **REQ-037(a)(b)** giữ nguyên: mỗi lô một lượt review, cộng một lượt review lại nếu còn mục chặn.
- **REQ-037(e)** được thay. Mức Nhỏ cũng được một lượt review lại như mọi mức; không còn "đúng 1 lượt duy nhất" rồi phải hỏi người dùng.
- **REQ-037(d)** được thay. Ngân sách số lần gọi review mà plugin đếm là **Nhỏ 2, Vừa 2, Lớn 4**.
- **REQ-037(g)** được thay; đây là ghi bù quyết định đã ship ở [design-delta-20260924-qa-ledger §6](../design/paseo-bm-delta-20260924-qa-ledger.md). Khi vượt ngân sách, plugin báo Manager một lần; Manager chỉ báo người dùng một dòng và **không hỏi**. Người hỏi là Worker, trước khi gọi một lượt review ngoài ngân sách. Một lần người dùng đồng ý có hiệu lực đúng phạm vi họ nói.

### REQ-045(d) — Bảng bước quy trình trên Dashboard

- "Không làm (hợp lệ theo mức)" nay áp dụng cho PRD, Technical Design, ADR, Implementation Plan, `reviewing-plan` và polish beads **ở mọi mức**, vì tài liệu không còn gắn với mức (REQ-036c).
- Các bước khác không đổi.

### REQ-035(a) — Ai kiểm skill

Thay (a). Plugin kiểm các skill bắt buộc theo đúng provider mà Worker chạy, rồi đưa kết quả vào Runtime facts của Manager ([design-delta-20260924-instruction-quality §3](../design/paseo-bm-delta-20260924-instruction-quality.md)). Manager không tự đọc thư mục skill nữa. (b) và (c) giữ nguyên: thiếu thì nhắc người dùng kèm lệnh, rồi vẫn giao việc.

### Quyết định P2 của chủ repo (2026-09-24)

Nguyên văn: "1. Việc tra cứu thì không được phép có bead và reviewer chứ không phải là bắt buộc có, ý nghĩa ngược hẳn 2. Đồng ý có thêm decided 3. Manager hoàn toàn được phép, như vậy mới là giá trị quan trọng của Manager - nắm được tình trạng công việc".

- **REQ-022 và REQ-024 — yêu cầu chỉ hỏi thông tin.** Một yêu cầu chỉ hỏi thông tin (câu hỏi, tra cứu, điều tra, chẩn đoán) không thay đổi gì. Vì vậy nó **không được** tạo bead, **không được** gọi Reviewer, và không viết tài liệu trừ khi người dùng yêu cầu. Câu trả lời kèm nguồn nằm trong chat và báo cáo `finished`. Điều cần sửa mà nó phát hiện ra chỉ là gợi ý; người dùng quyết có thành việc mới hay không.
- **REQ-034 — trường `decided`.** `BM-REPORT` có thêm trường `decided` (đặt trước `blockers`), liệt kê các lựa chọn Worker tự đưa ra, dạng `<lựa chọn> — <lý do>`, ngăn cách bằng `; `, hoặc `none`. Trường này là tuỳ chọn với bộ kiểm định dạng, để báo cáo của Worker tạo trước thay đổi vẫn hợp lệ. Nó thay quy ước `Decided: …` nằm trong `blockers`.
- **REQ-025 — Manager nắm tình trạng công việc.** Manager được đọc trạng thái và hoạt động gần đây của Worker và các Reviewer của nó (`get_agent_status`, `get_agent_activity`) bất cứ khi nào cần để biết công việc đang ở đâu. Manager vẫn không nhắn Worker để hỏi tiến độ, và vẫn không bịa điều nó không thấy.

### Quyết định sau lần chạy thật đầu tiên (2026-09-24, 05:45Z)

Chủ repo: "tôi chỉ bảo sửa lại comment url và commit rồi push vào Dev trên paseo, mà hệ thống vẫn ngồi tạo beads và thậm chí đánh giá việc đó là large". Worker `a9018a07` (project-b, `req-20260924T054525Z`) chạy chỉ dẫn mới và xếp Large, lý do *"the request ends in a push to the shared branch dev"*. Nó làm đúng chữ của REQ-036(a) bản đầu. Chỗ sai nằm ở định nghĩa.

- **REQ-036(a), sửa lại.** Mức đo hệ quả của **thay đổi Worker tự làm**. Một hành động người dùng gọi đích danh (commit, push, publish, deploy) là quyết định của họ, đã được chính yêu cầu cho phép, và **không bao giờ làm tăng mức**. Lớn = thay đổi của Worker khó hoàn tác, hoặc thay đổi thứ người ngoài repo nhận được.
- **REQ-026(a).** Một yêu cầu gọi đích danh một việc cần hỏi trước (commit, push…) chính là lời đồng ý cho đúng việc đó.
- **REQ-022 và REQ-024 — thao tác thuần.** Chủ repo chọn "Chỉ thao tác thuần bỏ cả hai". Yêu cầu chỉ gồm thao tác (commit, push, đồng bộ hay rebase nhánh, chạy lệnh hay script), không có thay đổi nội dung của Worker, thì **không** tạo bead và **không** gọi Reviewer; bằng chứng là kết quả của chính thao tác. Một chỉnh sửa nằm trong cùng yêu cầu vẫn xử lý như mọi thay đổi: Small thì một bead ngắn và một lượt review.

### Nguyên tắc chung thay cho liệt kê tình huống (2026-09-24)

Chủ repo: "Tôi không muốn làm theo kiểu cứ phải chỉ định case tình huống là git, commit hay các tình huống khác … vì đây là Agent dùng cho rất nhiều loại việc, cần có hướng dẫn phổ quát ngắn gọn". Hai quy tắc "yêu cầu chỉ hỏi thông tin" và "thao tác thuần" ở trên được gộp thành **một nguyên tắc**, không nêu tên tình huống nào:

- **Quy trình đi theo thứ Worker thiết kế.** Bead, tài liệu và review dùng để theo dõi và kiểm một thay đổi do Worker thiết kế. Yêu cầu không cần Worker thiết kế gì (chỉ cần một câu trả lời, hoặc đúng điều chính nó đã nói rõ) thì không có bead, tài liệu hay review; Worker làm và cho thấy kết quả kèm bằng chứng. Phần nào cần Worker thiết kế thì xử lý như mọi thay đổi.
- **Mức đo rủi ro của thứ Worker thiết kế.** Không đo độ lớn của diff, cũng không đo điều người dùng đã nói rõ, vì đó là quyết định của họ (và là lời đồng ý theo REQ-026a). Lớn = khó hoàn tác, hoặc thay đổi thứ người khác đang dựa vào.

## 3. Ngoài phạm vi

- Năm giới hạn cứng của Worker (REQ-026a, b; luật không làm cho check "xanh giả"; không đọc bí mật; phạm vi là yêu cầu) giữ nguyên.
- Mẫu `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW` giữ nguyên. Riêng `blockers` của báo cáo `finished` thêm quy ước `Decided: …`.
- Vai trò Manager và Reviewer giữ nguyên, ngoài những câu nói về mức và ngân sách.

## 4. Tiêu chí nghiệm thu

- **N1.** `worker.md` không còn luật "khớp đầu tiên thắng", ví dụ phân mức, bảng skill theo mức, các thời điểm hỏi bắt buộc, hay bước xác nhận trước khi implement của Lớn. Nó có định nghĩa mức theo hệ quả (REQ-036a), luật tự quyết cộng bốn lý do được hỏi (§2), và `Decided: …`.
- **N2.** Năm giới hạn cứng còn nguyên, và các test ghim chúng vẫn xanh mà không bị nới.
- **N3.** `REVIEW_BUDGET` của plugin là Nhỏ 2, Vừa 2, Lớn 4. `BM-BUDGET`, `BM-HANDOVER` và Dashboard dùng số mới.
- **N4.** `manager.md` đoán mức bằng cùng định nghĩa. Nó không còn nói Worker Lớn "đang chờ xác nhận", không còn bắt lỗi thiếu skill theo mức, và nói với người dùng số quyết định Worker đã tự đưa ra.
- **N5.** Đo trước/sau: mốc hiện tại ghi ở thiết kế §2. Số đo "sau" lấy trên các request chạy bằng agent tạo sau khi cài bản mới.
