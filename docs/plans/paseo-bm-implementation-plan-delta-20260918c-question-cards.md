# Delta plan — Câu hỏi có cấu trúc của Worker và thẻ trả lời có lựa chọn

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918c-question-cards` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-250 → WP-254 vào Phase 2a-7 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review b1 pass ở lần re-review) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T021211Z` |
| Source design | [design-delta-20260918c-question-cards](../design/paseo-bm-delta-20260918c-question-cards.md) — nguồn duy nhất cho định dạng, hành vi thẻ, chữ của chỉ dẫn và kiểm thử |
| Source PRD | [prd-delta-20260918c-question-cards](../product/paseo-bm-prd-delta-20260918c-question-cards.md) — REQ-059 (a)–(h); quyết định Q40–Q44 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260918c-question-cards.md#0-routing-decision) — brownfield, **Large**: hợp đồng đang được tiêu thụ và nhiều thành phần |
| Phase | Phase 2a-7 MVP (nhãn bead `phase:2a-7`) |

## 1. MVP-Lock

- **Trong phạm vi:** REQ-059 (a)–(h); toàn bộ §4 của delta thiết kế.
- **Ngoài phạm vi:**
  - thẻ câu hỏi trong chat Worker hay Reviewer; đoán tách `blockers` kiểu cũ (Q44);
  - báo Manager khi người dùng trả lời trong thẻ (Q40);
  - panel gom câu hỏi của mọi Worker; đổi Dashboard, kho vết, `chat.peers`, `contracts.ts`;
  - giữ trạng thái "đã gửi" qua lần tải lại app;
  - đổi `reviewer.md`, `BM-REVIEW`, hay các trường có sẵn của `BM-REPORT`;
  - nâng phiên bản gói, phát hành, commit.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Owner tự kiểm trên daemon thật với hai Worker cùng hỏi:
     - thẻ hiện đúng câu và đúng lựa chọn;
     - trả lời trong thẻ tới đúng Worker;
     - trả lời `A… B…` trong chat Manager tới đúng Worker;
     - 0 câu trả lời nhầm Worker hay nhầm câu.
  3. PRD gốc có dòng REQ-059, và delta chat-cards trỏ tới delta này (WP-254).

  Điều kiện 2 là việc của owner sau khi Worker báo `finished`; không bead nào chờ nó. Worker không cài hay reload plugin trên daemon của owner.
- **Hợp đồng đang được tiêu thụ:**
  - bên phát là `worker.md` (khối `BM-QUESTIONS`) cùng thẻ và `manager.md` (khối `BM-ANSWERS`);
  - bên đọc là `manager.md`, thẻ chat, bộ đọc `BM-REPORT` / bộ thu thập / kho vết, và Worker;
  - tương thích theo bảng thiết kế §4.7;
  - bằng chứng: ca bất biến của bộ đọc báo cáo (WP-250), ca báo cáo kiểu cũ của thẻ (WP-253), và luật "lấy từ `blockers` khi không có khối" của Manager (WP-252).
- **Câu hỏi mở:** không còn. Ngưỡng dòng của `manager.md` đã quyết theo quy ước repo ở thiết kế §4.6:
  - viết gọn trước;
  - vẫn vượt 159 dòng thì ngưỡng mới = số dòng đo được + 3, có chú thích lý do trong test;
  - không đổi ngưỡng của `worker.md` hay `reviewer.md`.

  Owner xác nhận điểm này cùng các điểm khác ở bước xác nhận bắt buộc trước khi implement của một request Large.
- **Tư thế hoàn tác mặc định:** mỗi WP hoàn tác bằng cách revert tệp của chính nó; với chỉ dẫn thì chạy lại `npm run build`. Không có dữ liệu lưu bền nào đổi và không có điểm không đảo ngược. Agent đã tạo với chỉ dẫn mới giữ chỉ dẫn đó tới khi người dùng mở agent mới; thiết kế §4.7 cho thấy các bên vẫn hiểu nhau.

## 2. Thứ tự và vì sao

Một phụ thuộc thật: **WP-253 cần WP-250**. Thẻ đọc câu hỏi bằng `parseQuestions` và soạn câu trả lời bằng `answersText`, mà WP-250 tạo ra.

WP-251 (Worker) và WP-252 (Manager) không cần mã nào, vì định dạng đã chốt ở thiết kế §4.1–§4.2. Hai WP cùng sửa `test/roles-content.test.ts` và cùng chạy `npm run build` để sinh lại file chỉ dẫn, nên làm lần lượt; đó là chuyện tránh xung đột, không phải phụ thuộc. WP-254 đóng delta, phụ thuộc cả bốn.

```
WP-250 ──> WP-253 ──┐
WP-251 ─────────────┼──> WP-254
WP-252 ─────────────┘
```

## 3. Work packages

### WP-250 — Bộ đọc `BM-QUESTIONS` và bộ soạn `BM-ANSWERS`

**Kết quả:** `plugin/shared/bm-questions.ts` có `parseQuestions` và `answersText` đúng thiết kế §4.3, được chứng minh bằng test. Bộ đọc `BM-REPORT` cho kết quả y như cũ trên tin có thêm khối.

**Nguồn:** REQ-059 (a), (e), (h); thiết kế §4.1–§4.3, F2, F8, §6 (năm dòng đầu). **Phụ thuộc:** none.

**Phạm vi:**

- file mới `plugin/shared/bm-questions.ts`;
- file test mới `test/plugin-bm-questions.test.ts`;
- thêm **một** ca vào `test/plugin-bm-report.test.ts`: tin `BM-REPORT` + `BM-QUESTIONS` cho đúng kết quả của tin chỉ có `BM-REPORT`.

Không sửa `plugin/shared/bm-report.ts`.

**Điều kiện ra:**

- mọi ca của thiết kế §6 cho bộ đọc và bộ soạn đều xanh, kể cả đối chứng âm (bỏ lệnh ném lỗi thì ca "thiếu câu" đỏ);
- một `BM-REPORT` hợp lệ dài hơn 20 000 ký tự đứng trước khối → khối vẫn được đọc đủ;
- đầu vào 200 KB chạy dưới 100 ms;
- `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint` và hai file test mã 0.

### WP-251 — Chỉ dẫn Worker: hỏi bằng `BM-QUESTIONS`, đọc `BM-ANSWERS`

**Kết quả:** `plugin/roles/worker.md` dạy mẫu §4.1: mã đếm tiếp trong request, mọi câu vào khối, `blockers:` chỉ trỏ tới khối. Nó cũng dạy cách đọc `BM-ANSWERS`: câu không còn mở thì nói ra, câu thiếu đáp án thì hỏi lại. File chỉ dẫn sinh ra khớp với markdown.

**Nguồn:** REQ-059 (a), (g); thiết kế §4.5. **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/roles/worker.md`: mục Asking, và dòng `blockers:` của mẫu báo cáo trong mục Reporting;
- `plugin/server/worker-instructions.ts`, sinh lại bằng `npm run generate:role-instructions`;
- `test/roles-content.test.ts`, phần của Worker.

Chỉ sửa đúng các đoạn này. Thay đổi đang có trong file (dòng `BM-STOP`) giữ nguyên.

**Điều kiện ra:**

- các luật mới của thiết kế §6 ("Chỉ dẫn Worker nói đúng") có trong test và xanh;
- mỗi luật cũ được thay bằng một luật **ít nhất chặt bằng** cho cùng ý (ví dụ "every question goes into blockers" → "every question goes into BM-QUESTIONS"), không luật nào bị xoá mà không có luật thay;
- `worker.md` dưới 394 dòng, **không** nâng ngưỡng;
- `npx vitest run test/roles-content.test.ts` mã 0.

### WP-252 — Chỉ dẫn Manager: nhóm câu hỏi theo Worker, chuyển câu trả lời bằng `BM-ANSWERS`

**Kết quả:** `plugin/roles/manager.md` làm đúng thiết kế §4.6: luật 2 có ngoại lệ `BM-ANSWERS`, và mục `blocked` có đủ sáu bước. File chỉ dẫn sinh ra khớp với markdown.

**Nguồn:** REQ-059 (f), (h); thiết kế §4.6 (kể cả quy tắc ngưỡng dòng). **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/roles/manager.md`: luật 2, và mục `blocked` của "Talking to the user";
- `plugin/server/manager-instructions.ts`, sinh lại;
- `test/roles-content.test.ts`, phần của Manager, và ngưỡng dòng của `manager.md` theo quy tắc thiết kế §4.6: chỉ khi file đã viết gọn vẫn vượt 159 dòng, lên đúng số dòng đo được + 3, kèm chú thích lý do.

Thay đổi đang có trong file (bước 2 về `BM-NEW-REQUEST` và Worker `running`) giữ nguyên.

**Điều kiện ra:**

- các luật mới của thiết kế §6 ("Chỉ dẫn Manager nói đúng") có trong test và xanh;
- các luật cũ của mục `blocked` vẫn được kiểm, hoặc được thay bằng luật ít nhất chặt bằng;
- `manager.md` dưới ngưỡng: ngưỡng cũ (160), hoặc số dòng đo được + 3 theo quy tắc thiết kế §4.6, kèm chú thích;
- khối `## RULES` của `manager.md` vẫn ≤ 29 dòng và vẫn đúng 5 giới hạn, **không** nâng trần RULES (thiết kế §4.6);
- `npx vitest run test/roles-content.test.ts` mã 0.

### WP-253 — Thẻ câu hỏi trong chat Manager

**Kết quả:** trong chat Manager, báo cáo có `BM-QUESTIONS` hiện đủ câu hỏi và lựa chọn. Người dùng có:

- đánh dấu đề xuất, không chọn sẵn;
- `Use recommendations`, `Other…`, `Clear`;
- nút gửi chỉ bật khi đủ đáp án.

Câu trả lời đi thẳng tới Worker duy nhất của request, sau khi đọc lại trạng thái; thẻ từ chối khi không xác định được Worker hay Worker đang chạy. Báo cáo kiểu cũ và mọi thẻ khác không đổi.

**Nguồn:** REQ-059 (b), (c), (d), (h); thiết kế §4.4, F3–F5, F7.

**Phụ thuộc:** WP-250 — cần `parseQuestions`, `answersText` và kiểu `Question`.

**Phạm vi:**

- `plugin/client/chat-cards.ts`:
  - trường `questions`;
  - `toChatCard`, `summaryOf`, `quickReplies`, `markdownOf`;
  - hàm mới `showsQuestions`, `recommendedPicks`, `formComplete`, `answerTarget`, `answeredKey`, và `sendAnswers`, chứa toàn bộ đường gửi với `refreshPeers` / `send` truyền vào (thiết kế §4.4). Repo không có test dựng component React, nên logic gửi không được nằm trong `.tsx`;
- `plugin/client/chat-card.tsx`: phần chọn, nối `sendAnswers` vào nút, bảng "đã gửi" ở mức module;
- `test/plugin-chat-cards.test.ts`.

Không sửa `plugin/shared/contracts.ts` hay `chat-rpc.ts`. File trong `test/` không import `react-native` như một giá trị (AGENTS.md).

**Điều kiện ra:**

- mọi ca thẻ của thiết kế §6 xanh:
  - lấy câu hỏi;
  - chỉ hiện nút ở chat Manager;
  - chặn gửi khi có 0 hay 2 Worker, và khi Worker `running` / `initializing` / `closed`;
  - `idle` / `error` gửi được;
  - chọn đúng;
- các ca `sendAnswers` của thiết kế §6 xanh, với `refreshPeers` và `send` giả:
  - `send` được gọi đúng một lần, với id Worker từ lần đọc lại và chữ bằng `answersText`;
  - Worker `running` lúc bấm → không gửi;
  - `send` lỗi → lý do hiện ra;
  - đối chứng âm: bỏ bước đọc lại trạng thái thì ca `running` đỏ;
- các test thẻ đang có vẫn xanh, không sửa kỳ vọng nào của báo cáo kiểu cũ;
- `npm run typecheck:plugin`, `npm run lint` và `npx vitest run test/plugin-chat-cards.test.ts` mã 0.

### WP-254 — Áp delta vào tài liệu gốc và kiểm cả gói

**Kết quả:**

- PRD gốc `docs/product/paseo-bm-prd.md` có dòng REQ-059 trỏ về PRD delta, kèm một mục Revision History;
- `docs/design/paseo-bm-delta-20260916-chat-cards.md` có một mục ngắn trỏ tới delta này;
- ba tài liệu của delta mang trạng thái cuối (PRD delta `Accepted, Applied`, design delta `Active`, plan delta giữ `Active`);
- `npm run verify` mã 0.

**Nguồn:** PRD delta §9 (điều kiện ra); quy tắc "delta, không sửa tại chỗ" của `AGENTS.md`.

**Phụ thuộc:** WP-250, WP-251, WP-252, WP-253 — tài liệu gốc chỉ được ghi REQ-059 khi phần mã và chỉ dẫn đã xong.

**Phạm vi:** chỉ ba chỗ nêu trên, cộng dòng trạng thái của ba tài liệu delta. Không sửa nội dung REQ khác, không sửa `AGENTS.md`.

**Điều kiện ra:**

- `npm run verify` mã 0, đọc ở dòng tổng kết;
- `br lint -s all` không có cảnh báo cho bead của request này;
- `br dep cycles` báo không có vòng.

## 4. Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Một Worker khác (`req-20260918T011706Z`) đang sửa cùng workspace | Delta này không sửa `contracts.ts`, Dashboard hay kho vết. Với `roles/*.md` và `test/roles-content.test.ts` thì chỉ sửa đoạn của mình. Chạy `git status` trước mỗi bead; thấy file của bead vừa bị sửa ở đoạn khác thì làm tiếp, bị sửa ở cùng đoạn thì dừng và hỏi |
| Test vai trò hỏng vì thay chữ | Mỗi luật cũ được thay bằng luật ít nhất chặt bằng (điều kiện ra WP-251, WP-252); không xoá luật để cho xanh |
| `manager.md` vượt ngưỡng dòng | Viết gọn trước; chỉ nâng theo quy tắc thiết kế §4.6, và owner xác nhận trước khi implement |
| Mô hình viết lệch mẫu | Bộ đọc dễ dãi (thiết kế §4.3); thẻ lùi về chữ tự do |

## 5. Kiểm thử của phase

- **Unit:** bộ đọc và bộ soạn; logic thẻ thuần; nội dung chỉ dẫn. Tất cả bằng Vitest, như quy ước của repo.
- **Gửi:** test `sendAnswers` với `refreshPeers` và `send` giả. Repo không dựng component React trong test, nên phần `.tsx` được kiểm bằng `typecheck:plugin` và lần chạy thật của owner.
- **Toàn gói:** `npm run verify`.
- **Chạy thật:** owner tự kiểm trên daemon thật (§1 điều kiện ra 2). Worker không cài hay reload plugin trên daemon của owner.
- **Độ phủ:** không đặt ngưỡng phần trăm (repo không có). Mọi hàm mới của `bm-questions.ts` và `chat-cards.ts` có ít nhất một ca đúng và một ca sai.

## 6. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-250 → WP-254 xong (bead `bm-wp-250-question-cards-nv8m.1`–`.5`); `manager.md` lên 171 dòng, ngưỡng 174 theo Q46. Điều kiện ra 2 (owner kiểm trên daemon thật) còn chờ owner. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata lúc chuyển thành bead: ghi rõ ràng buộc đã có của test "the RULES budget" — khối `## RULES` của `manager.md` đang ở trần 29 dòng, nên ngoại lệ của luật 2 phải nằm trong số dòng hiện có. Không đổi phạm vi hay hành vi |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `plan-ready-for-beads` PASS sau review b1 (hai phát hiện chặn đã sửa: chặn độ dài tính từ dòng mở khối; ngưỡng dòng `manager.md` theo quy ước repo). Status → Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo plan delta: WP-250 → WP-254, Phase 2a-7 |
