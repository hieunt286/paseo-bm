# Delta-change — Rút gọn review, bỏ polish, gọn luồng trao đổi giữa 3 agent

| Trường | Giá trị |
|---|---|
| Ngày | 2026-09-16 |
| Trạng thái | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Thay thế một phần | [PRD](../../product/paseo-bm-prd.md) REQ-037 (con số ngân sách, polish); [Technical Design](../../design/paseo-bm.md) §F (bảng lan can review và polish) |
| Bead | `bm-u8j` |

## 1. Owner yêu cầu gì

> "số lượng lượt review và polish trong file instruction của Work hơi quá nhiều… hãy xem lại follow giữa 3 Agents, đánh giá điểm conflict trong trao đổi. Các thông tin dư thừa thì nên bỏ đi"

## 2. Luồng thực tế đo được (workspace `xspace-customer`, 16/09)

| Quan sát | Số liệu |
|---|---|
| Report Worker gửi Manager cho 4 request | 46: 14 `blocked`, 12 `finished`, 11 `bead-implemented`, 6 `received`, 2 `documents-done`, 1 `beads-done` |
| Reviewer tạo cho một request (PAKD) | 6 |
| Tin Manager gửi Worker | trung bình ~1.500 ký tự, gồm quyết định kỹ thuật ("Kế hoạch R4 đúng hướng… Hai điều chỉnh") và "uỷ quyền chống ngắt lượt" tự đặt ra |
| Dòng `guardrail` | Worker viết thêm chú thích tự do ("ĐÃ CẠN…", "đóng batch…") vì luật tính lượt khó theo |

## 3. Điểm xung đột và dư thừa

1. **Ngân sách tự mâu thuẫn.** Mỗi tài liệu là một lô (tối đa 2 lượt), đợt bead là một lô (2 lượt, cộng 1 polish), mỗi bead implement là một lô (2 lượt). Một request Large với 4 tài liệu và 5 bead có thể cần 8 + 3 + 10 = 21 lượt, trong khi trần tổng là 10. Worker vì thế liên tục chạm trần và phải `blocked`.
2. **Polish mơ hồ.** Worker bị cấm "tự review hay dùng review skill", nhưng lại được một "lượt polish" mà không nói ai chạy. `br lint` vốn đã là bước dọn bead.
3. **Manager tự quyết thay người dùng.** Luật "DO NOT ADD WORK" chỉ cấm thêm việc lúc giao, không nói gì về việc chuyển lời. Manager tự duyệt kế hoạch, thêm chỉnh sửa, và tự đặt "uỷ quyền".
4. **Trả lời hai lần.** Người dùng trả lời Worker trực tiếp (nay còn có nút Reply trên thẻ chat), rồi Manager lại chuyển lời một lần nữa.
5. **Báo cáo quá dày.** Có `documents-done` và một `bead-implemented` cho mỗi bead, trong khi Manager không làm gì với các mốc này.
6. **Lặp lại giữa các file.**
   - Manager chép lại bảng ngân sách theo lô, danh sách mốc báo cáo và các luật cứng của Worker.
   - Prompt khởi tạo nhắc Worker "làm theo instruction và ngân sách", dù instruction đã được plugin nạp sẵn.
   - Worker dán mẫu `BM-REVIEW` vào mỗi yêu cầu review, dù Reviewer đã có mẫu đó.
   - Câu "Large phải hỏi trước khi implement" xuất hiện ba lần trong `worker.md`.
7. **Mỗi lần kiểm lại tạo một Reviewer mới**, nên số agent tăng nhanh (6 Reviewer cho một request).

## 4. Quyết định

**Review gom theo giai đoạn, không theo từng tài liệu hay từng bead. Bỏ polish.**

| | Nhỏ | Vừa | Lớn |
|---|---|---|---|
| Lô review | 1: implement | 2: kế hoạch (tài liệu + bead), implement | 3: tài liệu, bead, implement |
| Lượt mỗi lô | 1 | 1, thêm 1 lượt kiểm lại **chỉ khi** còn mục chặn | như Vừa |
| **Tổng lượt review mỗi request** | **1** | **4** (trước 6) | **6** (trước 10) |
| Polish | 0 | **0** (trước 1/đợt) | **0** (trước 1/đợt) |

- Implement: làm từng bead và kiểm từng bead, rồi review **một lần cho cả phần implement**, sau đó mới đóng bead kèm bằng chứng.
- Lượt kiểm lại gửi cho **chính Reviewer cũ**, không tạo agent mới.
- **Mốc báo cáo:** chỉ `received`, `beads-done` (Vừa, Lớn), `blocked`, `finished`. Giữa các mốc không gửi gì. Parser vẫn đọc được các phase cũ.
- **Dòng guardrail** bỏ phần `polish`: `batch <id> reviews <n>/<max>; total <n>/<budget>; userAllowedExtra <n>`.
- **Manager là người chuyển lời, không phải người quyết:**
  - không duyệt hay chỉnh kế hoạch của Worker;
  - chuyển nguyên văn câu trả lời của người dùng kèm `requestId`;
  - muốn Worker chạy tiếp chỉ gửi `Continue <requestId>.`;
  - không chuyển lại câu người dùng đã trả lời thẳng cho Worker;
  - không đòi báo cáo tiến độ giữa các mốc.
- **Manager chỉ giữ bảng tổng** để giám sát. Bỏ câu nhắc luật của Worker trong prompt khởi tạo.
- **Khi `blocked`**, Worker hỏi **một** câu rõ ràng và nói trước sẽ làm gì với từng câu trả lời.
- **Metric:** bước "Beads polished" được coi là "không cần" ở mọi mức. Report cũ có polish vẫn hiện là đã làm.
- **Không đổi:** danh sách skill bắt buộc (vẫn có `polishing-beads`, vì trình cài đặt và `doctor` kiểm theo danh sách đó); cách phân mức; các luật cứng.

## 5. Ảnh hưởng

- Chỉ có tác dụng với agent **được tạo sau khi cập nhật**: instruction được nạp lúc tạo agent. Worker và Manager đang chạy vẫn theo bản cũ; muốn áp dụng thì tạo phiên mới.
- Test `roles-content.test.ts` khoá các con số mới, luật "relay" của Manager và danh sách phase mới.
- README cập nhật bảng mức, mục review và mục báo cáo.
