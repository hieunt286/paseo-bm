# Delta plan — Dự phòng khi hết hạn mức cho mọi vai trò, màn "Roles & models", mọi provider cho mọi vai trò

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260921-worker-fallback-and-role-settings` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ.** Delta này thêm WP-287 → WP-309 trong sáu phase 2a-13 → 2a-18 (2a-12 thuộc delta 20260921-ci-linux-hang) |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-22 — hieu.nt10** (Beads Worker tự chấm sau review `b1` và re-review. Mục chặn cuối của re-review được sửa theo gợi ý của Reviewer, owner chốt Q9 a, và **không được review lại** — ghi như một ngoại lệ, không phải một lượt pass của Reviewer) |
| Owner | hieu.nt10 |
| Created | 2026-09-21 |
| Request | `req-20260921T111242Z` |
| Source design | [design-delta-20260921-worker-fallback-and-role-settings](../design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md). Đây là nguồn duy nhất cho hàm, hợp đồng, chữ thông báo, luật kiểm và kiểm thử |
| Source PRD | [prd-delta-20260921-worker-fallback-and-role-settings](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) — REQ-062 → REQ-067; quyết định Q1–Q8 |
| ADR | [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md) (Proposed), thực thi ở phase 2a-15, 2a-16 và 2a-17 |
| Routing decision | [PRD delta §0](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md#0-routing-decision) — brownfield, **Large** |
| Phase | **Phase 2a-13 → 2a-18**, nhãn bead `phase:2a-13` … `phase:2a-18`. Beads mang `feature:paseo-bm`, `feature:worker-fallback` (nhãn các bead của đề xuất đã dùng) và `wp:wp-<số>` |

## 1. MVP-Lock

### 1.1 Phạm vi theo phase

| Phase | Bản phát hành | Trong phạm vi | WP |
|---|---|---|---|
| **2a-13** — Tôn trọng profile | `0.2.0-alpha.2` | REQ-062 (a)–(e); thiết kế §4.1 | WP-287 → WP-289 |
| **2a-14** — Mọi provider cho mọi vai trò | `0.3.0-alpha.0` | REQ-063 (a)–(g); thiết kế §4.2. Riêng ý (h) (cảnh báo khi lưu) thuộc 2a-15 | WP-290 → WP-294 |
| **2a-15** — Màn Roles & models | `0.3.0-alpha.1` | REQ-064 (a)–(g), REQ-063 (h); thiết kế §4.3; ADR-008 QĐ1–QĐ3, QĐ5 | WP-295 → WP-298 |
| **2a-16** — Hạ tầng dự phòng và Worker, "Hỏi tôi" | `0.3.0-alpha.2` | REQ-065 (a)–(k); thiết kế §4.4; ADR-008 QĐ2 (alias dự phòng của Worker), QĐ4 | WP-299 → WP-304 |
| **2a-17** — Dự phòng cho Reviewer và Manager | `0.3.0-alpha.3` | REQ-066 (a)–(f); PRD gốc REQ-020 (b) mới; thiết kế §4.5; ADR-008 QĐ2 (alias dự phòng của Reviewer, Manager) | WP-305 → WP-307 |
| **2a-18** — Dự phòng Tự động | sau | REQ-067 (a)–(d); thiết kế §4.6 | WP-308 → WP-309 |

### 1.2 Ngoài phạm vi

Toàn bộ PRD delta §7.2, và thêm:
- **Beads và mã trong request này** (Q5 a). Chuyển plan thành beads là request sau.
- Sửa bản phát hành hay quy trình phát hành. Mỗi phase phát hành theo [release runbook](../operations/paseo-bm-release-runbook.md) đang có, do owner chạy.
- Ghi đè `modeId` của profile khi người dùng không chọn trên màn hình. Installer vẫn không ghi `modeId` (ADR-006).

### 1.3 Điều kiện ra

**Của mỗi phase:**
1. Mọi WP của phase đã đóng. `npm run verify` mã 0; `br lint -s all` và `br dep cycles` sạch.
2. Các dòng của PRD delta §4 ghi phase đó đã được áp vào PRD gốc, kèm dòng revision. Thiết kế gốc có một dòng errata trỏ tới delta này cho các mục phase đó chạm.
3. Owner nghiệm thu trên daemon thật theo thiết kế §8, phần của phase đó. Owner tự cài bản build, hoặc cho phép Worker cài.
4. Owner phát hành bản của phase theo runbook. Việc này cần OTP của owner, và không bead nào tự làm.

Điều kiện 3 và 4 là việc của owner sau `finished`. WP đóng phase chỉ chuẩn bị và ghi lại.

**Của cả delta:** phase 2a-17 đã phát hành. Phase 2a-18 là tuỳ chọn: nó chỉ mở khi đủ điều kiện vào (§3, trước WP-308). Delta có hai đường đóng, không đường nào phải tự nghĩ ra:
- **2a-18 chưa đủ điều kiện vào** khi WP-307 chạy: WP-307 đóng delta ở trạng thái **"Applied — 2a-18 deferred"**. REQ-067 **không** được áp vào PRD gốc (dòng 15 của PRD delta §4 ở lại chưa áp). Phase 2a-18 về sau là một request riêng, chạy WP-308 và WP-309.
- **2a-18 được làm** (đủ điều kiện ngay lúc WP-307 chạy, hoặc mở về sau): WP-309 áp dòng 15, và chuyển ba tài liệu delta sang **"Applied"** từ trạng thái đang có hoặc từ "Applied — 2a-18 deferred".

### 1.4 Hành vi người dùng đang dựa vào sẽ đổi

- **Cài lại thôi đưa mục `bm-*` về mặc định** (REQ-062 c). Người dùng từng dùng cài lại để "reset" vai trò giờ phải dùng `--role` hay `--reconfigure`.
- **Dòng mode trong `## Runtime facts` có thể là "none"** (thiết kế §4.2.3). `manager.md` và `worker.md` đổi theo.
- **Reviewer trên Codex / Claude:** không đổi. Trên provider khác: như REQ-063 (b).
- **Manager nhận thêm thông báo của plugin** (`BM-TOOLS`, `BM-SETTINGS`, `BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`), và Worker nhận `BM-SETTINGS`, `BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`.
- **Một workspace có thể có hai Manager sống** sau khi Manager bị thay (REQ-020 b mới): lối vào mở Manager thay thế; Manager cũ ở lại cho tới khi người dùng lưu trữ.
- **Worker không tự tạo Reviewer khác** khi Reviewer hỏng vì provider; nó chờ `BM-FALLBACK` (thiết kế §4.5.1).

### 1.5 Tư thế hoàn tác mặc định

- Mỗi WP revert tệp của chính nó. Sửa chỉ dẫn vai trò thì chạy lại `npm run build` để sinh `*-instructions.ts`.
- **Dữ liệu lưu bền mới:** `runtime.provider` trong kho vết (tuỳ chọn, không di trú); hai file mới trong thư mục cài đặt (dữ liệu người dùng, bản cũ bỏ qua); alias `bm-<vai trò>-fallback-*` (bản cũ gỡ được theo luật tiền tố). Không có điểm không quay lại được trong mã.
- **Điểm không quay lại được duy nhất: `npm publish`** của mỗi phase, vì số phiên bản đã dùng thì không dùng lại được. Việc này do owner làm, lên dist-tag `next` theo runbook. Hoàn tác là dời dist-tag về bản trước; không có R3 rehearsal riêng, vì runbook đã là quy trình đã chạy thật (0.2.0-alpha.0, 0.2.0-alpha.1).
- Hoàn tác theo từng phase: thiết kế §9.

### 1.6 Câu hỏi mở

| ID | Câu hỏi | Owner | Trạng thái | Chặn |
|---|---|---|---|---|
| Q6 | Ngoại lệ hẹn giờ trong plugin cho nút "Chờ" (thiết kế §4.4.9) | hieu.nt10 | answered — **a**, 2026-09-21 | — |
| Q7 | Rủi ro Reviewer trên Pi / OpenCode; `auto_accept` của Reviewer luôn tắt (thiết kế §4.2.2) | hieu.nt10 | answered — **a**, 2026-09-21 | — |
| Q8 | Chuỗi dự phòng cho vai trò nào | hieu.nt10 | answered — **c** (cả ba vai trò; phase 2a-17 riêng), 2026-09-21 | — |

Không còn câu hỏi mở.

## 2. Thứ tự và vì sao

**Điều kiện bắt đầu delta:** owner đã duyệt PRD delta §9 (Status Accepted).

**Giữa các phase:** WP đầu của mỗi phase phụ thuộc WP đóng phase trước. Lý do: mỗi phase là một bản phát hành riêng, cắt từ một cây **chỉ** có thay đổi của phase đó và các phase trước (đề xuất §5.1 "mỗi bước rút lại được bằng cách cài bản trước"). Worker không commit, nên cạnh bead không đủ để bảo đảm điều đó. Vì vậy mỗi phase từ 2a-14 còn một **điều kiện bắt đầu ngoài bead**: owner đã commit thay đổi của phase trước. Bản phát hành có thể cắt sau, từ đúng commit đó. Chưa có commit thì Worker gửi `blocked`, không bắt đầu phase mới.

**Trong phase, các phụ thuộc thật:**

| Cạnh | Bên phụ thuộc cần gì từ bên kia |
|---|---|
| WP-290 → WP-287 | `profileOf` (§4.1.1), để đọc mode, thinking và feature của profile trong `runPostureOf` |
| WP-291 → WP-290 | `capabilityOf` và `runPostureOf` trong `manager.ensure`. Cả hai WP cùng sửa `manager.ts` và `manager.md` |
| WP-295 → WP-290 | `capabilityOf`, để `roles.options` và kiểm §4.3.3 biết lớp của provider |
| WP-296 → WP-295 | hợp đồng `roles.settings` / `roles.options` / `roles.save-settings` trong `contracts.ts` |
| WP-297 → WP-295, WP-290, WP-291 | lần lưu thành công (điểm kích hoạt), `runtimeFactsText` với dạng "none", và `notice-queue` |
| WP-299 → WP-295, WP-296 | `config-writer.ts`, và mục Roles & models để thêm phần chuỗi |
| WP-300 → WP-299 | `roleOfProvider` nhận alias dự phòng; `role-fallback.json` (chuỗi, policy, mẫu) |
| WP-301 → WP-300 | sự cố đã ghi, và định dạng của nó |
| WP-302 → WP-301 | `fallback.act`, `BM-FALLBACK` với trạng thái mới |
| WP-303 → WP-301 | như trên |
| WP-305 → WP-304 | cả hạ tầng của 2a-16: sự cố, thẻ, `notice-queue`, `fallback.act`, hẹn giờ |
| WP-306 → WP-304 | như trên, cộng bàn giao (`fallback-handover.ts`) và `soleWorkerOf` / cây agent của WP-302 |
| WP-308 → WP-307 | cả phase 2a-17, cộng **điều kiện vào**: một sự cố thật |

```
2a-13: WP-287 ─┬─────────────┐
       WP-288 ─┴──> WP-289 ──┤
2a-14:  WP-290 ──> WP-291 ─┐ │   (WP-290, WP-292, WP-293 phụ thuộc WP-289)
        WP-292 ────────────┼─┴> WP-294
        WP-293 ────────────┘
2a-15:  WP-295 ──> WP-296 ──┐   (WP-295 phụ thuộc WP-294)
           └────> WP-297 ───┴──> WP-298
2a-16:  WP-299 ──> WP-300 ──> WP-301 ──┬─> WP-302 ─┐   (WP-299 phụ thuộc WP-298)
                                       └─> WP-303 ─┴──> WP-304
2a-17:  WP-305 ─┬──> WP-307               (WP-305, WP-306 phụ thuộc WP-304)
        WP-306 ─┘
2a-18:  WP-308 ──> WP-309               (WP-308 phụ thuộc WP-307 + điều kiện vào)
```

## 3. Work packages

### Phase 2a-13 — Tôn trọng profile

#### WP-287 — Worker và Reviewer nhận thinking và feature của profile

**Kết quả:** Worker và Reviewer được tạo sau bản này chạy mức thinking và feature đặt trên profile `bm-worker` / `bm-reviewer`, theo đúng luật ba điều kiện của thiết kế §4.1.1. Lookup hết giờ thì agent vẫn được tạo như hôm nay.

**Nguồn:** REQ-062 (a), (b); thiết kế §4.1.1. **Phụ thuộc:** none.

**Phạm vi:** `plugin/server/role-mode.ts` (`profileOf`); `plugin/server/role-hook.ts` (`applyRoleProfile`, `prepare`); test `role-hook` / `role-mode`.

**Điều kiện ra:**
- các ca 2a-13 phần hook của thiết kế §8 xanh, gồm "model khác → không đặt";
- các ca đang có của hook không sửa kỳ vọng;
- `npm run typecheck:plugin`, `npm run lint` và test mã 0.

#### WP-288 — Cài lại gộp mục `bm-*`; `doctor` báo lệch

**Kết quả:**
- Cài lại hay cập nhật không xoá khoá nào người dùng đặt trên alias và profile `bm-*`.
- `--role` / `--reconfigure` chỉ đổi `extends`, `label`, `name`, `model` của vai trò được nêu, và xoá `thinkingOptionId` khi model đổi.
- `doctor` có kiểm info `roles.changed-in-app`.

**Nguồn:** REQ-062 (c), (d), (e); thiết kế §4.1.2, §4.1.3. **Phụ thuộc:** none.

**Ranh giới:** đây là đường **ghi `config.json` của trình cài** (ADR-004), một trong ba chỗ thiết kế gốc §7 yêu cầu owner review mã. Chỉ đổi phép gộp, không đổi backup, reload hay kiểm ghi song song.

**Phạm vi:** `src/roles/register.ts`; `src/paseo/config.ts` (`applyProviders`, `applyProfiles`); `src/commands/install/*` nơi dựng `ConfigEdit`; `src/commands/doctor.ts` (`roleChecks`); test integration với `$HOME` giả.

**Điều kiện ra:**
- các ca 2a-13 phần trình cài và `doctor` của thiết kế §8 xanh, gồm đối chứng âm;
- REQ-009: chạy lại cùng phiên bản trên máy đã đủ → 0 thay đổi;
- `npm run verify` mã 0.

#### WP-289 — Đóng phase 2a-13

**Kết quả:**
- PRD gốc nhận dòng 1, 2 và 16 (Roadmap) của PRD delta §4, cùng dòng revision (dòng 17). Dòng 13 và 14 thuộc WP-307.
- Thiết kế gốc §3.2 có dòng errata "`roles[]` = lần ghi cuối của trình cài" trỏ tới delta này.
- Bản build sẵn cho owner nghiệm thu theo thiết kế §8 (2a-13).
- Ghi chú phát hành `0.2.0-alpha.2`, soạn sẵn cho `--notes-file` của runbook.

**Nguồn:** PRD delta §4, §5; plan §1.3. **Phụ thuộc:** WP-287, WP-288.

**Phạm vi:** `docs/product/paseo-bm-prd.md`; `docs/design/paseo-bm.md`; ba tài liệu delta này (Status, revision); ghi chú phát hành trong `docs/operations/`.

**Điều kiện ra:** `npm run verify` mã 0; `br lint -s all`, `br dep cycles` sạch; đọc lại các dòng đã áp khớp PRD delta §4.

### Phase 2a-14 — Mọi provider cho mọi vai trò

#### WP-290 — Cách chạy theo khả năng provider; Runtime facts nói được "none"

**Kết quả:**
- `capabilityOf` phân bốn lớp. `modesFor` phân biệt "không có mode" với "đọc không được".
- `runPostureOf` cho đủ 12 ô của thiết kế §4.2.2; hook dùng nó cho Worker và Reviewer, `manager.ensure` dùng nó cho Manager.
- `runtimeFactsText` có ba dạng. `REVIEWER_FALLBACK_MODE` chỉ còn cho claude/codex.
- `manager.md` và `worker.md` sửa câu về mode của agent con.

**Nguồn:** REQ-063 (a), (b), (c); thiết kế §4.2.1–§4.2.3. **Phụ thuộc:** WP-289, WP-287. Luật `auto_accept` của Reviewer theo Q7 a.

**Ranh giới:** ô Reviewer của bảng §4.2.2 là **ranh giới quyền**. Kiểm âm (profile đặt `auto_accept: true` → hook trả `false`) phải có trước khi đóng.

**Phạm vi:** `plugin/server/role-mode.ts`; `role-hook.ts`; `role-extras.ts`; `manager.ts`; `plugin/roles/manager.md`, `worker.md` và `*-instructions.ts` sinh lại; test.

**Điều kiện ra:**
- các ca 2a-14 phần `capabilityOf`, `modesFor`, `runPostureOf`, Runtime facts và `manager.ensure` của thiết kế §8 xanh;
- ngưỡng dòng của file vai trò không nâng;
- `npm run verify` mã 0.

#### WP-291 — Người dùng biết khi Manager hay Worker thiếu công cụ Paseo

**Kết quả:**
- `manager.ensure` trả `toolsNotice`, và màn Manager hiện nó.
- `on("agent.created")` gửi `BM-TOOLS` cho Manager cha khi một Worker có `supportsMcpServers === false`.
- `setup.status` trả `paseoTools`. `BM-TOOLS` vào `PREFIXES`; `manager.md` có câu về nó.

**Nguồn:** REQ-063 (d); thiết kế §4.2.4. **Phụ thuộc:** WP-290.

**Phạm vi:** `plugin/server/manager.ts`; `agent-labels.ts`; `plugin/server/notice-queue.ts` (mới: hàng chờ gửi tới agent đang chạy, thiết kế §4.2.4 / F13 — Manager cha thường đang chạy lúc Worker vừa được tạo); `notices.ts`; `setup-skills.ts` hoặc handler `setup.status`; `plugin/shared/contracts.ts` (trường cộng thêm); `plugin/client/launch-manager.ts` (hiện `toolsNotice` cạnh `modeNotice` đang có); `plugin/client/setup-screen.tsx`; `manager.md`; test.

**Điều kiện ra:**
- ca `BM-TOOLS` và `toolsNotice` của thiết kế §8 xanh;
- các ca đang có của `agent-labels` và `manager.ensure` không sửa kỳ vọng, trừ trường mới;
- `npm run verify` mã 0.

#### WP-292 — Cột skill Pi và OpenCode; hướng dẫn đăng nhập Pi

**Kết quả:**
- Màn Setup có cột `pi` (`~/.pi/agent/skills`) và `opencode` (`~/.config/opencode/skill`), chỉ đọc; trường mới tuỳ chọn trong lược đồ.
- Trình cài in hướng dẫn cho Pi thay vì chạy lệnh đăng nhập.

**Nguồn:** REQ-063 (e), (f); thiết kế §4.2.5, §4.2.6. **Phụ thuộc:** WP-289.

**Phạm vi:** `plugin/server/setup-skills.ts`; `plugin/shared/contracts.ts` (`setupStatusSchema`); `plugin/client/setup-screen.tsx`, `setup-model.ts`; `src/roles/login.ts`; test.

**Điều kiện ra:**
- test dò skill với `$HOME` giả có và không có hai thư mục;
- payload cũ không có cột mới vẫn qua lược đồ;
- test đăng nhập Pi in hướng dẫn, không chạy tiến trình nào;
- `npm run verify` mã 0.

#### WP-293 — Giá theo `metadata.cost`

**Kết quả:**
- Bản ghi lượt có `runtime.provider`.
- `costOf` đọc `metadata.cost` qua `listModels`, nhớ theo provider.
- Giá theo thứ tự: bảng có sẵn → `metadata.cost` → chỉ token. Dashboard dùng thứ tự đó.

**Nguồn:** REQ-063 (g); thiết kế §4.2.7, F2, F7. **Phụ thuộc:** WP-289.

**Ranh giới:** đây là **định dạng lưu bền** của kho vết (ADR-007). Trường tuỳ chọn, giữ `v: 1`. Test bắt buộc: bản ghi mới qua lược đồ cũ, và bản ghi cũ qua lược đồ mới.

**Phạm vi:** `plugin/shared/contracts.ts` (`traceRecordSchema`); `plugin/server/collector.ts`; `plugin/server/model-costs.ts` (mới); `plugin/shared/prices.ts`; `plugin/server/cost.ts`; `plugin/server/dashboard-rpc.ts`; test.

**Điều kiện ra:**
- ca giá của thiết kế §8 xanh, gồm model id có `/`;
- các ca giá đang có (bảng Claude) không sửa kỳ vọng;
- `npm run verify` mã 0.

#### WP-294 — Đóng phase 2a-14

**Kết quả:**
- PRD gốc nhận dòng 3–6 của PRD delta §4.
- Thiết kế gốc §2.6 và §7 có errata trỏ tới delta này.
- Checklist nghiệm thu 2a-14 cho owner, gồm năm điểm phải kiểm trên daemon thật của thiết kế §8.
- Ghi chú phát hành `0.3.0-alpha.0`.

**Nguồn:** PRD delta §4, §5; thiết kế §8. **Phụ thuộc:** WP-290, WP-291, WP-292, WP-293.

**Phạm vi:** `docs/product/paseo-bm-prd.md`; `docs/design/paseo-bm.md`; `docs/operations/` (checklist nghiệm thu mới); ba tài liệu delta.

**Điều kiện ra:** như WP-289.

### Phase 2a-15 — Màn Roles & models

#### WP-295 — Ghi cấu hình vai trò qua `config.patch` (phía server)

**Kết quả:**
- `roles.settings`, `roles.options`, `roles.save-settings` chạy đúng thiết kế §4.3.2–§4.3.4.
- Mọi lần ghi đi qua `config-writer.ts`: kiểm `revision`, **một** `patch`, đọc lại, báo profile khác bị đổi, mutex.
- Ba mã lỗi mới vào sổ mã.

**Nguồn:** REQ-064 (b), (c), (e), (f), (g); REQ-063 (h) phần server; thiết kế §4.3.2–§4.3.4; ADR-008 QĐ1–QĐ3. **Phụ thuộc:** WP-294, WP-290.

**Ranh giới:** đây là đường **ghi `config.json` của plugin**, rủi ro Q3 owner đã chấp nhận. Owner review mã trước khi phát hành (thiết kế §6). Hợp đồng RPC trong `contracts.ts` là bên cung cấp cho WP-296, nên chốt trước.

**Phạm vi:** `plugin/server/config-writer.ts` (mới); `plugin/server/roles.ts` hoặc module RPC mới; `plugin/shared/contracts.ts`; `plugin/index.server.ts`; test với `config.get` / `config.patch` giả.

**Điều kiện ra:**
- các ca 2a-15 phần `revision`, patch, kiểm khi lưu và cảnh báo của thiết kế §8 xanh;
- kiểm "mọi profile khác giống từng byte";
- lệch `revision` → không gọi `patch`;
- `npm run verify` mã 0.

#### WP-296 — Mục Roles & models trên màn Setup (phía client)

**Kết quả:**
- Setup có mục Roles & models, và form Edit như thiết kế §4.3.1.
- Cảnh báo REQ-063 (h) và cảnh báo cùng provider gốc hiện khi lưu.
- Xung đột hiện "reopen"; câu "Changes apply to agents created after you save" luôn hiện.

**Nguồn:** REQ-064 (a), (d); REQ-063 (h); thiết kế §4.3.1. **Phụ thuộc:** WP-295.

**Phạm vi:** `plugin/client/setup-screen.tsx`; `setup-model.ts` (logic thuần, test được không cần renderer); test model.

**Điều kiện ra:**
- test thuần của `setup-model` cho: danh sách, ẩn thinking khi model không có, không cho chọn mode `dangerous` / `planning` cho Reviewer, cảnh báo, lỗi xung đột;
- `npm run typecheck:plugin`, `npm run lint` và test mã 0.

#### WP-297 — `BM-SETTINGS` cho Manager và Worker đang sống

**Kết quả:**
- Lần lưu làm đổi dòng Runtime facts của agent con → mọi đích sống nhận `BM-SETTINGS`: ngay nếu đang nghỉ, ở `turn_ended` kế nếu đang chạy, tin mới thay tin cũ.
- `roles.save-settings` trả `notified`.
- `BM-SETTINGS` vào `PREFIXES`; `manager.md` và `worker.md` có câu về nó.

**Nguồn:** REQ-064 (d); thiết kế §4.3.5, F5. **Phụ thuộc:** WP-295, WP-290.

**Phạm vi:** `plugin/server/settings-notices.ts` (mới); `plugin/server/notice-queue.ts` (có từ WP-291, dùng lại); `notices.ts`; `index.server.ts`; `plugin/roles/manager.md`, `worker.md`; test.

**Điều kiện ra:**
- ca `BM-SETTINGS` của thiết kế §8 xanh, gồm "dòng không đổi → không gửi" và "không bị đếm là review";
- `npm run verify` mã 0.

#### WP-298 — Đóng phase 2a-15

**Kết quả:**
- PRD gốc nhận dòng 7–9.
- ADR-008 → Accepted, với điều kiện owner đã duyệt PRD delta §9. Dòng "Sửa đổi bởi" của ADR-004 / ADR-006 bỏ chữ "Proposed".
- Thiết kế gốc §3.4 và §5 có errata trỏ tới delta này.
- Checklist nghiệm thu 2a-15; ghi chú phát hành `0.3.0-alpha.1`.

**Nguồn:** PRD delta §4; ADR-008. **Phụ thuộc:** WP-295, WP-296, WP-297.

**Phạm vi:** `docs/product/paseo-bm-prd.md`; `docs/adr/ADR-004…`, `ADR-006…`, `ADR-008…`; `docs/design/paseo-bm.md`; `docs/operations/`; ba tài liệu delta.

**Điều kiện ra:** như WP-289.

### Phase 2a-16 — Hạ tầng dự phòng và Worker, "Hỏi tôi"

Hạ tầng (alias, file, phát hiện, sự cố, thẻ, `notice-queue`, hẹn giờ) được viết cho cả ba vai trò ngay từ phase này, nhưng chỉ vai trò Worker được bật (`FALLBACK_ROLES = ["worker"]`, thiết kế §4.4). Nhờ vậy phase 2a-17 không phải di trú file hay hợp đồng.

#### WP-299 — Khai chuỗi dự phòng; alias dự phòng được nhận đúng vai

**Kết quả:**
- `roles.save-fallback` lưu policy (`ask` / `off`) và 0–3 mục cho một vai trò trong `FALLBACK_ROLES`: ghi alias `bm-<vai trò>-fallback-<n>` qua `config-writer`, rồi `role-fallback.json`.
- Màn Roles & models có phần chuỗi của Worker (thêm, xoá, đổi thứ tự, policy).
- `roleOfProvider` nhận alias dự phòng của cả ba vai trò ở mọi chỗ của thiết kế §4.4.1, gồm `collector.ts`. Nhờ đó agent dự phòng được ghi vết và đếm ngân sách.

**Nguồn:** REQ-065 (f); REQ-031 (a) mới; thiết kế §4.4.1–§4.4.3; ADR-008 QĐ2, QĐ4. **Phụ thuộc:** WP-298, WP-295, WP-296.

**Ranh giới:** hợp đồng (`FallbackSettings`, file `role-fallback.json`) được viết đủ ba vai trò và chốt trước. Phía server và phía client chứng minh riêng được.

**Phạm vi:** `plugin/shared/fallback.ts` (mới: `FALLBACK_ROLES`, kiểu); `plugin/server/fallback-settings.ts` (mới); `config-writer.ts`; `agent-role.ts`; `stop-propagation.ts`; `collector.ts`; `review-budget.ts`; `role-hook.ts`; `plugin/shared/contracts.ts`; `plugin/client/setup-screen.tsx`, `setup-model.ts`; test.

**Điều kiện ra:**
- ca `roles.save-fallback` của thiết kế §8 xanh (trùng mục, đánh số lại, vai trò chưa bật → lỗi);
- `roleOfProvider("bm-worker-fallback-2/x") === "worker"`, và `"bm-worker-fallback-4"` → `null`;
- bộ thu thập ghi lượt của Worker dự phòng;
- `npm run verify` mã 0.

#### WP-300 — Phát hiện, phân loại và ghi sự cố

**Kết quả:** mỗi lượt kết thúc của agent có vai trong `FALLBACK_ROLES` được xét theo N1 và N2 (bốn điều kiện của thiết kế §4.4.4). Loại L1, L2, L4, L5 tạo một sự cố trong `role-fallback-state.json`, với:
- `resetsAt` và `perModelWindow` từ `listUsage` (chỉ L1, chỉ claude/codex, một lần);
- ứng viên theo bốn luật bỏ qua;
- `managerId` theo bảng của thiết kế §4.4.5.

Policy `off` chỉ ghi sự cố.

**Nguồn:** REQ-065 (a), (b), (g), (i), (j); thiết kế §4.4.4, §4.4.5. **Phụ thuộc:** WP-299.

**Ranh giới:** `listUsage` là **hành vi gọi mạng mới** (NFR Riêng tư). Test phải đếm số lần gọi, và chứng minh không gọi cho L2–L5 hay cho provider khác claude/codex.

**Phạm vi:** `plugin/server/fallback-detect.ts`, `fallback-state.ts` (mới); `plugin/shared/fallback-patterns.ts` (mới); `index.server.ts`; test.

**Điều kiện ra:**
- mọi ca phân loại, N2, chống trùng, ứng viên và `listUsage` của thiết kế §8 (2a-16) xanh;
- một chuỗi 2.000 ký tự với mẫu tồi không làm test quá 1 giây;
- `npm run verify` mã 0.

#### WP-301 — Thẻ, pill, hàng chờ thông báo và "Để tôi"

**Kết quả:**
- `managerId` nhận `BM-FALLBACK`. Đích đang chạy thì tin chờ trong `notice-queue` tới `turn_ended` kế tiếp.
- Chat Manager hiện thẻ `fallback` với trạng thái đọc từ `fallback.incidents`; pill đếm sự cố `pending`.
- `fallback.act("dismiss")` chạy.
- `BM-FALLBACK` vào `PREFIXES`; `manager.md` có câu về nó.

**Nguồn:** REQ-065 (c); thiết kế §4.4.6, §4.4.10. **Phụ thuộc:** WP-300.

**Ranh giới:** `notice-queue` (WP-291) được dùng lại, không viết lại. Một hàng chờ giữ được cả tin `BM-SETTINGS` lẫn tin `BM-FALLBACK` cho cùng một đích; tin mới chỉ thay tin **cùng loại**.

**Phạm vi:** `plugin/shared/bm-fallback.ts` (mới); `plugin/server/fallback-rpc.ts` (mới); `notice-queue.ts`; `chat-waiting.ts`; `notices.ts`; `plugin/client/chat-cards.ts`, `chat-card.tsx`, `waiting-pills-model.ts`; `plugin/shared/contracts.ts`; `manager.md`; test.

**Điều kiện ra:**
- bộ đọc khoan dung của `BM-FALLBACK` có ca đúng và ca sai;
- thẻ không hiện nút cho sự cố đã khác `pending`;
- pill đếm đúng;
- ca `notice-queue` xanh; các ca `BM-SETTINGS` của WP-297 không sửa kỳ vọng;
- các ca đang có của thẻ và pill không sửa kỳ vọng;
- `npm run verify` mã 0.

#### WP-302 — Chuyển sang Worker dự phòng với lời bàn giao

**Kết quả:**
- `fallback.act("switch")` cho vai trò `worker` làm đúng tám bước của thiết kế §4.4.7.
- Lời bàn giao `BM-HANDOVER` role worker dựng bằng mã (§4.4.8).
- `soleWorkerOf` bỏ Worker `replaced`; cây agent ghi "replaced by".
- `worker.md` có đoạn `BM-HANDOVER`.

**Nguồn:** REQ-065 (d), (h), (k); thiết kế §4.4.7, §4.4.8, F10. **Phụ thuộc:** WP-301.

**Ranh giới:** đây là **chỗ plugin tự tạo agent**, loại thiết kế gốc §7 yêu cầu owner review mã. Chống trùng ("bấm hai lần → một Worker") là ca bắt buộc.

**Phạm vi:** `plugin/server/fallback-switch.ts`, `fallback-handover.ts` (mới); `fallback-rpc.ts`; `paseo-cli.ts` (dùng `setAgentLabels` có sẵn); `stop-propagation.ts` (dùng lại hàm dừng Reviewer); `plugin/shared/sole-worker.ts`; `chat-rpc.ts`, `contracts.ts` (`replaced`); `plugin/client/tree.tsx`; `worker.md`; test.

**Điều kiện ra:**
- mọi ca `switch` Worker, bàn giao Worker và `soleWorkerOf` của thiết kế §8 xanh;
- không test nào chạy `paseo` thật;
- `npm run verify` mã 0.

#### WP-303 — Chờ reset rồi làm tiếp

**Kết quả:**
- `fallback.act("wait")` đặt đúng một hẹn giờ theo thiết kế §4.4.9 (ngoại lệ owner chấp nhận ở Q6 a).
- Hẹn giờ được đặt lại khi plugin nạp. Tới giờ, agent hỏng nhận `BM-RESUME`, hoặc sự cố thành `expired`.
- Mã gửi `BM-RESUME` không phụ thuộc vai trò, để 2a-17 dùng lại.
- `worker.md` có câu về `BM-RESUME`.

**Nguồn:** REQ-065 (e); thiết kế §4.4.9. **Phụ thuộc:** WP-301.

**Phạm vi:** `plugin/server/fallback-wait.ts` (mới); `fallback-rpc.ts`; `index.server.ts`; `notices.ts`; `chat-card.tsx`; `worker.md`; test với fake timers.

**Điều kiện ra:**
- ca `wait` của thiết kế §8 xanh (đặt lại khi nạp, quá giờ, agent đang chạy);
- `npm run verify` mã 0.

#### WP-304 — Đóng phase 2a-16

**Kết quả:**
- PRD gốc nhận dòng 10–12.
- Thiết kế gốc có errata trỏ tới delta này: §2.6; §3.1 (hai file mới); §8 (ngoại lệ hẹn giờ của Q6 a).
- Checklist nghiệm thu 2a-16, gồm "thẻ hiện khi lượt của Manager cùng provider gốc hỏng".
- Ghi chú phát hành `0.3.0-alpha.2`.

**Nguồn:** PRD delta §4, §5; thiết kế §8. **Phụ thuộc:** WP-299, WP-300, WP-301, WP-302, WP-303.

**Phạm vi:** như WP-298, cộng `GUIDE.md` (bảng vị trí paseo-bm ghi: hai file mới, alias dự phòng — REQ-015).

**Điều kiện ra:** như WP-289.

### Phase 2a-17 — Dự phòng cho Reviewer và Manager

#### WP-305 — Reviewer dự phòng, do Worker tạo theo chỉ dẫn

**Kết quả:**
- `FALLBACK_ROLES` thêm `reviewer`; màn Roles & models có chuỗi của Reviewer.
- Alias `bm-reviewer-fallback-<n>` không bao giờ có `paseoTools`.
- `fallback.act("switch")` cho Reviewer **không tạo agent**. Nó gửi Worker cha `BM-FALLBACK` có chỉ dẫn tạo Reviewer thay thế, đúng mẫu thiết kế §4.5.1.
- `agent.created` nhận ra Reviewer thay thế qua `bm.replaces`, ghi `replacementId` và đặt `bm.replacedBy`.
- `reviewCallsOf` không đếm tin đầu của Reviewer thay thế.
- Mất hàng chờ thì thẻ có nút **Resend to Worker**.
- `worker.md` có đoạn "Reviewer hỏng vì provider".
- "Chờ" gửi `BM-RESUME` cho Reviewer cũ.

**Nguồn:** REQ-066 (a), (b), (d), (e), (f); thiết kế §4.5.1, §7. **Phụ thuộc:** WP-304.

**Ranh giới:** đây là **ranh giới quyền** của Reviewer (ADR-006 QĐ3). Kiểm âm bắt buộc: alias Reviewer dự phòng có `paseoTools` → test đỏ.

**Phạm vi:** `plugin/shared/fallback.ts`; `fallback-settings.ts`; `fallback-rpc.ts`, `fallback-switch.ts`; `agent-labels.ts`; `plugin/server/traces.ts` (`reviewCallsOf`); `review-budget.ts`; `chat-card.tsx`; `plugin/client/setup-screen.tsx`, `setup-model.ts`; `worker.md`; test.

**Điều kiện ra:**
- các ca Reviewer của thiết kế §8 (2a-17) xanh, gồm "không gọi `agents.create`" và "vẫn đếm tin thứ hai";
- các ca đang có của `reviewCallsOf` và `BM-BUDGET` không sửa kỳ vọng;
- ngưỡng dòng của file vai trò không nâng;
- `npm run verify` mã 0.

#### WP-306 — Manager dự phòng, với lời bàn giao cho Manager

**Kết quả:**
- `FALLBACK_ROLES` thêm `manager`; màn Roles & models có chuỗi của Manager.
- `fallback.act("switch")` cho Manager làm đúng bảy bước của thiết kế §4.5.2, qua hàm `createManager` tách từ `ensureManager`.
- Lời bàn giao `BM-HANDOVER` role manager dựng bằng mã. Tin của người dùng trong đó đã qua bộ che bí mật.
- `findLiveManagers` bỏ Manager đã bị thay, nên `manager.ensure` mở Manager thay thế.
- Mọi Worker sống nhận `BM-SETTINGS` có id Manager mới.
- Thẻ `switched` chỉ đường mở Beads Manager.
- `manager.md` có đoạn `BM-HANDOVER`; `worker.md` mở rộng câu `BM-SETTINGS` sang id Manager.
- "Chờ" gửi `BM-RESUME` cho Manager cũ.

**Nguồn:** REQ-066 (a), (c), (d), (f); PRD gốc REQ-020 (b) mới; thiết kế §4.5.2. **Phụ thuộc:** WP-304.

**Ranh giới:**
- Đây là **chỗ plugin tự tạo agent**, loại thiết kế gốc §7 yêu cầu owner review mã.
- Nó đổi hành vi của `manager.ensure`: REQ-020 (b) "một Manager cho mỗi workspace". Các ca đang có của `manager.ensure` không được sửa kỳ vọng, trừ ca mới "bỏ Manager đã bị thay".
- Kiểm âm bắt buộc: một token giả trong tin người dùng phải bị che trong lời bàn giao.

**Phạm vi:** `plugin/server/manager.ts` (`createManager`, `findLiveManagers`); `fallback-switch.ts`, `fallback-handover.ts`; `settings-notices.ts`; `collector.ts` (dùng lại bộ che bí mật); `chat-waiting.ts` (dùng lại `waitingOf`); `chat-card.tsx`; `plugin/client/setup-screen.tsx`, `setup-model.ts`; `manager.md`, `worker.md`; test.

**Điều kiện ra:**
- các ca Manager của thiết kế §8 (2a-17) xanh;
- các ca đang có của `manager.ensure` xanh không đổi kỳ vọng;
- `npm run verify` mã 0.

#### WP-307 — Đóng phase 2a-17

**Kết quả:**
- PRD gốc nhận dòng 13 và 14 (REQ-066; REQ-020 b).
- Thiết kế gốc §8 ("Một Manager cho mỗi workspace") có errata trỏ tới delta này.
- Checklist nghiệm thu 2a-17: "Chuyển" Reviewer và "Chuyển" Manager trên daemon thật.
- Ghi chú phát hành `0.3.0-alpha.3`.
- **Đóng delta khi 2a-18 chưa mở** (§1.3): đọc `role-fallback-state.json` trên máy owner (chỉ đọc; owner cho phép) để xét điều kiện vào của 2a-18.
  - Chưa đủ: PRD delta, design delta và plan delta chuyển sang "Applied — 2a-18 deferred", mỗi tài liệu một dòng revision nêu lý do. REQ-067 và dòng 15 không áp. Bead của WP-308 và WP-309 ở lại, bị chặn bởi điều kiện vào.
  - Đủ rồi: ba tài liệu giữ trạng thái đang có, và WP-308 được mở.

**Nguồn:** PRD delta §4, §5; thiết kế §8. **Phụ thuộc:** WP-305, WP-306.

**Phạm vi:** như WP-304.

**Điều kiện ra:** như WP-289, cộng: kết quả xét điều kiện vào của 2a-18 được ghi trong revision của plan delta, kèm số sự cố thật đã đọc.

### Phase 2a-18 — Dự phòng "Tự động"

**Điều kiện vào:** `role-fallback-state.json` trên máy owner có ít nhất một sự cố do provider thật sinh ra, ở bất kỳ vai trò nào, và bộ mẫu (mặc định hoặc của file) phân loại đúng nó. Kiểm bằng cách đọc file đó, **không** chạy provider thật tới hạn mức. Chưa đủ thì phase để "deferred".

#### WP-308 — Chính sách "Tự động" cho cả ba vai trò

**Kết quả:**
- `role-fallback.json` nhận `policy: "auto"` cho mỗi vai trò; màn hình có lựa chọn Auto switch kèm cảnh báo chi phí, và cảnh báo thay chat cho Manager.
- Sau khi ghi sự cố: có reset trong ≤ 30 phút → `wait`; không thì có ứng viên → `switch` theo đúng đường của vai trò; không thì `pending`.

**Nguồn:** REQ-067 (a)–(d); thiết kế §4.6. **Phụ thuộc:** WP-307 và điều kiện vào.

**Phạm vi:** `fallback-settings.ts`; `fallback-detect.ts`; `plugin/client/setup-screen.tsx`, `setup-model.ts`; `contracts.ts`; test.

**Điều kiện ra:** ca 2a-18 của thiết kế §8 xanh; `npm run verify` mã 0.

#### WP-309 — Đóng phase 2a-18 và delta

**Kết quả:**
- PRD gốc nhận dòng 15 (REQ-067).
- Ba tài liệu delta chuyển sang "Applied", từ trạng thái đang có (2a-18 đã đủ điều kiện ngay lúc WP-307 chạy) hoặc từ "Applied — 2a-18 deferred" (2a-18 mở về sau), khớp hai đường đóng ở §1.3.
- Ghi chú phát hành cho bản kế tiếp.

**Phụ thuộc:** WP-308.

**Điều kiện ra:** như WP-289.

## 4. Rủi ro

| Rủi ro | WP | Giảm thiểu |
|---|---|---|
| Mẫu nhận dạng sai | 300, 308 | Mẫu là dữ liệu; N2 hẹp (bốn điều kiện); mặc định "Hỏi tôi"; 2a-18 chỉ mở sau một sự cố thật |
| Ghi đè thay đổi song song trong `agentProfiles` | 295, 299 | `revision`, kiểm sau khi ghi, mutex (ADR-008 QĐ3); rủi ro còn lại owner chấp nhận |
| Tín hiệu `supportsMcpServers` không phản ánh Pi thiếu adapter | 291, 294 | Kiểm trên daemon thật ở nghiệm thu; sai thì dừng và hỏi |
| Thẻ không hiện khi lượt của Manager cùng provider gốc hỏng | 301, 304 | Pill đọc RPC, không đọc timeline; kiểm trên daemon thật |
| Runtime facts cũ làm lần tạo agent con hỏng | 297 | `BM-SETTINGS`; còn lại thì `blocked` như hôm nay |
| Plugin tự tạo agent sai hay tạo trùng | 302, 306, 308 | Chỉ từ `pending`, mutex, `failed` không quay về `pending`; owner review mã |
| Hai Manager sống trong một workspace | 306 | `findLiveManagers` bỏ Manager đã bị thay; Worker nhận id mới; REQ-020 (b) sửa có chủ đích |
| Worker không làm đúng chỉ dẫn tạo Reviewer thay thế | 305 | Chỉ dẫn nêu đủ giá trị; thiếu nhãn thì `BM-BUDGET` báo; nút "Resend to Worker" |
| Tin người dùng lộ bí mật trong lời bàn giao Manager | 306 | Bộ che bí mật của bộ thu thập; kiểm âm |
| Request khác sửa cùng tệp (`manager.md`, `worker.md`, `manager.ts`, `contracts.ts`, `chat-cards.ts`, `setup-screen.tsx`, tài liệu gốc) | mọi WP | Trước khi sửa mã: `git status`, và kiểm Worker khác đang chạy trên repo; có thì `blocked` |
| Phát hành sai thứ tự hay lẫn phase | 289, 294, 298, 304, 307 | Phụ thuộc giữa các phase (§2); owner phát hành theo runbook |

## 5. Kiểm thử của delta

- Theo thiết kế §8. Mỗi WP chạy test của chính nó; mọi WP có mã chạy `npm run verify`.
- Repo không đặt ngưỡng coverage. Thay vào đó, mỗi luật của thiết kế §4 và mỗi ca của thiết kế §8 có ít nhất một test, kèm đối chứng âm ở chỗ thiết kế nêu:
  - trình cài gộp;
  - `auto_accept` của Reviewer;
  - alias Reviewer dự phòng không có `paseoTools`;
  - che bí mật trong lời bàn giao Manager.
- Không test nào chạm daemon thật, `paseo` thật, `$HOME` thật hay mạng.
- Nghiệm thu trên daemon thật là việc của owner ở mỗi WP đóng phase (§1.3).

## 6. Revision History

| Ngày | Ai | Thay đổi |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta theo Q1–Q5 của `req-20260921T111242Z`: năm phase, WP-287 → WP-306. Status Draft, Plan-ready Pending |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: §2 thêm điều kiện bắt đầu delta (PRD delta Accepted) và điều kiện ngoài bead giữa các phase (owner commit phase trước, vì Worker không commit); WP-291 nêu tệp client hiện `toolsNotice` |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Owner trả lời Q6 a, Q7 a, Q8 c. Phase 2a-16 thành hạ tầng dự phòng chung cộng Worker; thêm phase 2a-17 (Reviewer, Manager — WP-305 → WP-307); Tự động thành phase 2a-18 (WP-308, WP-309); bỏ các cạnh "chặn bởi" Q6–Q8; §4, §5 theo đó |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo review `b1` (hai mục chặn): WP-289 áp dòng 1, 2, 16 của PRD delta (dòng 14 thuộc WP-307); §1.3 và WP-307 định nghĩa đường đóng delta khi 2a-18 chưa mở ("Applied — 2a-18 deferred"), WP-309 chuyển sang "Applied" |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Sửa mục chặn còn lại của re-review `b1` theo gợi ý của Reviewer (owner chốt Q9 a): WP-309 và gạch đầu dòng thứ hai của §1.3 (cùng câu hẹp) chuyển ba tài liệu sang "Applied" từ trạng thái đang có hoặc từ "Applied — 2a-18 deferred". **Bản sửa này không được review lại** (ngân sách lô b1 đã dùng hết 1 + 1) |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Cổng `plan-ready-for-beads` **PASS** (cảnh báo không chặn: plan dài hơn 10 trang). Status Draft → Active; phạm vi Phase 2a-13 → 2a-18 (WP-287 → WP-309) khoá. Ngoại lệ: bản sửa WP-309 / §1.3 chưa được review lại |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Errata khi chuyển thành beads (thiết kế F12, F13): `notice-queue.ts` được tạo ở WP-291 (cho `BM-TOOLS`, vì Manager cha đang chạy lúc Worker vừa được tạo) thay vì WP-297; WP-297 và WP-301 dùng lại. Không đổi phạm vi, phase hay REQ nào |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-13 xong (beads `bm-phase-2a-13-respect-profile-8u20.1` → `.4`): dòng 1, 2, 16 của PRD delta §4 đã áp vào PRD gốc; errata §3.2 vào thiết kế gốc; checklist nghiệm thu `docs/operations/paseo-bm-worker-fallback-checklist.md` (phần 2a-13) và ghi chú phát hành `docs/operations/paseo-bm-release-notes-0.2.0-alpha.2.md` |
| 2026-09-22 | hieu.nt10 (soạn bởi Beads Worker) | Phase 2a-14 xong (beads `bm-phase-2a-14-any-provider-u2g9.1` → `.11`): dòng 3–6 của PRD delta §4 đã áp vào PRD gốc; errata §2.6 và §7 vào thiết kế gốc; checklist nghiệm thu phần 2a-14 và ghi chú phát hành `docs/operations/paseo-bm-release-notes-0.3.0-alpha.0.md`. Khi implement: hook tra mode của Worker cả khi bên tạo đã chọn mode (để bật `auto_accept` trên OpenCode); `costOf` nhận thêm `paseo` làm tham số đầu |
