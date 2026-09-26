# paseo-bm — Technical Design

| Trường | Giá trị |
|---|---|
| Status | Active |
| Cách sửa | **Tài liệu sống từ 2026-09-25.** Sửa tại chỗ để luôn mô tả trạng thái hiện tại, mỗi lần sửa thêm một dòng Revision History; git là hồ sơ kiểm toán. Không mở delta mới cho tài liệu này. |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Requirements source | [PRD paseo-bm](../product/paseo-bm-prd.md) |
| Routing decision | [PRD §0](../product/paseo-bm-prd.md#0-routing-decision) (amended 2026-09-25 theo ADR-012, lane Designed); bản 0.4.0: [plan 0.4.0 §0](../plans/paseo-bm-plan-040-single-source.md#0-routing-decision) |
| Tài liệu anh em | [Technical Design Dashboard](./paseo-bm-dashboard.md) — màn Metric, Beads, Setup, thẻ chat, pill, kho lưu vết và các RPC của chúng |
| Related ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-003](../adr/ADR-003-skills-delegation.md) · [ADR-004](../adr/ADR-004-paseo-config-mutation.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) · [ADR-006](../adr/ADR-006-role-registration.md) · [ADR-007](../adr/ADR-007-dashboard-trace-store.md) · [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md) · [ADR-009](../adr/ADR-009-payload-as-npm-package.md) · [ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md) · [ADR-011](../adr/ADR-011-manager-coordinates-workers.md) · [ADR-012](../adr/ADR-012-plugin-is-the-product.md) |
| Hành vi của agent | [`plugin/roles/manager.md`](../../plugin/roles/manager.md), [`worker.md`](../../plugin/roles/worker.md), [`reviewer.md`](../../plugin/roles/reviewer.md) là nguồn sự thật duy nhất. Tài liệu này chỉ mô tả cơ chế plugin làm quanh chúng. |
| Môi trường tham chiếu | Mã hiện có: Paseo CLI/daemon 0.8.0 (kiểm thêm 0.9.2), Node ≥ 22, macOS và Linux. **(0.4.0)** Paseo ≥ 0.9.0; plugin vẫn biên dịch với `@getpaseo/plugin`/`client`/`protocol` 0.8.0 |

## 1. Phạm vi

- **Tài liệu này sở hữu:** đóng gói gói `paseo-bm-plugin` và quy trình phát hành; CLI chuyển đổi `paseo-bm` 0.4.0 (lệnh, cờ, JSON, mã thoát, mã lỗi); thư mục dữ liệu của plugin và các file trong đó; phần paseo-bm ghi vào `config.json`; plugin server: thiết lập máy (vai trò, tool Paseo cho agent, skills, gỡ cấu hình), nhận vai agent, hook tạo agent, Manager, endpoint công cụ cho agent, các thông điệp `BM-*` của plugin, kiểm mẫu khối, đếm ngân sách review, sổ hỏi–đáp, dừng agent, dự phòng khi hết hạn mức; các slash command.
- **Không sở hữu:** câu chữ và hành vi của ba vai (thuộc `plugin/roles/*.md`); giao diện Metric/Beads/Setup (kể cả luồng thiết lập máy trên Setup), thẻ chat, pill, kho lưu vết (thuộc [Design Dashboard](./paseo-bm-dashboard.md)); chất lượng suy luận của model; nội dung skills bên thứ ba; nội bộ Paseo (kể cả cách Paseo tải, cập nhật và gỡ gói npm); thao tác git.
- **Trạng thái của tài liệu.** Tới 0.3.1 sản phẩm gồm trình cài `npx paseo-bm` cộng plugin. [ADR-012](../adr/ADR-012-plugin-is-the-product.md) (2026-09-25) chốt bản đích **0.4.0**: plugin `paseo-bm-plugin` là toàn bộ sản phẩm. Các mục §2–§6 và §7.13 tả bản 0.4.0; chỗ nào tả mã hiện có mà 0.4.0 đổi thì ghi **(0.4.0)** ngay tại chỗ. Trình cài 0.3.1 (wizard, `doctor`, `uninstall`, hồ sơ sở hữu payload, sửa file `config.json` có backup) chỉ còn trong lịch sử git của file này (bản trước dòng Revision History "ADR-012").

## 2. Kiến trúc

```
  paseo.cafe  hoặc  paseo plugin add npm:paseo-bm-plugin          (Paseo ≥ 0.9.0)
  cập nhật:   paseo plugin update paseo-bm
            │ Paseo tải gói vào ~/.paseo/plugins/paseo-bm/<uuid>/node_modules/paseo-bm-plugin
            ▼
┌─ PLUGIN (chạy trong daemon) ────────────────────────────────────────────────┐
│ client: sidebar + Command Center "Beads Manager", slash command, màn        │
│         Metric/Beads/Setup (kể cả thiết lập máy), thẻ chat (Design Dashboard)│
│ server: thiết lập máy (§7.13) → tạo vai trò còn thiếu, cấp tool Paseo cho    │
│                                 agent, chạy CLI skills, gỡ cấu hình          │
│         before("agent.create") → chỉ dẫn vai, Runtime facts, mode, công cụ  │
│         on("agent.created")    → gắn nhãn, kiểm công cụ Paseo (BM-TOOLS)    │
│         on("agent.turn_ended") → lưu vết, BM-FORMAT, ngân sách review,      │
│                                   sổ hỏi–đáp, dừng Reviewer, dự phòng,      │
│                                   hàng chờ thông báo                        │
│         RPC · endpoint MCP 127.0.0.1 (bm_report / bm_review / bm_answers)   │
└───────────┬────────────────────────────────────────────────────────────────┘
            │ ghi (plugin là bên ghi duy nhất)
            ▼
  <thư mục dữ liệu>     mặc định ~/.paseo-bm, plugin tự tạo (§5):
                        traces/ · ui/ (gồm setup-state.json) · role-*.json
  ~/.paseo/config.json  chỉ qua config.patch (§6): agents.providers.bm-* ·
                        daemon.agentProfiles[bm-*] · daemon.mcp.injectIntoAgents (khi người dùng bấm)

  npx paseo-bm@0.4.0    bản cuối của trình cài, chỉ chuyển bản cài thư mục sang npm (§4)
            │ tạo / nhắn / đọc trạng thái
            ▼
  người dùng ⇄ MANAGER (bm-manager) ──tạo──▶ WORKER (bm-worker) ──tạo──▶ REVIEWER (bm-reviewer)
  người dùng ⇄ WORKER                          Manager, Worker có công cụ Paseo; Reviewer không
```

Người dùng chat được với cả Manager lẫn Worker. Agent do agent khác tạo vẫn là agent hạng nhất trong workspace (chỉ mang thêm nhãn `paseo.parent-agent-id`); người dùng mở, nhắn, dừng, lưu trữ, xoá được. Vòng đời agent thuộc người dùng (ADR-005): plugin không bao giờ lưu trữ hay xoá agent, và không có RPC nào làm việc đó. Ngoại lệ duy nhất: một Manager chính `createManager` vừa tạo mà khởi động hỏng thì đúng agent đó bị lưu trữ trước khi báo lỗi (§7.3).

Plugin tồn tại vì ba việc một agent không làm được: lối vào ổn định mở đúng Manager của workspace; bảo đảm một Manager mỗi workspace; và các cơ chế cần mã (hook, đếm, kiểm mẫu, dự phòng). Từ 0.4.0 nó thêm việc thứ tư: tự thiết lập máy, vì không còn trình cài nào làm thay.

Ba việc plugin **không** làm được (ADR-012): bật `pluginsEnabled` (plugin chưa chạy khi công tắc còn tắt — công tắc thuộc Paseo và người dùng); tự dọn khi bị gỡ (Paseo không có hook gỡ plugin); sao lưu nguyên file `config.json` (SDK chỉ trả một view, và file có thể chứa khoá của provider).

## 3. Đóng gói và phát hành

### 3.1 Gói

Tới 0.3.1 mỗi lần phát hành publish hai gói cùng phiên bản (ADR-009). **(0.4.0)** Sản phẩm là một gói; `paseo-bm` 0.4.0 là lần publish cuối của trình cài:

| Gói | Vai trò | Gốc tarball |
|---|---|---|
| `paseo-bm-plugin` | **Sản phẩm.** Cài bằng paseo.cafe hoặc `paseo plugin add npm:paseo-bm-plugin`, cập nhật bằng `paseo plugin update paseo-bm`, gỡ bằng `paseo plugin remove paseo-bm` sau nút gỡ cấu hình (§7.13.7). Đường cài duy nhất được hỗ trợ | plugin nạp được: `paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`, `tsconfig.json`, `LICENSE`, `README.md` |
| `paseo-bm` | **(0.4.0)** Bản cuối, chỉ để chuyển đổi (§4); `bin: { "paseo-bm": "dist/index.js" }`; `files: ["dist/"]` (không còn `plugin/`: bản 0.4.0 không chép payload). Sau 0.4.0 không publish nữa; owner chạy `npm deprecate paseo-bm "<thông điệp>"` (cần OTP) | chỉ `dist/`, không có gì trông như plugin |

Thông điệp deprecate (owner dán nguyên văn): `paseo-bm is now installed from paseo.cafe or with "paseo plugin add npm:paseo-bm-plugin" (Paseo 0.9+). If you installed it with npx before, run "npx paseo-bm@0.4.0" once to switch.`

- **(0.4.0)** `plugin/paseo-plugin.json` = `{ "id": "paseo-bm", "requirements": { "paseo": ">=0.9.0" } }`: Paseo 0.8 không có nguồn npm (ADR-009 QĐ5), nên 0.8 không được hỗ trợ; người dùng 0.8 giữ `paseo-bm@0.3.1`. Chỉ có **một** `paseo-plugin.json` trong repo; một test khẳng định điều đó.
- **Phiên bản.** `package.json` gốc vẫn là nguồn phiên bản duy nhất người sửa tay; `scripts/generate-plugin-version.mjs` (chạy trong `build`, nên cả trong `prepack`) ghi `plugin/package.json` và `PLUGIN_VERSION` (`plugin/shared/version.ts`); một test đỏ khi ba nguồn lệch. Ở 0.4.0 luật này giữ nguyên vì hai gói còn publish cùng lần. **Sau 0.4.0:** `package.json` gốc mang `"private": true` (không publish được nữa, vẫn giữ phiên bản, script build/test và devDependencies); `src/` (CLI chuyển đổi) và test của nó bị xoá ở bản kế tiếp; test đồng bộ phiên bản giữ nguyên.
- `plugin/package.json` không có `dependencies` (Paseo cấp module runtime — với nguồn npm điều này chưa kiểm, §13 Q-045) và **không có script `test`**: không có test nào trong `plugin/`, và một script chỉ để mục health `hasTests` xanh là kiểm tra giả. Script `typecheck` chỉ chạy được từ checkout của repo. **(0.4.0)** `description`: `Beads Management for Paseo: a Beads Manager agent that hands each request to a Beads Worker, with Metric, Beads and Setup screens. Install from paseo.cafe or with "paseo plugin add npm:paseo-bm-plugin" (Paseo 0.9+).`
- `plugin/LICENSE` là bản sao đúng từng byte của `LICENSE` gốc; một test giữ hai file khớp.
- `plugin/images/` chỉ phục vụ trang listing, không vào tarball nào; `smoke:packed` khẳng định điều đó và khẳng định gốc tarball payload có manifest cùng hai entry. **(0.4.0)** `smoke:packed` thêm: tarball `paseo-bm` 0.4.0 chỉ có `dist/` và `package.json`, `README.md`, `LICENSE`; manifest của tarball plugin khai `>=0.9.0`.
- Không có `preinstall` / `install` / `postinstall` ở gói nào (tải gói không được đổi máy người dùng; Paseo tự chạy `npm install` cho plugin npm); `prepack` được phép vì chạy trên máy người phát hành.
- **Registry paseo.cafe** (`registry/paseo-bm.json` ở repo `paseo-cafe/paseo-cafe`): giữ `package: "paseo-bm-plugin"`, `path: "plugin"`. **(0.4.0)** Caveat 1–3 (đang nói `npx paseo-bm` là đường cài duy nhất và hứa hợp đồng CLI) được owner viết lại bằng một PR ở repo đó: cài từ paseo.cafe là đủ trên Paseo 0.9+; ba bước cần bấm trên Setup; gỡ plugin mà không bấm "Remove paseo-bm's settings" thì cấu hình `bm-*` và `injectIntoAgents` còn lại. Hai bẫy của CI bên đó vẫn áp dụng (mảng ngắn một dòng; không ghi file từ giá trị chưa kiểm là khác rỗng — AGENTS.md).

### 3.2 CI và phát hành

- **`.github/workflows/ci.yml`** (mỗi push lên `main` và mỗi PR): một job ubuntu, Node 22 (mức `engines` thấp nhất): `npm ci`, typecheck gốc và plugin, lint, test. Bỏ qua commit chỉ đụng `docs/**`, `.beads/**`, `README.md`, `GUIDE.md`, `AGENTS.md`, `CLAUDE.md`, `assets/**`. `plugin/roles/*.md` cố ý không bị bỏ qua vì được nhúng vào bundle và có test.
- **`.github/workflows/release.yml`** chạy khi một GitHub Release được publish, hoặc chạy tay (`workflow_dispatch`, input `tag` tuỳ chọn, mặc định `v<version>`; luôn là dry-run). Không đổi tên file: trusted publisher npm của **cả hai** gói trỏ theo tên file này. Xác thực bằng OIDC, không có `NPM_TOKEN` hay secret nào.
  1. Job `verify`: ma trận `{ubuntu-latest, macos-latest} × Node 24`, `fail-fast: false`: typecheck gốc và plugin, lint, test, build, `smoke:packed`, kiểm không có script vòng đời cài đặt. Node 22 đã được `ci.yml` kiểm ở mọi commit; chiều hệ điều hành được giữ vì chính nó bắt được lỗi treo chỉ có trên Linux.
  2. Job `release` (`needs: verify`, `id-token: write`, npm ≥ 11.5.1): tag phải bằng `v<version>` của `package.json`; với sự kiện `release`, cờ prerelease của Release phải khớp hình dạng phiên bản (`version.includes("-")`), nên bản ổn định phải được tạo Release **không** đánh dấu prerelease. **Dist-tag theo loại phiên bản:** prerelease → `next`, bản ổn định → `latest`. Sau đó `npm ci` → kiểm → build → `smoke:packed` → "Assert both packages agree" (`plugin/package.json` có `name` `paseo-bm-plugin` và cùng phiên bản) → `npm publish --dry-run` cho cả hai gói. Chỉ khi sự kiện là `release`: publish `paseo-bm` rồi mới publish `paseo-bm-plugin` (cả hai `--provenance --access public --tag <dist-tag>`), rồi chờ `npm view <gói>@<dist-tag> version` bằng phiên bản mới (tối đa 20 lần × 15 giây, vì npm báo "being processed" một lúc sau khi publish).
  3. Script node của bước "Resolve version, tag and dist-tag" nằm trong chuỗi shell nháy đơn: không được có dấu nháy đơn hay apostrophe nào trong script.
  4. **(0.4.0)** Bản 0.4.0 chạy đúng luồng trên lần cuối (cả hai gói). **Từ bản sau 0.4.0:** bỏ dry-run và publish của `paseo-bm` cùng bước chờ của nó; "Assert both packages agree" thành "Assert the plugin version": `plugin/package.json` có `name` `paseo-bm-plugin` và `version` bằng tag. Tên file và trusted publisher của `paseo-bm-plugin` giữ nguyên.
- Bản ổn định **không** được đẩy thêm vào `next`: việc đó cần `npm dist-tag add`, một lệnh ghi khác `publish` mà quyền trusted publisher chưa được chứng minh là cho phép. `next` vì vậy ở lại bản prerelease cuối; dời nó (hay dời `latest` khi publish không tự dời) là việc tay của owner, cần OTP. Registry paseo.cafe đọc `paseo-bm-plugin@latest`, và `paseo plugin add npm:paseo-bm-plugin` không nêu phiên bản cũng lấy `latest`.
- Bản đã publish không lùi được (npm chặn `unpublish` sau 72 giờ): đường lùi là phát hành bản vá, và chính GitHub Release là điểm phê duyệt của người.

## 4. CLI `paseo-bm` 0.4.0 — chỉ chuyển đổi

**(0.4.0)** Toàn bộ mục này là bản đích. CLI 0.3.1 (wizard, `install`, `doctor`, `uninstall`, `--prune`) thay bằng đúng một việc: đưa một bản cài dạng thư mục của trình cài cũ sang nguồn npm, giữ nguyên dữ liệu, vai trò và công tắc (ADR-012 QĐ7). Nó dùng lại các module sẵn có của `src/`: `paseo/adapter.ts`, `preflight.ts`, `layout.ts` + `paths-guard.ts`, `lock.ts`, `record.ts`, `fsops.ts`, `redact.ts`, `report/*`, `exit-codes.ts`, `errors.ts`, và mẫu đường lùi `restorePrevious` của `commands/install/register.ts` (bm-vey).

### 4.1 Lệnh và cờ

| Lệnh | Ý nghĩa |
|---|---|
| `paseo-bm`, `paseo-bm install`, `paseo-bm migrate` | Chuyển đổi (§4.3–§4.5). Có TTY: xem trước rồi hỏi một câu, mặc định "Không". Không TTY: cần `--apply`; thiếu thì in bản xem trước và thoát 6 |
| `paseo-bm doctor`, `paseo-bm uninstall` | Không chạy gì. In việc đó đã chuyển về đâu (sức khoẻ: màn Setup, hoặc `paseo plugin ls` / `paseo plugin logs paseo-bm` khi plugin không nạp được; gỡ: nút "Remove paseo-bm's settings" trên Setup rồi `paseo plugin remove paseo-bm`), thoát 2, `E_COMMAND_RETIRED` |
| `--version`, `--help` | (`-v`, `-h`) |

| Cờ | Ghi chú |
|---|---|
| `--apply` | Không TTY thì bắt buộc để ghi |
| `--yes` | Bỏ câu hỏi xác nhận khi có TTY |
| `--home <dir>` / `PASEO_BM_HOME` | Thư mục cài đặt của trình cài cũ (mặc định `~/.paseo-bm`); cùng luật an toàn như cũ (`E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`, `E_TARGET_NOT_WRITABLE`, thoát 3) |
| `--paseo-home <dir>` / `PASEO_HOME` | Chỉ để dò; `home` của `paseo daemon status --json` vẫn là nguồn sự thật |
| `--json`, `--verbose` | |

Mọi cờ khác của 0.3.x (`--enable-plugins`, `--install-skills`, `--install-beads-tools`, `--skills-agents`, `--role`, `--reconfigure`, `--skip-skills-check`, `--force`, `--ask-skills-again`, `--restore-backups`, `--prune`, `--claude-home`, `--codex-home`) → thoát 2, `E_COMMAND_RETIRED`, thông điệp nêu chỗ thay thế trên Setup. Thứ tự ưu tiên: cờ > biến môi trường > mặc định.

### 4.2 Tiền đề

Dừng trước mọi thao tác ghi, thoát 3, khi: hệ điều hành không phải macOS/Linux (`E_UNSUPPORTED_OS`); Node < 22 (`E_NODE_TOO_OLD`); không có `paseo` (`E_PASEO_CLI_MISSING`); daemon không trả lời `paseo daemon status --json` (`E_DAEMON_UNREACHABLE`); phiên bản CLI (`cliVersion`, không có thì `paseo --version`) khác `daemonVersion`, hoặc thấp hơn **0.9.0** (`E_VERSION_MISMATCH`, thông điệp đổi thành "requires Paseo 0.9.0 or newer"); thư mục cài đặt không an toàn; khoá `<install home>/.lock` đang bị giữ (`E_LOCKED`); `install.json` không đọc được hay hỏng (thoát 3 như cũ) hoặc có `schemaVersion` > 2 (`E_RECORD_SCHEMA_TOO_NEW`). Mỗi lời gọi Paseo là tiến trình con, argv mảng, không shell, 15 giây — trừ `plugin add` (§4.4).

### 4.3 Nhận ra bản cài

Đọc `paseo plugin ls --json`, mục `id === "paseo-bm"`. Paseo 0.9 báo thêm `installation.identity = { kind, packageName?, pluginPath? }`; thiếu trường này thì chỉ dùng luật đường dẫn. "Nằm trong" là so sau `path.resolve` (không `realpath`), như bản cũ.

| Tình huống | Nhận ra bằng | CLI làm | `migration.outcome`, mã |
|---|---|---|---|
| **A** — bản cài thư mục của trình cài | có mục; `identity.kind` là `"directory"` hoặc vắng; `path` nằm trong `<install home>/plugin/`; `install.json` có `schemaVersion: 1` | chuyển đổi (§4.4), rồi đánh dấu (§4.5) | `migrated` 0 · `fell-back` 7 · `fallback-failed` 7 · `remove-failed` 7 |
| **B** — đã là npm | `identity.kind === "npm"` và `identity.packageName === "paseo-bm-plugin"` | không gọi Paseo. `install.json` còn `schemaVersion: 1` → chỉ làm bước 0 của §4.4 rồi §4.5 (lần chuyển trước dừng giữa chừng, hoặc người dùng tự `plugin add`) | `already-npm` 0 |
| **C** — thư mục khác | `identity.kind` là `"directory"` (hoặc vắng) mà `path` ngoài `<install home>/plugin/` (checkout của người phát triển, hoặc thư mục cài ở home khác) | không ghi gì; thông điệp gợi ý `--home <dir>` | `not-ours` 5, `E_CONFLICT` |
| **D** — không có mục `paseo-bm` | | không ghi gì; in hướng dẫn cài từ paseo.cafe và lệnh `paseo plugin add npm:paseo-bm-plugin` (có `install.json` thì thêm: dữ liệu cũ ở `<install home>` được bản npm dùng tiếp) | `no-directory-install` 0 |
| **E** — nguồn khác | `identity.kind` là giá trị khác, hoặc `npm` với `packageName` khác | không ghi gì | `not-ours` 5, `E_CONFLICT` |

Mục thư mục có `path` nằm trong `<install home>/plugin/` mà **không có** `install.json` → coi như C: không ghi gì, `not-ours` 5, `E_CONFLICT` (hồ sơ là bằng chứng sở hữu duy nhất — ADR-002; không có nó thì không có gì để mang `agentTools` sang hay để đánh dấu). `plugin ls --json` lỗi hay không đọc được → dừng như tiền đề, thoát 3, mã của `PaseoCliError` (như `listPluginOrStop` của 0.3.x). Luật nhận B dựa vào `installation.identity` có mặt trong `plugin ls --json` với bản npm (schema `{ kind: "npm", packageName, pluginPath }` có trong bundle Paseo 0.9.2; việc CLI in nó ra được đo ở §13 Q-047): nếu vắng, bản npm rơi vào C và lần chạy lại trả 5 thay vì 0 — sửa bằng dữ liệu đo trước khi phát hành.

**Cài từ paseo.cafe khi còn bản cài thư mục cũ.** Paseo từ chối id đã cấu hình (`Plugin ID "paseo-bm" is already configured; choose another ID with --id`), nên người dùng 0.3.x bấm cài từ paseo.cafe sẽ gặp lỗi đó. Lối ra duy nhất được hỗ trợ là chạy `npx paseo-bm@0.4.0` một lần (tình huống A); không bao giờ khuyên `--id` khác (hai bản paseo-bm cùng chạy sẽ cùng tạo vai trò và cùng tiêm chỉ dẫn). README, `plugin/README.md` và caveat của listing nêu đúng câu lỗi này cùng lệnh đó.

`install.json` đã có `schemaVersion: 2` (đã chuyển) mà Paseo lại báo bản cài thư mục của tình huống A → **không** tự chuyển lại (có thể người dùng cố ý quay về): không ghi gì, thông điệp "already switched once; Paseo shows a directory install again", thoát 5, `E_CONFLICT`, `not-ours`.

### 4.4 Chuyển đổi (tình huống A)

Bản xem trước liệt kê đúng các bước dưới, kèm thư mục cũ, gói và phiên bản đích (`npm:paseo-bm-plugin@<phiên bản của chính CLI>`), và một câu: "agents keep running; paseo-bm's hooks are off for the seconds the switch takes". Xác nhận xong:

0. **Ghi trước khi đụng Paseo** (plugin 0.3.x không đọc hai file này nên chúng vô hại nếu phải lùi): (i) thư mục cài đặt khác `~/.paseo-bm` → con trỏ `~/.paseo-bm/home.json` (§5.2; tạo `~/.paseo-bm` với quyền `0700` nếu chưa có); (ii) `install.json` có `paseo.mcpInject.setByUs: true` và `<install home>/ui/setup-state.json` chưa có `agentTools` → ghi `agentTools = { setBy: "installer", previous: <previous.present && previous.value === true>, at }` (§5.3). Ghi qua `fsops` (một bộ cho mỗi gốc: thư mục cài đặt và `~/.paseo-bm`; atomic, `0600`, chặn symlink và thoát thư mục).
1. `paseo plugin remove paseo-bm --json`. Lỗi → dừng; không bước nào sau chạy; thoát 7, `E_PLUGIN_LOAD_FAILED`, `remove-failed`, kèm nguyên văn lý do của Paseo.
2. `paseo plugin add npm:paseo-bm-plugin@<phiên bản> --id paseo-bm --json`, hạn **120 giây** (`PLUGIN_ADD_TIMEOUT_MS = 120_000`: Paseo chạy `npm install` thật).
3. Chờ mục `paseo-bm` có `status` ∈ {`running`, `disabled`}: poll `plugin ls --json` mỗi 500 ms, tổng 30 giây (như bản cũ). `disabled` nghĩa là `pluginsEnabled` đang tắt — việc của Paseo và người dùng — nên vẫn là thành công, kèm một dòng nhắc.
4. Bước 2 hay 3 lỗi → **đường lùi** (bm-vey): `paseo plugin remove paseo-bm` (lỗi bỏ qua: Paseo có thể giữ mục của plugin không khởi động được) → `paseo plugin install <thư mục cũ> --id paseo-bm --json` → chờ như bước 3. Thoát 7, `E_PLUGIN_LOAD_FAILED`, kèm nguyên văn lý do của Paseo (`error.message` của JSON lỗi, không có thì stderr) và kết quả đường lùi: `fell-back` (bản cũ chạy lại) hoặc `fallback-failed` (in hai lệnh tay: `paseo plugin install <thư mục cũ> --id paseo-bm`, `paseo plugin logs paseo-bm`). `install.json` không đổi; hai file của bước 0 ở lại.
5. Thành công → §4.5.

Không bao giờ: `paseo daemon restart`/`stop`; sửa tay khoá `plugins`; đụng mục `bm-*`, `daemon.mcp.injectIntoAgents`, `pluginsEnabled`; xoá hay sửa `plugin/<ver>/`, `backups/`, `traces/`, `ui/` (trừ bước 0), `role-*.json`. Chạy lại sau khi thành công → tình huống B, 0 thay đổi.

### 4.5 Đánh dấu `install.json`

Ghi lại `install.json` (atomic, `0600`) với `schemaVersion: 2`, `updatedAt` mới và trường mới:

```jsonc
"migratedTo": { "source": "npm", "package": "paseo-bm-plugin", "version": "0.4.0", "at": "<ISO 8601 UTC>" }
```

Mọi trường khác giữ nguyên giá trị. Lý do tăng `schemaVersion`: trình cài ≤ 0.3.1 đọc hồ sơ **trước mọi thao tác ghi** (`install` — `src/commands/install/index.ts` `loadRecordOrStop`; `uninstall` — `src/commands/uninstall.ts` `readRecord`; `doctor`) và dừng ở `E_RECORD_SCHEMA_TOO_NEW`, thoát 3, khi gặp `schemaVersion` > 1. Một `npx paseo-bm@0.3.x` còn trong cache vì vậy không cài ngược bản thư mục và không gỡ plugin npm của người đã chuyển; lời khắc phục nó in (`npx paseo-bm@latest`) dẫn tới 0.4.0 sau khi owner dời `latest`. CLI 0.4.0 đọc được cả `1` và `2`.

### 4.6 Mã thoát, JSON, mã lỗi

| Mã | Ý nghĩa ở 0.4.0 |
|---|---|
| 0 | Đã chuyển; đã là npm; không có bản cài thư mục (đã in hướng dẫn); hoặc xem trước theo chủ đích |
| 2 | Dùng sai lệnh/cờ, kể cả lệnh và cờ đã bỏ (`E_COMMAND_RETIRED`) |
| 3 | Tiền đề không đạt — chưa ghi gì |
| 5 | Plugin `paseo-bm` đang cài không phải của trình cài ở thư mục này (`E_CONFLICT`) — chưa ghi gì |
| 6 | Không TTY và không `--apply`: đã in bản xem trước, chưa ghi gì |
| 7 | `plugin remove`/`plugin add` hỏng hoặc plugin mới không lên (`E_PLUGIN_LOAD_FAILED`); `migration.outcome` nói đường lùi ra sao |

Mã 1 và 4 không còn phát ra (không còn `doctor`, không còn ranh giới tin cậy nào do CLI hỏi) và không được dùng lại cho nghĩa khác. `--json`: stdout đúng một tài liệu, output tiến trình con ra stderr; cùng khung `schemaVersion: 1` của báo cáo cũ:

```jsonc
{
  "schemaVersion": 1,
  "command": "migrate",                     // cả khi gọi bằng `paseo-bm` hay `install`
  "mode": "preview",                        // preview | applied
  "paseoBmVersion": "0.4.0",
  "paseo": { "cliVersion": "…", "daemonVersion": "…", "home": "…", "pluginsEnabled": true },
  "actions": [
    { "kind": "create", "target": "~/.paseo-bm/home.json", "reason": "custom-install-home" },
    { "kind": "create", "target": "installHome/ui/setup-state.json#agentTools", "reason": "carry-over" },
    { "kind": "plugin", "target": "paseo-bm", "from": "<thư mục cũ>", "to": "npm:paseo-bm-plugin@0.4.0" },
    { "kind": "update", "target": "installHome/install.json", "reason": "migrated" }
  ],
  "migration": { "outcome": "migrated", "from": "<thư mục cũ> | null", "to": "npm:paseo-bm-plugin@0.4.0 | null", "fallback": null },
  "warnings": [],
  "result": { "exitCode": 0, "pluginState": "running" }
  // thất bại: "result": { "exitCode": 7, "pluginState": "running", "error": { "code": "E_PLUGIN_LOAD_FAILED", "message": "…" } },
  //           "migration.fallback": { "outcome": "fell-back" | "fallback-failed", "detail": "…" }
}
```

`kind: "plugin"` là giá trị mới; `migration.outcome` ∈ `migrated`, `already-npm`, `no-directory-install`, `not-ours`, `fell-back`, `fallback-failed`, `remove-failed`. `result.error` chỉ có mặt khi thất bại.

**Sổ mã lỗi của CLI** (`src/errors.ts`) ở 0.4.0: giữ `E_DAEMON_UNREACHABLE`, `E_VERSION_MISMATCH` (thông điệp 0.9.0), `E_UNSUPPORTED_OS`, `E_NODE_TOO_OLD`, `E_PASEO_CLI_MISSING`, `E_PASEO_OUTPUT_UNEXPECTED`, `E_CONFLICT`, `E_RECORD_SCHEMA_TOO_NEW`, `E_LOCKED`, `E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`, `E_TARGET_NOT_WRITABLE`, `E_PLUGIN_LOAD_FAILED`; thêm **`E_COMMAND_RETIRED`** (thoát 2); bỏ mọi mã chỉ luồng cài cũ dùng (`E_BAD_SKILLS_AGENTS`, `E_BAD_ROLE_SPEC`, `E_CONFIG_CONCURRENT_WRITE`, `E_PROVIDER_UNAVAILABLE` của CLI, mọi `W_*`). Sổ mã lỗi RPC của plugin ở §7.12.

## 5. Dữ liệu trên đĩa

### 5.1 Thư mục dữ liệu

```
<thư mục dữ liệu>/                 (0700; mặc định ~/.paseo-bm)
  home.json                        (0600) con trỏ, chỉ nằm ở ~/.paseo-bm, chỉ khi dữ liệu ở chỗ khác (§5.2)
  traces/                          (0700) kho lưu vết Dashboard: meta.json, <workspaceId>/{meta.json, events-<YYYYMM>.jsonl}
  ui/                              trạng thái bền của plugin: answer-marks.json, budget-told.json, qa-ledger.json,
                                   agent-tools.json, setup-state.json (0.4.0, §5.3)
  role-extras.json                 (0600) chỉ dẫn bổ sung của người dùng cho từng vai
  role-fallback.json               (0600) chuỗi dự phòng và policy từng vai (§7.10)
  role-fallback-state.json         (0600) các sự cố dự phòng, tối đa 200
  ── chỉ ở người dùng cũ, do trình cài để lại (§5.4); plugin không đọc, không ghi, không xoá ──
  install.json · plugin/<ver>/ · backups/<UTC>/ · .lock
```

Thư mục gói do Paseo quản lý (`~/.paseo/plugins/paseo-bm/<uuid>/node_modules/paseo-bm-plugin`) có thể đổi mỗi lần cập nhật, nên **không bao giờ** chứa dữ liệu. Bundle server không dùng được `import.meta.url` (Paseo biên dịch thành CJS và fork không đặt cwd).

**Tìm thư mục dữ liệu.** `resolveDataHome()` ở `plugin/server/data-home.ts`, **đồng bộ và không cần handle Paseo** — nên endpoint công cụ (§7.4) biết ghi cổng ở đâu ngay lúc plugin còn đang nạp. Dừng ở bước đầu có giá trị:

1. `PASEO_BM_HOME` trong môi trường của tiến trình plugin (tức của daemon), phải là đường dẫn tuyệt đối;
2. con trỏ `~/.paseo-bm/home.json` (§5.2), khi file tồn tại;
3. `~/.paseo-bm`.

Ứng viên của bước 1 hoặc 2 phải qua cùng luật an toàn của trình cài (`src/layout.ts` `assertSafeInstallHome`, chép sang plugin vì plugin không import `src/`): không phải `$HOME` hay thư mục chứa nó; không trùng, không chứa, không nằm trong `~/.paseo` / `PASEO_HOME`, `~/.claude` / `CLAUDE_CONFIG_DIR`, `~/.codex` / `CODEX_HOME`, `~/.agents`. Hỏng luật, hay con trỏ hỏng → `{ home: null, reason }`, **không** lùi âm thầm về `~/.paseo-bm` (lùi sẽ tách dữ liệu làm hai nơi); các phần cần thư mục tắt đi và Setup hiện `reason`. Kết quả: `{ home, tracesDir, source: "env" | "pointer" | "default" } | { home: null, tracesDir: null, reason }`.

**Tạo.** `ensureDataHome(home)` chỉ chạy ở lần ghi đầu tiên cần nó: `mkdir -p` quyền `0700`, kiểm symlink trên đường xuống thư mục trước và sau khi tạo (cùng cách `trace-store.ts` `ensureStoreDir` / `assertNoSymlinkOnPath`). Đường kiểm bắt đầu ở `$HOME` khi thư mục nằm trong `$HOME` — mặc định và gần như mọi máy thật — còn lại bắt đầu ở thư mục cha của nó: `$HOME` là symlink trên không ít máy nên gốc chỉ được kiểm tồn tại, không bị xét; và `/var`, `/tmp` trên macOS là symlink nên đi từ gốc hệ thống sẽ từ chối một `PASEO_BM_HOME=/var/data/bm` hoàn toàn bình thường. Đọc không bao giờ tạo; thư mục chưa có thì đọc như rỗng. `install.json` **không** là điều kiện để tin một thư mục: trình cài 0.3.x ghi nó, bản cài từ paseo.cafe không có, và đó đúng là ca từng làm Dashboard trống.

**Ai đọc thư mục dữ liệu.** Phần lớn đi qua một hàm duy nhất: `role-extras.ts` `dataHomeOf(deps)` — đồng bộ, không tham số `paseo`, trả `string | null`, không bao giờ ném; nó gói `resolveDataHome` và chỉ lấy `home`. Dùng ở `manager.ts`, `role-hook.ts`, `chat-waiting.ts`, `setup-rpc.ts`, `dashboard-rpc.ts`, `fallback-settings.ts`, `fallback-state.ts`, `fallback-rpc.ts`, `fallback-switch.ts`, `fallback-wait.ts`, `fallback-reviewer.ts`; các kho nhận thư mục từ chỗ gọi (`qa-ledger.ts`, `answer-marks.ts`, `budget-told.ts`). Sáu module gọi `resolveDataHome` trực tiếp vì còn cần `tracesDir` hoặc `reason`: `agent-tools.ts`, `collector.ts`, `dashboard-rpc.ts`, `setup-machine.ts`, `setup-rpc.ts`, `setup-state.ts` — `dashboard-rpc.ts` và `setup-rpc.ts` đi cả hai đường, tuỳ chỗ cần gì. `trace-store.ts` không tự tìm thư mục: nó nhận `tracesDir` từ chỗ gọi. `install-home.ts` chỉ còn `installHomeFromPluginPath` và `confirmInstallHome`, để nhận ra bản cài thư mục 0.3.x cho banner chuyển đổi (§7.13.6). Cổng endpoint công cụ nằm ở `<thư mục dữ liệu>/ui/agent-tools.json`, ghi atomic có chặn symlink, quyền `0600`.

### 5.2 Con trỏ `~/.paseo-bm/home.json` (0.4.0)

Chỉ CLI 0.4.0 ghi (§4.4 bước 0), khi thư mục cài đặt cũ không phải `~/.paseo-bm`; plugin chỉ đọc.

```jsonc
{ "schemaVersion": 1, "home": "/abs/path", "writtenBy": "paseo-bm@0.4.0", "at": "<ISO 8601 UTC>" }
```

Không phải JSON, `schemaVersion` khác `1`, `home` không tuyệt đối hay không qua luật an toàn → `{ home: null, reason }`. `home` bằng `~/.paseo-bm` → như không có con trỏ. Thư mục đích chưa có → `ensureDataHome` tạo ở lần ghi đầu. Muốn bỏ con trỏ thì xoá file (README nói điều này).

### 5.3 `ui/setup-state.json` (0.4.0)

Trạng thái của thiết lập máy, thay phần `install.json` mà plugin còn cần (trạng thái trước của `injectIntoAgents` để hoàn tác đúng). Module `plugin/server/setup-state.ts`.

```ts
{ schemaVersion: 1,
  agentTools: { setBy: "plugin" | "installer", previous: boolean, at: string /* ISO */ } | null,
  rolesCreated: { at: string, roles: Array<"manager" | "worker" | "reviewer">, baseProvider: string, model: string } | null,
  skillsRun: { at: string, command: string, code: number, outcome: "ok" | "failed" | "timeout" } | null,
  cleanedUpAt: string | null }
```

- `agentTools`: có mặt khi và chỉ khi chính paseo-bm (plugin, hoặc trình cài cũ qua bước chuyển) đã bật `daemon.mcp.injectIntoAgents`. Plugin ghi nó **trước** lần patch bật công tắc; patch hỏng thì trả trường về giá trị trước. View của SDK luôn có `mcp.injectIntoAgents` kiểu boolean (khoá vắng đọc là `false`), nên hoàn tác ghi `false`, không bao giờ xoá khoá — khác bản `{ present, value }` của trình cài, và chấp nhận được vì vắng và `false` cùng nghĩa với daemon.
- `rolesCreated`: lần cuối plugin tạo vai trò (§7.13.2); Setup dùng nó để nói vai trò được tạo với mặc định.
- `skillsRun`: lần cuối chạy CLI `skills` (§7.13.4), chỉ để hiện.
- `cleanedUpAt`: thời điểm "Remove paseo-bm's settings" chạy (§7.13.7); khác `null` thì plugin không tự tạo vai trò nữa.
- Không chứa bí mật, không chứa đường dẫn tới credential.

### 5.4 Luật chung, và phần của người dùng cũ

- Mọi file trong thư mục dữ liệu là dữ liệu người dùng: cập nhật plugin không chạm; chỉ nút gỡ cấu hình xoá được, sau xác nhận thứ hai (§7.13.7).
- Ghi atomic (file tạm → `fsync` → `rename`), `0600`, chặn symlink. File mang `schemaVersion` (hay `version`) mới hơn plugin hiểu thì đọc như rỗng và **không ghi đè**; đọc không bao giờ sửa file.
- **Người dùng cũ** giữ nguyên `~/.paseo-bm` (hoặc thư mục `--home` của họ, tìm qua con trỏ): traces, `ui/`, `role-*.json` được bản npm dùng tiếp, không di trú. `install.json` được đánh dấu (§4.5) rồi để yên; `plugin/<ver>/` và `backups/` không còn gì trỏ tới sau khi chuyển. **Không** bản 0.4.0 nào xoá chúng: plugin không đọc `install.json` và không được xoá thứ nó không tạo; một cách xoá an toàn có tồn tại (CLI có `files[]` + `sha256` và `versions[]` trong `install.json`, và mã dọn của `src/commands/prune.ts`) nhưng nằm ngoài phạm vi 0.4.0. README chỉ cho người dùng tự xoá hai thư mục đó sau khi chuyển.

## 6. Cấu hình Paseo

### 6.1 Phần paseo-bm ghi vào `config.json`

**(0.4.0)** Plugin là bên ghi duy nhất, và chỉ qua `config.patch` của SDK (khoá phẳng: `providers` = `agents.providers`, gộp sâu; `removeProviders: string[]`; `agentProfiles` = `daemon.agentProfiles`, **thay nguyên mảng**; `mcp.injectIntoAgents`). Không bao giờ sửa file, không bao giờ `daemon reload`, không bao giờ đọc `~/.paseo/config.json` bằng `node:fs` (file có thể chứa khoá và `env` của provider). CLI 0.4.0 không ghi `config.json`; nó chỉ gọi `paseo plugin remove|add|install`.

| Khoá | Ghi gì | Khi nào |
|---|---|---|
| `pluginsEnabled` | Không bao giờ | Công tắc của Paseo và người dùng; plugin tắt thì không chạy được mã nào |
| `plugins` | Do **Paseo** ghi khi `plugin add/remove` | paseo-bm không tự ghi |
| `daemon.mcp.injectIntoAgents` | `true`; khi gỡ cấu hình: `agentTools.previous` | Khi người dùng bấm "Allow agent tools…" (§7.13.3); trả về khi gỡ, chỉ nếu `setup-state.agentTools` có và giá trị hiện tại là `true` |
| `agents.providers.bm-manager` / `bm-worker` / `bm-reviewer` | Tạo khi thiếu: `{ extends, label, paseoTools: { enabled: true } }` cho Manager và Worker, `{ extends, label }` cho Reviewer; không `command`, không `env`. Sau đó chỉ đổi `extends` (§7.3.6) | Tạo: §7.13.2. Xoá: chỉ khi gỡ cấu hình |
| `agents.providers.bm-<vai>-fallback-<n>` (n = 1…3) | Manager/Worker: `{ extends, label: "<Role> (fallback <n>)", paseoTools: { enabled: true } }`; Reviewer: không `paseoTools`. Không có profile | Khi người dùng lưu chuỗi dự phòng; xoá khi gỡ cấu hình |
| `daemon.agentProfiles[]` | Chỉ các mục `id` bắt đầu bằng `bm-`. Tạo khi thiếu: `{ id: "bm-<vai>", name, provider: "bm-<vai>", model, notes }`, thêm vào **cuối** mảng; không bao giờ ghi `modeId`/`thinkingOptionId` lúc tạo. Sau đó chỉ đổi `model` / `thinkingOptionId` / `modeId` của mục `bm-<vai>` đã có | Tạo: §7.13.2. Xoá: chỉ khi gỡ cấu hình |

**Giá trị khi tạo** (cùng quy tắc mặc định của trình cài cũ, `src/roles/config.ts` `defaultProvider`/`defaultModel` và `src/roles/register.ts`):

- `label` = `name`: `Beads Manager`, `Beads Worker`, `Beads Reviewer`.
- `notes`: hằng số `ROLE_PROFILE_NOTES` của `plugin/server/setup-roles.ts`, mô tả vai trò đúng như chỉ dẫn vai trò hiện hành (Worker: việc nhỏ làm và kiểm thẳng, việc lớn hơn mới có bead, tài liệu và Reviewer; chỉ commit hay push khi người dùng yêu cầu). Chỉ ghi khi tạo vai trò: profile đã có không bị sửa.
- Provider gốc mặc định: mục **đầu tiên** của `paseo.providers.listAvailable()` có `available === true` và không phải alias `bm-*`, theo **thứ tự Paseo trả** (không sắp xếp; `pickableProviders` sắp theo tên chỉ cho form). Khác trình cài: không có provider nào `available` thì plugin **không** trỏ vai trò vào provider không dùng được (trình cài lấy `providers[0]`), mà báo `E_SETUP_ROLES_FAILED`.
- Model mặc định: model **đầu tiên** của `paseo.providers.listModels(<provider gốc>)`; không có → `E_SETUP_ROLES_FAILED`.
- Thiếu một nửa: alias `bm-<vai>` có mà profile thiếu → profile dùng model đầu tiên của `extends` của alias; profile có mà alias thiếu → alias dùng provider gốc mặc định (profile giữ nguyên; màn Roles & models cảnh báo nếu model không thuộc provider đó).
- Mục đã có **không bao giờ bị sửa** khi tạo (ADR-008 QĐ5: config của Paseo là nguồn sự thật). Gỡ cấu hình xoá mọi mục có tiền tố `bm-`.

### 6.2 Plugin ghi cấu hình (`plugin/server/config-writer.ts`, ADR-008, ADR-012)

Mọi lần ghi đi qua **một** mutex trong tiến trình (`serialised`) và qua `config.patch`, rồi đọc lại và kiểm **chính mục vừa ghi**; không khớp → lỗi, không ghi lại (ghi lại cũng là thay cả mảng). Hôm nay chỉ có đường của màn "Roles & models" (`writeRoleConfig`). **(0.4.0)** Thêm ba đường, cùng mutex, cùng bước đọc lại:

| Hàm (0.4.0) | Patch | Kiểm trước khi ghi | Đọc lại |
|---|---|---|---|
| `createRoleEntries(roles, defaults)` | `providers: { <alias thiếu>: {…} }`; `agentProfiles` = mảng vừa đọc + profile thiếu ở cuối (chỉ gửi khi có profile phải tạo) | Đọc ngay trong khoá; chỉ id thuộc ba vai chính và đang thiếu; hình dạng cố định của §6.1 | Alias và profile vừa tạo có đúng khoá đã gửi; mọi mục khác của mảng giữ nguyên |
| `setAgentTools(value)` | `mcp: { injectIntoAgents: value }` | — | `config.mcp.injectIntoAgents === value` |
| `removeAllBmEntries(restoreAgentTools)` | `removeProviders` = mọi id provider bắt đầu bằng `bm-` (ba vai chính và mọi alias dự phòng); `agentProfiles` = mảng vừa đọc bỏ mọi mục `id` bắt đầu bằng `bm-` (chỉ gửi khi có mục như vậy); `mcp.injectIntoAgents` khi phải trả về — **một** patch | Đọc ngay trong khoá | Không còn provider hay profile `bm-*`; công tắc đúng giá trị trả về |

Luật cho đường "Roles & models" (`writeRoleConfig`), không đổi trừ câu chữ:

1. `config.get()` → tính `revision` = sha256 của JSON chuẩn hoá (khoá sắp xếp) gồm `{ providers: mọi mục bm-*, profiles: toàn bộ mảng agentProfiles }`. Khác `input.revision` → `E_ROLE_SETTINGS_CONFLICT`, không ghi.
2. Patch: `providers["bm-<vai>"] = { extends }`; `agentProfiles` = đúng mảng vừa đọc, chỉ thay mục `bm-<vai>` tại chỗ (`null` = xoá khoá). `agentProfiles` chỉ được gửi khi có sửa profile, nên lần lưu chuỗi dự phòng (chỉ alias) không đè được profile nào.
3. `config.patch`. Lỗi → `E_ROLE_SETTINGS_WRITE_FAILED` kèm lời daemon.
4. Đọc lại, kiểm chính mục `bm-*` vừa ghi. Không khớp → `E_ROLE_SETTINGS_WRITE_FAILED`.

**Luật phạm vi** (`checkScope`). Hôm nay: chỉ id `bm-`; alias chính phải có sẵn ("run npx paseo-bm install first") và không bao giờ bị xoá; chỉ ba profile vai trò và chỉ khi đã có. **(0.4.0)** ADR-008 QĐ2 hết hiệu lực cho việc **tạo**: alias và profile của ba vai chính được tạo, nhưng **chỉ** qua `createRoleEntries` và chỉ khi đang thiếu; chúng chỉ bị xoá qua `removeAllBmEntries`. Đường `writeRoleConfig` vẫn từ chối tạo hay xoá mục vai chính (lưu một form không bao giờ tạo vai trò), với câu chữ mới ở §7.13.10. Phạm vi ghi vẫn chỉ là các id bắt đầu bằng `bm-`, cộng đúng một khoá ngoài phạm vi đó: `mcp.injectIntoAgents`, chỉ qua `setAgentTools`/`removeAllBmEntries`.

Giới hạn đã chấp nhận (ADR-008 QĐ3, ADR-012 Consequences): một thay đổi trong app rơi đúng giữa lần đọc và lần patch của một lần ghi có gửi `agentProfiles` (lưu profile, tạo profile, gỡ cấu hình) bị trả về bản đã đọc và **không phát hiện được**; plugin chỉ thu hẹp cửa sổ đó. Không còn bản sao lưu nguyên file `config.json`: daemon tự kiểm patch và tự khôi phục file của nó khi lỗi. Settings → Agent profiles của Paseo sửa cùng dữ liệu: sửa ở đó khi màn "Roles & models" đang mở thì lần Lưu sau bị `E_ROLE_SETTINGS_CONFLICT`.

## 7. Plugin server

### 7.1 Nhận vai agent (`agent-role.ts`, `agent-labels.ts`)

- `roleOfAgent(agent)`: nhãn `bm.role` ∈ {`manager`, `worker`, `reviewer`} → `{ role, labelled: true }`; không thì `roleOfProvider(providerId(agent.provider))` → `{ role, labelled: false }`; còn lại `null`. `providerId` bỏ phần sau dấu `/` **đầu tiên** (model OpenCode có `/`, ví dụ `bm-worker/anthropic/claude-sonnet-4-6`). `roleOfProvider` nhận ba alias chính và `^bm-(manager|worker|reviewer)-fallback-([1-3])$`.
- Mọi chỗ tìm agent (Manager, cây agent, thẻ chat, pill, dừng agent, Dashboard, ngân sách, dự phòng) dùng `roleOfAgent` và `listAllAgents` (sổ hỏi–đáp chỉ cần vai của chính agent vừa kết thúc lượt và lấy theo provider), hàm đi hết mọi trang (`pageInfo.hasMore` / `nextCursor`).
- **Nhãn:** `bm.role`, `bm.version` (plugin gắn khi tạo Manager); `bm.requestId`, `bm.batchId` (agent gắn theo chỉ dẫn vai); `bm.modeSet` (§7.3); `bm.replaces`, `bm.replacedBy` (§7.10); `paseo.parent-agent-id` (Paseo gắn).
- `on("agent.created")`: agent `bm-*` không có `bm.role` hợp lệ được gắn bằng một lệnh `paseo agent update <id> --label bm.role=<vai> [--label bm.modeSet=<mode hiện tại>] --json` (Manager thêm `bm.modeSet` lấy từ `runtimeInfo.modeId` rồi `currentModeId`). Mỗi id tối đa một lần mỗi lần chạy plugin; lỗi chỉ tốn một dòng log.
- **Lượt quét một lần mỗi lần nạp:** plugin không có handle Paseo lúc nạp, nên lượt quét bắt đầu ở `agent.turn_started` hay `agent.created` đầu tiên; nó liệt kê agent chưa lưu trữ và gắn nhãn cho agent `bm-*` thiếu nhãn.
- Vì gắn nhãn là cố gắng tốt nhất, nhận vai theo provider là bảo đảm; agent chỉ được nhận theo provider hiện chip "Not started by paseo-bm" trên thẻ và `· no label` trên cây agent.

### 7.2 Hook `before("agent.create")` (`role-hook.ts`)

Paseo chạy hook này cho **mọi** lần tạo agent (kể cả `create_agent` của agent, vốn không có tham số system prompt). Chỉ agent `bm-*` (theo `roleOfProvider`) mới tốn tra cứu. Daemon đã chọn mode **trước** hook (`resolveMcpCreateAgent`): hook sửa được config đã chọn (trừ `cwd`) nhưng không cứu được một lần tạo daemon đã từ chối.

**Ngân sách thời gian.** Mọi tra cứu (extras, profile, mode, feature, Runtime facts, provider gốc) chạy trong **một** `withTimeout(…, LOOKUP_TIMEOUT_MS = 5000)`, vì host huỷ hook sau 30 giây và làm hỏng cả lần tạo. Hết giờ → agent vẫn được tạo với chỉ dẫn gốc, không mode, không công cụ, một dòng log. `listModes` được truyền `cwd` của agent.

Thứ tự áp:

1. **Chỉ dẫn** (`applyRoleInstructions`): `config.systemPrompt` = `fullInstructions(role)` = nội dung `roles/<vai>.md` (nhúng vào bundle lúc build bởi `scripts/generate-role-instructions.mjs` → `plugin/server/{manager,worker,reviewer}-instructions.ts`), rồi mục `## Runtime facts` (nếu có), rồi `---` + `## Additional instructions from the user` + câu "These add to the rules above and never override a RULES item." + nội dung `role-extras.json` của vai đó (tối đa 8000 ký tự; RPC `roles.instructions`, `roles.save-extra`). System prompt sẵn có khác thì đứng sau, cách bằng `\n\n---\n\n`; đã chứa đủ thì không nhân đôi; chỉ chứa bản gốc thì nâng cấp tại chỗ.
2. **Model và profile** (Worker và Reviewer). Trước tiên `applyRoleModel`: model của request (`config.model`, không thì phần sau dấu `/` đầu tiên) khác model của profile → đổi sang model của profile (ở `config.provider` `<alias>/<model>` và ở `config.model` nếu có), kèm một dòng log. Profile là điều người dùng đặt trên Setup, nên nó thắng: Manager đọc profile một lần rồi nhớ, và sau khi người dùng chuyển Worker từ Claude sang Codex, một Manager tạo trước đó vẫn xin `bm-worker/claude-opus-5-5` và Codex từ chối model ấy ngay lượt đầu của Worker (lần cài trắng 2026-09-26). Request không nêu model, hay alias dự phòng (không có profile), thì giữ nguyên. Rồi `applyRoleProfile`: `thinkingOptionId` của profile khi bên tạo không truyền và model của request (`config.model`, không thì phần sau dấu `/` đầu tiên) trùng model của profile hoặc không nêu; `featureValues` = `{ ...profile, ...bên tạo }` (bên tạo thắng). Profile tra theo alias thật của agent; alias dự phòng không có profile (thinking/mode của nó đến từ lần tạo). Manager không qua đây: `manager.ensure` tự truyền profile.
3. **Cách chạy theo khả năng provider** (Worker và Reviewer; `ROLE_GETS_MODE.manager = false`). `capabilityOf(listModes)`:

   | Lớp | Nhận ra | Ví dụ |
   |---|---|---|
   | `tiered` | có mode mang `colorTier` | Claude, Codex |
   | `untiered` | có mode, không mode nào có `colorTier` | OpenCode (mode = agent OpenCode của người dùng) |
   | `none` | danh sách rỗng, không `error` | Pi |
   | `unknown` | lỗi, hết giờ, có `error` | — |

   | Vai | `tiered` (`chooseModeId`) | `untiered` (`runPostureOf`) | `none` |
   |---|---|---|---|
   | Worker | giữ mode bên tạo truyền; không có thì mode profile nếu provider liệt kê; không thì `dangerous` đầu tiên → `moderate` → `safe` | giữ mode bên tạo nếu có trong danh sách; không thì mode profile, không thì mode **đầu tiên** (không bao giờ bỏ trống); `auto_accept: true` nếu provider có feature đó và chưa ai đặt | xoá `modeId` và `featureValues` |
   | Reviewer | mode profile nếu không `dangerous`/`planning`; không thì `auto` → `moderate` đầu tiên không có "full"/"network" → `safe`. Mode bên tạo là `dangerous`/`planning` thì bị hạ về mode trên, kèm log; mode bên tạo mà provider không liệt kê thì giữ nguyên | như Worker, nhưng `auto_accept` **luôn `false`**, đè cả profile lẫn giá trị daemon tự bật, và được ghi cả khi không đọc được feature | như Worker |

   `unknown` → không đổi mode. Feature chỉ được tra (`listFeatures({ provider: "<alias>/<model>" })`) khi lớp là `untiered`.
4. **Công cụ agent** (`applyAgentTools`, §7.4): chỉ khi endpoint đang nghe và provider gốc của alias (`config.get()` → `providers[<alias>].extends`) ∈ `TOOL_PROVIDERS = ["claude", "codex", "opencode"]`. Provider khác mà mang `toolPolicy` thì Paseo **từ chối tạo agent**, nên agent Pi/Copilot không có công cụ và viết khối bằng tay.

**Runtime facts** (`role-extras.ts`). Paseo từ chối tạo agent con thiếu mode trước khi hook chạy (Manager không ở mode không-người-trông, và Worker `bypassPermissions` cũng không được coi là không-người-trông), nên bên tạo phải truyền mode. Plugin tính giá trị bằng đúng luật của hook và ghi vào chỉ dẫn của bên tạo:

```
## Runtime facts

Worker mode: `<modeId>` — pass it as `settings.modeId` when you create a Worker.
Worker skills: all present.
```

- Manager nhận dòng `Worker mode` (tra `listModes("bm-worker")`) và dòng `Worker skills`; Worker nhận dòng `Reviewer mode` (tra `listModes("bm-reviewer")`); Reviewer không có mục này.
- Provider không có mode: ``<Child> mode: none — do not pass `settings.modeId` when you create a <Child>; Paseo sets it.`` Không tra được: không có dòng (lần tạo hỏng to, kèm danh sách mode của Paseo). Ngoại lệ cho Reviewer: dùng danh sách mode đọc được lần gần nhất trong tiến trình (qua đúng luật của hook); không có thì `REVIEWER_FALLBACK_MODE = "auto"` nếu provider gốc của `bm-reviewer` là `claude`/`codex` hoặc không đọc được, còn lại không có dòng; mọi lần dùng dự phòng có log. Với Manager, tra hỏng mà profile có mode thì truyền mode đó.
- `Worker skills`: plugin kiểm năm skill bắt buộc (§7.13.4) với thư mục skill của provider gốc của `bm-worker` (`claude` `$CLAUDE_CONFIG_DIR/skills`, mặc định `~/.claude/skills`; `codex` `~/.agents/skills` hoặc `$CODEX_HOME/skills`; `pi` `~/.pi/agent/skills`; `opencode` `~/.config/opencode/skill`): `all present.` hoặc ``missing `<tên>`, … — tell the user once, when you confirm the Worker, that it works with lower quality, and point to `npx paseo-bm doctor`.`` — **(0.4.0)** đuôi câu thành ``…and point to Beads Manager → Setup → Agent skills.``. Provider gốc khác bốn provider này, hoặc không đọc được → không có dòng.
- Hai tra cứu mode và skill chạy song song. Runtime facts nằm ngoài bản nhúng, nên file `roles/*.md` và bản nhúng vẫn khớp từng byte.
- Agent đang sống mà dòng Runtime facts của nó đổi (người dùng đổi mode/provider của vai con) được báo bằng `BM-SETTINGS` (§7.5).

### 7.3 Manager (`manager.ts`)

**`manager.ensure { workspaceId }` → `{ agentId, created, otherManagerIds, modeNotice: string | null, toolsNotice?: string | null, setupNotice?: string | null }`** (`setupNotice` là **(0.4.0)**, §7.13.2: câu về vai trò chỉ khi lần gọi này vừa tạo vai trò; câu về công tắc tool ở mọi lần gọi khi công tắc tắt).

- `findLiveManagers`: agent `roleOfAgent().role === "manager"` còn sống trong workspace, **bỏ** Manager có `bm.replacedBy` hoặc là agent của một sự cố Manager `switched`; xếp có nhãn trước, rồi mới nhất trước. Có → trả nó, `created: false`, các Manager còn lại trong `otherManagerIds` (báo, không bao giờ xoá). Manager bị người dùng xoá → lần sau tạo mới, không báo lỗi.
- Chưa có → đọc profile `bm-manager` (không có → `E_PROVIDER_UNAVAILABLE`, "re-run `npx paseo-bm`"), chọn mode rồi `createManager`. **(0.4.0)** Trước khi đọc profile, gọi `ensureRoles` (§7.13.2): vai trò thiếu được tạo, lỗi thành `E_PROVIDER_UNAVAILABLE` với câu chữ của §7.13.2. **(0.4.0)** Rồi, nếu `config.mcp.injectIntoAgents === false`, **không tạo Manager**: ném `E_PROVIDER_UNAVAILABLE` với `AGENT_TOOLS_OFF_MESSAGE` (§7.13.2). Lý do: agent chỉ nhận tool Paseo lúc được tạo, nên một Manager tạo khi công tắc tắt sẽ không bao giờ có `create_agent`, kể cả sau khi người dùng bật công tắc, và chỉ người dùng được lưu trữ nó (lần cài trắng 2026-09-26: Manager như vậy phải tự chế lệnh `paseo run` trong shell). Manager đã có thì vẫn được mở như trên, kèm `setupNotice`.
- **Mode của Manager:** `tiered` → `managerModeFor`: mode profile nếu provider liệt kê (kể cả `planning`), không thì mode `dangerous` đầu tiên (Claude `bypassPermissions`, Codex `full-access`); không có → mode mặc định của provider và một dòng log. Plugin không bao giờ tự chọn `planning`, và không lùi về `moderate` (yêu cầu là "không hỏi quyền"). Không đọc được danh sách → truyền mode profile như cũ. `untiered`/`none` → `runPostureOf("manager")` như Worker. Khi plugin tự chọn mode, Manager mang nhãn `bm.modeSet=<mode>`.
- **Manager đã có, chưa có `bm.modeSet`, và có nhãn `bm.role`** được chuyển **một lần** (`switchOnce`): không có mode đích → thôi; đang `running` → bỏ qua lần này và trả `modeNotice` (đổi mode giữa lượt có thể dựng lại query của Claude); `currentModeId` khác đích → `paseo agent mode <id> <mode> --json`; rồi `paseo agent update <id> --label bm.modeSet=<mode> --json`. Mọi lỗi thành `modeNotice`, Manager vẫn được mở; `modeNotice` cũng được ghi ra log, vì đường mở Manager từ màn Beads không hiện thông báo. Có `bm.modeSet` → không bao giờ đổi nữa (người dùng đổi tay được tôn trọng). Manager chỉ nhận theo provider thì không bao giờ bị đổi mode. Trên `untiered`, plugin không đổi được feature của agent đã có, nên `modeNotice` nói Manager có thể hỏi quyền.
- **`createManager`** (dùng chung cho `manager.ensure` và Manager thay thế): `workspaces.ref(id).agents.create({ config: { provider, modeId?, thinkingOptionId?, featureValues?, systemPrompt }, title: "Beads Manager", labels: { bm.role: "manager", bm.version, …extra }, prompt? })`. Agent vừa tạo đã hỏng → lưu trữ đúng agent đó rồi ném `E_PROVIDER_UNAVAILABLE`. `capabilities.supportsMcpServers === false` → `toolsNotice` ("…without Paseo tools (on Pi this means pi-mcp-adapter is missing): it cannot create or message a Worker.").
- **Paseo CLI từ trong daemon** (`paseo-cli.ts`): tìm `paseo` trên PATH của daemon cộng `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`; `execFile` không shell, `CLI_TIMEOUT_MS = 5000`; id agent phải khớp `^[A-Za-z0-9][A-Za-z0-9_-]*$`, khoá/giá trị nhãn và mode khớp `^[A-Za-z0-9][A-Za-z0-9._-]*$` (không mở đầu bằng `-`), mode phải có trong danh sách provider. Đã kiểm trên daemon thật.
- **`agents.list { workspaceId }` → `{ agents: [{ id, role, title, status, parentId, updatedAt, labelled, replacedBy }] }`**: thành viên là agent có vai và con cháu của chúng; `role: "unknown"` khi không suy được; `parentId` chỉ khi cha có trong danh sách (Worker mồ côi thành gốc cây).
- **`roles.describe {}` → `{ roles: [{ role, provider, model, paseoTools, instructionsPath }] }`**: đọc cấu hình Paseo đang có hiệu lực (`config.get()`), không đọc `install.json`; `instructionsPath` là tên nhúng (`roles/manager.md`); vai không có cả provider lẫn profile thì bỏ qua.

#### 7.3.6 Màn "Roles & models" — hợp đồng server

Giao diện thuộc Design Dashboard; server:

| RPC | Input | Output |
|---|---|---|
| `roles.settings` | `{}` | `{ revision, roles: RoleSetting[], fallback: Record<Role, FallbackSettings> \| null, warnings, providers: string[] }` (`providers` = provider gốc `available`, không gồm alias `bm-*`, xếp theo tên) |
| `roles.options` | `{ provider }` (gốc; alias `bm-*` → `E_ROLE_SETTINGS_INVALID`) | `{ provider, capability, models: [{ id, label, thinkingOptions, defaultThinkingOptionId, cost }], modes: [{ id, label, colorTier }], autoAccept }` |
| `roles.save-settings` | `{ revision, role, baseProvider, model, thinkingOptionId, modeId }` | `{ revision, role: RoleSetting, warnings, notified }` |
| `roles.save-fallback` | `{ revision, role, policy: "ask" \| "off" \| "auto", entries: [...] (≤ 3) }` | `{ revision, fallback: FallbackSettings, warnings }` |

`RoleSetting = { role, providerId, baseProvider, label, model, thinkingOptionId, modeId, featureValues, capability }`; `FallbackSettings = { role, policy, entries: [{ position, alias, baseProvider, model, thinkingOptionId, modeId, capability, cost }], patternsFromFile }`. `roles.settings` không đọc được cấu hình → ba vai rỗng kèm một cảnh báo; `revision` khi đó là của cấu hình rỗng, nên lần lưu kế tiếp bị `E_ROLE_SETTINGS_CONFLICT` thay vì ghi mù. Kiểm trước khi ghi (lỗi → `E_ROLE_SETTINGS_INVALID`): provider gốc `available` và không phải alias `bm-*`; model có trong `listModels`; thinking thuộc model; mode thuộc provider, Reviewer trên `tiered` không `dangerous`/`planning`; chuỗi ≤ 200 ký tự. Cảnh báo không chặn: Manager và Worker cùng provider gốc ("Worker hết hạn mức thì Manager cũng dừng"); Pi cho Manager/Worker (cần `pi-mcp-adapter`); Reviewer trên Pi (không có lớp duyệt quyền); Reviewer trên OpenCode chưa chọn agent; model có giá. Thay đổi áp cho agent tạo **sau** khi lưu. `notified` = số agent sống đã được gửi hoặc xếp hàng `BM-SETTINGS`.

### 7.4 Endpoint công cụ cho agent (`agent-tools.ts`, `shared/bm-tools.ts`, ADR-010)

- Tiến trình server của plugin nghe HTTP trên `127.0.0.1`, trả JSON-RPC của MCP, một JSON cho mỗi request: `initialize` (giao thức `2025-06-18`, `2025-03-26`, `2024-11-05`; phiên bản lạ nhận bản mới nhất), `ping`, `tools/list`, `tools/call`; notification → 202. Mỗi vai một đường `/mcp/<worker|reviewer|manager>`, nên agent chỉ thấy công cụ của mình. Đường khác → 404. Chỉ `POST` (khác → 405). Từ chối header `Origin` (403), `Host` khác `127.0.0.1`/`localhost` (403), body > `MAX_BODY_BYTES = 1_000_000` (413, đóng kết nối), batch rỗng (400).
- Cổng được lưu ở `<thư mục dữ liệu>/ui/agent-tools.json` (`{ schemaVersion: 1, port }`), tìm bằng `resolveDataHome` (đồng bộ, không cần handle Paseo — endpoint khởi động trước khi có handle) và tạo bằng `ensureDataHome` khi cần (§5.1). Cổng được lấy lại ở lần chạy sau, nên agent đang sống giữ công cụ qua một lần nạp lại plugin. Cổng bị chiếm → cổng mới, agent cũ quay về viết tay. Lỗi → một dòng log, không có công cụ.
- Hook gắn vào config: `mcpServers["paseo-bm"] = { type: "http", url, alwaysLoad: true }` và thêm `toolPolicy.preapproved` `{ kind: "mcp", server: "paseo-bm", tool }` cho công cụ của vai (không có `alwaysLoad` thì Claude giấu công cụ sau một bước tìm công cụ). Agent thấy `mcp__paseo-bm__<tool>` (Claude) hay `paseo-bm.<tool>` (Codex), không bị hỏi quyền. Agent đã tồn tại không nhận được công cụ (`agent.session_open` chỉ đổi `env`).
- **Công cụ chỉ dựng văn bản**, không có tác dụng phụ, nên endpoint không cần biết ai gọi; agent tự gửi văn bản trả về bằng `send_agent_prompt` như cũ. Mọi bên đọc văn bản (thẻ, Dashboard, trace, sổ hỏi–đáp, bộ kiểm mẫu) không đổi. Đường viết tay được giữ vĩnh viễn làm dự phòng.

| Công cụ | Vai | Đầu vào chính | Dựng |
|---|---|---|---|
| `bm_report` | Worker | `requestId`, `phase`, `tier { level, changedFrom?, reason?, note? }`, `buildAndTests` (bắt buộc); `filesChanged`, `beadsCreated/Updated/Closed/Ready` (id đầy đủ), `reviewFindingsOpen [{ batchId, finding }]`, `skillsUsed`, `decided [{ choice, why }]`, `blockers`, `suggestions`, `questions` (1–5, bắt buộc khi và chỉ khi `blocked`; `id` `^Q[1-9]\d{0,2}$`, 2–8 lựa chọn, đúng một `recommended`) | `BM-REPORT` (+ `BM-QUESTIONS`); `suggestions` thành `Suggestion (not done): …` trong `blockers`, mở bằng `none` khi không có gì chờ |
| `bm_review` | Reviewer | `requestId`, `batchId` (`^b\d+$`), `reviewKind`, `checked`, `notChecked` (mỗi trường ≤ 4000 ký tự), `findings [{ severity, location, reason, suggestedFix }]` | `BM-REVIEW`; `verdict` suy từ finding (`changes-required` khi có `blocking`) |
| `bm_answers` | Manager | `requestId`, `answers [{ id, option + optionText \| other }]` | `BM-ANSWERS` |

Mỗi công cụ có một JSON Schema (thứ model thấy và cũng là bộ kiểm hình dạng); ngữ nghĩa được kiểm bằng `checkBlocks` trên chính văn bản dựng ra. Trường `null` bị bỏ trước khi kiểm; giá trị trông như placeholder (`<…>`, `a | b`) bị từ chối, vì `checkBlocks` sẽ bỏ qua cả khối; với `bm_report`, `tier.reason` bắt buộc khi và chỉ khi có `changedFrom`, và `changedFrom` phải khác `level`. Đầu vào sai → kết quả MCP `isError: true` liệt kê lỗi từng trường, agent sửa và gọi lại ngay trong lượt.

### 7.5 Thông điệp của plugin

**Nhận dạng.** SDK luôn gắn `messageId` cho `PaseoAgentHandle.send()` và daemon lưu nó thành `clientMessageId` — đúng trường phân biệt lời người dùng gõ với lời agent chuyển. Vì vậy thông điệp của plugin được nhận theo **tiền tố văn bản** (`plugin/shared/notices.ts`, `isPluginNotice`) và bị loại khỏi `origin: "user"`, khỏi nội dung request và khỏi đếm review. Tiền tố: `BM-BUDGET`, `STOP: The Beads Worker that created you was stopped`, `BM-STOP`, `BM-FORMAT`, `BM-TOOLS`, `BM-SETTINGS`, `BM-FALLBACK`, `BM-RESUME`, `BM-ANSWERED`. `BM-HANDOVER` là prompt khởi đầu của agent thay thế, không nằm trong danh sách. `BM-NEW-REQUEST` là lời người dùng (§7.9), cũng không nằm trong danh sách.

**Hàng chờ thông báo** (`notice-queue.ts`). `send()` vào agent đang chạy **thay** lượt hiện tại của nó, nên thông báo tới agent có thể đang chạy đi qua hàng chờ: `refresh()` ngay trước; đích không `running`/`initializing` → gửi ngay; ngược lại giữ trong bộ nhớ và gửi ở `agent.turn_ended` kế tiếp của đích. Mỗi lúc rảnh gửi một thông báo (thông báo mở một lượt; lượt đó kết thúc thì gửi cái kế). Thông báo mới cùng loại cho cùng đích thay cái cũ. Đích đã lưu trữ, đã đóng hay không còn → bỏ, một dòng log (`send()` bỏ lưu trữ agent — ADR-005). Khoá theo id agent và loại, không bao giờ theo turn id (Paseo dùng lại turn id). Mất khi plugin nạp lại. Hàng chờ bám vào hook `agent.turn_ended` của bộ kiểm mẫu và chạy **sau** nó.

| Thông điệp | Gửi tới | Khi nào | Đường gửi | Văn bản (tiếng Anh, nguyên văn) |
|---|---|---|---|---|
| `BM-BUDGET` | Manager của request | request vượt ngân sách review (§7.7) | trực tiếp, chỉ khi Manager không `running` | `BM-BUDGET requestId: <id>` / `The Worker has used <n> review calls; the <tier> budget is <b>. For your information only: the Worker asks the user itself before any review beyond its budget, so do not ask the user about it. Tell the user in one line. Do not cancel on this notice alone; if the user asks you to stop the Worker, cancel its run.` |
| Dừng Reviewer | Reviewer đang chạy | Worker bị dừng; Worker bị thay; `/bm-worker-stop-all` | trực tiếp (cố ý thay lượt) | `STOP: The Beads Worker that created you was stopped by the user. Stop this review now: do not read files, run commands or call any tool; reply with the single line "BM-REVIEW STOPPED" and end your turn.` |
| `BM-STOP` | Worker đang chạy | `/bm-worker-stop-all` | trực tiếp (cố ý thay lượt) | `BM-STOP The user asked every Beads Worker and Reviewer in this workspace to stop. This is a stop: follow your Stop rule.` (trỏ tới luật dừng của `worker.md`, không lặp lại thủ tục) |
| `BM-FORMAT` | người gửi khối sai mẫu | §7.6 | luật riêng của §7.6 | §7.6 |
| `BM-TOOLS` | Manager cha (cha không phải Manager → chỉ log) | Worker (kể cả dự phòng) vừa tạo có `supportsMcpServers === false` | hàng chờ | `BM-TOOLS Worker <id> runs on <provider> without Paseo tools (on Pi this means pi-mcp-adapter is missing). It cannot send you a BM-REPORT or create a Reviewer. Tell the user in one line; do not create another Worker for this request unless the user asks.` |
| `BM-SETTINGS` | mọi Manager sống (mode Worker đổi) / mọi Worker sống (mode Reviewer đổi), mọi workspace | sau `roles.save-settings` làm đổi dòng Runtime facts | hàng chờ | `BM-SETTINGS The user changed the paseo-bm role settings. This replaces the matching line under "## Runtime facts":` / `<dòng mới>` / `Do not reply to this message; carry on with what you were doing.` Khi Manager bị thay: câu mở là `The Beads Manager you report to was replaced. This replaces the Manager agent id you were given:` và dòng ``Manager agent id: `<newId>` — send every BM-REPORT to this agent from now on.`` |
| `BM-FALLBACK` | chat Manager của sự cố; Worker cha khi Reviewer bị thay | §7.10 | hàng chờ | §7.10 |
| `BM-RESUME` | chính agent hỏng | hẹn "Wait" tới giờ | trực tiếp, chỉ khi agent không chạy | `BM-RESUME The usage limit that stopped you has reset. Continue from where you stopped; do not redo finished work.` |
| `BM-ANSWERED` | Manager của Worker | §7.8 | hàng chờ, loại `BM-ANSWERED:<requestId>` | §7.8 |

Agent tạo trước khi có một thông điệp đọc nó như tin thường; mỗi văn bản tự nói agent phải làm gì.

### 7.6 Khối `BM-*` và kiểm mẫu (`shared/bm-format.ts`, `server/format-check.ts`)

Agent trao đổi bằng khối văn bản có mẫu; mẫu đầy đủ nằm trong `roles/*.md` và trong schema của công cụ (§7.4). Bộ đọc khoan dung (`shared/bm-report.ts`, `shared/bm-questions.ts`) lấy được gì thì lấy, kể cả phase cũ `documents-done`, `bead-implemented`; `checkBlocks(message)` là nửa nghiêm ngặt và chỉ nhận bốn phase hiện hành:

- **Tìm khối:** dòng chỉ có `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW` (cho phép `-`/`*`, `**`, `>` hay hàng rào code đứng trước); kết thúc ở dòng trống, hàng rào code hay khối khác (`BM-REVIEW` cho phép dòng trống trong `findings:`). `BM-REVIEW STOPPED` hợp lệ một mình. Bỏ qua khối "mẫu" (giá trị có `|`, hay placeholder `<…>`). Kiểm tối đa `MAX_CHECKED_CHARS = 20_000` ký tự; tin dài hơn nhận thêm lỗi `message too long to check in full`.
- **`BM-REPORT`:** trường theo đúng thứ tự `requestId, phase, tier, filesChanged, beadsCreated, beadsUpdated, beadsClosed, beadsReady, reviewFindingsOpen, buildAndTests, skillsUsed, decided, blockers`, mỗi trường một lần, không trường lạ; `decided` là tuỳ chọn. `requestId` khớp `^req-\d{8}T\d{6}Z$`; `phase` ∈ `received`, `beads-done`, `blocked`, `finished`; `tier` = `Small|Medium|Large (changed: no | from <tier>, <lý do>)`, cho phép ghi chú sau; trường bead là `none` hoặc danh sách id đầy đủ; `skillsUsed` là `none` hoặc tên skill; `reviewFindingsOpen` là `none` hoặc các mục `b<n>: …`; `filesChanged`, `buildAndTests`, `blockers` không rỗng; `phase: blocked` bắt buộc có `BM-QUESTIONS` trong cùng tin và `blockers` mở bằng `<n> question(s): Q…, Q… — see BM-QUESTIONS`.
- **`BM-QUESTIONS`:** `requestId` bằng của báo cáo; 1–5 câu `Q<n>: …`, mã không trùng, tăng dần; mỗi câu ≥ 2 lựa chọn `- <chữ>: …` liên tiếp từ `a`, đúng một lựa chọn kết thúc bằng `(recommended)`.
- **`BM-ANSWERS`:** `requestId` hợp lệ; mỗi dòng `Q<n>: <chữ> — …` hoặc `Q<n>: other — …`; không trùng; ít nhất một dòng.
- **`BM-REVIEW`:** đủ `requestId, batchId, reviewKind, verdict, checked, findings, notChecked`; `batchId` `^b\d+$`; `reviewKind` ∈ `first`, `re-review`; `verdict` ∈ `pass`, `changes-required`; finding đủ `severity` (`blocking`/`non-blocking`), `location`, `reason`, `suggestedFix`; `verdict = changes-required` khi và chỉ khi có finding `blocking`.

**Thông báo `BM-FORMAT`.** Chỉ kiểm tin do agent gửi (`user_message` không có `clientMessageId`, không phải thông báo plugin) và `assistant_message` của Reviewer; không bao giờ kiểm lời người dùng.

| Khối | Kiểm ở lượt kết thúc của | Người gửi (nhận thông báo) |
|---|---|---|
| `BM-REPORT` (+ `BM-QUESTIONS`) | Manager | Worker duy nhất của `requestId` trong workspace |
| `BM-ANSWERS` | Worker | cha của Worker nếu là Manager |
| `BM-REVIEW` | Reviewer | chính Reviewer |

- Không xác định được đúng một người gửi → không gửi, chỉ chip `template error` trên thẻ (thẻ lấy lỗi từ `checkBlocks`) và một dòng log.
- Chỉ khối **mới nhất** của mỗi `(người gửi, requestId, loại)` được xét; khối mới đúng thì xoá thông báo đang chờ. Thông báo đang chờ được xét lại ở lượt kết thúc nơi khối được kiểm, lượt kết thúc kế tiếp của phía nhận (Manager; Worker; Worker cha của Reviewer) và lượt kết thúc kế tiếp của chính người gửi; chỉ gửi khi người gửi không `running`/`initializing` (ở lượt của chính nó thì đọc lại tối đa `OWN_TURN_REREADS = 5` lần cách `1000` ms), và ở lượt của người gửi chỉ khi `lastUserMessageAt` của phía kiểm vẫn bằng mốc lúc kiểm (khác thì giữ lại cho lần sau).
- Mỗi khối (theo nội dung) báo tối đa một lần; mỗi `(người gửi, requestId, loại)` tối đa `MAX_NOTICES = 2` lần, quá thì chỉ còn chip và log. Đếm trong bộ nhớ. Gửi lỗi → giữ lại, thử ở lượt kết thúc sau; người gửi đã lưu trữ, đã đóng hay không còn → bỏ, một dòng log.
- Văn bản:

```
BM-FORMAT requestId: <requestId | unknown>
Your last <BM-REPORT | BM-QUESTIONS | BM-ANSWERS | BM-REVIEW> broke the template:
- <field>: <issue>
If you have the <bm_report | bm_review | bm_answers> tool, build the block with it.
<dòng cuối>
```

  Dòng cuối: Reviewer → `Answer with the whole corrected BM-REVIEW block as your final message; do not review again.`; khối mang câu hỏi cho người dùng → dòng công cụ đổi thành `…build your next report with it.` và dòng cuối là `Do NOT send this block again: its BM-QUESTIONS would reach the user a second time. Leave the report as it stands, apply the correction to your next one, and carry on exactly where you were. Do not mention this notice to the user.` (gửi lại cả khối sẽ đưa cùng bộ câu hỏi tới người dùng lần hai); còn lại → `Send the whole corrected block again, to the same agent as before, in one message. Change nothing else and do not redo any work; then carry on exactly where you were. Do not mention this notice to the user.`

### 7.7 Ngân sách review (`review-budget.ts`, `budget-told.ts`)

Lan can hành vi, không phải chốt chặn: plugin **đếm và báo**, không dừng agent nào. Việc hỏi người dùng trước một lượt review vượt ngân sách là của Worker (theo `worker.md`); luật lô (một lượt đầu, một lượt kiểm lại) cũng nằm trong chỉ dẫn.

- **Ngân sách tổng mỗi request:** `REVIEW_BUDGET = { Small: 2, Medium: 2, Large: 4 }`, là trần chứ không phải chỉ tiêu (một request Small chỉ review khi người dùng yêu cầu — `worker.md`). Mức lấy từ `tier` của `BM-REPORT`. `BM-HANDOVER` đọc cùng hằng số.
- **Đếm** (`reviewCallsOf` trong `traces.ts`, cùng con số Dashboard hiện): mỗi tin gửi tới một Reviewer của request là một lượt, trừ `BM-REVIEW` và thông báo của plugin; tin **đầu tiên** của mỗi Reviewer thay thế (id lấy từ `replacementId` của các sự cố Reviewer) không được đếm. Không có bản ghi Reviewer nào → `null` (không biết, không phải 0), và không bao giờ báo.
- **Khi nào kiểm:** sau khi bộ thu thập **đã ghi** bản ghi của lượt vừa kết thúc (khe `onRecorded`), cho agent của request. Chỉ lượt của Worker hay Reviewer mới **phát hiện** vượt; lượt của Manager chỉ **gửi đi** cái đã phát hiện trong tiến trình (nếu không, sau một lần nạp lại mọi request cũ sẽ bị báo và mỗi thông báo lại mở một lượt Manager mới). Lượt cuối của Worker thường đánh thức Manager (đang `running`), nên thông báo bị hoãn và được gửi ở lượt kết thúc của chính Manager.
- **Một lần mỗi request, bền qua nạp lại:** `<home>/ui/budget-told.json` (`{ schemaVersion: 1, told: [{ key, calls, at }] }`, tối đa 500 mục). Đánh dấu **trước** `await` đầu tiên để hai lượt kết thúc cùng lúc không cùng gửi; gửi lỗi thì bỏ đánh dấu. File hỏng hay mới hơn → coi như chưa báo gì (thừa một thông báo rẻ hơn thiếu).
- Không gửi vào Manager đang chạy, đã lưu trữ hay đã đóng. Mỗi lần gọi gửi tối đa một thông báo.

### 7.8 Sổ hỏi–đáp (`qa-ledger.ts`)

"Đã trả lời" là trạng thái thật, không suy từ thứ tự tin nhắn.

- **File** `<home>/ui/qa-ledger.json`: `{ schemaVersion: 1, requests: [{ requestId, workspaceId, updatedAt, questions: [{ id, text, at }], answers: [{ id, text, via: "user" | "agent", workerId, at }] }] }`. `via` = `user` khi tin có `clientMessageId`. `at` là lúc plugin ghi (hook không có dấu thời gian), chỉ để đọc. Mỗi `text` qua bộ che bí mật rồi cắt 1000 ký tự. Giới hạn 300 request (bỏ `updatedAt` cũ nhất), 100 câu hỏi và 200 câu trả lời mỗi request. Không dựng từ kho lưu vết (bản ghi trace có thể cắt tin còn 512 ký tự).
- **Ghi** (`on("agent.turn_ended")`, đọc **cả** timeline, idempotent): Manager kết thúc lượt → mọi `user_message` do agent gửi có `BM-QUESTIONS` → câu hỏi (`requestId` của khối, không có thì của `BM-REPORT` ngay trên). Worker kết thúc lượt → mọi `user_message` không phải thông báo plugin có `BM-ANSWERS` → câu trả lời (`parseAnswers`: khối cuối của tin, chấp nhận đậm, trích dẫn, gạch đầu dòng). Hook lỗi → một dòng log; lượt sau ghi bù.
- **Luật:** câu `(requestId, Qn)` đã trả lời khi sổ có ít nhất một câu trả lời cho nó, bất kể thứ tự. Luật đi kèm trong chỉ dẫn Worker: một câu trả lời luôn đóng số đó; phần còn lại được hỏi dưới số mới.
- **`chat.waiting`** nhận thêm `answered: string[]` cho mỗi Worker đang chờ (mặc định `[]`); Worker có mọi câu của khối `blocked` mới nhất đã được trả lời thì không còn chờ. Không đọc được sổ → như khi chưa có sổ. Pill và thẻ dùng trường này (Design Dashboard).
- **`BM-ANSWERED`** ở lượt kết thúc của Worker, cho câu trả lời trong **lượt cuối**, `via: "user"`, **vừa ghi lần này**. Gửi tới Manager cha nếu còn sống và chưa bị thay, không thì Manager sống duy nhất của workspace; không có đúng một → không gửi, log.

```
BM-ANSWERED requestId: <requestId>
The user answered Q16, Q17 directly to the Worker (in its card or chat); the Worker has them. Those questions are closed: do not ask them again and do not relay answers to them. Tell the user in one line which Worker has its answers and what is still open.
Still open: <Q… | none | unknown>.
```

  `unknown` khi sổ chưa có câu hỏi nào của request; không bao giờ nói `none` khi không biết.

### 7.9 Dừng agent và slash command

- **Worker bị Stop trong Paseo.** Stop chỉ ngắt lượt hiện tại; Paseo 0.8 không cho plugin huỷ agent (`PaseoAgentHandle` không có `cancel`). Khi `agent.turn_ended` của `bm-worker` (kể cả alias dự phòng) có `outcome.kind === "canceled"`, plugin đọc lại trạng thái Worker; nếu nó không còn `running` thì gửi thông báo dừng cho từng Reviewer con đang chạy (đọc lại ngay trước mỗi lần gửi). Việc dừng là **hợp tác**: Reviewer chạy thêm một lượt ngắn để trả `BM-REVIEW STOPPED`, và Worker đã dừng bị đánh thức một lần khi Reviewer kết thúc. Luật dừng của Worker nằm trong `worker.md`.
- **`/bm-worker-new <yêu cầu>`** (context `workspace`): gọi `manager.ensure`, gửi Manager `BM-NEW-REQUEST` trên dòng đầu rồi lời người dùng nguyên văn bằng `paseo.agents.ref(id).send()` (lời người dùng thật, có `clientMessageId`), rồi mở chat Manager. Tham số được `trim()`; rỗng → không gửi gì, chỉ mở chat. Cờ là `NEW_REQUEST_MARKER` (`plugin/shared/new-request.ts`), bộ thu thập cắt bằng `stripNewRequestMarker`. Không có đường tạo Worker thứ hai: Manager vẫn cấp `requestId` và tạo Worker. Bộ thu thập cắt dòng cờ khi ghi và giữ `origin: "user"`; cờ không nằm trong `isPluginNotice` (nếu có thì Dashboard mất lời yêu cầu).
- **`/bm-worker-stop-all`** → RPC `agents.stop-all { workspaceId }` → `{ workers, reviewers, skipped }`: chỉ workspace hiện tại; gửi `BM-STOP` cho Worker và thông báo dừng cho Reviewer đang `running`; mỗi đích được đọc lại ngay trước khi gửi (`send()` bỏ lưu trữ agent); `skipped` đếm agent đã lưu trữ, đã đóng, không còn `running` lúc đọc lại, hoặc gửi lỗi; **không bao giờ** đụng Manager. Đây là "yêu cầu dừng", không phải huỷ; mọi chữ cho người dùng nói "đã yêu cầu dừng".
- Slash command của Paseo 0.8 chỉ hiện chữ khi `onSubmit` ném lỗi (toast lỗi), nên kết quả được đẩy vào hàng `launcherNotices` rồi mở màn Beads Manager, nơi nó hiện như một dòng thông báo.

### 7.10 Dự phòng khi hết hạn mức (Manager, Worker, Reviewer)

`FALLBACK_ROLES = ["worker", "reviewer", "manager"]`. Mọi phần "lỗi thì log, không phá".

**Cài đặt** — `role-fallback.json`:

```ts
{ version: 1,
  roles: Partial<Record<Role, { policy: "ask" | "off" | "auto",
                                entries: Array<{ baseProvider, model, thinkingOptionId: string | null, modeId: string | null }> /* 0..3 */ }>>,
  patterns?: Partial<Record<"L1"|"L2"|"L3"|"L4"|"L5", string[]>> }   // regex, cờ "i", chỉ sửa tay, chung cho mọi vai
```

- Thiếu file hay thiếu vai → `{ policy: "ask", entries: [] }` (vẫn có thẻ với "Wait" và "I'll handle it"). File hỏng → dùng mặc định, log, màn cấu hình báo lỗi, và `roles.save-fallback` **từ chối ghi** bằng `E_ROLE_SETTINGS_INVALID` (không đè `patterns` người dùng sửa); không tìm được thư mục cài đặt → `E_ROLE_SETTINGS_WRITE_FAILED` ("run npx paseo-bm install"; **(0.4.0)** thư mục dữ liệu không dùng được, câu chữ §7.13.10); khi lưu, khoá plugin không quản lý được giữ nguyên.
- `roles.save-fallback`: vai phải thuộc `FALLBACK_ROLES`; mỗi mục qua kiểm của §7.3.6 với luật mode của vai; chặn hai mục trùng `baseProvider` + `model` và mục trùng provider gốc + model của vai chính; mục cùng provider gốc với vai chính được cảnh báo `only helps when the limit is per model`. Ghi alias `bm-<vai>-fallback-<n>` qua `config-writer` trước (xoá bằng `removeProviders`, đánh số lại cho liền), rồi mới ghi file.

**Phát hiện** (`fallback-detect.ts`, hook `agent.turn_ended` riêng, không phụ thuộc kho lưu vết). Chỉ xét agent có vai trong `FALLBACK_ROLES`, không có `bm.replacedBy`, có `workspaceId`; lượt `canceled` bị bỏ qua, và install home chỉ được đọc khi lượt có dạng N1 hay N2.

- **N1:** `outcome.kind === "failed"`; chữ so là `outcome.error.message`.
- **N2:** `outcome.kind === "completed"` và đủ bốn điều: không có lời gọi công cụ; không có `BM-REPORT`/`BM-REVIEW` trong tin **của chính agent**; tin assistant cuối ≤ `MAX_QUIET_REPLY_CHARS = 500`; token ra của lượt là 0, hoặc (khi provider không báo token) tin mở đầu lượt không phải thông báo plugin. Chữ so là tin assistant cuối.
- **Phân loại** (`shared/fallback-patterns.ts`, loại đầu tiên khớp thắng, không phân biệt hoa thường, chữ cắt `MAX_MATCH_CHARS = 2000`):

  | Thứ tự | Loại | Mẫu mặc định | Dự phòng |
  |---|---|---|---|
  | 1 | L1 hạn mức gói | `usage limit`, `limit reached`, `hit your (usage )?limit`, `limit (will )?reset`, `resets? (at\|in) ` | có |
  | 2 | L2 billing | `credit balance`, `billing`, `subscription (has )?(expired\|ended\|inactive)`, `payment (required\|failed)`, `quota exceeded` | có |
  | 3 | L4 đăng nhập | `not logged in`, `please (run )?/?login`, `invalid api key`, `authentication (failed\|error)`, `\b401\b`, `oauth token (has )?expired` | có |
  | 4 | L5 provider không chạy | `provider (is )?unavailable`, `process exited with code`, `command not found`, `ENOENT` | có |
  | 5 | L3 rate limit tạm | `rate[ _]limit`, `overloaded`, `\b429\b`, `\b529\b`, `too many requests` | không |
  | — | L6 không khớp | — | không |

  L1 đứng trước L3 vì thông báo hạn mức gói có thể chứa "rate limit". `patterns` của file thay mẫu mặc định của loại nó liệt kê; mẫu hỏng hay có **lượng từ lồng nhau** (ví dụ `(a+)+`) bị bỏ và log (chặn backtracking theo hàm mũ treo tiến trình plugin trong daemon; dạng hiếm như `(a|aa)*$` vẫn lọt — rủi ro chấp nhận vì file chỉ sửa tay).

**Sự cố** — `role-fallback-state.json`: `{ version: 1, incidents: Incident[] }`, tối đa `MAX_INCIDENTS = 200` (bỏ sự cố cũ nhất đã xong trước), mọi đọc–sửa–ghi qua mutex; file hỏng → không ghi sự cố nào (log mỗi lần) tới khi người dùng sửa.

```ts
Incident = { id: "fb-<12 hex>", role, workspaceId, requestId: string | null /* null với Manager */,
  agentId, agentProvider, agentModel /* runtimeInfo.model, không thì model cấu hình */, parentId, managerId /* chat hiện thẻ */,
  class: "L1"|"L2"|"L4"|"L5", signal: "failed"|"completed", message /* che bí mật rồi cắt 500 */,
  perModelWindow, resetsAt: ISO | null, candidate: { position, alias, baseProvider, model, thinkingOptionId, modeId } | null,
  status: "pending"|"switched"|"waiting"|"resumed"|"dismissed"|"exhausted"|"expired"|"failed",
  detectedAt, decidedAt, waitUntil, replacementId, error }
```

1. Agent đã có sự cố `pending`/`waiting`/`switched` → dừng.
2. **Hạn mức:** chỉ khi L1, provider gốc là `claude`/`codex` và policy khác `off`: gọi `providers.listUsage()` **một lần**, 5 giây. Cửa sổ đã hết là `usedPct >= 100` hoặc `remainingPct <= 0`; `resetsAt` = muộn nhất trong các cửa sổ đã hết; `perModelWindow` khi mọi cửa sổ đã hết có id chứa họ model (`opus`, `sonnet`, `haiku`, `gpt`). Lỗi → `resetsAt: null`, `perModelWindow: false`.
3. **Ứng viên:** chuỗi `[bm-<vai>, bm-<vai>-fallback-1, …]`, xét các mục **sau** vị trí của agent hỏng; bỏ mục đã hỏng trong cùng phạm vi (request với Worker/Reviewer, workspace với Manager), mục có provider gốc không `available`, mục **cùng provider gốc** khi L2/L4 hoặc L1 không `perModelWindow`, và mục cùng provider gốc cùng họ model khi L1 `perModelWindow`. Không còn → `candidate: null`.
4. `managerId`: Worker → Manager cha; Reviewer → Manager của Worker cha; Manager → chính nó. `parentId`: Worker cha của Reviewer, Manager của Worker.
5. Ghi `pending` (policy `off` → ghi `dismissed` và dừng); gửi `BM-FALLBACK` tới `managerId` qua hàng chờ (không có → chỉ pill).

```
BM-FALLBACK
incident: fb-3f9a2c1d7e4b
role: worker
agent: <id>
requestId: <req-… | none>
status: pending
class: L1 usage limit
provider: bm-worker (claude) · claude-opus-5
message: <một dòng, 300 ký tự | none>
resetsAt: <ISO | unknown>
candidate: <alias · provider gốc · model · thinking <id | provider default> | none>
replacement: <id | none>

The <role> stopped because of its provider plan. The user decides on the card in this chat. Tell the user in one line; do not create an agent yourself. Once the status is switched, follow the agent on the replacement line instead.
```

Giá trị `class` (cũng dùng ở dòng `reason:` của bàn giao): `L1 usage limit`, `L2 billing`, `L4 login`, `L5 provider unavailable`. Sau mỗi quyết định plugin gửi thêm một `BM-FALLBACK` cùng `incident` với `status` mới. Thẻ và pill đọc trạng thái thật từ RPC, không từ chữ (thẻ và pill: Design Dashboard). Nếu Manager cùng provider gốc với agent hỏng thì lượt của nó cũng hỏng; tin vẫn nằm trong timeline và thẻ vẫn hiện.

| RPC | Input | Output |
|---|---|---|
| `fallback.incidents` | `{ workspaceId?, ids? (≤ 200) }` | `{ incidents }`, cũ nhất trước |
| `fallback.act` | `{ incidentId, action: "switch" \| "wait" \| "dismiss" \| "resend" }` | `{ incident }` |

`chat.waiting` trả thêm `fallback` (sự cố `pending` của Manager sống); `chat.peers` trả `replaced`; `agents.list` trả `replacedBy`.

`fallback.act` chạy từng hành động một trong toàn tiến trình; sự cố được đọc và kiểm `pending` **bên trong** khoá, nên Switch không tạo agent cho sự cố mà một Wait/Dismiss đồng thời đã quyết. Mã lỗi: `E_FALLBACK_NOT_FOUND` (không có sự cố, không tìm thấy install home, hay file sự cố không đọc được); `E_FALLBACK_NOT_PENDING` (sự cố đã quyết, agent cũ đã có `bm.replacedBy`, hay `resend` không có gì để gửi); `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET` (dưới); `E_FALLBACK_CREATE_FAILED` (tạo agent lỗi hay không đọc được Worker cũ, dưới; Reviewer không rõ Worker cha; `resend` mà hàng chờ bỏ tin).

**Switch — Worker** (plugin tạo): mutex; sự cố `pending`, có ứng viên, Worker cũ chưa `bm.replacedBy`; ứng viên vẫn `available` (không → `E_FALLBACK_NO_CANDIDATE`). Dựng `BM-HANDOVER` (5 giây, phần quá giờ ghi `unknown`). `agents.create({ config: { provider: "bm-worker-fallback-<n>/<model>", thinkingOptionId?, modeId?, featureValues? }, cwd: <cwd Worker cũ>, parent: managerId, title: "Beads Worker (fallback)", labels: { bm.role: "worker", bm.requestId, bm.version, bm.replaces: <cũ> }, prompt: <handover> })` — hook §7.2 vẫn chạy; provider phân tầng được truyền mode tường minh theo luật Worker. Rồi `bm.replacedBy=<mới>` cho Worker cũ (lỗi chỉ log; sự cố đã ghi `replacementId`), thông báo dừng cho Reviewer đang chạy của Worker cũ, ghi `switched`. Không đọc được Worker cũ hay `cwd` của nó → `E_FALLBACK_CREATE_FAILED`, không tạo gì, giữ `pending`; `agents.create` lỗi → `failed` + `E_FALLBACK_CREATE_FAILED`, **không** quay về `pending` (bấm lặp không đẻ hai Worker).

```
BM-HANDOVER
role: worker
requestId: <req | unknown>
managerAgentId: <id | none>
replaces: <id>
reason: <class> — "<message, 300 ký tự>"
lastReport: <phase> at <ISO> | none
tier: <tier | unknown>
filesChanged / beadsCreated / beadsUpdated / beadsClosed / beadsReady / reviewFindingsOpen: <…>
reviewCalls: <n> of <budget> | <n> of an unknown budget | unknown
skillsUsed / decided: <…>
questions: none | unknown | (một dòng mỗi câu: - Q<n>: <câu, 300> → <câu trả lời mới nhất, 300 | open>)

You continue this request in place of the Worker that stopped. Read `git status` and `git diff` first: every change there belongs to the request, so never revert it. Reopen a closed bead only if a review blocks it. Continue the review budget from `reviewCalls` and open no new batch for one in review. The `questions` above are settled: never ask an answered one again; ask an `open` one at your next `blocked` under its own number, and number new ones after the highest listed (from Q100 when it reads `unknown`). Then send `received` to `managerAgentId`.

Original request (verbatim, the first message the replaced Worker received):
<text | unavailable>
```

Nguồn: nhãn `bm.requestId`; `BM-REPORT` mới nhất của request trong kho lưu vết; `reviewCalls` theo §7.7; sổ hỏi–đáp; `user_message` đầu tiên của timeline Worker cũ (che bí mật). Worker bị thay (nhãn hoặc sự cố `switched`) bị loại khỏi luật "một Worker mỗi request" (`soleWorkerOf`), khỏi thẻ, pill và thông báo id Manager mới (`BM-SETTINGS` do lưu vai trò vẫn tới mọi agent sống của vai tạo).

**Switch — Reviewer** (Worker cha tạo, vì Worker chỉ nhận kết luận của Reviewer do chính nó tạo): plugin không tạo agent, chỉ gửi Worker cha qua hàng chờ một `BM-FALLBACK` `status: switched` với đoạn cuối:

```
The user chose to replace Reviewer <oldId>. Create the new Reviewer now with create_agent:
provider `bm-reviewer-fallback-<n>/<model>`, settings.modeId `<mode>` (or: do not pass settings.modeId),
settings.thinkingOptionId `<id>` (omit when none), and the labels you give any Reviewer plus `bm.replaces` = `<oldId>`.
Send it, unchanged, the message you sent <oldId>. This is the same review call, not a new one.
```

Mode: luật Reviewer của hook với provider phân tầng, `runPostureOf` với provider không phân tầng, dòng "do not pass" với provider không có mode; không đọc được thì mode của mục, không có thì `auto` cho Claude/Codex. `on("agent.created")` thấy Reviewer có `bm.replaces` = agent của một sự cố Reviewer `switched`, cùng workspace, là con của đúng Worker cha của sự cố và cùng `bm.requestId` (khi cả hai có) → ghi `replacementId`, đặt `bm.replacedBy` cho Reviewer cũ; không khớp thì nhãn bị bỏ qua. Hàng chờ mất tin → thẻ có "Resend to Worker" (`action: "resend"`: chỉ cho sự cố Reviewer `switched` chưa có `replacementId`, gửi lại đúng tin, không đổi trạng thái).

**Switch — Manager** (plugin tạo bằng `createManager`): provider `bm-manager-fallback-<n>/<model>`, mode theo luật Manager kèm `bm.modeSet`, thinking của mục, nhãn `bm.replaces`, prompt:

```
BM-HANDOVER
role: manager
workspaceId: <id>
replaces: <oldId>
reason: <class> — "<message, 300>"
workers: none | unknown | (- <id> · requestId <req> · <provider>/<model> · <status> · last report: <phase> at <ISO> · blockers: <300>)
openQuestions: <workerId: Q1, Q2; …> | none | unknown
openIncidents: <id sự cố pending/waiting khác của workspace> | none | unknown

The user's last messages to the Manager you replace (oldest first, verbatim):
1. <text>

You are the Beads Manager of this workspace from now on. Every Worker listed was told your id: take them as yours and create no Worker that already exists. Tell the user in one line that you took over, then carry on.
```

Tin người dùng là ba `user_message` **có `clientMessageId`** mới nhất của Manager cũ, bỏ thông báo plugin và `BM-HANDOVER`, che bí mật rồi cắt 1000 ký tự (đọc được mà không có tin nào → `none`, không đọc được → `unknown`); `openQuestions` theo luật của `chat.waiting` cộng sổ hỏi–đáp. Rồi `bm.replacedBy` cho Manager cũ, `BM-SETTINGS` báo id Manager mới cho mọi Worker sống chưa bị thay trong workspace, ghi `switched`. Manager cũ sống tới khi người dùng lưu trữ nó; `manager.ensure` từ đó mở Manager mới.

**Wait** (mọi vai): cần `resetsAt` và không quá 7 ngày (`FALLBACK_MAX_WAIT_MS`), không thì `E_FALLBACK_NO_RESET`. Ghi `waiting`, `waitUntil = resetsAt + 60 s`, một `setTimeout(…).unref()`. Hẹn giờ được đặt lại ở hook hay RPC đầu tiên có handle Paseo sau khi nạp (plugin không có handle lúc nạp); quá hạn thì chạy ngay. Tới giờ: sự cố không còn `waiting` → không làm gì; agent hỏng đã lưu trữ, đang chạy hay đã `bm.replacedBy` → `expired` (không báo); không thì gửi `BM-RESUME` cho chính nó, ghi `resumed`, báo `BM-FALLBACK`. Đây là ngoại lệ hẹp duy nhất của luật "không tác vụ nền" (§9): một hẹn giờ mỗi lần người dùng chọn, ghi ra file, không quét đĩa, không lặp.

**Dismiss:** ghi `dismissed`, báo `BM-FALLBACK`, không đụng agent nào.

**Auto** (`policy: "auto"`, tắt mặc định, người dùng bật riêng từng vai kèm cảnh báo chi phí; với Manager thêm cảnh báo chat có thể bị thay): sau bước 5, có `resetsAt` cách không quá `AUTO_WAIT_WINDOW_MS` = 30 phút → `wait`; không thì có ứng viên → `switch`; không thì để `pending`. Quyết định tự động đi qua đúng `fallback.act`; chat Manager chỉ nhận một `BM-FALLBACK` mang trạng thái đã chọn (không có bản `pending` trước); hành động tự động lỗi → log, báo trạng thái hiện có. Không kiểm hạn mức trước khi tạo agent.

Lan can: mỗi agent bị thay tối đa một lần; chuỗi tối đa 3 mục và chỉ đi tiến trong một phạm vi; chỉ plugin (hay Worker theo chỉ dẫn, với Reviewer) tạo agent thay thế — Manager không tự tạo.

### 7.11 Lưu vết

Bộ thu thập (`collector.ts`) ghi một bản ghi mỗi lượt của agent `bm-*` (kể cả alias dự phòng) vào `traces/` khi `agent.turn_ended`, chạy theo sự kiện, không đồng hồ, không quét đĩa; lỗi ghi bị nuốt và log (không bao giờ ném vào lượt của agent). Bản ghi mang `runtime { provider?, model, thinkingOptionId, modeId }` lấy từ `runtimeInfo` của snapshot trước, trường cấu hình chỉ là dự phòng; `origin` phân biệt lời người dùng (có `clientMessageId`) với lời agent; tin nhắn qua bộ che bí mật. Thời điểm tin nhắn có thể là lúc ghi khi `timeline.refetch` lỗi. Lược đồ, gộp request, chi phí và các RPC `traces.*`, `beads.*`, `workspaces.overview`, `answers.*`, `chat.*`, `setup.*`: [Design Dashboard](./paseo-bm-dashboard.md).

### 7.12 Bảng RPC của plugin

Định nghĩa Zod trong `plugin/shared/contracts.ts`, xử lý trong `index.server.ts` và các module `server/`. Hợp đồng nội bộ giữa client và server của cùng bundle; mọi trường mới là cộng thêm, có mặc định hoặc tuỳ chọn.

| Nhóm | RPC | Mục |
|---|---|---|
| Manager và agent | `manager.ensure`, `agents.list`, `agents.stop-all`, `roles.describe` | §7.3, §7.9 |
| Vai trò | `roles.settings`, `roles.options`, `roles.save-settings`, `roles.save-fallback`, `roles.instructions`, `roles.save-extra` | §7.2, §7.3.6 |
| Dự phòng | `fallback.incidents`, `fallback.act` | §7.10 |
| Chat | `chat.waiting`, `chat.peers`, `chat.beads` | §7.8, Design Dashboard |
| Dashboard, Beads, Setup | `traces.list`, `traces.get`, `traces.delete`, `traces.reassign`, `traces.workspaces`, `beads.stats`, `beads.list`, `beads.get`, `beads.action`, `beads.lookup`, `workspaces.overview`, `answers.marks`, `answers.mark`, `setup.status`, `setup.install-tool` | Design Dashboard |
| Thiết lập máy **(0.4.0)** | `setup.ensure-roles` (`setupEnsureRolesRpc`), `setup.grant-agent-tools` (`setupGrantAgentToolsRpc`), `setup.install-skills` (`setupInstallSkillsRpc`), `setup.cleanup` (`setupCleanupRpc`); `setup.status` thêm trường `setup` | §7.13 |

Tên RPC theo đúng lối sẵn có: `<nhóm>.<việc-viết-gạch-nối>`, khớp `^[a-z][a-z0-9._-]*$` của SDK. Mọi RPC có tác dụng ra ngoài máy của người dùng (chạy lệnh, bật công tắc, xoá) nhận `confirmed: z.literal(true)` như `setup.install-tool`, để schema chặn lời gọi chưa qua hộp xác nhận.

**Sổ mã lỗi của RPC plugin** (`DASHBOARD_ERROR_CODES` trong `plugin/shared/contracts.ts`; đi qua kênh RPC, không có mã thoát; thông điệp bắt đầu bằng mã): `E_TIMELINE_UNAVAILABLE`, `E_BEADS_STORE_UNREADABLE`, `E_TRACE_NOT_FOUND`, `E_TRACE_STORE_UNWRITABLE`, `E_TRACE_STORE_SCHEMA_TOO_NEW`, `E_TRACE_REASSIGN_INVALID`, `E_BEAD_NOT_FOUND`, `E_ROLE_EXTRA_INVALID`, `E_TOOL_PRESENT`, `E_TOOL_INSTALL_FAILED`, `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`, `E_ROLE_SETTINGS_WRITE_FAILED`, `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING`, `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED`; **(0.4.0)** thêm `E_SETUP_ROLES_FAILED`, `E_SETUP_WRITE_FAILED`, `E_SKILLS_PRESENT`, `E_SKILLS_INSTALL_FAILED`, `E_DATA_HOME_UNAVAILABLE` (§7.13.9). `manager.ensure` ném `E_PROVIDER_UNAVAILABLE` (`ManagerEnsureErrorCode`, ngoài danh sách trên).

### 7.13 Thiết lập máy (0.4.0)

Toàn mục là bản đích 0.4.0 (ADR-012 QĐ4–QĐ6, QĐ8). Plugin không có hook cài hay gỡ, và `contribute()` không có handle Paseo, nên mọi việc thiết lập chạy **lười**: ở RPC đầu tiên cần nó. Giao diện của luồng này thuộc [Design Dashboard](./paseo-bm-dashboard.md) §11.3; mục này là hợp đồng server. Module: `server/setup-roles.ts` (tạo vai trò, hằng số mặc định), `server/setup-machine.ts` (tool agent, đăng nhập, loại bản cài, gỡ cấu hình), `server/setup-skills.ts` (thêm `installSkills`), `server/setup-state.ts`, `server/data-home.ts`; mọi ghi cấu hình qua `config-writer.ts` (§6.2).

#### 7.13.1 Khi nào chạy

| Việc | Tự chạy? | Điểm kích hoạt |
|---|---|---|
| Tạo vai trò còn thiếu (`ensureRoles`) | **Có** — không cấp quyền gì mới, chỉ tạo mục `bm-*` của chính paseo-bm | `manager.ensure` (trước khi đọc profile `bm-manager`); `setup.ensure-roles` (màn Setup gọi mỗi lần mở, trước `setup.status`) |
| Cấp tool Paseo cho agent (`injectIntoAgents`) | Không — nút có cảnh báo | `setup.grant-agent-tools` |
| Cài skills bằng CLI `skills` | Không — nút có lưu ý bên thứ ba | `setup.install-skills` |
| Cài `br` / `bv` | Không — nút như hôm nay | `setup.install-tool` (không đổi) |
| Đăng nhập provider | Không bao giờ chạy | `setup.status` chỉ báo trạng thái và lệnh của chính công cụ đó |
| Gỡ cấu hình | Không — nút, xác nhận hai lớp | `setup.cleanup` |

`ensureRoles` không chạy khi `setup-state.cleanedUpAt` khác `null`, hoặc khi cờ trong bộ nhớ `cleanedUpThisRun` bật (đặt bởi `setup.cleanup`, để việc xoá thư mục dữ liệu cũng không làm vai trò tự sinh lại trước khi người dùng gỡ plugin); khi đó nó trả `skipped: "cleaned-up"` và chỉ `setup.ensure-roles { resume: true }` ("Set up again") mới xoá mốc đó và chạy tiếp.

#### 7.13.2 `setup.ensure-roles` và `ensureRoles`

1. Trong mutex của `config-writer`: `config.get()`; vai `r` thiếu khi thiếu alias `bm-r` **hoặc** profile `bm-r`. Không thiếu gì → trả ngay, không patch (chạy lại cho 0 thay đổi).
2. Chọn giá trị theo §6.1 (`listAvailable`, `listModels`, mỗi lời gọi trong `withTimeout` 5 giây như `role-choices.ts`). Không chọn được → `E_SETUP_ROLES_FAILED` ("Paseo reports no available provider" / "Paseo lists no model for <provider>"), không ghi gì.
3. `createRoleEntries` (§6.2): **một** patch, rồi đọc lại. Patch bị từ chối hay đọc lại lệch → `E_SETUP_ROLES_FAILED` kèm lời daemon.
4. Thành công → ghi `setup-state.rolesCreated` (lỗi ghi file chỉ log: cấu hình đã đúng), log một dòng `[paseo-bm] created roles …`.

| RPC | Input | Output |
|---|---|---|
| `setup.ensure-roles` | `{ resume?: boolean }` | `{ created: BmRole[], baseProvider: string \| null, model: string \| null, skipped: "cleaned-up" \| null }` |

`manager.ensure` gọi cùng `ensureRoles`: lỗi → `E_PROVIDER_UNAVAILABLE` với thông điệp `paseo-bm could not create its roles (<lý do>). Open Beads Manager → Setup to see what is missing.`; `skipped: "cleaned-up"` → `E_PROVIDER_UNAVAILABLE`, `paseo-bm's settings were removed. Open Beads Manager → Setup and choose "Set up again", or remove the plugin with: paseo plugin remove paseo-bm`. Output của `manager.ensure` thêm trường tuỳ chọn **`setupNotice?: string | null`**, ghép từ hai câu (thứ tự này, mỗi câu khi đúng):
- vừa tạo vai trò: `paseo-bm created its roles with defaults (<provider> · <model>). Change them in Setup → Agents.`
- `config.mcp.injectIntoAgents === false`: `Paseo's agent tools are off, so the Manager may not be able to create a Worker. Allow them in Setup.`

Khi công tắc tắt và workspace chưa có Manager, `manager.ensure` không tạo Manager mà ném `E_PROVIDER_UNAVAILABLE` với `AGENT_TOOLS_OFF_MESSAGE`: `Paseo's agent tools are off, and a Beads Manager created now would never get them, so it could not create a Worker. Press "Allow agent tools…" in Setup, then open Beads Manager again.` Vai trò vẫn được tạo trước đó. Dòng lỗi hiện ngay trên màn Setup, nơi có nút ấy (§8).

#### 7.13.3 `setup.grant-agent-tools`

| RPC | Input | Output |
|---|---|---|
| `setup.grant-agent-tools` | `{ confirmed: true }` (`z.literal(true)`) | `{ injectIntoAgents: true, changed: boolean }` |

Đã `true` → `changed: false`, không ghi gì và **không** ghi `agentTools` (không phải paseo-bm bật). Ngược lại: ghi `setup-state.agentTools = { setBy: "plugin", previous: false, at }` → `setAgentTools(true)` → đọc lại; patch hỏng → trả `agentTools` về giá trị trước rồi ném `E_SETUP_WRITE_FAILED`; không ghi được `setup-state.json` (trước patch) → `E_DATA_HOME_UNAVAILABLE`, không patch (không có bản ghi thì không hoàn tác được). Văn bản cảnh báo trên màn hình (Design Dashboard §11.3) phải nêu: công tắc áp dụng cho **mọi** agent trên máy, không chỉ ba vai của paseo-bm; agent nào cũng được tạo, nhắn và dừng agent khác. Nút này bắt buộc: §13 Q-044 đã đo, `paseoTools.enabled` của provider không tự cấp tool khi công tắc tắt.

#### 7.13.4 `setup.install-skills`

| RPC | Input | Output |
|---|---|---|
| `setup.install-skills` | `{ confirmed: true }` | `{ command: string, code: number, tail: string[], missingBefore: MissingRequired, missingAfter: MissingRequired }` (`MissingRequired` = `setupStatusSchema.skills.missingRequired`) |

- Năm skill bắt buộc (`REQUIRED_SKILLS`: `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads`); `architecture-premise-audit`, `authoring-workspace-protocol` chỉ là gợi ý, không bao giờ cảnh báo. Nguồn là hằng số `cuongntr/agent-skills`.
- Lệnh cố định, **không** ghép từ input nào: đúng chuỗi `installCommand` của `skillsStatus` hôm nay, `npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s feature-workflow reviewing-plan converting-plan-to-beads polishing-beads implementing-beads -y` (chế độ symlink mặc định của CLI `skills`, không `--copy`). Chạy như `installTool` của `setup-tools.ts`: `/bin/zsh -lc <lệnh>` khi `SHELL` kết thúc bằng `zsh`, còn lại `/bin/bash -lc <lệnh>` (shell đăng nhập, để `npx` có trên PATH của người dùng), hạn **300 giây** (`SKILLS_INSTALL_TIMEOUT_MS = 300_000`), giữ 40 dòng cuối, output qua bộ che bí mật. Hàm `run` của `setup-tools.ts` hôm nay gộp hết giờ vào mã 1; đường này cần nó trả thêm `timedOut: boolean` (lỗi `execFile` có `killed === true`) để `skillsRun.outcome` là `"timeout"` thay vì `"failed"`.
- Trước khi chạy: đọc `skillsStatus`; Claude và Codex đều đủ năm skill → `E_SKILLS_PRESENT`, không chạy. Sau khi chạy: đọc lại (`missingAfter`), ghi `setup-state.skillsRun` (lỗi ghi chỉ log). Mã khác 0 hay hết giờ → `E_SKILLS_INSTALL_FAILED` kèm lệnh và ba dòng cuối (vẫn ghi `skillsRun` với `outcome` tương ứng).
- Plugin **không bao giờ** tự ghi, sửa, xoá file trong thư mục skills (ADR-003 QĐ1); thay đổi duy nhất ở đó đến từ tiến trình CLI `skills` người dùng vừa bấm chạy. Cột Pi/OpenCode vẫn chỉ đọc: lệnh không nhắm chúng.

#### 7.13.5 Trạng thái đăng nhập provider

Trong `setup.status` (chỉ đọc): với mỗi provider gốc (`extends`) của `bm-manager`, `bm-worker`, `bm-reviewer` (gộp trùng), gọi `paseo.providers.diagnostic(<provider>)` song song, mỗi lời gọi 5 giây. Từ `payload.diagnostic` (văn bản) chỉ giữ đúng một boolean bằng `/"loggedIn"\s*:\s*(true|false)/` (cùng luật `src/roles/login.ts` `parseProviderDiagnostic`); phần còn lại của văn bản không bao giờ được lưu, trả hay log. Không có boolean, lỗi, hết giờ → `unknown`, không bao giờ đoán là chưa đăng nhập. Lệnh hiển thị (hằng số, chép từ `PROVIDER_LOGIN_COMMANDS`): `claude` → `claude auth login`; `codex` → `codex login`; `opencode` → `opencode providers login`; `pi` → không có lệnh, `guidance` = `Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then open Setup again.`; provider khác → `loginCommand: null`, `guidance: null`. Plugin **không bao giờ** chạy lệnh đăng nhập và không mở terminal cho nó.

#### 7.13.6 Loại bản cài và banner chuyển đổi

`setup.status` báo `install.kind`: `"installer-directory"` khi `config.plugins["paseo-bm"].path` có dạng `<X>/plugin/<ver>` (`installHomeFromPluginPath`) **và** `<X>/install.json` tồn tại; còn lại `"other"` (bản npm, hay checkout của người phát triển). Không gọi `paseo plugin ls` (không cần CLI cho việc chỉ đọc này). `installer-directory` → banner trên Setup với lệnh `npx paseo-bm@0.4.0` (Design Dashboard §11.3). Giới hạn đã biết: người dùng cũ đang chạy mã 0.3.x từ bản cài thư mục, nên banner chỉ hiện khi một bản cài thư mục chạy mã ≥ 0.4.0 (ví dụ sau đường lùi của lần chuyển mà ai đó cài lại tay thư mục mới); đường chính tới người dùng cũ là cảnh báo deprecate của npm, README và caveat của listing.

#### 7.13.7 `setup.cleanup` — "Remove paseo-bm's settings"

| RPC | Input | Output |
|---|---|---|
| `setup.cleanup` | `{ confirmed: true, deleteData: boolean }` | `{ removedProviders: string[], removedProfiles: string[], agentTools: "restored" \| "left-on" \| "off", data: { deleted: string[], kept: string[] } \| null, nextCommand: "paseo plugin remove paseo-bm" }` |

1. `removeAllBmEntries` (§6.2) trong **một** patch: mọi provider `bm-*` (ba vai và mọi alias dự phòng), mọi profile `bm-*`, và `mcp.injectIntoAgents = agentTools.previous` khi `setup-state.agentTools` có **và** giá trị hiện tại là `true` (`agentTools: "restored"`); công tắc bật mà không do paseo-bm → giữ, `"left-on"` (màn hình nói ai muốn tắt thì tắt trong Paseo); công tắc tắt → `"off"`. Patch hỏng hay đọc lại lệch → `E_SETUP_WRITE_FAILED`, không bước nào sau chạy.
2. Đặt `cleanedUpThisRun`; ghi `setup-state.cleanedUpAt` và `agentTools: null` — luôn luôn, kể cả khi `deleteData` là `true`, vì `ui/setup-state.json` không bao giờ bị xoá (bước 3).
3. `deleteData: true` (màn hình chỉ gửi sau xác nhận thứ hai; mặc định giữ): xoá **đúng các mục do plugin tạo** trong thư mục dữ liệu: `traces/`, mọi thứ trong `ui/` **trừ `ui/setup-state.json`**, `role-extras.json`, `role-fallback.json`, `role-fallback-state.json`; từng mục `lstat` trước, symlink thì bỏ qua và liệt kê vào `kept`. `ui/setup-state.json` luôn được giữ (và liệt kê trong `kept`) vì nó mang `cleanedUpAt`: không có nó, một lần plugin nạp lại trước khi người dùng gỡ plugin sẽ tự tạo lại vai trò (REQ-012 e). Thư mục dữ liệu vì thế không bao giờ bị xoá hẳn bởi nút này. `home.json`, `install.json`, `plugin/`, `backups/`, `.lock` và mọi thứ lạ **được giữ** và liệt kê trong `kept` (chúng không phải của plugin; nếu plugin đang chạy từ một bản cài thư mục thì chính mã của nó nằm trong `plugin/`). Lỗi xoá một mục → liệt kê trong `kept` kèm lý do, không ném.
4. Không đụng: agent đang tồn tại (màn xác nhận nói agent đang chạy trên vai `bm-*` sẽ hỏng khi tạo lượt mới, nên lưu trữ chúng trước), skills, `br`/`bv`, `pluginsEnabled`, `plugins`, mọi mục không có tiền tố `bm-`.
5. Plugin không tự gỡ mình (`paseo plugin remove` từ trong plugin dừng chính tiến trình đang chạy lệnh): `nextCommand` là lệnh người dùng chạy tiếp. Gỡ plugin mà không bấm nút → mục `bm-*` và `injectIntoAgents` còn lại; README và caveat của listing nói rõ.

#### 7.13.8 `setup.status` thêm gì

Trường mới `setup` (tuỳ chọn trong schema, để payload của server cũ vẫn parse), vẫn chỉ đọc:

```ts
setup?: {
  roles: { present: BmRole[], missing: BmRole[], created: { at, roles, baseProvider, model } | null, cleanedUpAt: string | null },
  agentTools: { injectIntoAgents: boolean | null /* null: không đọc được config */, setBy: "plugin" | "installer" | null },
  logins: Array<{ provider: string, roles: BmRole[], state: "logged-in" | "logged-out" | "unknown",
                  loginCommand: string | null, guidance: string | null }>,
  skillsRun: { at, command, code, outcome } | null,
  dataHome: { path: string | null, source: "env" | "pointer" | "default" | null, reason: string | null },
  install: { kind: "installer-directory" | "other", pluginPath: string | null },
}
```

#### 7.13.9 Mã lỗi mới

Thêm vào `DASHBOARD_ERROR_CODES` (§7.12): `E_SETUP_ROLES_FAILED` (không chọn được provider/model, patch bị từ chối, đọc lại lệch khi tạo vai trò), `E_SETUP_WRITE_FAILED` (patch của `setup.grant-agent-tools` / `setup.cleanup` bị từ chối hay đọc lại lệch), `E_SKILLS_PRESENT` (`setup.install-skills` khi không thiếu skill nào), `E_SKILLS_INSTALL_FAILED` (CLI `skills` thoát khác 0 hay quá 300 giây), `E_DATA_HOME_UNAVAILABLE` (thư mục dữ liệu không dùng được: `resolveDataHome` trả `home: null`, hoặc không ghi được `setup-state.json`). Các RPC sẵn có giữ mã hiện tại; chỉ câu chữ đổi (§7.13.10).

#### 7.13.10 Câu chữ còn trỏ tới trình cài

| Chỗ | Hôm nay | (0.4.0) |
|---|---|---|
| `server/manager.ts` (profile thiếu) | `…re-run \`npx paseo-bm\` to register the roles.` | Hai câu ở §7.13.2 |
| `server/config-writer.ts` `checkScope` (alias/profile chính chưa có) | `provider "<id>" is not registered; run npx paseo-bm install first` · `profile "<id>" is not registered; run npx paseo-bm install first` | `provider "<id>" is not registered; open Beads Manager → Setup, which creates it` · `profile "<id>" is not registered; open Beads Manager → Setup, which creates it` |
| `server/config-writer.ts` (xoá alias chính) | `provider "<id>" belongs to the installer and is never removed by the plugin` | `provider "<id>" is a main role; only "Remove paseo-bm's settings" on Setup removes it` |
| `server/fallback-settings.ts` (lưu chuỗi dự phòng) | `paseo-bm cannot find its install home; run npx paseo-bm install, then save again` | `paseo-bm cannot use its data folder (<reason>); see Setup` (mã giữ `E_ROLE_SETTINGS_WRITE_FAILED`) |
| `server/fallback-rpc.ts`, `fallback-switch.ts`, `fallback-wait.ts`, `fallback-manager.ts`, `fallback-reviewer.ts` (`E_FALLBACK_NOT_FOUND`) | `paseo-bm cannot find its install home` | `paseo-bm cannot use its data folder (<reason>); see Setup` (mã giữ `E_FALLBACK_NOT_FOUND`) |
| `server/setup-rpc.ts` (lưu chỉ dẫn thêm) | `cannot save: the paseo-bm install home cannot be found` | `cannot save: paseo-bm cannot use its data folder (<reason>)` (mã giữ `E_ROLE_EXTRA_INVALID`) |
| `server/role-extras.ts` (Runtime facts, dòng `Worker skills`) | ``…and point to `npx paseo-bm doctor`.`` | ``…and point to Beads Manager → Setup → Agent skills.`` |
| `client/agent-tree.ts` (không có vai trò) | `…paseo-bm is not installed on this host, or its roles are not registered with Paseo. Run \`npx paseo-bm doctor\`.` | `No role configuration found: paseo-bm's roles are not registered with Paseo. Open Beads Manager → Setup to create them.` |
| `client/setup-screen.tsx` (nhãn lệnh skills) | `…(run it yourself, or use \`npx paseo-bm install --apply --install-skills\`)` | `Install the required skills for Claude Code and Codex: press Install skills, or run it yourself` |
| `plugin/package.json` `description` | `…Install with npx paseo-bm, which also registers the three agent roles.` | §3.1 |
| `plugin/README.md`, caveat 1–3 của listing | `npx paseo-bm` là đường cài duy nhất; hứa hợp đồng CLI | Cài từ paseo.cafe / `paseo plugin add npm:paseo-bm-plugin` (Paseo 0.9+); ba bước bấm trên Setup; bấm "Remove paseo-bm's settings" trước `paseo plugin remove paseo-bm`, không thì cấu hình còn lại; plugin không nạp được thì `paseo plugin ls` và `paseo plugin logs paseo-bm`; người dùng cũ chạy `npx paseo-bm@0.4.0` một lần |

## 8. Plugin client (lối vào)

- Sidebar "Beads Manager" và Command Center (mở Manager của workspace hiện tại qua `manager.ensure`; mở Metric), hai slash command (§7.9), màn Settings "Beads Dashboard", bộ biến đổi và vẽ timeline cho thẻ chat, các workspace panel. Client không đọc được hệ thống file: mọi thứ cần đĩa đi qua RPC.
- Renderer của Paseo là Expo + `react-native-web`; mã client dùng primitive React Native, `useNativeDriver` phải là `false`. File trong `test/` không import `react-native` như một giá trị.
- Bố cục và hành vi màn hình: [Design Dashboard](./paseo-bm-dashboard.md).
- **(0.4.0)** Thiết lập máy nằm trên màn Setup (Design Dashboard §11.3): mỗi lần mở, màn gọi `setup.ensure-roles` rồi `setup.status`; thẻ "Set up paseo-bm" phía trên dãy tab liệt kê việc còn thiếu (vai trò, tool Paseo cho agent, skills, `br`/`bv`, đăng nhập), mỗi việc cần đồng ý có nút và hộp xác nhận riêng; nút "Remove paseo-bm's settings" có xác nhận thứ hai cho dữ liệu; banner chuyển đổi khi `install.kind` là `installer-directory`. Dải trạng thái hiện `setupNotice` của `manager.ensure` như `modeNotice`.

## 9. Security và reliability

- **Ranh giới tin cậy 1 — bật plugin:** mã không sandbox. **(0.4.0)** Công tắc `pluginsEnabled` thuộc Paseo và người dùng; plugin không đọc hay ghi nó. README và caveat của listing nói plugin là mã không sandbox, truy cập được file, tiến trình và mạng của máy. (Tới 0.3.1: trình cài hỏi, `--enable-plugins`; `--yes` không tính.)
- **Ranh giới tin cậy 2 — chạy tiến trình ngoài:** CLI `skills` (**(0.4.0)** nút trên Setup, lệnh hằng số hiện nguyên văn trong hộp xác nhận, shell đăng nhập, 300 giây, §7.13.4), cài `br`/`bv` (nút sẵn có), Paseo CLI từ trong daemon (`paseo-cli.ts`, `execFile` không shell). Lệnh đăng nhập provider **không bao giờ** được chạy: chỉ hiện (§7.13.5). CLI 0.4.0 chỉ gọi `paseo` (argv mảng, không shell).
- **Ranh giới tin cậy 3 — mở công cụ Paseo:** `daemon.mcp.injectIntoAgents` cho **mọi** agent trên máy quyền tạo, nhắc, dừng agent khác. **(0.4.0)** Một nút riêng có cảnh báo đó (§7.13.3), không còn gộp với việc bật plugin; plugin ghi trạng thái trước vào `setup-state.json` để gỡ cấu hình trả về đúng; Setup hiện công tắc đang bật hay tắt và ai bật.
- **Phạm vi ghi.** **(0.4.0)** Plugin: `<thư mục dữ liệu>/**` (§5.1) và `config.json` chỉ qua `config.patch` trong phạm vi §6.2 (id `bm-*` và `mcp.injectIntoAgents`); không bao giờ ghi thư mục skills, `~/.paseo` bằng `node:fs`, workspace (ngoài hành động bead đã có), hay `install.json`/`plugin/`/`backups/` của trình cài cũ. CLI 0.4.0: `<install home>/install.json`, `<install home>/ui/setup-state.json`, `~/.paseo-bm/home.json`, và các lệnh `paseo plugin remove|add|install`. Có test chứng minh cả hai phạm vi.
- **Chống thoát thư mục:** mọi đường dẫn `resolve` rồi kiểm nằm trong gốc cho phép; từ chối thư mục cài đặt hay (0.4.0) thư mục dữ liệu trùng/chứa `$HOME`, `~/.paseo`, thư mục cấu hình agent; `lstat` trước khi ghi, không đi xuyên symlink; gỡ cấu hình chỉ xoá danh sách mục cố định của §7.13.7.
- **Bí mật:** không đọc, ghi, in credential; trong `~/.paseo` chỉ đọc `config.json` (**(0.4.0)** plugin chỉ đọc qua `config.get()`; văn bản `providers.diagnostic` chỉ để lấy một boolean `loggedIn`, không lưu, không trả, không log); che `PASEO_PASSWORD`, `PASEO_DAEMON_PASSWORD` và token dạng mật khẩu ở mọi kênh. Tin người dùng đi vào bàn giao, sổ hỏi–đáp, sự cố dự phòng và lưu vết đều qua bộ che bí mật. `listUsage` là daemon gọi bằng phiên của nó, chỉ sau một sự cố L1 của Claude/Codex khi policy khác `off`, một lần mỗi sự cố — ngoại lệ mạng duy nhất.
- **Quyền của agent:** Manager và Worker chạy ở mode không hỏi quyền của provider, nên ranh giới hành vi của chúng (không git, không phá, không ra ngoài workspace, không đọc bí mật, hỏi trước khi cài/mạng/migration/deploy) **chỉ còn trong chỉ dẫn vai**. Reviewer không bao giờ chạy mode `dangerous`/`planning` và không bao giờ tự duyệt (`auto_accept: false`); trên Pi không có lớp duyệt nào và trên OpenCode chạy với quyền agent OpenCode được chọn — ở hai trường hợp đó luật chỉ-đọc cũng chỉ còn trong chỉ dẫn. Alias Reviewer không bao giờ có `paseoTools`; ràng buộc "Reviewer không tạo agent" nằm trong chỉ dẫn (câu hỏi mở ở §13).
- **Endpoint công cụ:** chỉ `127.0.0.1`, từ chối `Origin` và `Host` lạ, giới hạn body; công cụ không có tác dụng phụ.
- **Tạo agent của plugin:** chỉ ở `manager.ensure`, `fallback.act` và chế độ Auto người dùng bật. **(0.4.0)** Tạo mục cấu hình không cần hỏi chỉ có một: vai trò `bm-*` còn thiếu (§7.13.2); nó không cấp quyền nào mới.
- **Atomic:** mọi file ghi qua tạm → `fsync` → `rename` (hôm nay trừ `ui/agent-tools.json`; **(0.4.0)** không còn ngoại lệ, §5.1). **Idempotent (0.4.0):** `ensureRoles` trên cấu hình đủ không patch; CLI chạy lại sau khi chuyển là tình huống B, 0 thay đổi. **Khoá:** mọi lần ghi cấu hình của plugin qua một mutex; CLI giữ `<install home>/.lock`. **Ctrl+C** giữa lần chuyển của CLI: file dở ở dạng tạm nên bị bỏ; ngắt giữa `remove` và `add` để lại máy không có plugin `paseo-bm` — chạy lại CLI gặp tình huống D và in đúng lệnh `paseo plugin add`, dữ liệu và `install.json` (chưa đánh dấu) còn nguyên.
- **Không tác vụ nền, không cron, không watcher.** Mọi thứ của plugin chạy theo sự kiện hay RPC. Ngoại lệ hẹp duy nhất: hẹn giờ "Wait" (§7.10).
- **Agent mồ côi / chết giữa chừng:** Worker còn chạy khi Manager đã bị xoá không bị ảnh hưởng và hiện ở nhánh gốc của cây; tài liệu và bead đã ghi vẫn hợp lệ; paseo-bm không tự dọn và không tự tạo lại Worker.
- Mọi thứ nhớ trong bộ nhớ tiến trình (hàng chờ, đếm `BM-FORMAT`, danh sách mode gần nhất, kết quả kiểm công cụ, nhãn đã gắn) mất khi plugin nạp lại; mỗi thành phần đã nêu đường lùi của nó.
- Yêu cầu rà soát trước bản phát hành: sửa `config.json` (`config-writer.ts`, kể cả ba đường mới của §6.2), chạy tiến trình ngoài (`setup-tools.ts`, `setup-skills.ts`), xoá trong thư mục dữ liệu (`setup.cleanup`), phần plugin tạo agent (`manager.ts`, `fallback.act`), và CLI chuyển đổi 0.4.0.

## 10. Chỉ dẫn vai trò — cơ chế

- `plugin/roles/{manager,worker,reviewer}.md` là nguồn sự thật cho hành vi của ba vai: phân mức, khi nào dùng bead, khi nào review, cách hỏi, báo cáo, dừng. Tài liệu này không chép lại chúng.
- Chúng được đóng trong payload (tới 0.3.1 có hash trong `install.json` như mọi file payload; **(0.4.0)** chỉ nằm trong gói `paseo-bm-plugin`, không hồ sơ nào hash chúng), và được nhúng vào bundle server lúc build (`npm run generate:role-instructions`). Nạp vào agent qua hook §7.2, không phụ thuộc việc người dùng đã cài skills.
- Paseo đưa `config.systemPrompt` tới từng provider một kiểu (Claude: `append` sau preset `claude_code`; Codex: `developerInstructions`; OpenCode: `system`); phân tích ở [research-20260918-instructions-by-model](./paseo-bm-research-20260918-instructions-by-model.md).
- Mọi nội dung dành cho agent viết bằng **tiếng Anh**. Tài liệu Worker tạo cho repo đích theo ngôn ngữ repo đó, mặc định tiếng Anh.
- `test/roles-content.test.ts` ghim nguyên văn chỉ những gì mã hay vai khác phụ thuộc (mẫu khối, tên nhãn, tên phase, thông điệp plugin mà vai phải nhận ra, câu trỏ tới Runtime facts) và kiểm các giới hạn cứng theo ý, trên khối `## RULES`.
- Quyền tự điều phối của Manager — tự đánh thức một Worker đang chờ khi kiểm chứng được điều kiện, tự trả lời câu hỏi chỉ hỏi một sự thật, giữ thứ tự khi hai Worker va nhau — là quyết định sản phẩm ở [ADR-011](../adr/ADR-011-manager-coordinates-workers.md) và [PRD REQ-025](../product/paseo-bm-prd.md#6-functional-requirements) (d)–(g); luật cụ thể chỉ nằm trong `manager.md`.
- Agent chỉ nhận chỉ dẫn lúc được tạo: agent đang sống giữ bản cũ tới khi người dùng tạo phiên mới; thay đổi chỉ dẫn phải ghi trong ghi chú phát hành.

## 11. Testing

- Vitest. Plugin test với Paseo SDK giả; không test nào chạm daemon thật. CI không chạy agent thật (không xác định, tốn tiền, cần đăng nhập).
- Test không được treo cả tiến trình: một lời gọi đồng bộ bị chặn thì `testTimeout` của Vitest không cắt được (đã xảy ra với `mkdirSync(…, { recursive: true })` dưới `/proc` trên Linux). Đường dẫn "không ghi được" trong test được dựng bằng một **file thường đứng ở vị trí thư mục** trong thư mục tạm của test (`ENOTDIR` ngay trên mọi hệ điều hành, không phụ thuộc quyền root).
- Hôm nay (0.3.1) còn tầng tích hợp của trình cài: `$HOME` giả với `paseo`, `skills` giả trên `PATH` ghi lại argv; luồng install/doctor/uninstall, phân loại quyền sở hữu, hợp nhất `agentProfiles` trên fixture thật đã ẩn danh. **(0.4.0)** Các test đó (install/doctor/uninstall, planner, applier, ownership, prune, preflight 0.8, skills assist, login, roles register) bị bỏ cùng mã của chúng; thay bằng:

| Tầng (0.4.0) | Kiểm gì |
|---|---|
| Thư mục dữ liệu | `resolveDataHome`: env / con trỏ / mặc định; con trỏ hỏng, schema lạ, đích không an toàn → `home: null` không lùi; `ensureDataHome` tạo `0700`, từ chối symlink ở mọi cấp; đọc không tạo gì; không còn đọc `install.json` |
| `setup-state.json` | ghi atomic `0600`; schema mới hơn → đọc rỗng, không ghi đè |
| `ensureRoles` | thiếu cả ba / một / nửa (alias không profile và ngược lại) / không thiếu gì (0 patch); không provider `available`; không model; patch bị từ chối; đọc lại lệch; mảng `agentProfiles` gửi đi = mảng đọc được + mục mới ở cuối, mọi mục không `bm-` giữ từng byte; không bao giờ có `command`/`env`/`modeId`/`thinkingOptionId`; Reviewer không `paseoTools`; `cleanedUpAt` chặn, `resume` mở lại; `manager.ensure` trả `setupNotice` |
| Tool agent và gỡ cấu hình | ghi `agentTools` trước patch, hoàn tác khi patch hỏng; đã bật sẵn → không ghi; gỡ trả công tắc chỉ khi `setBy` có và đang `true`; một patch duy nhất; `deleteData` chỉ xoá các mục của plugin, giữ `ui/setup-state.json` (còn `cleanedUpAt`), `install.json`/`plugin/`/`backups/`/`home.json` và symlink; sau `deleteData` rồi nạp lại plugin, `ensureRoles` vẫn trả `skipped: "cleaned-up"` |
| Skills | lệnh cố định (so nguyên văn), shell giả, hết 300 giây, mã khác 0, `E_SKILLS_PRESENT`, đọc lại sau khi chạy; không ghi vào thư mục skills |
| Đăng nhập | chỉ boolean ra khỏi `diagnostic`; lỗi / hết giờ / không có boolean → `unknown`; bảng lệnh |
| Hợp đồng | danh sách RPC chính xác (`test/plugin-bundle-cjs.test.ts`, `test/rpc-list-describe.test.ts`) gồm bốn RPC mới; `confirmed: true` bắt buộc ở schema; `DASHBOARD_ERROR_CODES` |
| Câu chữ | không chuỗi nào trong mã của `plugin/` (`server/`, `client/`, `shared/`, `roles/`, hai entry) còn chứa `npx paseo-bm` ngoài banner chuyển đổi, và không còn chứa `install home` trong thông điệp cho người dùng; `plugin/README.md` chỉ nhắc `npx paseo-bm@0.4.0` ở đoạn chuyển đổi |
| CLI 0.4.0 (tích hợp, `$HOME` giả, `paseo` giả) | tình huống A–E của §4.3; `remove`/`add` hỏng → đường lùi `fell-back` / `fallback-failed`, `install.json` không đổi; thành công → `schemaVersion: 2` + `migratedTo`, con trỏ khi `--home` khác mặc định, mang `agentTools` sang; chạy lại → B; lệnh/cờ đã bỏ → 2; không TTY không `--apply` → 6; JSON đúng khung; không ghi ngoài ba file của §9 |
| Gói | `smoke:packed`: tarball plugin nạp được, manifest `>=0.9.0`; tarball `paseo-bm` 0.4.0 chỉ có `dist/` |

- Nghiệm thu thủ công trên daemon thật (bắt buộc trước 0.4.0, bản prerelease trên dist-tag `next`, Paseo 0.9.x): cài mới bằng `paseo plugin add npm:paseo-bm-plugin@next` trên máy chưa có gì (đo cả §13 Q-044, Q-045, Q-047); chuyển một bản cài 0.3.1 dạng thư mục (mặc định và `--home`); sau khi chuyển, `npx paseo-bm@0.3.1 install` phải dừng ở mã 3 mà không đổi gì; `paseo plugin update paseo-bm` (§13 Q-046); gỡ cấu hình rồi `paseo plugin remove paseo-bm`. Nghiệm thu điều phối như cũ; checklist ở `docs/operations/`, biên bản mỗi lần chạy ở `docs/archive/operations/` (quy ước của `docs/README.md`).

## 12. Tương thích

- **(0.4.0) Paseo 0.8 không còn được hỗ trợ.** `requirements.paseo: ">=0.9.0"`, nên Paseo 0.8 không nạp gói 0.4.0; người dùng 0.8 giữ `paseo-bm@0.3.1` (trình cài và payload thư mục) hoặc nâng Paseo. Mã plugin vẫn biên dịch với SDK 0.8.0 và đã chạy trên 0.9.2.
- **(0.4.0) Hợp đồng CLI.** Tới 0.3.1 lệnh, cờ, JSON và mã thoát của CLI là hợp đồng công khai, trong cùng major chỉ thêm. 0.4.0 bỏ gần hết chúng; đó là thay đổi phá vỡ có chủ ý, đánh dấu bằng bước minor trước 1.0 (ADR-012 QĐ9). Phần còn lại (khung JSON `schemaVersion: 1`, các mã 0/2/3/5/6/7) giữ nghĩa cũ; mã 1 và 4 không bao giờ được dùng lại cho nghĩa khác.
- `install.json`: `schemaVersion` 1 tới 0.3.1; **(0.4.0)** `2` sau khi chuyển (§4.5), để trình cài cũ dừng thay vì ghi.
- **(0.4.0) Hạ phiên bản xuống dưới 0.4.0 không phải đường lùi.** Plugin 0.3.x chỉ tin một thư mục có `install.json` `schemaVersion: 1`, tìm ở `<đường dẫn đăng ký>/../..` rồi `~/.paseo-bm` (`install-home.ts` `confirmInstallHome`). Sau `paseo plugin update paseo-bm --version 0.3.1` trên bản npm, đường dẫn đăng ký không có dạng `<home>/plugin/<ver>`, và `install.json` hoặc đã là `2` (người đã chuyển) hoặc không có (người cài mới): plugin 0.3.1 chạy nhưng mọi phần cần thư mục (lưu vết, chỉ dẫn thêm, dự phòng, sổ hỏi–đáp) tắt; cấu hình `bm-*` vẫn dùng được. Đường lùi được hỗ trợ là một bản vá ≥ 0.4.0 (§3.2); hạ trong phạm vi ≥ 0.4.0 bằng `paseo plugin update paseo-bm --version <v>` thì an toàn.
- **(0.4.0) Quyết định R3.** Người chịu rủi ro: hieu.nt10. Điểm không lùi: mỗi lần publish npm (npm chặn `unpublish` sau 72 giờ) và `npm deprecate paseo-bm`. Diễn tập **có chọn**: bản prerelease trên dist-tag `next` của cả hai gói cộng nghiệm thu trên daemon Paseo 0.9 thật (§11) trước khi có gì lên `latest`; §13 Q-045 không đạt thì dừng. Khoanh vùng sau phát hành: bản vá; người dùng thư mục mà lần chuyển lùi (`fell-back`) vẫn chạy 0.3.1 như trước.
- Văn bản khối `BM-REPORT` là hợp đồng đang được Dashboard, thẻ, trace và sổ hỏi–đáp tiêu thụ; đổi nó cần cập nhật mọi bên đọc và bộ đọc khoan dung.
- Kho lưu vết và các file `ui/` (kể cả `setup-state.json`) có lược đồ riêng đánh số độc lập; bản ghi mới chỉ thêm trường tuỳ chọn. Bản npm đọc nguyên kho của bản cài thư mục, không di trú.
- Bản plugin cũ gặp alias `bm-*-fallback-*` không nhận ra vai của nó; mọi đường gỡ vẫn xoá alias đó (luật tiền tố `bm-`).
- Khi Paseo đổi phiên bản: xem lại `requirements.paseo`, khoá cấu hình ở §6 và hình dạng `MutableDaemonConfigPatch`, hình dạng `plugin ls --json` (`installation.identity`) mà CLI 0.4.0 đọc, và danh sách `TOOL_PROVIDERS`.

## 13. Câu hỏi mở

| ID | Câu hỏi | Owner | Status |
|---|---|---|---|
| Q-028 | Khi công tắc MCP toàn cục bật, `paseoTools` ở mức provider có thật sự tước công cụ của `bm-reviewer` không? Nếu không, "Reviewer không tạo agent" chỉ nằm ở chỉ dẫn (ADR-006 QĐ9) | hieu.nt10 | open |
| Q-025 | Một workspace đúng một Manager; người dùng cố tình tạo cái thứ hai thì xử lý gì ngoài "chọn cái có nhãn, mới nhất, và báo"? | hieu.nt10 | open |
| Q-044 | Trên daemon thật với `daemon.mcp.injectIntoAgents` **tắt**, `paseoTools.enabled` của `bm-manager`/`bm-worker` có tự cấp tool Paseo cho agent của hai vai đó không? | hieu.nt10 | **closed 2026-09-25 — không.** Đo trên Paseo 0.9.2: công tắc tắt → agent trên `bm-worker` (có `paseoTools.enabled: true`) và agent `claude` thường đều không có `create_agent`/`send_agent_prompt`/`list_agents`; đối chứng dương với công tắc bật → agent `bm-worker` có đủ `mcp__paseo__create_agent`, `mcp__paseo__send_agent_prompt`, `mcp__paseo__list_agents`. Công tắc toàn máy là bắt buộc; nút §7.13.3 giữ nguyên; vai trò tự tạo kèm `paseoTools` không tự cấp quyền gì |
| Q-045 | Gói cài bằng `paseo plugin add npm:paseo-bm-plugin` có nạp được `zod` và `@getpaseo/plugin` không (`plugin/package.json` không khai `dependencies`; bản cài thư mục cũng không có `node_modules` mà vẫn chạy, nên host có lẽ cấp chúng, nhưng chưa thấy với nguồn npm)? Không → thêm `dependencies` trước 0.4.0. Đo trên bản prerelease `next` | hieu.nt10 | **closed 2026-09-26 — có.** Cài bằng `paseo plugin add npm:paseo-bm-plugin@next` trên Paseo 0.9.2 (daemon cô lập, registry thử phục vụ đúng tarball sẽ publish): plugin `running`, `Loading plugin` → `Plugin ready`, mọi RPC và hook chạy; không cần `dependencies` (biên bản `docs/archive/operations/paseo-bm-install-run-20260926.md`)
| Q-046 | `paseo plugin update paseo-bm` có đổi đường dẫn đăng ký (thư mục `<uuid>` mới) không? Không ảnh hưởng dữ liệu (§5.1 không dùng thư mục gói), nhưng ảnh hưởng `install.kind` và chẩn đoán | hieu.nt10 | **closed 2026-09-26 — có.** `paseo plugin update` cài vào thư mục `<uuid>` mới và xoá thư mục cũ; dữ liệu ở thư mục dữ liệu không đổi. Thêm: trên bản cài từ `@next`, `update` không cờ theo `latest` và đề xuất hạ về `0.3.1` — phải dùng `--version next` (biên bản 20260926)
| Q-047 | Paseo 0.9 `plugin add npm:…` với `--json` và không TTY: có hỏi tin cậy tương tác, có tự bật `pluginsEnabled`, và in JSON cùng hình dạng `{ id, path, enabled, status }` như `plugin install` không? Và `plugin ls --json` của một bản npm có mang `installation.identity = { kind: "npm", packageName, pluginPath }` không? CLI 0.4.0 (§4.3 tình huống B, §4.4 bước 2) dựa vào hai hình dạng đó | hieu.nt10 | **closed 2026-09-26.** `plugin add npm:… --json` không TTY: không hỏi tin cậy (chỉ in một dòng cảnh báo ra stderr), **không** bật `pluginsEnabled` (công tắc tắt → mục được ghi, `status: "disabled"`, `pluginsEnabled` vẫn `false`), JSON cùng hình `{ id, path, enabled, status, installation }`; `plugin ls --json` của bản npm có `installation.identity = { kind: "npm", packageName, pluginPath: "." }` và `currentRevision`. Khớp §4.3/§4.4: chuyển đổi A, B, C chạy đúng (biên bản 20260926)

## 14. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | hieu.nt10 (soạn bởi Claude) | Sau lần cài trắng trên daemon cô lập (biên bản `docs/archive/operations/paseo-bm-install-run-20260926.md`): `manager.ensure` không tạo Manager khi `injectIntoAgents` tắt (§7.3, §7.13.2), vì Manager tạo lúc ấy không bao giờ nhận tool Paseo; hook `before("agent.create")` đổi model của Worker/Reviewer về model của profile (§7.2), vì Manager tạo trước khi người dùng đổi provider vẫn xin model cũ; `notes` của profile Worker mô tả cách làm theo cỡ việc (§6.1); §13: Q-045, Q-046, Q-047 đóng (Q-046 kèm cảnh báo `update` trên bản `next` hạ về `latest`). |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | **ADR-012: một nguồn duy nhất — plugin `paseo-bm-plugin` là toàn bộ sản phẩm (bản đích 0.4.0).** §1–§6 viết lại theo bản đích: một gói sản phẩm, `requirements.paseo >=0.9.0`, `paseo-bm` 0.4.0 là lần publish cuối và `release.yml` sau đó chỉ publish plugin (§3); CLI 0.4.0 chỉ chuyển bản cài thư mục sang npm, với tình huống A–E, đường lùi bm-vey, `install.json` `schemaVersion: 2` + `migratedTo`, `E_COMMAND_RETIRED`, mã thoát 0/2/3/5/6/7 và khung JSON (§4); thư mục dữ liệu do plugin tự tạo, `resolveDataHome` env → con trỏ `~/.paseo-bm/home.json` → mặc định, `ui/setup-state.json` (§5); plugin là bên ghi config duy nhất, giá trị mặc định khi tạo vai trò, ba đường ghi mới và luật phạm vi đổi (§6). Thêm §7.13 (thiết lập máy: `setup.ensure-roles`, `setup.grant-agent-tools`, `setup.install-skills`, `setup.cleanup`, trường `setup` của `setup.status`, `setupNotice` của `manager.ensure`, năm mã lỗi mới, bảng câu chữ còn trỏ tới `npx paseo-bm`); sổ mã lỗi RPC chuyển về §7.12. Cập nhật §7.2, §7.3, §7.4, §7.10, §8–§12. §13: bỏ Q-039b (đã trả lời: nút gỡ cấu hình, xoá dữ liệu chỉ sau xác nhận thứ hai, mặc định giữ — ADR-012 QĐ6) và Q-043 (không còn `doctor`); thêm Q-044 → Q-047. Trình cài 0.3.1 chỉ còn trong lịch sử git. **Rà soát `design-ready` độc lập cùng ngày**, đối chiếu mã: thêm dòng Routing decision ở đầu; §4.3 thêm bản cài trong `<install home>/plugin/` không có `install.json` (→ C) và lỗi `plugin ls` (→ 3), ghi rõ luật B dựa vào `installation.identity`; §5.1 liệt kê đủ chỗ gọi `installHomeOf`; §7.13.4 `run` phải báo hết giờ; §7.13.10 thêm câu `E_FALLBACK_NOT_FOUND` của năm module dự phòng; §11 phạm vi test câu chữ và chỗ để biên bản; §12 thêm hạ phiên bản dưới 0.4.0 (không phải đường lùi, plugin 0.3.x không tin thư mục dữ liệu) và quyết định R3; Q-047 thêm hình dạng `plugin ls --json` của bản npm Sau review plan: Q-044 đóng (đo: không), bằng chứng cho Q-045 và một phần Q-047, thêm trường hợp cài từ paseo.cafe khi còn bản cài thư mục (§4.3). |
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | **Q-026 đã trả lời và rời bảng câu hỏi mở:** Manager được tự điều phối Worker trong phạm vi người dùng đã quyết ([ADR-011](../adr/ADR-011-manager-coordinates-workers.md), PRD REQ-025 (d)–(g), quyết định chủ repo Q1 (c) của `req-20260925T051841Z`); §10 trỏ tới quyết định đó, luật nằm trong `plugin/roles/manager.md` |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | Rà soát sau khi gộp, đối chiếu từng delta với mã: **bổ sung** dist-tag theo loại phiên bản của `release.yml` (gộp delta 20260925b-stable-release), `plugin/LICENSE`, năm skill bắt buộc, lệnh `provider ls/models/diagnostic`, cài `br`/`bv` và thời hạn login, hình dạng mục vai trò tạo mới (có `notes`), phạm vi `config-writer`, `FallbackSettings` và lỗi của `roles.*`, luật nhận Reviewer thay thế, khoá tuần tự và mã lỗi của `fallback.act`, nhãn `class`, Auto chỉ báo một lần, 404 và chỗ lưu cổng của endpoint công cụ, luật đầu vào của công cụ, phase cũ bộ đọc khoan dung nhận, chip `template error`, thử lại `BM-FORMAT`, đọc lại đích của `agents.stop-all`, cờ `NEW_REQUEST_MARKER`, trỏ tới báo cáo nghiên cứu system prompt theo provider; **sửa** mã thoát của `--role` (cặp không có trong Paseo là mã 3), dự phòng mode Reviewer trong Runtime facts, thứ tự trường `BM-HANDOVER`, hẹn giờ Wait (không huỷ, `expired` không báo), ngoại lệ ghi atomic của `ui/agent-tools.json`, phạm vi loại trừ Worker bị thay khỏi `BM-SETTINGS` |
| 2026-09-25 | hieu.nt10 (soạn bởi Claude) | **Gộp 16 delta thiết kế lõi vào tài liệu này; từ nay là tài liệu sống, sửa tại chỗ.** Viết lại theo thành phần, chỉ mô tả trạng thái hiện tại theo mã; bỏ errata, bảng câu hỏi đã trả lời và lịch sử cũ (git giữ bản trước). Hành vi của vai trỏ về `plugin/roles/*.md`. Các delta đã gộp liệt kê ở §15 và mang Status "Merged". Chỗ lệch giữa delta và mã được viết theo mã |
| 2026-09-14 → 2026-09-24 | hieu.nt10 | Bản 1 (trình cài), bản 2 (điều phối) và các errata đến 2026-09-24 — xem lịch sử git của file này và các delta ở §15 |

## 15. Lịch sử

Các delta dưới đây đã được gộp vào tài liệu này ngày 2026-09-25 và chỉ còn là hồ sơ lịch sử, nằm ở `docs/archive/design/` (mã nguồn còn trích tên và mục của chúng). [Đề xuất 20260921-worker-fallback-and-role-settings](../archive/design/paseo-bm-proposal-20260921-worker-fallback-and-role-settings.md) giữ làm nguồn sự thật đã kiểm của phần dự phòng.

| Delta | Ngày | Đưa vào |
|---|---|---|
| [20260916-trace-store](../archive/design/paseo-bm-delta-20260916-trace-store.md) | 2026-09-16 | `traces/` trong install home; loại quyền sở hữu `user-data`; mã lỗi RPC của Dashboard |
| [20260916-review-budget](../archive/design/paseo-bm-delta-20260916-review-budget.md) | 2026-09-16 | Luật review theo lô (nay nằm trong chỉ dẫn vai; con số ngân sách đã được thay) |
| [20260917-workflow-skills](../archive/design/paseo-bm-delta-20260917-workflow-skills.md) | 2026-09-17 | Trường `skillsUsed` của `BM-REPORT`; phần còn lại là chỉ dẫn vai và Dashboard |
| [20260917b-simplify-roles](../archive/design/paseo-bm-delta-20260917b-simplify-roles.md) | 2026-09-17 | Bố cục `## RULES` theo loại của ba file vai; chính sách test nội dung vai hai tầng |
| [20260917c-context-engineering](../archive/design/paseo-bm-delta-20260917c-context-engineering.md) | 2026-09-17 | Hook chọn và hạ mode; Runtime facts; ngân sách 5 giây của hook; plugin đếm ngân sách review và `BM-BUDGET`; nhận dạng thông báo plugin theo văn bản |
| [20260917e-manager-screen-and-commands](../archive/design/paseo-bm-delta-20260917e-manager-screen-and-commands.md) | 2026-09-17 | `/bm-worker-new`, `/bm-worker-stop-all`, `agents.stop-all`, `BM-STOP` (phần giao diện thuộc Design Dashboard) |
| [20260917f-new-request-command](../archive/design/paseo-bm-delta-20260917f-new-request-command.md) | 2026-09-17 | Dòng cờ `BM-NEW-REQUEST`, giữ là lời người dùng |
| [20260918-manager-mode-model-metrics](../archive/design/paseo-bm-delta-20260918-manager-mode-model-metrics.md) | 2026-09-18 | Manager ở mode không hỏi quyền, chuyển một lần bằng Paseo CLI, nhãn `bm.modeSet`, `modeNotice`; trường `runtime` của bản ghi (số liệu model thuộc Design Dashboard) |
| [20260918g-agent-conventions](../archive/design/paseo-bm-delta-20260918g-agent-conventions.md) | 2026-09-18 | Nhận vai theo nhãn hoặc provider; gắn nhãn và lượt quét; kiểm mẫu `BM-*` và `BM-FORMAT`; mode Reviewer dự phòng |
| [20260921-ci-linux-hang](../archive/design/paseo-bm-delta-20260921-ci-linux-hang.md) | 2026-09-21 | `release.yml` chỉ Node 24 × hai hệ điều hành; cách dựng đường dẫn không ghi được trong test |
| [20260921-worker-fallback-and-role-settings](../archive/design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) | 2026-09-21 | Profile thinking/feature; cách chạy theo khả năng provider; `BM-TOOLS`; màn "Roles & models" và `config-writer`; trình cài gộp; dự phòng cho ba vai (`BM-FALLBACK`, `BM-HANDOVER`, `BM-RESUME`), Auto |
| [20260923-payload-npm-package](../archive/design/paseo-bm-delta-20260923-payload-npm-package.md) | 2026-09-23 | Gói `paseo-bm-plugin`, đồng bộ phiên bản, publish hai gói trong `release.yml` |
| [20260924-instruction-quality](../archive/design/paseo-bm-delta-20260924-instruction-quality.md) | 2026-09-24 | Dòng `Worker skills` trong Runtime facts; thông điệp plugin tự mô tả việc phải làm |
| [20260924-qa-ledger](../archive/design/paseo-bm-delta-20260924-qa-ledger.md) | 2026-09-24 | Sổ hỏi–đáp, `BM-ANSWERED`, `chat.waiting.answered`, `BM-BUDGET` chỉ để báo, khối `questions` của `BM-HANDOVER` |
| [20260924-worker-autonomy](../archive/design/paseo-bm-delta-20260924-worker-autonomy.md) | 2026-09-24 | `REVIEW_BUDGET = { Small: 2, Medium: 2, Large: 4 }`; phần còn lại là chỉ dẫn vai |
| [20260924b-agent-tools](../archive/design/paseo-bm-delta-20260924b-agent-tools.md) | 2026-09-24 | Endpoint MCP trong plugin, `bm_report` / `bm_review` / `bm_answers`, gắn công cụ theo provider gốc |
| [20260925b-stable-release](../archive/design/paseo-bm-delta-20260925b-stable-release.md) | 2026-09-25 | `release.yml` nhận bản ổn định; dist-tag theo loại phiên bản (`next` / `latest`); bản ổn định không đẩy vào `next` |
