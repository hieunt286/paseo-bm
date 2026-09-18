# Delta plan — Rà soát và đơn giản hoá phần UI/UX ngày 2026-09-18

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918f-ui-review` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ.** Delta này thêm WP-270 → WP-276 vào Phase 2a-10 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review b1 pass ở lần re-review) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T063746Z` |
| Source design | [design-delta-20260918f-ui-review](../design/paseo-bm-delta-20260918f-ui-review.md) — nguồn duy nhất cho mã phát hiện (F1–F14, S1–S12), tên hàm, hình dạng và ca kiểm thử |
| Source PRD | Không có PRD delta — không thêm kết quả sản phẩm. Mỗi F đưa hành vi về đúng REQ hay câu thiết kế đã duyệt ghi ở cột "Đúng theo" (thiết kế §3.1); S là dọn không đổi hành vi. Gỡ tính năng ghim (Q11 c): [prd-delta-20260918f-remove-pinning](../product/paseo-bm-prd-delta-20260918f-remove-pinning.md) sửa REQ-060 (e) của [PRD Dashboard](../product/paseo-bm-dashboard-prd.md). Delta ở Review, `prd-ready` PASS, chờ owner duyệt; WP-276 .2 áp nó sau khi được duyệt |
| Routing decision | [design delta §0](../design/paseo-bm-delta-20260918f-ui-review.md#0-routing-decision) — brownfield + refactor, **Large**: nhiều thành phần độc lập, gỡ một tính năng người dùng đang dùng, hợp đồng `launcher.order.*` bị bỏ và `chat.peers` thêm một trường, bàn giao nhiều phiên |
| Phase | Phase 2a-10 (nhãn bead `phase:2a-10`) |

## 1. MVP-Lock

- **Trong phạm vi:** F1–F5 và F9–F14, S1–S12 của thiết kế §3; gỡ tính năng ghim (thiết kế §4.5, Q11 c); `GUIDE.md`, errata và sửa REQ-060 (e) ở thiết kế §4.12.
- **Ngoài phạm vi:**
  - mọi mục ở thiết kế §3.3 (gợi ý);
  - `plugin/roles/*.md`, `*-instructions.ts`, hook `agent.create`;
  - code server cũ: `bm-report.ts` trùng, khoá của `manager.ensure`, chặn chạy trùng của `installTool`, cache `beads-store`;
  - batch `b6` của delta 20260918d, và pill quay lại sau khi đã trả lời (owner chốt Q18 b ở request đó);
  - gỡ tính năng nào khác ngoài ghim; đổi thứ tự chip lọc; F6–F8 (tính năng bị gỡ);
  - nâng phiên bản gói, phát hành, commit, cài hay nạp lại plugin trên daemon của owner.
- **Điều kiện vào:**
  - Q1 a: không bead nào ngoài WP-270 được bắt đầu trước khi WP-270 đóng;
  - WP-272 .1 (gỡ ghim) chỉ bắt đầu khi `prd-delta-20260918f-remove-pinning` đã được owner duyệt. Owner duyệt ở bước xác nhận trước khi implement.
- **Điều kiện ra của delta:**
  1. mọi bead của request đóng kèm bằng chứng;
  2. `npm run verify` mã 0;
  3. `br lint -s all` không cảnh báo cho bead của request;
  4. review implementation (batch `b3`) không còn phát hiện chặn;
  5. `prd-delta-20260918f-remove-pinning` đã được owner duyệt (Accepted) và đã áp vào REQ-060 (e).

  Owner tự kiểm trên daemon thật sau `finished`. Không bead nào chờ việc đó.
- **Hợp đồng đang được tiêu thụ:** `launcher.order.get` / `launcher.order.set` bị bỏ (WP-272 .1); `chat.peers` thêm `archived: boolean` (WP-274 .2).
  - Nhà cung cấp là `dashboard-rpc.ts` (ghim) và `handleChatPeers`; người tiêu thụ duy nhất là client của chính plugin (`launcher.tsx`, `chat-cards.ts`).
  - Paseo nạp client và server từ cùng một thư mục plugin, nên không có client cũ nói chuyện với server mới hay ngược lại.
  - Bằng chứng: hai danh sách RPC chính xác không còn `launcher.order.*`; một ca hình dạng mới cho `chatPeerSchema` trong `test/plugin-dashboard-contracts.test.ts`.
- **Câu hỏi mở:** không còn. Q1–Q12 đã chốt (thiết kế §1).
- **Tư thế hoàn tác mặc định:** mỗi bead hoàn tác bằng cách revert đúng các file trong phạm vi của nó. Không dữ liệu lưu bền nào đổi.

## 2. Thứ tự và vì sao

Chỉ có ba phụ thuộc thật:

- mọi bead sau WP-270, vì code chỉ được sửa trên nền sạch (Q1 a);
- WP-271 `.2` sau `.1`, vì nó dùng `Slot` mà `.1` tạo ra;
- WP-275 và WP-276 `.2` sau mọi bead code: WP-275 dọn comment theo code cuối, WP-276 `.2` chạy `npm run verify` trên toàn gói.

Các bead còn lại **làm lần lượt**, theo thứ tự dưới đây, để không hai bead cùng sửa một file một lúc. Đó là chuyện tránh xung đột, không phải phụ thuộc:

- `launcher.tsx`: WP-271 `.1`–`.4`, WP-272 `.1`;
- `beads-screen.tsx`: WP-271 `.3`, WP-273 `.1`, `.2`;
- `chat-cards.ts`: WP-274 `.1`, `.2`.

```
WP-270 ──> WP-271 (.1 ──> .2, .3, .4) ─┐
       ──> WP-272 (.1)                ├──> WP-275 ──> WP-276 .2
       ──> WP-273 (.1, .2)            │
       ──> WP-274 (.1, .2, .3)        ┘
       ──> WP-276 .1 ─────────────────────────────> WP-276 .2
```

## 3. Work packages

**Ràng buộc chung cho mọi WP có code.** Đây là quy ước test đang có:

- `test/plugin-launcher.test.ts` nạp `index.client.tsx` với `vi.mock("react-native")` chỉ có `ActivityIndicator`, `Pressable`, `ScrollView`, `Text`, `View`. Một file `.tsx` **không** được dùng giá trị của `react-native` ở cấp module; chỉ dùng trong thân component.
- Root tsconfig không có `jsx`, nên test nạp file `.tsx` qua một specifier không literal.
- Không file nào dưới `test/` import `react-native` như một giá trị (`AGENTS.md`); `import type` thì được.
- View không hook được test bằng bộ dựng cây phần tử. WP-271 `.3` chuyển nó từ `test/agent-tree.test.ts` sang `test/helpers/element-tree.ts`; `agent-tree.test.ts` import lại từ đó, và không kỳ vọng nào của nó đổi.
- Lệnh test là `npm test -- <file>`, không dùng `npx` (`AGENTS.md`).
- Mỗi lỗi F: viết test trước, **thấy nó đỏ** trên code cũ, rồi sửa. Đối chứng âm ghi trong lý do đóng bead.

### WP-270 — Nền sạch trước khi sửa code

**Kết quả:** ba request đang chạy song song đã xong và việc của chúng đã được commit, nên diff của request này tách riêng được.

- Ba request đó: `req-20260918T035101Z` (reviewer mode), `req-20260918T041426Z` (card replies, gồm `b6`), `req-20260918T064258Z` (CI).

**Nguồn:** Q1 a; thiết kế §8 dòng 1. **Phụ thuộc:** none (chờ owner).

**Phạm vi:** không sửa file nào. Chỉ đọc `git status --short`, `git log`, trạng thái ba Worker, và chạy `npm run verify`.

**Điều kiện ra:**

- ba Worker kia đã báo `finished` (đọc qua `get_agent_status`/`list_agents`, hoặc owner nói vậy);
- `git status --short` chỉ còn file của request này: `docs/design/paseo-bm-delta-20260918f-ui-review.md`, `docs/plans/paseo-bm-implementation-plan-delta-20260918f-ui-review.md`, `.beads/issues.jsonl`;
- `npm run verify` mã 0 trên nền đó. Nền đỏ thì dừng và hỏi owner, không sửa hộ request khác.

### WP-271 — Surface Beads Manager: thông báo, lần mở chờ, đầu màn, đọc số liệu

#### WP-271 .1 — Bỏ thông báo thì ẩn ngay; ba hàng đợi thành một `Slot` (F1, S1)

- **Nguồn:** thiết kế §4.1.
- **Phạm vi:**
  - `plugin/client/slot.ts` (mới);
  - `plugin/client/launch-manager.ts`: `launchRequests`, `selectFromCommandCenter`;
  - `plugin/client/dashboard-view.ts`: `dashboardRequests`, `launcherNotices`, `selectDashboardFromCommandCenter`;
  - `plugin/index.client.tsx`: `post` → `put`;
  - `plugin/client/launcher.tsx`: kiểu;
  - test: `test/plugin-dashboard-view.test.ts`, `test/plugin-launcher.test.ts`, `test/plugin-slash-commands.test.ts`, chỉ đổi tên gọi.
- **Điều kiện ra:**
  - ca mới "take báo cho listener đúng một lần; take khi trống không báo; listener gọi take không lặp" đỏ trên code cũ, xanh sau;
  - đối chứng âm: bỏ lệnh gọi listener trong `take` → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-dashboard-view.test.ts test/plugin-launcher.test.ts test/plugin-slash-commands.test.ts` mã 0.

#### WP-271 .2 — Yêu cầu mở Manager chờ lần mở đang chạy (F2)

- **Nguồn:** thiết kế §4.2. **Phụ thuộc:** WP-271 .1.
- **Phạm vi:** `launch-manager.ts` `runPendingRequest`; `launcher.tsx` effect chạy yêu cầu (nghe cả `managerLauncher`); `test/plugin-launcher.test.ts`.
- **Điều kiện ra:**
  - ca "launcher pending → trả null, yêu cầu còn trong ô; hết pending → mở đúng workspace đó" đỏ trước, xanh sau;
  - đối chứng âm: `take()` trước khi kiểm `pending` → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-launcher.test.ts` mã 0.

#### WP-271 .3 — Một đầu màn cho Beads và Metric: dải trạng thái và nút ← đúng (F3, F4, S3, S5)

- **Nguồn:** thiết kế §4.3.
- **Phạm vi:**
  - `plugin/client/ui.tsx`: `WorkspaceScreenProps`, `WorkspaceScreenHeader`;
  - `plugin/client/dashboard-view.ts`: `backLabelOf`;
  - `plugin/client/beads-screen.tsx`, `plugin/client/dashboard.tsx`: chỉ dòng đầu và props;
  - `plugin/client/launcher.tsx`: truyền `status` và `backLabel`, một hàm `goBack` (S5);
  - `test/helpers/element-tree.ts` (mới, chuyển từ `test/agent-tree.test.ts`);
  - `test/plugin-workspace-screen.test.ts` (mới), `test/plugin-dashboard-view.test.ts`.
- **Điều kiện ra:**
  - ca dựng `WorkspaceScreenHeader` (có/không `status`, có/không `onBack`, nhãn = `backLabel`), ca `backLabelOf` cho bốn view, và assert nguồn "hai nhánh `dashboard`/`beads` truyền `status`" đỏ trước, xanh sau;
  - đối chứng âm: bỏ `status={status}` ở một nhánh → đỏ;
  - `test/agent-tree.test.ts` xanh nguyên sau khi đổi chỗ bộ dựng;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-workspace-screen.test.ts test/plugin-dashboard-view.test.ts test/agent-tree.test.ts test/plugin-beads-screen.test.ts` mã 0.

#### WP-271 .4 — Số liệu workspace chỉ đọc khi danh sách đang hiện (F5)

- **Nguồn:** thiết kế §4.4.
- **Phạm vi:** `dashboard-view.ts` `overviewPolling`; `launcher.tsx` query overview; `test/plugin-dashboard-view.test.ts`, `test/plugin-launcher.test.ts` (assert nguồn).
- **Điều kiện ra:**
  - ca `overviewPolling` cho bốn view và assert nguồn đỏ trước, xanh sau;
  - đối chứng âm: bật poll cho mọi view → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-dashboard-view.test.ts test/plugin-launcher.test.ts` mã 0.

### WP-272 — Gỡ tính năng ghim workspace (Q11 c)

#### WP-272 .1 — Danh sách Workspaces chỉ xếp theo hoạt động gần nhất; ★ ▲▼, kéo-thả và `launcher.order.*` bị gỡ

- **Nguồn:** thiết kế §4.5; owner chốt Q11 c, Q12 a. F6–F8 không sửa vì tính năng bị gỡ.
- **Phạm vi (đúng danh sách ở thiết kế §4.5):**
  - client: `pinned-order.ts` (xoá file); `launcher.tsx` (`DragHandle`, `PinControls`, query và RPC thứ tự ghim, `savePinned`, `rowHeight`, `dragging`, `scrollEnabled`, `onLayout` đo dòng);
  - hợp đồng: `contracts.ts` (`launcherOrderOutput`, `launcherOrderGetRpc`, `launcherOrderSetRpc`);
  - server: `launcher-order.ts` (xoá file sau khi chuyển `UI_DIR_NAME` sang `install-home.ts`); `answer-marks.ts` import `UI_DIR_NAME` từ `install-home.ts`; `dashboard-rpc.ts` (hai handler và import);
  - test: xoá `test/plugin-pinned-order.test.ts` và `test/plugin-launcher-order.test.ts`. Trước khi xoá, đọc từng ca: ca nào kiểm thứ khác ngoài ghim thì chuyển sang file khác, không xoá. Bỏ hai tên `launcher.order.*` khỏi danh sách RPC chính xác của `test/plugin-bundle-cjs.test.ts` và `test/rpc-list-describe.test.ts`. Thêm một assert nguồn vào `test/plugin-launcher.test.ts`: danh sách vẽ `workspaces.data` theo thứ tự nhận được.
- **Không đụng:** file `<install home>/ui/launcher-order.json` và thư mục `ui/` trên máy owner.
- **Điều kiện ra:**
  - `grep -rn "launcher.order\|launcherOrder\|pinned-order\|PinControls\|DragHandle\|savePinned" plugin/ test/` không còn kết quả;
  - đối chứng âm: thêm tạm một `launcher.order.get` vào contracts và server → hai test danh sách RPC đỏ, rồi hoàn lại;
  - test của `answer-marks` xanh nguyên sau khi đổi chỗ import;
  - `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-launcher.test.ts test/plugin-bundle-cjs.test.ts test/rpc-list-describe.test.ts test/plugin-answer-marks.test.ts test/plugin-launcher-running-dot.test.ts` mã 0.
- **Hoàn tác:** revert các file trên (và khôi phục hai file test đã xoá từ git). File `launcher-order.json` của owner còn nguyên, nên thứ tự ghim cũ quay lại.

### WP-273 — Màn Beads

#### WP-273 .1 — Bead đang mở giữ nguyên khi đổi nhóm (F9)

- **Nguồn:** thiết kế §4.7.
- **Phạm vi:** `beads-model.ts` `beadListItems`; `beads-screen.tsx`, chỉ phần vẽ danh sách; `test/plugin-beads-screen.test.ts`.
- **Điều kiện ra:**
  - ca `beadListItems` (khoá = id, đổi nhóm giữ khoá, thứ tự và giới hạn 200 như `groupBeads`) và assert nguồn "không bọc `View` theo nhóm" đỏ trước, xanh sau;
  - đối chứng âm: bọc lại theo nhóm → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-beads-screen.test.ts` mã 0.

#### WP-273 .2 — Một khung dòng bead cho màn Beads và panel "Beads in this chat" (S4)

- **Nguồn:** thiết kế §3.2 S4.
- **Phạm vi:**
  - `plugin/client/ui.tsx` `BeadRowCard`: view không hook; props `bead`, `open`, `onToggle`, `meta: ReactNode` (phần giữa), `detail: ReactNode` (vẽ khi mở);
  - `BeadDetailPanel` ở lại `beads-screen.tsx` và được truyền vào qua `detail`, để `ui.tsx` không import `beads-screen.tsx` (tránh vòng import);
  - `beads-screen.tsx`, `bead-chips.tsx`;
  - `test/plugin-workspace-screen.test.ts`.
- **Điều kiện ra:**
  - ca dựng `BeadRowCard` cho hai cách dùng: tên màu theo trạng thái, không đậm, ▸/▾, id, chip trạng thái, phần giữa đúng của từng nơi, `BeadDetailPanel` chỉ khi mở;
  - các test hiện có của hai màn xanh nguyên;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-beads-screen.test.ts test/plugin-chat-beads.test.ts test/agent-tree.test.ts` mã 0.

### WP-274 — Thẻ chat và pill (trên code cuối sau `b6`)

**Luật riêng (thiết kế §8 dòng 2):**

- trước mỗi bead, đọc lại đoạn code của phát hiện trên code cuối;
- phát hiện nào `b6` đã sửa thì đóng bead bằng bằng chứng "không còn áp dụng": đoạn code và lệnh đã đọc;
- phát hiện mới thì gửi `blocked` hỏi owner, không tự thêm phạm vi.

#### WP-274 .1 — Chip bead tra trước, cắt sau (F10)

- **Nguồn:** thiết kế §4.8.
- **Phạm vi:** `chat-cards.ts` `beadChipsView`; `bead-chips.tsx` `BeadChips` (thêm `expanded`, `onExpand`, chip "…"); `chat-card.tsx` (bỏ "…" riêng); `test/plugin-chat-cards.test.ts`.
- **Điều kiện ra:**
  - ca `beadChipsView` (ứng viên có `BM-REPORT` và `local-first`, tìm thấy 3 → hiện 2, `hidden` 1; tìm thấy rỗng → không gì) đỏ trước, xanh sau;
  - đối chứng âm: cắt ứng viên trước khi tra → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-chat-cards.test.ts test/plugin-chat-beads.test.ts` mã 0.

#### WP-274 .2 — Một luật "Worker của request" cho `chat.waiting` và thẻ (F11, F12, S8)

- **Nguồn:** thiết kế §4.9.
- **Phạm vi:**
  - `plugin/shared/sole-worker.ts` (mới): `soleWorkerOf`, thuần, không phụ thuộc môi trường;
  - `plugin/shared/contracts.ts`: `chatPeerSchema.archived`;
  - `plugin/server/chat-rpc.ts`: `peersOfWorkspace`, `handleChatPeers`;
  - `plugin/server/chat-waiting.ts`: chỉ workspace có Manager sống; bỏ `try/catch` thừa;
  - `plugin/client/chat-cards.ts`: `replyTarget`, `partiesOf`;
  - test: `test/plugin-chat-waiting.test.ts`, `test/plugin-chat-cards.test.ts`, `test/plugin-dashboard-contracts.test.ts`.
- **Điều kiện ra:**
  - các ca sau đỏ trước, xanh sau:
    - "workspace không có Manager → không đọc kho vết" (đếm lần gọi);
    - "Worker hỏng đã lưu trữ + Worker mới cùng `requestId` → một pill và `replyTarget` chọn Worker mới";
    - `soleWorkerOf`: một / không / hai / một sống + một lưu trữ;
    - hình dạng `chatPeerSchema` có `archived`;
  - đối chứng âm: `soleWorkerOf` tính cả agent đã lưu trữ → đỏ;
  - `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-chat-waiting.test.ts test/plugin-chat-cards.test.ts test/plugin-dashboard-contracts.test.ts test/plugin-bundle-cjs.test.ts` mã 0.

#### WP-274 .3 — Pill: popover không bị dựng lại, khoá đổi khi nội dung đổi (F13, F14)

- **Nguồn:** thiết kế §4.10.
- **Phạm vi:** `waiting-pills.tsx`; `waiting-pills-model.ts` (khoá có `requestId` và băm nội dung); `test/plugin-waiting-pills.test.ts`.
- **Điều kiện ra:**
  - ca "cập nhật pill giữ cùng `Content`, `Content` đọc mục mới nhất" và ca "cùng số câu, `at` null, nội dung khác → `update`" đỏ trước, xanh sau;
  - đối chứng âm: tạo `Content` mới mỗi lần → đỏ; bỏ băm khỏi khoá → đỏ;
  - `npm run typecheck:plugin`, `npm run lint`, `npm test -- test/plugin-waiting-pills.test.ts` mã 0.

### WP-275 — Dọn code chết và hàm trùng, không đổi hành vi (S2, S6, S7, S9–S12)

- **Nguồn:** thiết kế §3.2, §4.11. **Phụ thuộc:** mọi bead của WP-271 → WP-274.
- **Phạm vi:** đúng các chỗ ở bảng §3.2 cho S2, S6, S7, S9, S10, S11, S12. S12 kiểm lại trên code cuối; nhánh còn chạy được thì giữ và ghi lý do.
- **Điều kiện ra:**
  - so `git diff --stat` trước và sau bead: các file bead này sửa đều nằm trong bảng §3.2;
  - không kỳ vọng test nào bị bỏ hay nới. Test chỉ đổi theo §4.11: tên hàm, kiểu, tên ca, cách ly;
  - `npm run typecheck`, `npm run typecheck:plugin`, `npm run lint`, `npm test` mã 0.

### WP-276 — Tài liệu

#### WP-276 .1 — `GUIDE.md` tả đúng các màn đã đổi hôm nay

- **Nguồn:** thiết kế §4.12; Q3 a.
- **Phạm vi:** `GUIDE.md`: bốn mục kể ở thiết kế §4.12. Không mục khác.
- **Điều kiện ra:**
  - `grep -n "gear button\|Created / closed, last 14 days\|⚙ Setup" GUIDE.md` không còn kết quả;
  - mỗi câu mới đọc lại được với code hay REQ đã duyệt (ghi nguồn trong lý do đóng bead);
  - các link neo của mục lục vẫn trỏ đúng (tên mục không đổi, hoặc mục lục đổi theo).

#### WP-276 .2 — Errata tài liệu, ghi nhận delta, kiểm cả gói

- **Nguồn:** thiết kế §4.12. **Phụ thuộc:** WP-275, WP-276 .1.
- **Phạm vi:**
  - dòng errata và Revision History ở các delta kể trong thiết kế §4.12, gồm dòng trỏ ở §4.1 của delta 20260917e;
  - PRD Dashboard: áp `prd-delta-20260918f-remove-pinning` vào REQ-060 (e) đúng như câu ở §5 của delta đó, kèm một dòng Revision History. Status của PRD Dashboard giữ Accepted, vì delta đã được owner duyệt; Status của PRD delta ghi Accepted với ngày duyệt;
  - một dòng Revision History ở Technical Design Dashboard;
  - Status của design delta và plan delta này.
- **Điều kiện ra:**
  - `npm run verify` mã 0;
  - `br lint -s all` không cảnh báo cho bead của request;
  - `br dep cycles` không có vòng.

## 4. Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Nền chưa sạch khi owner muốn bắt đầu | WP-270 chặn mọi bead; nền đỏ thì hỏi, không sửa hộ request khác |
| `b6` đổi code thẻ chat | Luật riêng của WP-274 |
| `answer-marks.ts` (`b6`) import `UI_DIR_NAME` từ `launcher-order.ts` | WP-272 .1 chuyển hằng số sang `install-home.ts` trước khi xoá file; grep mọi import từ `launcher-order` trên code cuối |
| Assert nguồn gãy khi refactor | Chỉ dùng cho chỗ đặt (như các ca hiện có). Hàm thuần và view không hook là bằng chứng chính |
| Đổi tên `request`/`post` → `put` bỏ sót chỗ gọi | `npm run typecheck` và `typecheck:plugin` bắt mọi chỗ gọi cũ |
| Dọn code ở WP-275 lỡ đổi hành vi | Bộ test hiện có xanh nguyên; không kỳ vọng nào bị nới |

## 5. Kiểm thử của phase

- **Unit:** hàm thuần mới (`createSlot`, `overviewPolling`, `backLabelOf`, `beadListItems`, `beadChipsView`, `soleWorkerOf`, khoá pill) bằng Vitest.
- **View không hook:** `WorkspaceScreenHeader`, `BeadRowCard` bằng bộ dựng cây phần tử.
- **Handler server:** `chat.waiting` và `chat.peers` với Paseo giả.
- **Gỡ tính năng:** grep không còn dấu vết; danh sách RPC chính xác.
- **Toàn gói:** `npm run verify`.
- **Chạy thật:** owner, sau `finished`.
- **Độ phủ:** không đặt ngưỡng phần trăm (repo không có). Mỗi lỗi F có ít nhất một ca đỏ trước khi sửa và một đối chứng âm đã thấy đỏ.

## 6. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review implementation `b3` pass, không có phát hiện nào (Reviewer 5cb1ca69). Điều kiện ra 4 đạt; điểm `[confirm]` còn lại là owner tự kiểm trên daemon thật |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Phase 2a-10 hoàn thành 2026-09-18** (bead `bm-wp-270-ui-review-v0o1.1`–`.26`). Cổng `feature-done`, profile standard, tự chấm: mọi leaf đã đóng kèm bằng chứng; `npm run verify` mã 0 (typecheck, typecheck:plugin, lint, 102 file / 2343 test, build); `br lint -s all` sạch cho bead của request; `br dep cycles` không vòng; không đặt ngưỡng độ phủ. Hợp đồng: `launcher.order.*` bỏ và `chat.peers.archived` thêm, bằng chứng là hai danh sách RPC chính xác và ca `chatPeerSchema`, client và server ship cùng bundle. Tài liệu: PRD Dashboard (REQ-060 e) và PRD delta Accepted; design delta Applied; errata ở các delta 20260916-chat-cards, 20260917e, 20260918d, 20260918e; `GUIDE.md`. Không có bead `discovered`, TODO, cờ tính năng hay code tạm. Hai điểm `[confirm]` chưa có bằng chứng: điều kiện ra 4 (review implementation `b3`) chạy ngay sau dòng này; owner tự kiểm trên daemon thật sau `finished`. Không bead nào bị tách sau khi đã bắt đầu implement (các lần tách đều ở `polishing-beads` và review `b2`). Status giữ Active |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `plan-ready-for-beads` PASS sau review b1 (pass ở lần re-review). Status → Active; phạm vi Phase 2a-10 đóng băng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Review b1 (một phát hiện chặn): Source PRD trỏ tới PRD delta mới (Review); điều kiện vào của WP-272 .1 và điều kiện ra 5 đòi delta đó được duyệt; WP-276 .2 chỉ áp delta đã Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner chốt Q6 a, Q7 a, Q10 a, Q11 c, Q12 a: WP-272 viết lại thành một bead gỡ tính năng ghim; WP-276 .2 thêm sửa REQ-060 (e) và dòng trỏ ở delta 20260917e; không còn câu hỏi mở |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: Plan-ready = Pending; thêm dòng Source PRD N/A; hợp đồng `chat.peers` ghi nhà cung cấp, người tiêu thụ, tương thích và bằng chứng; câu hỏi mở chặn WP nào; WP-272 ghi các ca assert nguồn phải đổi và ca thay thế; chốt file ở WP-272 .2, WP-273 .2, WP-274 .2; bằng chứng phạm vi file của WP-275 so trước/sau |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Tạo plan delta: WP-270 → WP-276, Phase 2a-10 |
