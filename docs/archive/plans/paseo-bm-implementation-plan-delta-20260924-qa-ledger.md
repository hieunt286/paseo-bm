# Delta plan — Sổ hỏi–đáp: "đã trả lời" thành một trạng thái thật

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260924-qa-ledger` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ** |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Active** |
| Plan-ready | **PASS — 2026-09-24 — hieu.nt10** (Claude Code tự chấm theo `plan-ready-for-beads`; xem §5) |
| Routing decision | Xem [design-delta-20260924-qa-ledger](../design/paseo-bm-delta-20260924-qa-ledger.md) "Routing Decision": plan → bead viết tay, theo tiền lệ của chẩn đoán 2026-09-23 |
| Requirements | N/A — không thêm REQ. Tiêu chí nghiệm thu là A1–A9 của design §9 |
| Source design | [design-delta-20260924-qa-ledger](../design/paseo-bm-delta-20260924-qa-ledger.md) — nguồn duy nhất cho tên, hình dạng và câu chữ |
| Chẩn đoán | [chan-doan-hoi-lap-20260924](../operations/paseo-bm-chan-doan-hoi-lap-20260924.md) |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |

## 1. MVP-Lock

### 1.1 Phạm vi

Sáu gói việc, QA-1 → QA-6, đúng sáu hướng sửa của chẩn đoán §5.

### 1.2 Ngoài phạm vi

- Cài bản mới lên daemon của chủ repo, phát hành npm, commit. Chủ repo tự quyết sau khi xem diff (AGENTS.md: "Do not commit … install plugins onto their daemon as a side effect").
- Những gì design §11 đã loại.

### 1.3 Điều kiện ra

1. A1–A8 của design §9, mỗi tiêu chí có test, và mỗi tiêu chí về hành vi có một đối chứng đỏ đã chạy.
2. A9: `npm run typecheck && npm run typecheck:plugin && npm run lint && npm test && npm run build` xanh.
3. `br lint -s all` không có cảnh báo cho bead của đợt này; `br dep cycles` sạch.
4. Một lượt review độc lập của toàn bộ diff, mọi finding chặn đã sửa.

### 1.4 Hành vi người dùng đang dựa vào sẽ đổi

| Trước | Sau |
|---|---|
| Hết ngân sách review: Manager hỏi "tiếp tục hay huỷ" | Manager báo một dòng. Người hỏi là Worker, trước khi gọi Reviewer vượt ngân sách |
| Pill đếm mọi câu của báo cáo `blocked` | Pill đếm câu còn mở |
| Trả lời trên thẻ xong, Manager im lặng | Manager nói một dòng, Worker đã có câu trả lời nào và còn câu nào mở |

### 1.5 Tư thế hoàn tác

Mọi gói việc lùi được bằng `git revert`. `qa-ledger.json` là file mới, bản cũ của plugin bỏ qua nó (design §10).

### 1.6 Hợp đồng công khai

| Hợp đồng | Đổi gì | Ai chịu ảnh hưởng |
|---|---|---|
| RPC `chat.waiting` | Thêm `waiting[].answered`, có mặc định `[]` | Máy khách của chính plugin; hai chiều tương thích |
| Thông báo `BM-ANSWERED` | Mới | Manager (`manager.md`) |
| Thông báo `BM-BUDGET` | Câu chữ đổi: chỉ để báo | Manager (`manager.md`) |
| `BM-HANDOVER` role worker | Thêm khối `questions` | Worker thay thế (`worker.md`) |
| Lệnh, cờ, mã thoát CLI | Không đổi | — |

## 2. Thứ tự và vì sao

QA-1 là nền: mọi gói dùng sổ phải đợi nó. QA-2, QA-3, QA-6 phụ thuộc QA-1. QA-6 còn phụ thuộc QA-2, vì `managerHandover` gọi `waitingOf` với tham số `answered` mà QA-2 thêm vào. QA-4 và QA-5 chỉ đổi câu chữ và chỉ dẫn vai trò, độc lập. QA-4 và QA-5 cùng sửa `worker.md` và cùng test trần số dòng, nên làm lần lượt để khỏi giẫm lên nhau, và QA-6 làm cuối vì cũng sửa `worker.md`.

## 3. Gói việc

### QA-1 — Sổ hỏi–đáp và hook ghi sổ

**Phụ thuộc:** không. **Design:** §3.

- `parseAnswers` trong `plugin/shared/bm-questions.ts`.
- `plugin/server/qa-ledger.ts`: đọc, ghi, giới hạn, che bí mật, `answeredIds`, `openQuestionIds`, `recordTurn(event)` và hook `registerQaLedger(host)`.
- Đăng ký hook trong `plugin/index.server.ts`, gỡ khi cleanup.
- **Ra:** A2, A7 có test. Ghi hai lần từ cùng timeline không nhân đôi. Đối chứng: bỏ kiểm `clientMessageId` thì test `via` đỏ.

### QA-2 — `chat.waiting`, pill và thẻ đọc sổ

**Phụ thuộc:** QA-1. **Design:** §4.

- `waitingOf(…, answered?)`, `handleChatWaiting` đọc sổ một lần mỗi lượt gọi; `waitingWorkerSchema.answered`.
- `questionCountOf` đếm câu mở; khoá pill thêm `answered`.
- Thẻ: dòng "Answered." cho câu đã trả lời; `recommendedPicks` bỏ qua chúng; câu "moved-on" mới.
- **Ra:** A1, A8. Đối chứng: `waitingOf` bỏ qua `answered` thì A1 đỏ.

### QA-3 — `BM-ANSWERED` tới Manager

**Phụ thuộc:** QA-1. **Design:** §5.

- Trong hook của QA-1: chọn câu trả lời mới, `via: user`, ở lượt cuối; tìm Manager; `enqueue` với kind `BM-ANSWERED:<requestId>`.
- `notices.ts`: thêm tiền tố. `manager.md`: dòng `BM-ANSWERED` và vế mới của luật "reported again".
- **Ra:** A3. Đối chứng: bỏ điều kiện "mới ghi" thì test gửi-một-lần đỏ.

### QA-4 — Ngân sách review: chỉ Worker hỏi

**Phụ thuộc:** không. **Design:** §6.

- `budgetNotice` đổi câu chữ; `manager.md` gạch đầu dòng `BM-BUDGET`; `worker.md` luật phạm vi cho phép.
- Sửa các test đang ghim câu cũ cho khớp quyết định mới. Đây là đổi quyết định có chủ ý, ghi trong design §6, không phải nới test cho xanh.
- **Ra:** A4.

### QA-5 — Phương án giao việc cho người dùng

**Phụ thuộc:** QA-4 (cùng file `worker.md`, cùng trần số dòng). **Design:** §7.

- `worker.md` "Asking": thêm luật.
- **Ra:** A5.

### QA-6 — `BM-HANDOVER` mang theo hỏi–đáp

**Phụ thuộc:** QA-1, QA-2, QA-5 (cùng `worker.md`). **Design:** §8.

- `workerHandover`: khối `questions`, đọc sổ trong ngân sách; `managerHandover`: `waitingOf` với `answered`.
- `worker.md`: đoạn `BM-HANDOVER`.
- **Ra:** A6.

## 4. Kiểm thử

Theo design §9. Fixture lấy từ văn bản thật trong trace của chẩn đoán (ca `4412007` 2026-09-22) khi tiêu chí nói về một ca thật.

## 5. `plan-ready-for-beads` — tự chấm

- ✓ Mỗi gói có phụ thuộc, design ref, và điều kiện ra kiểm được.
- ✓ Phạm vi đã khoá (§1.1, §1.2), hợp đồng công khai liệt kê đủ (§1.6), hành vi đổi ghi rõ (§1.4).
- ✓ Không còn câu hỏi mở (design §12).
- ✓ Tư thế hoàn tác (§1.5).
- Ngoại lệ ghi lại, không tính là pass: plan này **không** qua Reviewer trước khi dựng bead. Lượt review độc lập duy nhất là lượt trên toàn bộ diff (§1.3 mục 4).

## Revision History

| Ngày | Thay đổi | Người |
|---|---|---|
| 2026-09-24 | Tạo, Active, Plan-ready PASS | hieu.nt10 (Claude Code thực hiện) |
| 2026-09-24 | QA-1 → QA-6 xong. Review độc lập trên toàn diff: không có finding chặn; cả 8 finding không chặn đều đã sửa, xem close reason của `bm-so-hoi-dap-tb4m`. Phát lại trace thật: 24/24 câu bị trả lời trùng đều đã có trong sổ trước lần trả lời thứ hai | hieu.nt10 (Claude Code thực hiện) |
