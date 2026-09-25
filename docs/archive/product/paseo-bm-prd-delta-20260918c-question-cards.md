# Delta-change — Câu hỏi có cấu trúc của Worker và thẻ trả lời có lựa chọn

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260918c-question-cards` |
| Tài liệu gốc | [paseo-bm PRD](../../product/paseo-bm-prd.md) REQ-034 (báo cáo có cấu trúc), REQ-021 (Manager chuyển lời); [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-050 (`BM-REPORT` là hợp đồng đang được tiêu thụ) — **không sửa tại chỗ khi chưa duyệt** |
| Status | Merged — gộp vào [paseo-bm-prd.md](../../product/paseo-bm-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T021211Z` |
| Thiết kế | [design-delta-20260918c-question-cards](../design/paseo-bm-delta-20260918c-question-cards.md) |
| Plan | [plan-delta-20260918c-question-cards](../plans/paseo-bm-implementation-plan-delta-20260918c-question-cards.md) |

> **Đã được thay một phần:** REQ-059 (b)–(f) được sửa bởi [prd-delta-20260918d-card-replies](paseo-bm-prd-delta-20260918d-card-replies.md) (2026-09-18) — Manager không nhắc lại thẻ, câu trả lời đi qua ô Reply, thẻ câu hỏi trình bày lại.

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks: **hợp đồng đang được tiêu thụ** (khối `BM-REPORT` và cách Worker, Manager, bộ đọc của plugin hiểu nhau — REQ-050 của PRD Dashboard); **nhiều thành phần độc lập** (chỉ dẫn Worker, chỉ dẫn Manager, bộ đọc dùng chung, thẻ chat phía client)
- Required artifacts/gates: PRD delta này + `prd-ready` → design delta + `design-ready` → plan delta + `plan-ready-for-beads` → beads → `feature-done` (hồ sơ standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-18 — Beads Worker, cỡ **Large** Manager đoán và Worker xác nhận theo luật 1 (hợp đồng, nhiều thành phần)
- Supersedes: none

## 1. Owner nói gì

> Tôi thấy khi Worker phản hồi câu hỏi của Manager , lúc có nhiều Worker cần hỏi lại 1 lúc thì việc hiển thị cũng như cách thức trả lời nội dung rất vất vả.
> Có cách nào điều chỉnh lại phong cách trả lời, template cấu trúc mà Worker hỏi lại để Manager reply dễ hiểu hơn. Cách hiển thị cũng đưa vào Card và cho lựa chọn option thì thông minh hơn đảm bảo Manager trả lời lại chính xác cho câu hỏi cũng như trả lời đúng cho Worker đang hỏi
> Hãy đánh giá và thực hiện yêu cầu này

### 1.1 Quyết định của owner (2026-09-18, vòng hỏi đầu)

Owner trả lời "1.a 2.a 3.a 4.a 5.a" — chọn đúng đề xuất ở cả năm câu.

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q40 | Câu trả lời chọn trong thẻ đi tới đâu | **(a)** Thẳng tới Worker đang hỏi. Thẻ tìm Worker theo request của báo cáo nên không gửi nhầm được; tin đi dưới tên người dùng; Manager chỉ biết khi Worker gửi báo cáo kế tiếp. Thẻ không gửi khi Worker đang chạy, vì tin gửi vào sẽ thay mất lượt đang chạy |
| Q41 | Mẫu câu hỏi của Worker | **(a)** Một khối mới `BM-QUESTIONS` đặt ngay sau `BM-REPORT` trong cùng tin: mỗi câu một dòng, mỗi lựa chọn một dòng, lựa chọn đề xuất có đánh dấu; `blockers:` chỉ còn một dòng ngắn trỏ tới khối này |
| Q42 | Cách chọn trong thẻ | **(a)** Mỗi câu có các nút lựa chọn; lựa chọn đề xuất được đánh dấu nhưng không chọn sẵn; nút "dùng các đề xuất" điền nhanh; mỗi câu có "Khác" để gõ tự do; chỉ gửi được khi mọi câu đã có đáp án; tin gửi đi có dạng cố định `BM-ANSWERS` |
| Q43 | Manager nói gì khi nhiều Worker cùng hỏi | **(a)** Nhóm theo Worker, mỗi Worker một chữ cái, câu hỏi mang nhãn chữ cái + số; người dùng trả lời trong thẻ hoặc gõ `A1 a, B1 b` ở chat Manager; Manager chỉ chuyển cho mỗi Worker phần của nó dưới dạng `BM-ANSWERS`, và hỏi lại khi một câu trả lời không khớp đúng một câu hỏi. Luật "chỉ chuyển nguyên lời người dùng" của Manager được nới đúng chừng đó |
| Q44 | Thẻ câu hỏi xuất hiện ở đâu, và báo cáo kiểu cũ | **(a)** Chỉ trong chat của Manager, chỉ với báo cáo theo mẫu mới. Báo cáo kiểu cũ (của Worker tạo trước bản cập nhật) vẫn hiện như hôm nay, trả lời bằng chữ tự do |

### 1.2 Xác nhận trước khi implement (2026-09-18)

Owner trả lời "Q45.a Q46.a Q47.a Q48.a".

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q45 | Agent đang chạy giữ chỉ dẫn cũ | **(a)** Chấp nhận. Chỉ dẫn mới tới agent tạo sau khi plugin được nạp lại; muốn Manager nhóm theo Worker thì mở một Manager mới |
| Q46 | Ngưỡng dòng của `manager.md` | **(a)** Như thiết kế §4.6: viết gọn trước; vẫn vượt thì ngưỡng = số dòng đo được + 3, có chú thích; khối RULES không nâng |
| Q47 | Các điểm thêm ngoài lời owner | **(a)** Đồng ý tất cả: mã câu hỏi đếm tiếp trong request; Worker bỏ qua câu trả lời cho câu không còn mở; thẻ đọc lại trạng thái và không gửi khi Worker đang chạy, đang khởi tạo hay đã đóng; "đã gửi" chỉ giữ trong phiên app; nút `Clear` và dòng "Answers go to …"; ẩn hai câu gợi ý khi có câu hỏi; giới hạn của bộ đọc; Manager hỏi lại khi không khớp |
| Q48 | Bắt đầu implement | **(a)** Có: từng bead một theo thứ tự `.1`, `.4`, `.2`, `.3`, `.5`; không commit; review implementation ở batch `b3` |

### 1.3 Sau khi xong — ảnh chụp một thẻ khó trả lời (2026-09-18, batch `b4`)

Owner gửi ảnh thẻ `blocked` của Worker `req-20260918T011706Z`: dòng tóm tắt lặp lại cả đoạn `blockers:` dài, và hai câu gợi ý "Continue…/Stop here…". Ảnh là plugin **bản cũ** (chưa cài bản của request này), và Worker đó được tạo trước bản cập nhật nên báo cáo là **kiểu cũ**.

Owner trả lời "Q49. c, Q50. a, Q51. a", rồi nhắn thêm: "Bạn reload tôi xem lại thử, sau đó tôi sẽ điều chỉnh thay đổi".

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q49 | Thẻ của báo cáo kiểu cũ đổi thế nào | **(c)** Không đổi — giữ Q44. Worker mới (tạo sau khi nạp lại plugin) hỏi bằng `BM-QUESTIONS` và có thẻ đầy đủ nút |
| Q50 | Phần dễ đọc áp cho báo cáo nào | **(a)** Mọi báo cáo `blocked`: dòng tóm tắt không bao giờ quá 2 dòng, kể cả khi mở tin, nên toàn bộ `blockers` không bị lặp lại ở đó |
| Q51 | Ai cài bản mới lên daemon | **(a)** Worker không tự cài. Tin nhắn thêm của owner ("Bạn reload…") là lời cho phép **một lần** reload để owner xem, sau khi xong batch `b4` |

## 2. Bối cảnh — vì sao bây giờ

Owner chạy nhiều Worker song song (`/bm-worker-new`, delta 20260917f). Mỗi Worker hỏi bằng một báo cáo `blocked`, và hôm nay mọi câu hỏi nằm trên **một dòng** `blockers:`.

Đo trên kho vết của owner ngày 2026-09-18 (chỉ đọc):

- 42 báo cáo `blocked` có dòng `blockers:`;
- độ dài trung vị **458 ký tự**, dài nhất **2975**; 19 dòng dài hơn 500 ký tự;
- mỗi Worker tự viết theo một kiểu: `1. … (a) … (b) … Recommended: (a).`, `Q1 (…) A-recommended: … | B: …`, `answer e.g. "1A 2A"`.

Hệ quả:

- **Thẻ chat** (delta 20260916-chat-cards) chỉ hiện được "waiting on: <cả dòng>" và một ô nhập chữ tự do.
- **Manager** phải tự tách từng câu hỏi ra để hiện cho người dùng. Rồi khi người dùng trả lời "1a 2b" mà có hai Worker cùng chờ, Manager phải đoán câu trả lời nào của Worker nào.
- **Người dùng** không có chỗ nào để trả lời đúng câu, đúng Worker bằng một cú bấm.

## 3. Tác nhân

| Tác nhân | Muốn gì | Khó ở đâu hôm nay |
|---|---|---|
| Người dùng (owner) | Trả lời nhanh và đúng khi nhiều Worker cùng hỏi | Câu hỏi dồn một dòng; không chọn được; không chắc câu trả lời tới đúng Worker |
| Beads Manager (agent) | Hiện câu hỏi và chuyển câu trả lời không sai | Phải tách câu hỏi từ văn bản tự do; luật chỉ cho chuyển nguyên lời, nên "1a 2b" cho hai Worker là mơ hồ |
| Beads Worker (agent) | Nhận câu trả lời gắn đúng câu hỏi | Câu trả lời tới dưới nhiều kiểu chữ; không phân biệt được trả lời cho vòng hỏi cũ hay vòng hỏi mới |

## 4. Mục tiêu và bằng chứng thành công

1. **Mỗi câu hỏi là một mục riêng, có lựa chọn và đề xuất**, đọc được bằng máy và vẫn đọc được bằng mắt.
   *Bằng chứng:* test cho bộ đọc câu hỏi trên mẫu mới và trên các biến thể một mô hình ngôn ngữ hay viết lệch.
2. **Trả lời trong thẻ với ít thao tác nhất.** Đồng ý mọi đề xuất chỉ mất **2 cú bấm** ("dùng các đề xuất", "Gửi"); mỗi câu khác đề xuất tốn thêm **1 cú bấm**.
   *Bằng chứng:* test logic thẻ; owner tự kiểm trên daemon thật.
3. **Không câu trả lời nào tới nhầm Worker, và không câu trả lời nào gắn nhầm câu hỏi.**
   *Bằng chứng:*
   - test: thẻ chỉ gửi khi xác định được **đúng một** Worker;
   - mã câu hỏi không lặp lại trong một request;
   - lần nghiệm thu của owner với hai Worker cùng hỏi đạt **0** câu trả lời nhầm Worker và **0** câu trả lời nhầm câu hỏi, cả khi trả lời trong thẻ lẫn khi trả lời trong chat Manager.
4. **Không làm hỏng cái đang chạy.**
   *Bằng chứng:* báo cáo kiểu cũ vẫn ra đúng thẻ như hôm nay; bộ đọc `BM-REPORT` và kho vết cho kết quả y như cũ trên tin có thêm khối mới (test).

## 5. Yêu cầu

| ID | Tên | Ưu tiên | Tiêu chí chấp nhận |
|---|---|---|---|
| REQ-059 | Câu hỏi có cấu trúc và thẻ trả lời có lựa chọn | P2 | Xem các ý (a)–(h) ngay dưới bảng. |

**Các ý của REQ-059:**

- **(a) Mẫu câu hỏi.** Khi Worker hỏi người dùng, tin `blocked` gửi Manager có khối `BM-QUESTIONS` ngay sau khối `BM-REPORT`, trong **cùng** tin. Trong khối:
  - tối đa 5 câu một lượt hỏi;
  - mỗi câu có mã `Q<n>`, **không lặp lại trong cùng một request** (lượt hỏi sau đánh số tiếp từ lượt trước);
  - mỗi câu có chủ đề và câu hỏi, từ 2 lựa chọn trở lên, mỗi lựa chọn có khoá chữ cái và nói rõ cái giá cùng việc Worker sẽ làm;
  - **đúng một** lựa chọn được đánh dấu đề xuất.

  Dòng `blockers:` của báo cáo chỉ còn một câu ngắn nêu số câu hỏi và mã của chúng, sau đó là các `Suggestion (not done)` như trước. Câu hỏi và lựa chọn viết bằng ngôn ngữ của người dùng; từ khoá của khối giữ tiếng Anh.
- **(b′) Dòng tóm tắt (Q50).** Dòng tóm tắt của mọi thẻ báo cáo `blocked` không quá 2 dòng, kể cả khi mở toàn văn; phần `blockers` trong đó bị cắt ngắn.
- **(b) Thẻ hiện câu hỏi.** Trong chat của Manager, báo cáo có khối `BM-QUESTIONS` hiện thành thẻ gồm: từng câu hỏi, các lựa chọn của nó, dấu "đề xuất" trên đúng lựa chọn Worker đề xuất, và tên Worker đang hỏi cùng request id. **Không** lựa chọn nào được chọn sẵn.
- **(c) Chọn và gửi.**
  - Người dùng chọn một lựa chọn cho mỗi câu, hoặc chọn "Khác" rồi gõ câu trả lời của mình.
  - Nút "dùng các đề xuất" điền lựa chọn đề xuất cho mọi câu còn trống và **không tự gửi**.
  - Nút "Gửi" chỉ bật khi mọi câu đã có đáp án; ô "Khác" để trống không tính là đáp án.
- **(d) Gửi đúng Worker.**
  - Câu trả lời đi **thẳng** tới Worker duy nhất thuộc request của báo cáo, dưới tên người dùng (Q40).
  - Không xác định được đúng một Worker → thẻ không gửi và nói lý do.
  - Worker đang chạy hoặc đang khởi tạo (trạng thái đọc lại **ngay trước khi gửi**) → thẻ không gửi và nói lý do.
  - Gửi xong, thẻ hiện đã gửi gì, cho ai, lúc nào, và không cho gửi lại cùng bộ câu hỏi đó trong phiên app đang mở.
- **(e) Dạng câu trả lời.** Câu trả lời là khối `BM-ANSWERS` gồm request id và một dòng cho mỗi câu, dù người dùng trả lời trong thẻ hay qua Manager:
  - chọn một lựa chọn → mã câu, khoá lựa chọn, và nguyên văn lựa chọn đó;
  - chọn "Khác" → mã câu, `other`, và nguyên văn lời người dùng.
- **(f) Manager hiện và chuyển câu trả lời.**
  - Khi hiện các câu hỏi đang chờ, Manager nhóm theo Worker: mỗi nhóm có tên Worker và request id, mang một chữ cái (A, B, C…) trong danh sách đó. Nhãn câu hỏi là chữ cái cộng số của câu (A6 = câu Q6 của Worker A). Mỗi câu hiện đủ lựa chọn và đề xuất.
  - Manager nói người dùng trả lời được trong thẻ, hoặc ngay trong chat theo dạng `A6 a, B1 b`.
  - Khi người dùng trả lời trong chat, Manager gửi cho **mỗi** Worker **chỉ** phần của Worker đó: `Continue <requestId>.` rồi khối `BM-ANSWERS`. Lời nào không phải một lựa chọn thì chép **nguyên văn** vào dòng `other`.
  - Câu trả lời không khớp đúng một câu hỏi đang chờ của đúng một Worker → Manager hỏi lại người dùng và không gửi phần đó.
  - Manager không bao giờ tự chọn thay người dùng.
- **(g) Worker đọc câu trả lời.**
  - Worker áp câu trả lời cho các câu hỏi đang mở có mã đó.
  - Câu trả lời cho một mã không còn mở (đã trả lời, hoặc thuộc lượt cũ) → Worker nói ra và không làm theo nó.
  - Câu còn thiếu đáp án vẫn mở và được hỏi lại ở lần `blocked` sau; không bao giờ tự lấy mặc định.
- **(h) Tương thích.**
  - Báo cáo không có khối `BM-QUESTIONS` vẫn hiện thẻ và nút trả lời chữ tự do như hôm nay. Đó là báo cáo của Worker tạo trước bản cập nhật, vì chỉ dẫn được gắn lúc tạo agent.
  - Manager vẫn lấy câu hỏi từ `blockers` khi báo cáo không có khối.
  - Bộ đọc `BM-REPORT`, dữ liệu Dashboard và kho vết cho **cùng** kết quả trên một tin có thêm khối mới; kho vết không thêm trường nào.
  - Chat của Worker và của Reviewer không đổi (Q44).

## 6. Yêu cầu phi chức năng

- **Bảo mật:**
  - Thẻ chỉ gửi tới một agent paseo-bm **cùng workspace**, do plugin tự xác định qua request của nó; không bao giờ tới một id đọc từ nội dung tin.
  - Không đọc, lưu hay in bí mật.
  - Không gọi mạng.
- **Dữ liệu:** không thêm dữ liệu lưu bền. Trạng thái "đã gửi" của thẻ chỉ sống trong phiên app đang mở.
- **Hiệu năng:** đọc câu hỏi chạy trên mỗi tin của chat, nên phải bị chặn độ dài như bộ đọc `BM-REPORT` (REQ-050a). Một tin bình thường không được làm thẻ chậm đi thấy được.
- **Sẵn sàng:** lỗi khi gửi (Worker đã bị xoá, mất kết nối) hiện ngay trên thẻ và không làm mất lựa chọn đã chọn.
- **Khả năng tiếp cận:** mỗi lựa chọn là một nút có trạng thái "đã chọn".

## 7. Ngoài phạm vi

- Thẻ câu hỏi trong chat của Worker hay của Reviewer (Q44).
- Đoán tách dòng `blockers:` kiểu cũ thành nút bấm (Q44).
- Báo Manager khi người dùng đã trả lời trong thẻ (Q40): Manager biết qua báo cáo kế tiếp của Worker.
- Một màn hình hay panel gom mọi câu hỏi đang chờ của mọi Worker; đổi Dashboard.
- Giữ trạng thái "đã gửi" qua lần tải lại app.
- Đổi Reviewer, `BM-REVIEW`, hay các trường có sẵn của `BM-REPORT`.
- Nâng phiên bản gói hay phát hành.

## 8. Ranh giới và phụ thuộc

- **Phụ thuộc Paseo 0.8:**
  - timeline transformer và renderer (đã dùng cho thẻ chat);
  - `paseo.agents.ref(id).send()` ghi tin như tin người dùng thật;
  - RPC `chat.peers` có sẵn cho biết agent paseo-bm cùng workspace, request và trạng thái của chúng.
- **Phụ thuộc hành vi:** Worker và Manager làm theo chỉ dẫn là ràng buộc hành vi, giống lan can REQ-037. Plugin không ép được, nên thẻ có đường lùi về cách trả lời chữ tự do.
- **Không sở hữu:** nội dung các câu hỏi (Worker quyết), quyết định trả lời (người dùng quyết), cơ chế chat của Paseo.

## 9. Lộ trình

| Phase | Phạm vi | Điều kiện ra |
|---|---|---|
| Phase 2a-7 MVP (đợt này) | REQ-059 (a)–(h) | `npm run verify` mã 0. Owner tự kiểm trên daemon thật với hai Worker cùng hỏi: thẻ hiện đúng câu và đúng lựa chọn; trả lời trong thẻ tới đúng Worker; trả lời `A… B…` trong chat Manager tới đúng Worker; 0 câu trả lời nhầm. Delta được áp vào PRD gốc (REQ-059) |

## 10. Câu hỏi mở

| ID | Câu hỏi | Owner | Trạng thái |
|---|---|---|---|
| Q40–Q44 | Năm câu vòng hỏi đầu | hieu.nt10 | **answered (2026-09-18)** — §1.1 |
| Q45–Q48 | Xác nhận trước khi implement | hieu.nt10 | **answered (2026-09-18)** — §1.2 |
| Q49–Q51 | Thẻ khó trả lời trong ảnh (batch `b4`) | hieu.nt10 | **answered (2026-09-18)** — §1.3 |

## 11. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Thêm dòng trỏ: REQ-059 (b)–(f) được sửa bởi delta `prd-delta-20260918d-card-replies`. Không đổi nội dung nào khác |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4`: quyết định Q49–Q51 (§1.3); thêm ý (b′) về dòng tóm tắt |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Áp vào PRD gốc (REQ-059) và trỏ từ delta chat-cards §8; Status → Accepted, Applied |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner xác nhận Q45–Q48 (§1.2); Status → Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: REQ-059 (a)–(h), quyết định Q40–Q44, Routing Decision |
