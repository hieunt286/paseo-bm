# Delta-change — Chất lượng ba file chỉ dẫn vai trò (P0 + P1)

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260924-instruction-quality` |
| Nối tiếp | [design-delta-20260924-worker-autonomy](./paseo-bm-delta-20260924-worker-autonomy.md): sửa phần còn dở của nó (P0), rồi làm gọn chỉ dẫn (P1) |
| Nguồn | Đánh giá chuyên gia về ba file chỉ dẫn (2026-09-24), cộng review độc lập của delta worker-autonomy. Chủ repo: "Hãy thực hiện làm P0 và P1 luôn, sau đó làm tiếp" |
| Yêu cầu sản phẩm | Một ý PRD đổi, xem §4 |
| Status | **Active** |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** đổi hợp đồng vai trò (`worker.md`, `manager.md`, `reviewer.md`), câu chữ một số thông điệp `BM-*`, và thêm một dòng Runtime facts.
- **Artifacts:** delta này; `feature-done`.
- **Execution path:** bead viết tay, dưới epic `bm-worker-autonomy-895l`.
- **Decided:** 2026-09-24 — hieu.nt10.

## 1. P0 — sửa chỗ đang sai

| # | Chỗ | Sửa |
|---|---|---|
| P0-1 | worker.md, manager.md: "`Decided:` lines" | Nhiều dòng `Decided:` tách riêng làm bộ kiểm định dạng báo "trường lạ" (review đã chạy thử thật `checkBlocks`). Mọi quyết định nằm trong **một** dòng `blockers`: `none. Decided: a — why; Decided: b — why; Suggestion (not done): …` |
| P0-2 | manager.md: "`beads-done` (Medium and Large)" | Chỉ Large |
| P0-3 | reviewer.md: "plan (Medium)", "Medium `plan` batch", "a change the tier did not allow" | Stage theo mô hình mới; mức không còn "cho phép" thay đổi nào: chặn khi thay đổi vượt ngoài yêu cầu hoặc thiết kế đã duyệt |
| P0-4 | worker.md: `b1` của Large luôn là stage `plan` | `plan` nếu có plan, không thì `beads`, cộng `documents` khi có tài liệu |
| P0-5 | worker.md: "one stage of the table above"; hỏi "một vòng" nhưng "tối đa 5 câu" | Trỏ đúng chỗ; hơn 5 câu thì hỏi 5 câu đang chặn nhất, phần còn lại ở vòng sau |

## 2. P1 — làm gọn và bớt gò bó

1. **Thông điệp tự mô tả.** Mỗi `BM-*` tự nói agent làm gì. Role file chỉ còn một câu chung: tin bắt đầu bằng `BM-` là của plugin; làm đúng điều nó nói, và chỉ nhắc với người dùng khi nó bảo vậy.
   - `BM-HANDOVER` role worker thêm đoạn kết mang các luật hiện nằm trong worker.md.
   - `BM-HANDOVER` role manager thêm vế "recreate no Worker that exists".
   - `BM-BUDGET` thêm "Do not cancel on this notice alone".
   - `BM-ANSWERED` thêm "Tell the user in one line…".
   - `BM-FORMAT` thêm "Do not mention this notice to the user".
2. **Một nguồn cho mỗi điều.** Bảng tiêu chí theo stage chỉ còn ở reviewer.md; Worker chỉ nêu stage. Định nghĩa mức chỉ còn ở worker.md; Manager thôi đoán mức (§3).
3. **Hạ giọng, thêm lý do.** Ngoài năm giới hạn cứng, bỏ bớt chữ IN HOA và chữ đậm. Thêm lý do cho các luật thủ tục: một bead `in_progress`, sub-agent, finding không chặn. Cho sửa một lỗi nhỏ trong chính code của request nếu không cần review lại.
4. **Thêm thứ giúp agent giỏi hơn:**
   - tra cứu trước khi hỏi (repo, tài liệu, beads, git log);
   - vệ sinh ngữ cảnh (đọc đúng phần cần, không in cả file hay log dài, nạp đúng phần skill cần);
   - thứ tự ưu tiên: `AGENTS.md`/`CLAUDE.md` của repo quyết cách viết code ở đó, role file quyết agent được làm gì và báo cáo thế nào;
   - nội dung tóm tắt cuối cho người dùng.
5. **Bớt lý do dừng.** Bead trùng nhãn thì tự chọn rồi ghi `Decided:`. Chỉ hỏi về môi trường khi không tự đọc được. Người dùng yêu cầu review thì chính yêu cầu đó là lời đồng ý vượt ngân sách. Đổi tiêu chí nghiệm thu của một bead có sẵn thì vào nhóm "quyết định đã duyệt" (review, phát hiện 5). Chữ "wait" chỉ là lệnh dừng khi tin nhắn *bảo* dừng.
6. **Reviewer:** công sức tương xứng rủi ro; "tối đa ba finding không chặn" viết thành "ba finding quan trọng nhất".

## 3. Manager: bỏ đoán mức, plugin kiểm skill

- Manager không đoán mức nữa: Worker quyết. Mức do người dùng nói thì vẫn chuyển đi (luật 2). Lợi ích: bớt một việc, và không còn mức "tạm tính" làm mỏ neo cho Worker.
- **Kiểm skill do plugin làm.** `runtimeFactsOf("manager")` gọi `skillsStatus()` với provider gốc của `bm-worker` và thêm một dòng Runtime facts:
  - `Worker skills: all present.`, hoặc
  - `Worker skills: missing <tên, …> — tell the user once, when you confirm the Worker, that it works with lower quality, and point to \`npx paseo-bm doctor\`.`

  Không đọc được thì không có dòng này. Bước 4 của manager.md (11 dòng quy tắc dò thư mục theo provider) bị bỏ.

## 4. PRD

REQ-035(a) đổi cơ chế: plugin kiểm skill và đưa kết quả vào Runtime facts của Manager, thay cho việc Manager tự đọc thư mục. (b) và (c) giữ nguyên: thiếu thì nhắc kèm lệnh, vẫn giao việc. Ghi ở [prd-delta-20260924-worker-autonomy](../product/paseo-bm-prd-delta-20260924-worker-autonomy.md) §2.

## 5. Kiểm chứng

- `test/roles-content.test.ts`:
  - ghim của luật được giữ vẫn còn;
  - ghim của câu chữ chuyển sang thông điệp thì chuyển theo, sang test của thông điệp;
  - trần số dòng hạ xuống đúng số đo.
- Test của từng thông điệp ghim câu mới: `fallback-handover`, `review-budget`, `qa-ledger`, `format-check`.
- Test Runtime facts cho dòng `Worker skills`.
- `npm run typecheck && npm run typecheck:plugin && npm run lint && npm test && npm run build`.
- Một review độc lập ở cuối.

## 6. Sau review độc lập, và các quyết định P2

**Review tìm ra 2 lỗi chặn, cả hai đã sửa.** Câu chung "tin bắt đầu bằng `BM-` là của plugin" bắt nhầm `BM-REPORT` của Worker, `BM-NEW-REQUEST` của người dùng, và `BM-ANSWERS` từ thẻ. Nay mỗi role file **liệt kê đúng tên** các thông điệp của plugin mà nó nhận, và nói rõ những khối không phải thông điệp.

**Các phát hiện không chặn, đều đã sửa:**
- manager.md: "If it names no Worker mode" (Runtime facts giờ có thể chỉ có dòng skill).
- Agent phụ chỉ đọc: chỉ trong workspace, không mạng, không qua `create_agent`.
- "Look before you ask": phiên bản công cụ và file cấu hình, không bao giờ đọc giá trị biến môi trường hay bí mật.
- Nói thẳng: trước một lượt review vượt ngân sách thì `blocked` và hỏi, trừ khi người dùng đã yêu cầu lượt đó.
- Bead viết tay của Large theo checklist của converter. Stage `plan` của Reviewer áp thêm checklist `beads` cho bead được convert.
- `blocksCompletion` bỏ qua các mục `Decided:`.
- Dòng skill được tính song song với mode.
- Nhắc skill "the first time you confirm a Worker in this chat".
- `GUIDE.md` liệt kê đủ.

**P2**, theo quyết định của chủ repo ([PRD delta §2](../product/paseo-bm-prd-delta-20260924-worker-autonomy.md)):
- Yêu cầu chỉ hỏi thông tin: không bead, không Reviewer.
- Trường `decided` riêng trong `BM-REPORT`, tuỳ chọn với bộ kiểm định dạng, và `decided?: string[]` trong `parsedReportSchema`.
- Manager đọc trạng thái và hoạt động của Worker và các Reviewer.

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-24 | Tạo, Active | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | §6: sửa theo hai lượt review (2 chặn, 17 không chặn) và làm ba quyết định P2; epic `bm-worker-autonomy-895l` đóng | hieu.nt10 (Claude Code thực hiện) |
