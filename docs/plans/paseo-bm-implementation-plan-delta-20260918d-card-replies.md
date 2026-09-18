# Delta plan — Manager không nhắc lại thẻ, câu trả lời đi qua ô Reply, thẻ câu hỏi dễ đọc

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918d-card-replies` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-255 → WP-258 vào Phase 2a-8. Plan delta [20260918c-question-cards](paseo-bm-implementation-plan-delta-20260918c-question-cards.md) giữ nguyên |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review b1 pass ở lần re-review) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T041426Z` |
| Source design | [design-delta-20260918d-card-replies](../design/paseo-bm-delta-20260918d-card-replies.md) — nguồn duy nhất cho hàm, hành vi thẻ, chữ của chỉ dẫn và kiểm thử |
| Source PRD | [prd-delta-20260918d-card-replies](../product/paseo-bm-prd-delta-20260918d-card-replies.md) — REQ-059 (b)–(f) sửa; quyết định Q1–Q5 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260918d-card-replies.md#0-routing-decision) — brownfield, **Large**: nhiều thành phần độc lập, hành vi người dùng đang dựa vào |
| ADR | N/A — không có quyết định kiến trúc mới |
| Phase | Phase 2a-8 MVP (nhãn bead `phase:2a-8`) |

## 1. MVP-Lock

- **Trong phạm vi:**
  - REQ-059 (b), (c), (d), (e), (f) theo PRD delta §5;
  - toàn bộ §4 của delta thiết kế.

  REQ-059 (a), (g), (h) không đổi.
- **Ngoài phạm vi:**
  - tách `plugin/roles/*.md` thành reference/template hay thư mục theo provider (Q2: chỉ có đánh giá ở thiết kế §9, đã viết xong cùng tài liệu này);
  - sửa `worker.md`, `reviewer.md`, `bm-questions.ts`, `contracts.ts`, `chat-rpc.ts`, kho vết, Dashboard;
  - câu trả lời của Manager cho `BM-BUDGET` và cho lượt Worker kết thúc không kèm báo cáo;
  - thẻ câu hỏi trong chat Worker hay Reviewer;
  - giữ "đã trả lời" qua lần tải lại app;
  - nâng phiên bản, phát hành, commit, cài hay nạp lại plugin trên daemon của owner.
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Owner tự kiểm trên daemon thật với một Manager mới:
     - tick lựa chọn thì khối `BM-ANSWERS` hiện ở đầu ô Reply;
     - Send gửi tới đúng Worker;
     - Worker đang chạy thì không gửi;
     - Manager trả lời báo cáo có thẻ trong ≤ 2 dòng, không lặp câu hỏi;
     - thẻ đọc được.
  3. REQ-059 của PRD gốc được cập nhật, và hai tài liệu delta 20260918c trỏ tới delta này (WP-258).

  Điều kiện 2 là việc của owner sau khi Worker báo `finished`; không bead nào chờ nó. Worker chỉ nạp lại plugin nếu owner cho phép rõ ràng.
- **Hành vi người dùng đang dựa vào:**
  - cách trả lời trong thẻ đổi từ "nút Send answers" sang "ô Reply" (Q4);
  - Manager thôi in lại câu hỏi (Q1).

  Cả hai là quyết định của owner. Định dạng `BM-ANSWERS` không đổi, nên Worker cũ và mới đều đọc được (thiết kế §4.6).
- **Tư thế hoàn tác mặc định:** mỗi WP hoàn tác bằng cách revert tệp của chính nó; với chỉ dẫn thì chạy lại `npm run build`. Không có dữ liệu lưu bền nào đổi và không có điểm không đảo ngược.
- **Câu hỏi mở:** không còn. Ngưỡng dòng của `manager.md` (174) không nâng. Nếu bản viết gọn vẫn vượt, WP-255 dừng và hỏi owner (thiết kế §4.5).

## 2. Thứ tự và vì sao

Một phụ thuộc thật: **WP-257 cần WP-256**. WP-256 chuyển `picks` lên `ChatCardView` và biến `QuestionForm` thành phần chỉ vẽ, với các hàng lựa chọn gọi lại lên trên. WP-257 vẽ lại chính các hàng đó. Làm ngược thứ tự thì phải vẽ lại hai lần.

WP-255 (Manager) không cần mã nào của thẻ, vì chữ của nó chỉ nói về thứ thẻ hiện, và thứ đó đã có từ delta 20260918c. WP-258 đóng delta, phụ thuộc cả ba.

```
WP-256 ──> WP-257 ──┐
WP-255 ─────────────┴──> WP-258
```

## 3. Work packages

### WP-255 — Manager không nhắc lại thẻ

**Kết quả:** `plugin/roles/manager.md` làm đúng thiết kế §4.5:

- đoạn "Never repeat what the card shows";
- `received`, `beads-done`, `blocked`, `finished` viết lại;
- ngoại lệ "which you show in full" chỉ còn cho báo cáo kiểu cũ.

File chỉ dẫn sinh ra khớp markdown.

**Nguồn:** REQ-059 (f); thiết kế §4.5, F3, F4. **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/roles/manager.md`: chỉ mục "Talking to the user";
- `plugin/server/manager-instructions.ts`, sinh lại bằng `npm run generate:role-instructions`;
- `test/roles-content.test.ts`: chỉ phần của Manager, theo bảng luật của thiết kế §4.5.

**Điều kiện ra:**

- mọi luật mới của bảng thiết kế §4.5 có trong test và xanh; mỗi luật cũ được thay bằng luật ít nhất chặt bằng, không luật nào bị xoá mà không có luật thay;
- `manager.md` dưới 174 dòng, **không** nâng ngưỡng; khối `## RULES` không đổi (≤ 29 dòng, đúng 5 giới hạn);
- `npx vitest run test/roles-content.test.ts test/plugin-bundle-cjs.test.ts` mã 0.

### WP-256 — Một đường gửi cho mọi Reply; lựa chọn viết vào ô Reply

**Kết quả:**

- Tick lựa chọn, "Use recommendations", "Clear" hay gõ "Other" đều viết lại khối `BM-ANSWERS` ở đầu ô Reply, mở ô và giữ lời người dùng.
- Không còn nút "Send answers to <Worker>".
- Nút Send của **mọi** thẻ đọc lại trạng thái người nhận, gửi đúng một lần tới người nhận do plugin xác định, và từ chối khi người nhận đang chạy, đang khởi tạo, đã đóng hay không xác định được.
- Gửi một khối có đáp án thì thẻ ghi "đã trả lời".

**Nguồn:** REQ-059 (c), (d), (e); thiết kế §4.1, §4.2, §4.3, F1, F2, F5, F7. **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/client/chat-cards.ts`:
  - hàm mới `isAnswered`, `answersDraft`, `withAnswersBlock`, `sentSummary`, `replyTarget`, `sendReply`;
  - `answerSummary` chỉ đếm câu đã trả lời;
  - bỏ `formComplete`, `answerTarget`, `sendAnswers`;
- `plugin/client/chat-card.tsx`:
  - `picks` lên `ChatCardView`;
  - `QuestionForm` chỉ vẽ;
  - Send gọi `sendReply`;
  - bảng "đã trả lời";
  - nút lựa chọn tắt kèm lý do khi không xác định được người nhận;
- `test/plugin-chat-cards.test.ts`.

Không sửa `plugin/shared/bm-questions.ts`, `contracts.ts` hay `chat-rpc.ts`. File trong `test/` không import `react-native` như một giá trị.

**Điều kiện ra:**

- mọi ca của thiết kế §6 cho `isAnswered`, `answersDraft`, `withAnswersBlock`, `sentSummary`, `replyTarget`, `sendReply` xanh, gồm:
  - ca lỗi owner gặp (ô `OK` + khối → Worker nhận cả hai);
  - thẻ review và tin thường với người nhận `running` → không gửi;
  - hai đối chứng âm của §6;
- mỗi ca cũ của `formComplete`, `answerTarget`, `sendAnswers` có ca thay ít nhất chặt bằng; câu lý do cũ giữ nguyên văn;
- các ca đang có của `toChatCard`, `summaryOf`, `quickReplies`, `markdownOf`, `showsQuestions`, `partiesOf`, `replyText` không sửa kỳ vọng;
- `npm run typecheck:plugin`, `npm run lint` và `npx vitest run test/plugin-chat-cards.test.ts` mã 0.

### WP-257 — Bố cục câu hỏi dễ đọc

**Kết quả:** phần câu hỏi của thẻ vẽ theo thiết kế §4.4:

- mỗi câu một khối có tiêu đề đậm `Q<n> · <chủ đề>` và câu hỏi chữ thường;
- mỗi lựa chọn một hàng rộng hết thẻ, cách nhau 8px: dấu chọn, khoá đậm, nội dung xuống dòng thẳng hàng, chip `recommended` cuối hàng;
- "Other…" là hàng cuối cùng danh sách;
- vạch ngăn giữa các câu.

**Nguồn:** REQ-059 (b); thiết kế §4.4.

**Phụ thuộc:** WP-256 — cần `QuestionForm` đã thành phần chỉ vẽ, với `picks` và hàm chọn truyền từ `ChatCardView`.

**Phạm vi:**

- `plugin/client/chat-cards.ts`: hàm mới `questionHeading`;
- `plugin/client/chat-card.tsx`: chỉ phần vẽ của `QuestionForm`;
- `test/plugin-chat-cards.test.ts`: ca `questionHeading`.

**Điều kiện ra:**

- ca `questionHeading` của thiết kế §6 xanh;
- câu hỏi không còn dùng `styles.mono`;
- mỗi lựa chọn và hàng "Other…" giữ `accessibilityRole="button"` và `accessibilityState.selected`;
- `npm run typecheck:plugin`, `npm run lint` và `npx vitest run test/plugin-chat-cards.test.ts` mã 0.

Bố cục chỉ kiểm được bằng mắt (điều kiện ra 2 của delta, việc của owner).

### WP-258 — Áp delta vào tài liệu gốc và kiểm cả gói

**Kết quả:**

- PRD gốc `docs/product/paseo-bm-prd.md`: các ý (b)–(f) của dòng REQ-059 viết lại theo PRD delta §5, trỏ về delta này, kèm một mục Revision History;
- `prd-delta-20260918c-question-cards` và `design-delta-20260918c-question-cards`: mỗi file có một dòng ngay dưới bảng đầu, nói REQ-059 (b)–(f) / §4.2, §4.4, §4.6 đã được thay bởi delta 20260918d, kèm một mục Revision History;
- ba tài liệu của delta này mang trạng thái cuối: PRD delta `Accepted, Applied`; design delta `Active`; plan delta giữ `Active`;
- `npm run verify` mã 0.

**Nguồn:** PRD delta §9 (điều kiện ra 3); quy tắc "delta, không sửa tại chỗ" của `AGENTS.md`; quyết định Q3.

**Phụ thuộc:** WP-255, WP-256, WP-257 — tài liệu gốc chỉ ghi hành vi mới khi phần mã và chỉ dẫn đã xong.

**Phạm vi:** chỉ các chỗ nêu trên. Không sửa REQ nào khác, không sửa `AGENTS.md` hay phần nội dung của hai delta 20260918c.

**Điều kiện ra:**

- `npm run verify` mã 0, đọc ở dòng tổng kết;
- `br lint -s all` không có cảnh báo cho bead của request này;
- `br dep cycles` báo không có vòng.

## 4. Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Worker `req-20260918T035101Z` cũng sửa repo (`worker.md`, `role-extras.ts`, `test/roles-content.test.ts`, tài liệu delta 20260917c, `AGENTS.md`) | Delta này không đụng `worker.md`, `role-extras.ts` hay `AGENTS.md`. Với `test/roles-content.test.ts` thì chỉ sửa phần của Manager. `git status` trước mỗi bead; file của bead bị sửa ở đoạn khác thì làm tiếp, bị sửa cùng đoạn thì dừng và hỏi |
| Test hỏng vì bỏ `formComplete` / `answerTarget` / `sendAnswers` | Mỗi ca cũ có ca thay ít nhất chặt bằng (điều kiện ra WP-256); không xoá ca nào để cho xanh |
| `manager.md` vượt ngưỡng | Bù bằng phần bỏ (thiết kế §4.5); vượt thì dừng và hỏi owner |
| Bố cục không kiểm được bằng test | `typecheck:plugin` + owner kiểm bằng mắt; logic nằm ở hàm thuần có test |
| Người dùng sửa tay trong khối | Hành vi đã ghi (REQ-059c); dùng "Other…" hoặc viết dưới khối |

## 5. Kiểm thử của phase

- **Unit:** các hàm thuần của `chat-cards.ts` và nội dung chỉ dẫn, bằng Vitest như quy ước của repo.
- **Gửi:** `sendReply` với `refreshPeers` và `send` giả. Repo không dựng component React trong test, nên phần `.tsx` được kiểm bằng `typecheck:plugin`, `lint`, và lần chạy thật của owner.
- **Toàn gói:** `npm run verify`.
- **Độ phủ:** không đặt ngưỡng phần trăm (repo không có). Mọi hàm mới có ít nhất một ca đúng và một ca sai.

## 6. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Request `req-20260918T074311Z` (PRD delta §1.6, thiết kế §4.10): thẻ `finished` mở sẵn và có viền success. Nằm trong phạm vi WP-257 (trình bày thẻ); bead riêng cho request này, không đổi MVP-Lock |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6` xong: bead `bm-wp-256-answered-sync-ygit.1`–`.3` đóng, review b6 pass sau một lần sửa tài liệu; chưa cài lên daemon |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b6` (PRD delta §1.5, Q16–Q18): đồng bộ "đã trả lời", `answers.marks` / `answers.mark` lưu trong thư mục cài, nút "Mark as answered". Bead riêng cho batch này. Ngoại lệ của tư thế hoàn tác ở §1: batch này thêm một file lưu bền, `<install home>/ui/answer-marks.json`; revert mã thì file nằm yên và không ai đọc nữa, không xoá |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5` xong: bead `bm-wp-256-waiting-pills-mkgt.1`, `.2` đóng, review b5 pass; chưa cài lên daemon |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b5` (PRD delta §1.4, Q15 b): chip câu đang chờ — một RPC mới `chat.waiting`, composer pill, popover; owner mở rộng phạm vi, chấp nhận sửa chồng `index.client.tsx` và vượt số lượt review. Bead riêng cho batch này |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` xong: bead `bm-wp-257-card-b4-zwx7.1`–`.4` đóng, review b4 pass; chưa cài lên daemon |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Batch `b4` (PRD delta §1.3, Q11–Q14) nằm trong phạm vi của WP-257 (trình bày thẻ) và WP-258 (tài liệu); bead riêng cho batch này, không đổi MVP-Lock. Ý 6 thành request riêng (Q13) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-255 → WP-258 xong (bead `bm-wp-255-card-replies-jt7e.1`, `.2`, `.5`, `.3`, `.4`; WP-256 tách thành `.2` và `.5` lúc polishing). `manager.md` 173 dòng, ngưỡng 174 không đổi. Điều kiện ra 2 (owner kiểm trên daemon thật) còn chờ owner; theo Q7 (b) Worker nạp bản mới một lần sau khi review b3 pass. Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `plan-ready-for-beads` PASS sau review b1 (hai phát hiện chặn ở thiết kế đã sửa: khối luôn ở đầu ô Reply; dòng của Manager dùng mã `Q6, Q7`). Status → Active; phạm vi Phase 2a-8 chốt |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo plan delta: WP-255 → WP-258, Phase 2a-8 |
