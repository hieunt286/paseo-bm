# Implementation Plan — 0.4.0: một nguồn duy nhất, plugin từ paseo.cafe là toàn bộ sản phẩm

| Trường | Giá trị |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-25 — hieu.nt10 (rà soát độc lập; D1 chốt: giữ `ui/setup-state.json` khi xoá dữ liệu) |
| Owner | hieu.nt10 |
| Phase | **Phase 0.4.0 — Single source** |
| Quyết định | [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (Accepted 2026-09-25) |
| Requirements | [PRD](../product/paseo-bm-prd.md) REQ-001 → REQ-015, REQ-027, REQ-031, REQ-070 (bản 0.4.0, đang ghi *Chưa làm*) |
| Technical Design | [paseo-bm.md](../design/paseo-bm.md) §3, §4, §5, §6, §7.3, §7.12, §7.13, §9, §11, §12, §13 · [paseo-bm-dashboard.md](../design/paseo-bm-dashboard.md) §11.3 |
| Phân tích nền | Bảng đối chiếu 27 việc của trình cài (2026-09-25), tóm tắt trong ADR-012 phần Context |

## 0. Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** đổi hợp đồng công khai (bỏ CLI `paseo-bm`, đổi đường cài); ghi vào config Paseo của người dùng (tạo vai trò, cấp tool cho mọi agent, dọn cấu hình); ranh giới đồng ý (chạy CLI bên thứ ba, cài công cụ từ mạng); phát hành và quy tắc hai gói; đảo ADR-001, ADR-009 và sửa ADR-002/003/004/006/008; một thay đổi ở repo khác (entry registry của paseo.cafe); publish npm không lùi được (R3).
- **Artifacts và cổng:** ADR-012 (Accepted); PRD và hai design sửa tại chỗ; plan này + `plan-ready-for-beads`; beads qua `converting-plan-to-beads`; `feature-done` profile standard.
- **Execution path:** plan → converter.
- **Exceptions:** none.
- **Decided:** 2026-09-25 — hieu.nt10.
- **Supersedes:** none.

## 1. MVP-Lock

**Trong phase:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005, REQ-007, REQ-008, REQ-009, REQ-010, REQ-011, REQ-012, REQ-014, REQ-015, REQ-027, REQ-031, REQ-070 theo bản 0.4.0 của PRD, cùng các phần PRD viết lại cho 0.4.0: REQ-035 (b) (chỗ bổ sung skills trên Setup), REQ-062 (c), (e), REQ-063 (a), (f); REQ-006 và REQ-013 bỏ theo ADR-012. REQ-028 và REQ-032 (c) chỉ đổi câu chữ trong PRD, không có việc nào trong phase.

**Ngoài phase:**
- Xoá tệp cũ của trình cài (`~/.paseo-bm/plugin/*`, `backups/*`) bằng hash trong `install.json` — design §5.4 để lại cho sau.
- Tự mở terminal để đăng nhập provider — 0.4.0 chỉ hiện lệnh.
- Hỗ trợ Paseo 0.8.
- Đổi tên gói.
- Xoá `src/` (CLI chuyển đổi) và test của nó — bản sau 0.4.0 (design §3.1).

**Điều kiện ra của phase:**
1. Trên Paseo 0.9.2, một máy chưa từng có paseo-bm cài `npm:paseo-bm-plugin@0.4.0` rồi dùng được đủ: Manager tạo Worker, Worker tạo Reviewer, màn Metric có trace — sau đúng các bước trên Setup mà design §7.13 liệt kê.
2. Một máy đang chạy 0.3.1 dạng thư mục chạy `npx paseo-bm@0.4.0` một lần và sang bản npm, giữ nguyên trace, vai trò và công tắc.
3. Nút "Gỡ cấu hình của paseo-bm" để lại config không còn mục `bm-*` nào và trả công tắc cấp tool đúng giá trị cũ.
4. `paseo-bm-plugin@0.4.0` và `paseo-bm@0.4.0` ở `latest`, có provenance; `paseo-bm` deprecated; entry paseo.cafe có caveat mới; từ sau đó `release.yml` chỉ publish `paseo-bm-plugin`.
5. `npm run verify` xanh; Q-044 → Q-047 có câu trả lời ghi trong design §13.

**Tư thế checkpoint mặc định:** mọi gói việc trước WP-407 chỉ đổi mã và tài liệu trong repo, hoàn tác bằng git. Điểm không lùi được là các lần publish npm (WP-407 prerelease vào `next`, WP-408 bản ổn định vào `latest`); điểm duyệt là GitHub Release do owner đồng ý, theo [release runbook](../operations/paseo-bm-release-runbook.md). Đường lùi cho người dùng là một bản vá ≥ 0.4.0; hạ xuống 0.3.x **không** phải đường lùi, vì plugin 0.3.x không tin thư mục dữ liệu khi `install.json` là `schemaVersion: 2` hay không có (design §12). Người dùng thư mục mà lần chuyển lùi (`fell-back`) vẫn chạy 0.3.1 như trước. **Quyết định R3** (design §12): người chịu rủi ro hieu.nt10; diễn tập có chọn — prerelease trên `next` cộng nghiệm thu trên daemon thật (WP-407) trước khi có gì lên `latest`.

## 2. Work packages

### WP-401 — Plugin tự sở hữu thư mục dữ liệu

- **Outcome:** mọi kho của plugin (trace, `ui/`, `role-extras.json`, `role-fallback*.json`, sổ hỏi–đáp, dấu đã trả lời, budget-told, cổng của endpoint tool) chạy được khi không có `install.json`: thư mục dữ liệu được tìm theo thứ tự biến môi trường → con trỏ `home.json` → mặc định `~/.paseo-bm`, và được tạo khi cần với quyền 0700. Có kho `ui/setup-state.json` đọc/ghi được.
- **Requirements:** REQ-004, REQ-014, REQ-008.
- **Design:** paseo-bm.md §5.1, §5.2, §5.3, §5.4, §7.11; module mới `data-home.ts` (`resolveDataHome`, `ensureDataHome`), `setup-state.ts`; mã lỗi `E_DATA_HOME_UNAVAILABLE`.
- **Prerequisites:** none.
- **Exit:** test chứng minh: HOME mới tinh → collector ghi trace, RPC Dashboard trả dữ liệu, lưu role extras và chuỗi dự phòng thành công; HOME có `install.json` cũ → dùng đúng thư mục cũ; con trỏ `home.json` trỏ thư mục tuỳ chỉnh → dùng thư mục đó; symlink trên đường dẫn bị từ chối như `trace-store` hiện nay.
- **Ranh giới:** đây là seam dữ liệu người dùng đã có — không di chuyển, không đổi tên, không xoá tệp nào của người dùng cũ.

### WP-402 — Plugin tự tạo ba vai trò lần đầu

- **Outcome:** thiếu `bm-manager`/`bm-worker`/`bm-reviewer` thì plugin tạo đúng mục còn thiếu (provider dẫn xuất + profile) với mặc định "provider đầu tiên dùng được, model đầu tiên"; mục đã có không bao giờ bị sửa; sau khi người dùng đã dọn cấu hình thì không tự tạo lại.
- **Requirements:** REQ-005, REQ-009, REQ-027, REQ-031 (a), (b), REQ-062 (c), (e).
- **Design:** paseo-bm.md §6.1, §6.2 (`createRoleEntries`, luật phạm vi mới), §7.3 (`manager.ensure` + `setupNotice`), §7.12, §7.13.1, §7.13.2 (`setup.ensure-roles` / `setupEnsureRolesRpc`, `setup-roles.ts`, `E_SETUP_ROLES_FAILED`); paseo-bm-dashboard.md §11.2 (dải trạng thái hiện `setupNotice`).
- **Prerequisites:** WP-401 (cần `setup-state.json` để ghi `rolesCreated`, `cleanedUpAt`).
- **Exit:** test với SDK giả: config trống → ba vai trò được tạo với `paseoTools` đúng vai, không có `command`/`env`, profile có `notes`; config có sẵn một vai trò → chỉ hai vai còn lại được tạo; mục không phải `bm-*` không đổi; `cleanedUpAt` có giá trị → không tạo; hai lời gọi đồng thời chỉ ghi một lần (mutex + revision).

### WP-403 — Setup: tình trạng máy và các nút cần đồng ý

- **Outcome:** Setup cho thấy việc còn thiếu (vai trò, cấp tool Paseo, đăng nhập provider kèm lệnh, skills, `br`/`bv`, thư mục dữ liệu, bản cài dạng thư mục) và cho làm từng việc cần đồng ý bằng một nút có cảnh báo: cấp tool Paseo cho agent (ghi lại giá trị cũ), cài skills bằng CLI `skills`. Banner chuyển đổi hiện khi plugin chạy từ bản cài thư mục.
- **Requirements:** REQ-003, REQ-007, REQ-008 (e), REQ-011, REQ-027 (b), REQ-031 (c), REQ-063 (f), REQ-070 (g).
- **Design:** paseo-bm.md §6.2 (`setAgentTools`), §7.12, §7.13 (`setup.grant-agent-tools` / `setupGrantAgentToolsRpc`, `setup.install-skills` / `setupInstallSkillsRpc`, trường `setup` của `setup.status`, `setup-machine.ts`, `SKILLS_INSTALL_TIMEOUT_MS`, `E_SETUP_WRITE_FAILED`, `E_SKILLS_PRESENT`, `E_SKILLS_INSTALL_FAILED`); paseo-bm-dashboard.md §11.3 (bố cục, câu chữ, cảnh báo).
- **Prerequisites:** WP-401 (`setup-state.json`), WP-402 (trạng thái vai trò đọc từ cùng module).
- **Exit:** test server: nút cấp tool ghi `injectIntoAgents: true` và lưu `previous`; bấm lần hai không ghi lại; cài skills chạy đúng lệnh hằng, hết hạn 300 giây thì báo lỗi có mã, kiểm lại skills sau khi chạy; `setup.status` trả đủ trường mới (gồm `logins` chỉ lấy boolean `loggedIn`, lỗi/hết giờ → `unknown`, và `install.kind`); test phủ định: lời gọi thiếu `confirmed: true` bị schema từ chối, không ghi được `setup-state.json` thì không patch, không có lần ghi nào vào thư mục skills. Test client (model thuần): mỗi trạng thái hiện đúng dòng, đúng câu và đúng nút; không nút nào chạy khi chưa xác nhận.
- **Ranh giới:** ranh giới tin cậy — cảnh báo "mọi agent trên máy" và "công cụ bên thứ ba" phải hiện trước khi bấm; không có đường nào ghi mà không có `confirmed: true`.

### WP-404 — Nút gỡ cấu hình của paseo-bm

- **Outcome:** một nút trên Setup xoá mọi provider và profile `bm-*` (kể cả alias dự phòng), trả công tắc cấp tool về giá trị cũ nếu chính paseo-bm đã bật, xoá thư mục dữ liệu chỉ sau xác nhận thứ hai, ghi `cleanedUpAt`, rồi nói lệnh `paseo plugin remove paseo-bm`.
- **Requirements:** REQ-012.
- **Design:** paseo-bm.md §5.3, §6.2 (`removeAllBmEntries`), §7.13 (`setup.cleanup` / `setupCleanupRpc`); paseo-bm-dashboard.md §11.3.
- **Prerequisites:** WP-401, WP-403 (giá trị cũ của công tắc do WP-403 ghi).
- **Exit:** test: sau cleanup không còn mục `bm-*`, mục khác nguyên vẹn; công tắc do người dùng tự bật thì để nguyên (`left-on`); `deleteData: false` giữ thư mục; `deleteData: true` giữ `ui/setup-state.json`, và sau khi nạp lại plugin `ensureRoles` vẫn trả `skipped: "cleaned-up"` (REQ-012 e); không có xác nhận thì không làm gì.

### WP-405 — Văn bản, tài liệu người dùng và manifest của plugin

- **Outcome:** không còn lời nhắn nào bảo chạy `npx paseo-bm install/doctor/uninstall`; `paseo-plugin.json` đòi Paseo `>=0.9.0`; README, `plugin/README.md`, GUIDE mô tả đường cài từ paseo.cafe, các bước trên Setup, cập nhật bằng `paseo plugin update`, gỡ bằng nút rồi `paseo plugin remove`, và lệnh chẩn đoán khi plugin không nạp được.
- **Requirements:** REQ-001, REQ-002, REQ-010, REQ-015, REQ-035 (b).
- **Design:** paseo-bm.md §3.1, §7.13 (bảng câu chữ thay thế), §8, §12.
- **Prerequisites:** WP-402, WP-403, WP-404 (tài liệu tả hành vi cuối cùng).
- **Exit:** README và `plugin/README.md` có mục "Đã cài bằng `npx paseo-bm` trước đây" nêu câu lỗi `Plugin ID "paseo-bm" is already configured` và lệnh `npx paseo-bm@0.4.0` (design §4.3); `grep` không còn `npx paseo-bm install|doctor|uninstall` trong `plugin/` và tài liệu người dùng ngoài phần chuyển đổi; test manifest và `smoke:packed` xác nhận `requirements.paseo: ">=0.9.0"` của tarball plugin; test nội dung vai trò xanh (lời nhắn trong Runtime facts đổi).

### WP-406 — `paseo-bm` 0.4.0: CLI chỉ để chuyển đổi

- **Outcome:** `npx paseo-bm` (và `install`, `migrate`) chuyển bản cài thư mục sang npm theo design §4 (tình huống A–E, fallback cài lại thư mục cũ, con trỏ `home.json` cho thư mục tuỳ chỉnh, đánh dấu `install.json` `schemaVersion: 2` + `migratedTo`); `doctor`, `uninstall` và cờ cũ thoát 2 với `E_COMMAND_RETIRED`; phần trình cài không còn dùng bị xoá cùng test của nó; tarball `paseo-bm` chỉ còn `dist/` và `smoke:packed` kiểm đúng hình dạng mới của cả hai gói.
- **Requirements:** REQ-070, REQ-013 (bỏ), REQ-014.
- **Design:** paseo-bm.md §3.1, §3.2, §4.1 → §4.6, §5.2, §11.
- **Prerequisites:** WP-401 (định dạng `home.json` mà plugin đọc).
- **Exit:** test tích hợp với HOME giả và `paseo` giả cho cả năm tình huống (và thư mục trong `<install home>/plugin/` không có `install.json` → 5), gồm fallback thành công và fallback thất bại, cùng mọi mã thoát và `--json`; `npm run verify` xanh; `smoke:packed` xanh cho hình dạng mới của tarball `paseo-bm` (chỉ `dist/`, `package.json`, `README.md`, `LICENSE`).
- **Ranh giới:** seam tương thích với người dùng cũ — thứ tự ghi (con trỏ trước, Paseo sau, `install.json` cuối) không được đảo; không lệnh nào xoá dữ liệu hay vai trò. Cùng commit với việc đổi hình dạng tarball, bảng "Two packages, one release" của `AGENTS.md` cập nhật theo (gói `paseo-bm` chỉ còn `dist/`).

### WP-407 — Bản thử 0.4.0-alpha.0 vào `next` và nghiệm thu trên daemon thật

- **Outcome:** `0.4.0-alpha.0` của cả hai gói lên dist-tag `next`; checklist cài đặt (`paseo-bm-install-checklist.md`) viết lại cho 0.4.0 và chạy đạt trên Paseo 0.9.2: cài mới từ `npm:paseo-bm-plugin@next`, chuyển đổi từ 0.3.1 bằng `npx paseo-bm@next`, các nút Setup, gỡ cấu hình; Q-044 → Q-047 có câu trả lời ghi vào design §13.
- **Requirements:** mọi REQ trong MVP-Lock (bằng chứng quan sát).
- **Design:** paseo-bm.md §11, §13; runbook phát hành §1–§3.
- **Prerequisites:** WP-405, WP-406; rà soát độc lập các phần design §9 (mục cuối) bắt buộc — `config-writer.ts` ba đường mới, `setup-skills.ts`, `setup.cleanup`, CLI chuyển đổi — đã xong và mọi finding blocking đã đóng trước khi publish prerelease.
- **Exit:** biên bản chạy trong `docs/archive/operations/` với từng mục đạt/không đạt, gồm: chuyển cả bản cài mặc định lẫn `--home`; sau khi chuyển, `npx paseo-bm@0.3.1 install` dừng ở mã 3 mà không đổi gì (REQ-070 e); `paseo plugin update paseo-bm` (Q-046); gỡ cấu hình rồi `paseo plugin remove`. Q-045 (plugin cài từ npm nạp được `zod` và `@getpaseo/plugin`) **phải đạt**, không đạt thì dừng phase và quay lại design. Q-047 khác design §4.3/§4.4 → sửa trong phạm vi WP-406, phát hành `0.4.0-alpha.<n+1>` vào `next` và chạy lại các mục bị ảnh hưởng trước WP-408.
- **Ranh giới:** R3 — publish vào `next` không lùi được; nghiệm thu chạy trên máy của owner nên đổi config thật: owner đồng ý trước, ghi lại config trước khi chạy và trả lại sau (theo cách các lần nghiệm thu trước đã làm).

### WP-408 — Phát hành 0.4.0, cập nhật paseo.cafe, khép quy tắc hai gói

- **Outcome:** `0.4.0` của cả hai gói ở `latest`; PR vào `paseo-cafe/paseo-cafe` thay các caveat nói "phải cài bằng npx" bằng caveat về các bước trên Setup, công tắc cấp tool toàn máy và việc gỡ; owner chạy `npm deprecate` cho `paseo-bm` (cần OTP) với thông điệp nguyên văn của design §3.1; sau đó `release.yml` bỏ bước publish `paseo-bm` (design §3.2 mục 4), `package.json` gốc mang `"private": true`, AGENTS.md mục "Two packages, one release" và runbook phát hành cập nhật theo.
- **Requirements:** REQ-001, REQ-010, REQ-070.
- **Design:** paseo-bm.md §3.2; runbook phát hành §2–§4; hồ sơ paseo.cafe §9.
- **Prerequisites:** WP-407.
- **Exit:** `npm view` cho thấy cả hai gói 0.4.0 ở `latest` có provenance; PR registry qua mọi check; `paseo-bm` hiện thông báo deprecated; một commit sau phát hành gỡ bước publish `paseo-bm` với CI xanh.
- **Ranh giới:** R3 như WP-407; repo khác (paseo-cafe) — entry chỉ đổi caveat, Biome giữ mảng ngắn trên một dòng, không ghi file từ giá trị chưa kiểm là khác rỗng.

## 3. Dependencies

| WP | Cần | Vì sản phẩm nào |
|---|---|---|
| WP-402 | WP-401 | `setup-state.json` để ghi `rolesCreated`, `cleanedUpAt` |
| WP-403 | WP-401, WP-402 | `setup-state.json`; trạng thái vai trò |
| WP-404 | WP-401, WP-403 | giá trị cũ của công tắc cấp tool |
| WP-405 | WP-402, WP-403, WP-404 | hành vi cuối cùng để viết tài liệu |
| WP-406 | WP-401 | định dạng `home.json` plugin đọc |
| WP-407 | WP-405, WP-406 | cả hai gói ở trạng thái phát hành được |
| WP-408 | WP-407 | nghiệm thu đạt |

Không có vòng.

## 4. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Plugin cài từ npm không nạp được vì `plugin/package.json` không khai dependency (Q-045) | Đo ở WP-407 trên bản `next` trước khi có gì lên `latest`; không đạt thì dừng phase; bằng chứng từ `paseo-cafe` cho thấy host cấp module cho nguồn npm |
| Tạo profile ghi cả mảng `agentProfiles`, có thể đè thay đổi đồng thời | Mutex + kiểm revision + đọc lại của `config-writer.ts`, như ADR-008 đã chấp nhận |
| Người dùng gỡ plugin mà không bấm nút dọn → còn `bm-*` và công tắc cấp tool | README và caveat của listing nói rõ; nút dọn nằm ở Setup |
| `npx paseo-bm@0.3.x` trong cache cài ngược lại | `install.json` `schemaVersion: 2` làm 0.3.x dừng trước khi ghi (design §4.5); `npm deprecate` |
| Người dùng Paseo 0.8 mất đường lên | Nói rõ trong release notes và README; giữ 0.3.1 |
| Người dùng 0.3.x bấm cài từ paseo.cafe gặp `Plugin ID "paseo-bm" is already configured` | README, `plugin/README.md` (WP-405) và caveat listing (WP-408) nêu đúng câu lỗi và lệnh `npx paseo-bm@0.4.0` (design §4.3) |
| Người dùng cài thư mục không bao giờ chạy `npx` ở lại 0.3.1 mà không có thông báo (bản cài thư mục không tự cập nhật) | Release notes 0.4.0, README, caveat listing, thông điệp `npm deprecate` |
| Sau WP-408 không còn publish `paseo-bm`: sửa lỗi CLI chuyển đổi cần bật lại bước publish | Runbook phát hành ghi cách bật lại (WP-408) |
| Chạy CLI `skills` qua login shell | Lệnh là hằng số, không có đầu vào của người dùng; ghi ở header ADR-003 |

## 5. Câu hỏi mở

| Mã | Câu hỏi | Owner | Trạng thái | Chặn |
|---|---|---|---|---|
| Q-044 | `paseoTools.enabled` của từng provider có tự cấp tool khi công tắc toàn máy tắt không | hieu.nt10 | **đóng 2026-09-25 — không** (đo trên daemon thật, có đối chứng dương; design §13) | không còn chặn gì; nút cấp tool ở WP-403 giữ nguyên |
| Q-045 | Plugin cài từ npm có nạp được `zod`, `@getpaseo/plugin` không | hieu.nt10 | đo ở WP-407; rủi ro thấp — `paseo-cafe` cài từ npm chạy với cùng các import mà không khai dependency (design §13) | chặn WP-408 |
| Q-046 | `paseo plugin update` có đổi đường dẫn đã đăng ký không | hieu.nt10 | đo ở WP-407 | không chặn (dữ liệu không nằm cạnh gói) |
| Q-047 | `paseo plugin add npm:` với `--json` và không TTY có hỏi tin cậy không, JSON trả về hình gì; `plugin ls --json` của bản npm có `installation.identity` không | hieu.nt10 | đo ở WP-407 | không chặn việc viết WP-406 (viết theo design §4.3/§4.4); chặn WP-408 nếu khác design, sửa theo WP-407 Exit |

## 6. Test strategy

- **Unit (Vitest):** module server mới (`data-home`, `setup-state`, `setup-roles`, `setup-machine`, phần mới của `config-writer`) với SDK giả, HOME tạm; model thuần của client cho Setup (không import `react-native` trong `test/`, theo AGENTS.md). Bảng test của design §11 là danh sách bắt buộc.
- **Phủ định (ranh giới tin cậy):** RPC có tác dụng ra ngoài thiếu `confirmed: true` bị schema từ chối; không lần ghi nào ngoài thư mục dữ liệu và phạm vi `config.patch` của design §6.2; không ghi vào thư mục skills; không chuỗi `npx paseo-bm` trong mã plugin ngoài banner.
- **Integration (Vitest):** CLI chuyển đổi với HOME giả và binary `paseo` giả trên `PATH`, như các test tích hợp hiện có; năm tình huống, mọi mã thoát và `--json`.
- **Đóng gói:** `smoke:packed` cho hình dạng mới của hai tarball.
- **Nghiệm thu:** checklist cài đặt 0.4.0 trên daemon thật (WP-407).
- **Không có ngưỡng coverage mới**; test của phần trình cài bị xoá được thay bằng test của đường mới, không giảm test của phần còn giữ.

## 7. Revision History

| Ngày | Ai | Thay đổi |
|---|---|---|
| 2026-09-25 | hieu.nt10 | Bản đầu |
| 2026-09-25 | hieu.nt10 (rà soát bởi Claude) | `reviewing-plan`: sửa đường lùi (hạ xuống 0.3.x không đọc được dữ liệu — design §12) và ghi quyết định R3; MVP-Lock thêm REQ-035 (b), REQ-062 (c)(e), REQ-063 (a)(f), ngoài phase thêm việc xoá `src/`; WP-402 thêm dashboard §11.2; WP-403 thêm REQ-008 (e), REQ-031 (c), REQ-063 (f), REQ-070 (g) và test phủ định; WP-405 nhận kiểm manifest của `smoke:packed`; WP-406 thêm tình huống thiếu `install.json`; WP-407 thêm rà soát an ninh bắt buộc trước prerelease, các mục nghiệm thu của design §11 và vòng sửa khi Q-047 khác design; WP-408 thêm `private: true`; Q-047 thêm hình dạng `plugin ls`; test strategy thêm tầng phủ định |
| 2026-09-25 | hieu.nt10 | Chốt D1 (giữ `ui/setup-state.json` khi xoá dữ liệu, WP-404) và dòng skills theo provider của Worker (dashboard §11.3); WP-406 cập nhật bảng hai gói của `AGENTS.md`; cổng `plan-ready-for-beads` PASS, plan Active |
| 2026-09-25 | hieu.nt10 | Review kỹ plan: Q-044 đo trên daemon thật và đóng (không — công tắc toàn máy bắt buộc, WP-403 giữ nút); Q-045 hạ rủi ro nhờ bằng chứng `paseo-cafe`; Q-047 trả lời một phần; thêm ba rủi ro (xung đột id khi cài từ paseo.cafe, người dùng thư mục không nhận thông báo, bật lại publish `paseo-bm` khi cần sửa CLI); WP-405 Exit thêm mục hướng dẫn người dùng cũ |
