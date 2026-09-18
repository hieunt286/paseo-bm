# Delta plan — Plugin bắt buộc quy ước phối hợp giữa các agent

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918g-agent-conventions` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-277 → WP-282 vào Phase 2a-11 (2a-9 và 2a-10 đã thuộc delta 20260918e và 20260918f) |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review `b2` pass ở lần re-review) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T071130Z` |
| Source design | [design-delta-20260918g-agent-conventions](../design/paseo-bm-delta-20260918g-agent-conventions.md) — nguồn duy nhất cho hàm, luật kiểm, chữ thông báo, chữ chỉ dẫn và kiểm thử |
| Source PRD | [prd-delta-20260918g-agent-conventions](../product/paseo-bm-prd-delta-20260918g-agent-conventions.md) — REQ-061 (a)–(j); quyết định Q1–Q5 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260918g-agent-conventions.md#0-routing-decision) — brownfield, **Large**: nhiều thành phần, hợp đồng tin nhắn giữa các agent |
| ADR | N/A — không có quyết định kiến trúc mới |
| Phase | Phase 2a-11 (nhãn bead `phase:2a-11`) |

## 1. MVP-Lock

- **Trong phạm vi:**
  - REQ-061 (a)–(j) theo PRD delta §5;
  - toàn bộ §4 của delta thiết kế, với các lựa chọn owner chốt ở Q6–Q10;
  - cài và nạp lại plugin **một lần** trên daemon theo thiết kế §4.11 (Q10 a).
- **Ngoài phạm vi:**
  - chặn tin sai trước khi tới người nhận;
  - đổi mẫu `BM-*` hay bộ đọc khoan dung (`bm-report.ts`, `bm-questions.ts`);
  - cách Manager nói về thẻ, trừ luật `BM-FORMAT`;
  - kho vết (schema), Dashboard (ngoài việc dùng `bmAgentsOf` mới);
  - nâng phiên bản, phát hành, commit;
  - cài hay nạp lại lần thứ hai, `paseo daemon restart` / `stop`, đồng ý thay ranh giới tin cậy (`--enable-plugins`, `--install-skills`).
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0; `br lint -s all` và `br dep cycles` sạch.
  2. REQ-061 được thêm vào PRD gốc, kèm dòng revision; thiết kế gốc trỏ tới delta này (WP-282).
  3. Owner tự kiểm trên daemon thật sau khi plugin mới được nạp:
     - chat Manager `f13a4e4e` hiện thẻ và thẻ câu hỏi;
     - một agent tạo từ màn Paseo với profile "Manager" có nhãn `bm.role`;
     - Worker mới có `## Runtime facts` nêu mode Reviewer.

  Điều kiện 3 là việc của owner sau `finished`; không bead nào chờ nó.
- **Hành vi người dùng đang dựa vào:**
  - Beads Manager mở Manager không nhãn thay vì tạo cái mới;
  - `/bm-worker-stop-all` chạm cả agent không nhãn;
  - agent nhận thông báo `BM-FORMAT`.

  Cả ba đến từ Q1 và Q2 của owner.
- **Tư thế hoàn tác mặc định:**
  - mỗi WP revert tệp của chính nó; chỉ dẫn thì chạy lại `npm run build`;
  - không có dữ liệu lưu bền nào đổi;
  - nhãn đã gắn cho agent ở lại: đúng vai, vô hại.
- **Câu hỏi mở:** không còn. Owner chốt Q6–Q10 ngày 2026-09-18 ([PRD delta §1.2](../product/paseo-bm-prd-delta-20260918g-agent-conventions.md)):
  - Q6 a: quét khi nạp (WP-278);
  - Q7 a: thứ tự trường, `blocked` bắt buộc `BM-QUESTIONS` (WP-279);
  - Q8 a: tối đa 2 lần (WP-280);
  - Q9 a: `auto` (WP-281);
  - Q10 a: kiểm Worker đang chạy trước khi sửa code, cài và nạp lại một lần sau khi pass (thiết kế §4.11, WP-282).

## 2. Thứ tự và vì sao

Hai phụ thuộc thật:

- **WP-278 cần WP-277**: handler gắn nhãn dùng `ROLE_BY_PROVIDER` và `roleOfAgent` của `agent-role.ts`.
- **WP-280 cần WP-277 và WP-279**: tìm người gửi cần `roleOfAgent` và `bmAgentsOf` mới; kiểm cần `checkBlocks`.

WP-281 (mode Reviewer) độc lập. WP-282 đóng delta, phụ thuộc tất cả.

```
WP-277 ──> WP-278 ─────────────┐
   └────────────┐              │
WP-279 ──> WP-280 ─────────────┼──> WP-282
WP-281 ────────────────────────┘
```

## 3. Work packages

### WP-277 — Agent `bm-*` được nhận đúng vai dù thiếu nhãn

**Kết quả:** mọi chỗ plugin tìm agent (thẻ chat, pill chờ, Dashboard, `manager.ensure`, cây agent, `/bm-worker-stop-all`, dừng Reviewer) nhận vai theo nhãn, và khi thiếu nhãn thì theo provider.

- Danh sách đọc hết mọi trang.
- Manager có nhãn được ưu tiên; Manager không nhãn không bị đổi mode.
- Chat của agent không nhãn có chip `Not started by paseo-bm`; cây agent ghi `· no label`.

**Nguồn:** REQ-061 (a), (b), (c); thiết kế §4.1–§4.4, F1. **Phụ thuộc:** none.

**Ranh giới:** `contracts.ts` là hợp đồng giữa server và client của plugin. Trường `labelled` mới có mặc định `true`, nên làm phía server trước hay client trước đều không vỡ. Phía server (nhận diện, danh sách) và phía client (chip, cây) chứng minh riêng được.

**Phạm vi:**

- `plugin/server/agent-role.ts` (mới);
- `plugin/server/dashboard-rpc.ts` (`bmAgentsOf`, `AgentFacts`);
- `plugin/server/chat-rpc.ts`;
- `plugin/server/manager.ts` (`findLiveManagers`, `ensureManager`, `listWorkspaceAgents`; `listAllAgents` chuyển sang `agent-role.ts`);
- `plugin/server/stop-propagation.ts`;
- `plugin/server/role-hook.ts` (import `ROLE_BY_PROVIDER`);
- `plugin/shared/contracts.ts` (`labelled` trong `chatPeerSchema`, `agentNodeSchema`, có mặc định);
- `plugin/client/chat-card.tsx` (chip, dòng giải thích);
- `plugin/client/tree.tsx`;
- test tương ứng.

**Điều kiện ra:**

- mọi ca của thiết kế §6 cho `roleOfAgent`, `listAllAgents` / `bmAgentsOf`, `chat.peers`, `manager.ensure`, cây agent, dừng agent đều xanh, gồm:
  - ca dữ liệu giống workspace "Refactor Dependency";
  - đối chứng âm > 200 agent mỗi vai;
  - Manager không nhãn không bao giờ nhận thông báo dừng;
- các ca đang có của `chat.peers`, `manager.ensure`, cây agent, dừng agent không sửa kỳ vọng, trừ trường `labelled` mới;
- `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint` và các file test đó mã 0.

### WP-278 — Agent `bm-*` tạo thiếu nhãn được gắn nhãn

**Kết quả:** `on("agent.created")` gắn `bm.role` (Manager thêm `bm.modeSet` = mode hiện tại) cho agent `bm-*` vừa tạo thiếu nhãn, bằng một lệnh `paseo agent update`.

- Không lệnh nào cho agent đã có nhãn.
- Lỗi chỉ tốn một dòng log.
- Mỗi lần plugin nạp, một lượt quét gắn nhãn theo cùng cách cho agent `bm-*` chưa lưu trữ đang thiếu nhãn (Q6 a). Lượt quét bắt đầu ở sự kiện `agent.turn_started` / `agent.created` đầu tiên sau khi nạp (thiết kế §4.5, errata) và chạy nền.

**Nguồn:** REQ-061 (d); thiết kế §4.5, F2. **Phụ thuộc:** WP-277.

**Phạm vi:**

- `plugin/server/agent-labels.ts` (mới);
- `plugin/server/paseo-cli.ts` (`setAgentLabels`);
- `plugin/index.server.ts` (đăng ký);
- test với CLI giả.

**Điều kiện ra:**

- ca của thiết kế §6 cho `agent-labels` xanh;
- không test nào chạy `paseo` thật;
- `npm run typecheck:plugin` và test mã 0.

### WP-279 — Bộ kiểm template, chip "template error", bản dự phòng đọc được

**Kết quả:**

- `checkBlocks` trả lỗi đúng luật của thiết kế §4.6 cho `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW`.
- Thẻ của khối sai có chip `template error` và danh sách lỗi.
- Thẻ không vẽ được thì vẽ `markdownOf(card.text)`.

**Nguồn:** REQ-061 (e), (g), (h); thiết kế §4.6, §4.8. **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/shared/bm-format.ts` (mới);
- `plugin/client/chat-cards.ts` (`formatIssues`);
- `plugin/client/chat-card.tsx`;
- `test/bm-format.test.ts` (mới), `test/plugin-chat-cards.test.ts`.

**Điều kiện ra:**

- mỗi luật của bảng §4.6 có một ca sai với đúng lỗi;
- các báo cáo thật ngày 2026-09-18 và mẫu trong ba file vai (điền giá trị) không lỗi;
- khối "mẫu" có `|` bị bỏ qua;
- các ca đang có của `toChatCard`, `markdownOf`, `drawAsCard` không sửa kỳ vọng;
- `npm run typecheck:plugin`, `npm run lint` và test mã 0.

### WP-280 — Người gửi khối sai nhận `BM-FORMAT`; ba vai biết xử lý

**Kết quả:**

- Ở lượt kết thúc của phía nhận (Manager với báo cáo, Worker với câu trả lời, Reviewer với review của chính nó), khối mới nhất sai của mỗi `(người gửi, requestId, loại)` sinh một thông báo `BM-FORMAT` theo chữ của thiết kế §4.7.
- Thông báo chỉ gửi khi người gửi không chạy; mỗi khối một lần, mỗi người gửi / request / loại tối đa 2 lần (Q8 a).
- Thông báo được nhận là thông báo của plugin, không bị đếm là lượt review.
- `manager.md`, `worker.md`, `reviewer.md` mỗi file có luật `BM-FORMAT` của thiết kế §4.10.

**Nguồn:** REQ-061 (f), (j); thiết kế §4.7, §4.10, F3, F4. **Phụ thuộc:** WP-277, WP-279.

**Phạm vi:**

- `plugin/server/format-check.ts` (mới);
- `plugin/server/notices.ts`;
- `plugin/index.server.ts`;
- `plugin/roles/{manager,worker,reviewer}.md` và `*-instructions.ts` sinh lại;
- `test/format-check.test.ts` (mới), `test/roles-content.test.ts`.

**Điều kiện ra:**

- mọi ca `format-check` của thiết kế §6 xanh, gồm:
  - `received` sai rồi `blocked` đúng → không báo;
  - người gửi đang chạy → không gửi, và được gửi ở một lần xét sau khi người gửi rảnh (ba loại lượt của thiết kế §4.7, gồm lượt của Worker cha với review);
  - ở lượt của chính người gửi, phía kiểm đã nhận tin mới hơn mốc → chưa gửi, lượt kế tiếp của phía kiểm quyết (errata thiết kế §4.7);
  - tin có `clientMessageId` → không kiểm;
- `reviewCallsOf` không đếm `BM-FORMAT`;
- ngưỡng dòng của ba file vai không nâng;
- `npm run verify` mã 0.

### WP-281 — Worker luôn biết mode Reviewer

**Kết quả:** tra cứu mode `bm-reviewer` hỏng thì `## Runtime facts` của Worker vẫn nêu mode Reviewer.

- Nguồn thứ nhất: danh sách đọc được lần gần nhất.
- Nguồn thứ hai: `auto` (Q9 a).
- Mỗi lần hỏng, và mỗi lỗi bất ngờ của `runtimeFactsOf`, có một dòng log.

**Nguồn:** REQ-061 (i); thiết kế §4.9, F5. **Phụ thuộc:** none.

**Phạm vi:**

- `plugin/server/role-mode.ts` (nhớ danh sách);
- `plugin/server/role-extras.ts`;
- `test/plugin-role-runtime-facts.test.ts`.

**Điều kiện ra:**

- ca mode Reviewer của thiết kế §6 xanh;
- các ca đang có của Runtime facts và của hook không sửa kỳ vọng;
- test mã 0.

### WP-282 — Áp delta vào tài liệu gốc và kiểm cả gói

**Kết quả:**

- PRD gốc có REQ-061 và dòng revision; thiết kế gốc và delta thẻ chat trỏ tới delta này; ba tài liệu delta chuyển sang Accepted / Active.
- `npm run verify` mã 0.
- Sau khi batch implementation pass: plugin được cài và nạp lại **một lần** theo thiết kế §4.11, chỉ khi mọi agent `bm-*` khác không chạy, sau khi `finished` đã gửi. Việc này là bước cuối của request, không phải điều kiện đóng bead.

**Nguồn:** PRD delta §5, §9; thiết kế §4.11. **Phụ thuộc:** WP-277, WP-278, WP-280, WP-281.

**Phạm vi:**

- `docs/product/paseo-bm-prd.md` (thêm REQ-061, revision);
- `docs/design/paseo-bm.md` (một dòng trỏ và revision);
- ba tài liệu delta này.

**Điều kiện ra:**

- `npm run verify` mã 0;
- `br lint -s all`, `br dep cycles` sạch;
- đọc lại REQ-061 khớp PRD delta §5.

## 4. Rủi ro

| Rủi ro | WP | Giảm thiểu |
|---|---|---|
| Luật kiểm chặt quá, báo nhầm | 279, 280 | Luật chỉ lấy từ mẫu vai; test với báo cáo thật; giới hạn thông báo |
| Thông báo cắt ngang việc | 280 | Không gửi vào lượt đang chạy; chữ "do not redo work" |
| CLI từ daemon không chạy | 278 | Nhận diện theo provider (WP-277) là bảo đảm |
| Request khác sửa cùng tệp (`chat-cards.ts`, `chat-card.tsx`, `manager.md`, `worker.md`, tài liệu gốc) | 277, 279, 280, 282 | Trước khi sửa code, kiểm Worker khác đang chạy; có thì `blocked` (Q10 a, thiết kế §4.11) |
| Bản sửa chưa tới daemon | 282 | Cài và nạp lại một lần sau khi pass (Q10 a) |
| Thông báo về `BM-ANSWERS` sai đến muộn, vì nó chỉ được xét khi lượt Worker (có thể dài) kết thúc | 280 | Chip trên thẻ hiện ngay; giới hạn đã nêu ở thiết kế §4.7 |

## 5. Kiểm thử của phase

- Theo thiết kế §6.
- Mỗi WP chạy test của chính nó; WP-280 và WP-282 chạy `npm run verify`.
- Repo không đặt ngưỡng coverage. Thay vào đó, mỗi luật của thiết kế §4.6 và mỗi ca của thiết kế §6 có ít nhất một test, kèm đối chứng âm ở chỗ thiết kế nêu.
- Không test nào chạm daemon, `paseo` hay `$HOME` thật.

## 6. Revision History

| Ngày | Ai | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta theo Q1–Q5 của `req-20260918T071130Z`; Status Draft |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | WP-277 → WP-281 xong; WP-282: REQ-061 áp vào PRD gốc, thiết kế gốc trỏ tới delta; owner chốt Q14 a (trần dòng file vai) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi implement WP-280: mốc chống báo khối cũ chỉ xét ở lượt của người gửi, khác mốc thì giữ lại (thiết kế §4.7) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi chuyển thành beads: điểm bắt đầu lượt quét của WP-278 (thiết kế §4.5) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Cổng `plan-ready-for-beads` PASS; Status Active; phạm vi Phase 2a-11 (WP-277 → WP-282) khoá |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review `b2` (blocking): điều kiện ra WP-280 thêm lần xét sau khi người gửi rảnh và mốc chống báo khối cũ |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: phase 2a-11, Plan-ready Pending, bảng câu hỏi mở, ranh giới hợp đồng WP-277, rủi ro `BM-ANSWERS` đến muộn. Owner chốt Q6–Q10; câu hỏi mở đóng |
