# Delta plan — Manager mặc định Bypass, số đo model của từng agent, và báo cáo chỉ dẫn theo model

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260918-manager-mode-model-metrics` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) — **không sửa tại chỗ**; delta này thêm WP-243 → WP-249 vào Phase 2a-6 |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Applied** — 2026-09-18. WP-243 → WP-249 xong; điều kiện ra 2 đạt với một điểm chưa quan sát (Manager mới mở ở Bypass), owner chấp nhận — xem §8 |
| Plan-ready | **PASS — 2026-09-18 — hieu.nt10** (Beads Worker tự chấm sau review b1 pass; xem §6) |
| Owner | hieu.nt10 |
| Created | 2026-09-18 |
| Request | `req-20260918T011706Z` |
| Source design | [design-delta-20260918-manager-mode-model-metrics](../design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) — nguồn duy nhất cho hành vi, hợp đồng và chín kết quả kiểm chứng N1–N9 |
| Source PRD | [prd-delta-20260918-manager-mode-model-metrics](../product/paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md) — REQ-026c, NFR Quyền, REQ-058; quyết định Q31–Q35 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md#0-routing-decision) — brownfield, **Large**: quyền, trường cộng thêm vào dữ liệu lưu bền và hợp đồng RPC, ba thành phần độc lập |
| Phase | Phase 2a-6 (nhãn bead `phase:2a-6`) |

## 1. MVP-Lock

- **Trong phạm vi:** toàn bộ §4 của delta thiết kế; REQ-058 (a)–(f); REQ-026c và NFR Quyền theo PRD delta §2.3.
- **Ngoài phạm vi:**
  - sửa `plugin/roles/*.md` hay thêm biến thể chỉ dẫn theo provider (Q33) — đề xuất của báo cáo WP-248 là việc owner quyết sau;
  - một lượt đo thật trên daemon để so chất lượng theo model (Q33);
  - đổi mode của Worker hay Reviewer, đổi hook `before("agent.create")`;
  - ghi `modeId` vào `~/.paseo/config.json` hay đổi installer (Q31);
  - provider ngoài Claude Code, Codex và một đoạn về OpenCode (Q35).
- **Điều kiện ra của delta:**
  1. `npm run verify` mã 0.
  2. Trên daemon thật, owner tự xác nhận: một Manager mới mở ra ở `Bypass`; một Manager cũ ở `Always Ask` được chuyển sau một lần mở, và đổi tay sau đó thì không bị đè; Dashboard hiện model, thinking và mode của từng agent của một request mới.
  3. Báo cáo WP-248 có mặt, trả lời đủ R1–R6, mỗi khẳng định có nguồn.
  4. PRD, PRD Dashboard, hai thiết kế gốc và `AGENTS.md` mang đúng các dòng liệt kê ở WP-249.
- **Câu hỏi mở:** không còn. O1/O2 (cho WP-244) và O3 (cho WP-246) đã được owner chốt ngày 2026-09-18 thành Q36–Q38; Q39 giữ đường CLI của WP-244 như thiết kế (thiết kế §8).
- **Tư thế hoàn tác mặc định:** mỗi WP hoàn tác bằng cách revert các tệp của chính nó. Không có điểm không đảo ngược trong mã hay dữ liệu: `runtime` là trường tuỳ chọn, nên bản ghi đã ghi vẫn đọc được sau khi revert (lược đồ bỏ khoá lạ). **Ngoại lệ duy nhất là trạng thái agent của người dùng:** mode đã đổi và nhãn `bm.modeSet` trên một Manager thật (WP-243, WP-244) **không** tự quay lại khi revert mã — người dùng đổi lại mode trong Paseo; nhãn còn lại là vô hại.

## 2. Thứ tự và vì sao

Hai phụ thuộc thật:

- **WP-244 cần WP-243**: chuyển Manager cũ dùng lại hàm mode đích và nhãn `bm.modeSet` mà WP-243 tạo ra; chưa có nhãn thì không có cách nào phân biệt Manager "đã xử lý" với Manager cũ.
- **WP-246 và WP-247 cần WP-245**: hai màn hình đọc trường `runtime` và khoá "model hiệu lực" mà WP-245 ghi và định nghĩa.

WP-248 (báo cáo) độc lập với mọi WP mã. WP-249 đóng delta, phụ thuộc cả sáu.

```
WP-243 ──> WP-244 ──────┐
WP-245 ──> WP-246 ──────┤
       └─> WP-247 ──────┼──> WP-249
WP-248 ─────────────────┘
```

## 3. Work packages

### WP-243 — Manager mới khởi động ở mode không hỏi quyền

**Kết quả:** `manager.ensure` tạo Manager với `config.modeId` = mode đích (thiết kế §4.1) và nhãn `bm.modeSet=<mode>`.

**Nguồn:** REQ-026c (PRD delta §2.3 vị trí 1); thiết kế §4.1 "Mode đích", "Nhãn đánh dấu", "Manager mới"; N1, N3. **Phụ thuộc:** none.

**Phạm vi:** `plugin/server/role-mode.ts` (hàm `managerModeFor`), `plugin/server/manager.ts` (nhánh tạo; đọc mode của provider qua `withTimeout`), `plugin/index.server.ts` nếu phải truyền thêm phụ thuộc. Không đổi hook `before("agent.create")`.

**Nghiệm thu:**
- Profile không có `modeId`, provider có `bypassPermissions`[dangerous] → Manager tạo với `modeId: "bypassPermissions"` và nhãn `bm.modeSet: "bypassPermissions"`.
- Profile có `modeId` mà provider liệt kê → dùng mode đó, nhãn mang mode đó.
- Provider không có mode `dangerous` → không truyền `modeId`, không nhãn, có một dòng log.
- `listModes` lỗi hoặc quá 5 giây → Manager vẫn được tạo như hôm nay, không nhãn, có log.
- Không bao giờ **tự** chọn mode `planning`; mode tự đặt trên profile thì luôn thắng, kể cả `planning` (Q31).
- **Đối chứng âm:** trả `undefined` từ `managerModeFor` thì test ca đầu phải đỏ.
- `npm run verify` mã 0.

### WP-244 — Manager đang có được chuyển một lần khi mở lại

**Kết quả:** mở màn hình Manager cho một Manager không có nhãn `bm.modeSet` thì nó được chuyển sang mode đích và được gắn nhãn; mọi lỗi thành `modeNotice`, không chặn việc mở.

**Nguồn:** REQ-026c; thiết kế §4.1 "Manager đang có", "Chạy CLI", "Hợp đồng"; N2–N5; Q36 (một lần), Q37 (bỏ qua Manager đang chạy), Q39 (đường CLI).

**Phụ thuộc:** WP-243 — cần `managerModeFor` và nhãn `bm.modeSet`.

**Ranh giới an toàn:** đây là WP duy nhất chạm trạng thái agent **thật** của người dùng. Bộ chạy CLI phải tiêm được (`run` giả trong test); **không test nào được gọi `paseo` thật** hay chạm daemon thật.

**Phạm vi:** module mới `plugin/server/paseo-cli.ts` (tìm `paseo` bằng `findTool`, `execFile` không shell, timeout 5 giây, kiểm id và mode), nhánh tìm thấy của `ensureManager`, trường `modeNotice` trong `managerEnsureRpc` (`plugin/shared/contracts.ts`), và chỗ hiện notice ở `plugin/client/launch-manager.ts` / `launcher.tsx`.

**Nghiệm thu:**
- Có nhãn `bm.modeSet` → không gọi CLI lần nào (ca "tôn trọng lựa chọn tay").
- Không nhãn, `idle`, `currentModeId: "default"` → gọi đúng `paseo agent mode <id> bypassPermissions --json` rồi `paseo agent update <id> --label bm.modeSet=bypassPermissions --json`.
- Mode đã đúng → chỉ gọi `update`.
- Manager `running` → không gọi CLI, `modeNotice` nói sẽ thử ở lần mở sau.
- Không tìm thấy `paseo`, CLI mã khác 0, hay quá giờ → Manager vẫn được trả về, `modeNotice` nêu lý do và cách tự đổi trong Paseo.
- Id mở đầu bằng `-` (ví dụ `--help`) hoặc mode không có trong danh sách provider → không gọi CLI.
- **Đối chứng âm:** bỏ bước kiểm nhãn thì ca đầu phải đỏ.
- Client cũ bỏ qua `modeNotice` (trường cộng thêm) — test hợp đồng.
- `npm run verify` mã 0.

### WP-245 — Mỗi lượt ghi model, mức thinking và mode

**Kết quả:** bản ghi trace mới mang `runtime { model, thinkingOptionId, modeId }` theo thứ tự ưu tiên ở thiết kế §4.2; hàm "model hiệu lực" (`runtime.model` → `usage.model`) có một chỗ định nghĩa duy nhất.

**Nguồn:** REQ-058 (a)–(c); thiết kế §4.2; N6–N8. **Phụ thuộc:** none. **Ranh giới:** đây là thay đổi dữ liệu lưu bền — chỉ **cộng** trường tuỳ chọn, không đổi `v`, không di trú (thiết kế §7).

**Phạm vi:** `traceRecordSchema` trong `plugin/shared/contracts.ts` (trường tuỳ chọn), `plugin/server/collector.ts`, một hàm model hiệu lực dùng chung trong `plugin/server/traces.ts`.

**Nghiệm thu:**
- Snapshot có `runtimeInfo { model, thinkingOptionId, modeId }` **khác** `snapshot.model`, `effectiveThinkingOptionId`, `currentModeId` → `runtime` lấy cả ba giá trị của `runtimeInfo` (đối chứng âm: đảo thứ tự ưu tiên thì ca này đỏ).
- Thiếu `runtimeInfo` → lấy `snapshot.model`, `effectiveThinkingOptionId` → `thinkingOptionId`, `currentModeId`; không trường thinking nào có giá trị → `null`.
- `runtimeInfo.modeId: null` mà `currentModeId` có giá trị → lấy `currentModeId` (`null` không che giá trị dự phòng).
- `timeline.refetch` lỗi → `runtime: null`, `usage: null` như hôm nay.
- Bản ghi có `runtime` qua được lược đồ **không** có trường đó (bản plugin cũ), và bản ghi cũ qua được lược đồ mới; `v` và `TRACE_STORE_SCHEMA_VERSION` vẫn là `1`.
- `usage.model` giữ nguồn cũ.
- `npm run verify` mã 0.

### WP-246 — Chi tiết request: model, thinking, mode của từng agent và token theo model

**Kết quả:** mở một request trên Dashboard thấy, cho Worker, Reviewer và Manager, model / thinking / mode đã chạy kèm số lượt, và một dòng token + tiền theo model.

**Nguồn:** REQ-058 (a)–(d); thiết kế §4.3 (hai dòng `TraceDetail`, "Giá theo model hiệu lực"), §4.4 hai gạch đầu; Q38 (chi phí theo model hiệu lực).

**Phụ thuộc:** WP-245 — cần trường `runtime` và hàm model hiệu lực.

**Phạm vi:** `plugin/server/traces.ts` (gộp `runtime` theo agent, `usageByModel`, `usageOfTrace` theo model hiệu lực), `TraceDetail` trong `contracts.ts`, `plugin/server/dashboard-rpc.ts` nếu cần truyền, `plugin/client/dashboard-model.ts` (`requestGraph`).

**Nghiệm thu:**
- Một Worker có 3 lượt `claude-opus-5 / null / bypassPermissions` và 1 lượt `claude-opus-5 / high / bypassPermissions` → hai dòng `runtime` `recorded: true`, số lượt 3 và 1; thinking `null` hiện `provider default`.
- 2 lượt cũ không có `runtime` nhưng có `usage.model: "claude-opus-5"` → **một** dòng `{ model: "claude-opus-5", thinkingOptionId: null, modeId: null, recorded: false, turns: 2 }`, hiện `Model: claude-opus-5 · thinking/mode: not recorded · 2 turns` (thiết kế §4.3, bảng "Một lượt góp vào dòng nào").
- 1 lượt không có cả `runtime` lẫn `usage` → dòng `model: null, recorded: false`, hiện `Model: not recorded · 1 turn`.
- Dòng Manager nằm trong chi tiết request.
- `usageByModel` cộng bằng tổng token của request; tổng tiền bằng tổng tiền các phần.
- Ca profile trống model (`usage.model` null, `runtime.model` có giá) được định giá theo `runtime.model` — ca này đỏ nếu `usageOfTrace` còn gộp theo `usage.model`.
- Trace chỉ có bản ghi cũ: mọi dòng `runtime` là `recorded: false`, model đúng bằng `usage.model` của lượt.
- `npm run verify` mã 0.

### WP-247 — Tổng quan: token và chi phí theo model × vai trò

**Kết quả:** phần tổng quan của Dashboard có khối "Model × role", mỗi thanh một cặp (model, vai trò) với token và tiền.

**Nguồn:** REQ-058 (e); thiết kế §4.3 (dòng `TraceSummary`), §4.4 gạch "Tổng quan".

**Phụ thuộc:** WP-245 — cần hàm model hiệu lực để gộp.

**Phạm vi:** `TraceSummary.usageByModelRole` (`contracts.ts`, `traces.ts`), `plugin/client/dashboard-model.ts` (dữ liệu khối), `plugin/client/dashboard.tsx` + `BarChart` của `ui.tsx`.

**Nghiệm thu:**
- Ba request trên hai model và ba vai trò → đúng số cặp, token mỗi cặp bằng tổng các request.
- Cộng trên **đúng** danh sách mà `overviewCards` dùng — test đặt hai hàm cạnh nhau trên cùng đầu vào và tổng token phải bằng nhau.
- Model không có giá → thanh chỉ hiện token.
- `model: null` hiện `unknown model`, không bị bỏ.
- `npm run verify` mã 0.

### WP-248 — Báo cáo: cách nạp chỉ dẫn theo model

**Kết quả:** `docs/design/paseo-bm-research-20260918-instructions-by-model.md` (tiếng Việt) trả lời R1–R6 ở thiết kế §4.5 cho Claude Code / `claude-opus-5`, Codex / `gpt-5.6-sol`, và một đoạn về OpenCode.

**Nguồn:** PRD delta §4; thiết kế §4.5 (R1–R6 và luật của báo cáo); N9; quyết định Q33–Q35. **Phụ thuộc:** none.

**Phạm vi:** chỉ đọc — bundle Paseo (giải nén vào `mktemp -d`), snapshot agent, kho vết, `docs/operations/`, và tài liệu hướng dẫn prompt công khai của Anthropic và OpenAI (Q34). Đọc hai nhóm trang đó là **lần dùng mạng duy nhất** được phép trong delta này; không tải gói, không gọi API. **Không** sửa `plugin/roles/*.md`.

**Nghiệm thu:**
- Có sáu mục R1–R6, mỗi mục có kết luận riêng cho từng provider.
- Mỗi khẳng định ghi nguồn: tệp và dòng, URL và ngày đọc, hoặc phép đo trên trace kèm cách đo; điều suy luận ghi là suy luận.
- R4 có số đo tuân thủ theo model tính từ kho vết (số bản ghi, số báo cáo đủ trường / thiếu trường, số vi phạm thấy được).
- R6 là danh sách đề xuất có thứ tự, mỗi mục có tác động, chi phí, rủi ro, cách đo, và ghi rõ "một văn bản cho mọi model" hay "biến thể theo provider".
- `git diff --stat plugin/roles` rỗng; thư mục tạm đã xoá.

### WP-249 — Đóng delta

**Kết quả:** tài liệu khớp mã, và ba tài liệu delta chuyển `Applied`.

**Nguồn:** PRD delta §2.3, §3.3, §6; thiết kế §7, §9; plan §1 điều kiện ra.

**Phụ thuộc:** WP-243 → WP-248 — cần mã và báo cáo xong để tài liệu mô tả đúng cái đã có.

**Ranh giới an toàn:** cài bản build lên daemon thật để nghiệm thu là **việc của owner**, hoặc chỉ làm khi owner cho phép rõ ràng (AGENTS.md: không cài plugin lên daemon của người dùng như tác dụng phụ). Không bao giờ `paseo daemon restart` hay `stop`.

**Nghiệm thu:**
- `docs/product/paseo-bm-prd.md`: REQ-026c, NFR Quyền và Revision History theo PRD delta §2.3 vị trí 1–3.
- `docs/product/paseo-bm-dashboard-prd.md`: dòng REQ-058 và Revision History theo PRD delta §3.3 vị trí 5–6.
- `docs/design/paseo-bm.md` §2.6: errata "Manager chạy không hỏi quyền, chuyển một lần bằng nhãn `bm.modeSet`" trỏ về delta này; Revision History.
- `docs/design/paseo-bm-dashboard.md` §3.3 (trường `runtime`), §4.2–§4.3 (ba trường RPC mới), §9 (khoá model hiệu lực); Revision History.
- `AGENTS.md`, mục sự thật đã kiểm chứng: N2 (SDK không đặt được mode; CLI `paseo agent mode` và `paseo agent update --label`), N6 (`runtimeInfo`, `effectiveThinkingOptionId`, `persistence.metadata.systemPrompt`), N9 (đường nạp chỉ dẫn theo provider).
- Điều kiện ra 2 (§1) được owner xác nhận trên daemon thật và ghi vào bead kèm ngày.
- PRD delta, design delta, plan delta: Status → `Applied`, ghi mọi chỗ lệch thực tế.
- `npm run verify` mã 0; `br lint -s all` không cảnh báo mới; `br dep cycles` sạch.

## 4. Kiểm thử chung

Vitest, theo quy ước repo: SDK Paseo và bộ chạy CLI là **fake tiêm vào**, client kiểm bằng hàm thuần trong `dashboard-model.ts` không renderer. Repo không đặt ngưỡng coverage; thay vào đó:

1. **Đối chứng âm là bắt buộc** cho mỗi luật mới: xoá luật đi thì phải có test đỏ.
2. **Không test nào đang có được đỏ** — đặc biệt test của `usageOfTrace` (delta 20260917), luật tách đoạn (delta 20260917e) và luật gộp theo Manager (delta 20260917d).
3. **Không có test nào thay cho bằng chứng thật ở đường CLI**: việc gọi `paseo` từ trong tiến trình daemon chỉ chứng minh được trên daemon thật (điều kiện ra 2).
4. **Tương thích hợp đồng:** bên tiêu thụ duy nhất của `manager.ensure` và các RPC Dashboard là client đóng cùng bundle; mọi trường mới là cộng thêm và có test "lược đồ cũ vẫn nhận đầu ra mới" (WP-244, WP-245).

## 5. Rủi ro và cách chặn

| Rủi ro | Chặn bằng |
|---|---|
| Gọi CLI từ trong daemon không chạy được | Lỗi chỉ thành `modeNotice`; Manager mới (WP-243) không phụ thuộc CLI; nghiệm thu trên daemon thật ở WP-249 |
| Đè mode người dùng tự chọn | Nhãn `bm.modeSet`, test đối chứng âm ở WP-244 |
| Con số chi phí đổi ngoài ý muốn | Chỉ ca profile trống model; test riêng ở WP-246 |
| Bản ghi mới phá bản plugin cũ | Trường tuỳ chọn, test hai chiều ở WP-245 |
| Báo cáo thành ý kiến không nguồn | Luật nguồn của WP-248, đọc tài liệu hiện hành |

## 6. Cổng `plan-ready-for-beads`

| Mục | Kết quả |
|---|---|
| Header: Status, Plan-ready, Owner, Routing, nguồn PRD và thiết kế, phase có tên | PASS — Phase 2a-6; không có ADR mới (ADR-006, ADR-007 được giữ nguyên, liên kết ở thiết kế) |
| MVP-Lock: phạm vi khoá theo REQ, ngoài phạm vi, điều kiện ra, tư thế hoàn tác | PASS — ngoại lệ hoàn tác duy nhất (mode và nhãn trên Manager thật) được nêu |
| Mỗi WP có kết quả, nguồn REQ/thiết kế, phụ thuộc, nghiệm thu | PASS — 7 WP |
| Phụ thuộc thô, có lý do, không vòng | PASS — WP-243→WP-244, WP-245→WP-246, WP-245→WP-247, sáu WP→WP-249 |
| Rủi ro có cách chặn; không còn câu hỏi mở | PASS — Q31–Q39 đã chốt |
| Chiến lược test theo quy ước repo | PASS — Vitest, fake tiêm vào; không có ngưỡng coverage, thay bằng đối chứng âm bắt buộc |
| Dữ liệu lưu bền và hợp đồng: tương thích, bên tiêu thụ | PASS — trường cộng thêm, không di trú, bên tiêu thụ duy nhất là client cùng bundle |
| Quyền: chính sách đã chốt, bằng chứng âm, ai duyệt | PASS — chính sách do owner chốt (Q31, Q36–Q39); test âm cho nhãn và cho id `--help`; **duyệt PRD delta §6 là bước xác nhận của owner trước khi implement** — chuyển bead không phải implement |
| Chuyển bead không phải bịa phạm vi hay thiết kế | PASS — hợp đồng `runtime`, thứ tự ưu tiên, luật CLI và đường dẫn tệp đều có ở thiết kế |

**Đã phải sửa trước khi đạt:** review b1 lần đầu có hai mục chặn ở thiết kế (thứ tự ưu tiên của `runtimeInfo`; lượt cũ mất model trong hợp đồng) — đã sửa, re-review pass. Lượt `reviewing-plan` trước đó thêm nguồn và phụ thuộc cho từng WP, tư thế hoàn tác và hai ranh giới an toàn.

## 8. Điều kiện ra — kết quả

| # | Điều kiện (§1) | Kết quả | Bằng chứng |
|---|---|---|---|
| 1 | `npm run verify` mã 0 | **Đạt** | 94 file / 2091 test, build thành công (sau khi sửa lỗi review b3) |
| 2 | Owner tự xác nhận ba quan sát trên daemon thật | **Đạt, trừ một điểm chưa quan sát** | Worker kiểm theo lựa chọn của owner (Q1 = b): hai Manager có sẵn được chuyển sang Bypass và gắn nhãn `bm.modeSet` qua CLI từ trong daemon; đổi tay `557cc8e4` về `default`, gọi `manager.ensure` → `modeNotice: null`, mode vẫn `default`, rồi trả về Bypass; mọi lượt sau khi cài có `runtime`, `traces.get` trả `usageByModel`, `usageByModelRole`, `usageByAgent[].runtime`. Chưa quan sát: Manager **mới** mở ở Bypass (chưa có Manager nào được tạo sau khi cài; có unit test) |
| 3 | Báo cáo WP-248 trả lời đủ R1–R6, mỗi khẳng định có nguồn | **Đạt** | `docs/design/paseo-bm-research-20260918-instructions-by-model.md`; review b3 pass (người review không mở được các URL công khai vì không có mạng) |
| 4 | PRD, PRD Dashboard, hai thiết kế gốc, `AGENTS.md` mang đúng các dòng của WP-249 | **Đạt** | Bead `bm-wp-249-5qqp.2` |

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Bản Draft theo `req-20260918T011706Z`. Lượt `reviewing-plan`: thêm nguồn REQ/thiết kế và phụ thuộc cho từng WP, đánh dấu O1–O3 chặn WP-244/WP-246, tư thế hoàn tác (trạng thái agent của người dùng là ngoại lệ duy nhất), ranh giới "không test nào gọi `paseo` thật", việc cài lên daemon thật là của owner, mạng chỉ cho tài liệu công khai ở WP-248, và cách test theo quy ước repo |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner trả lời O1–O3 và rủi ro CLI (Q36–Q39); bỏ đánh dấu chặn của WP-244 và WP-246 |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Theo review b1: nghiệm thu WP-245 lấy `runtimeInfo` trước cho cả ba trường; WP-246 theo hợp đồng `runtime` mới (dòng có `recorded`, lượt cũ giữ `usage.model`) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Cổng `plan-ready-for-beads` PASS sau review b1 pass. Status Draft → **Active**; phạm vi Phase 2a-6 (WP-243 → WP-249) đóng băng |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Errata theo review b2 (không đổi phạm vi): nghiệm thu WP-243 nói rõ "không chọn `planning`" chỉ áp cho lựa chọn tự động; mode tự đặt trên profile luôn thắng (Q31) |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner chọn bỏ qua nghiệm thu trên daemon thật ("c"): cạnh WP-249 tài liệu → nghiệm thu được gỡ, bead nghiệm thu để `deferred`. Thêm §8 kết quả điều kiện ra. Status Active → Applied với ngoại lệ |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | Owner yêu cầu làm nốt; nghiệm thu trên daemon thật xong (Q1 = b), §8 dòng 2 cập nhật. Status → Applied |
