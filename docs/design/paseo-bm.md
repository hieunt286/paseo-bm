# paseo-bm — Technical Design

| Trường | Giá trị |
|---|---|
| Status | Active |
| Cách sửa | **Tài liệu sống từ 2026-09-25.** Sửa tại chỗ để luôn mô tả trạng thái hiện tại, mỗi lần sửa thêm một dòng Revision History; git là hồ sơ kiểm toán. Không mở delta mới cho tài liệu này. |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Requirements source | [PRD paseo-bm](../product/paseo-bm-prd.md) |
| Tài liệu anh em | [Technical Design Dashboard](./paseo-bm-dashboard.md) — màn Metric, Beads, Setup, thẻ chat, pill, kho lưu vết và các RPC của chúng |
| Related ADRs | [ADR-001](../adr/ADR-001-plugin-distribution.md) · [ADR-002](../adr/ADR-002-install-ownership-model.md) · [ADR-003](../adr/ADR-003-skills-delegation.md) · [ADR-004](../adr/ADR-004-paseo-config-mutation.md) · [ADR-005](../adr/ADR-005-manager-as-agent.md) · [ADR-006](../adr/ADR-006-role-registration.md) · [ADR-007](../adr/ADR-007-dashboard-trace-store.md) · [ADR-008](../adr/ADR-008-role-settings-written-by-plugin.md) · [ADR-009](../adr/ADR-009-payload-as-npm-package.md) · [ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md) · [ADR-011](../adr/ADR-011-manager-coordinates-workers.md) |
| Hành vi của agent | [`plugin/roles/manager.md`](../../plugin/roles/manager.md), [`worker.md`](../../plugin/roles/worker.md), [`reviewer.md`](../../plugin/roles/reviewer.md) là nguồn sự thật duy nhất. Tài liệu này chỉ mô tả cơ chế plugin làm quanh chúng. |
| Môi trường tham chiếu | Paseo CLI/daemon 0.8.0 (kiểm thêm 0.9.2 cho trình cài), Node ≥ 22, macOS và Linux |

## 1. Phạm vi

- **Tài liệu này sở hữu:** CLI `paseo-bm` (lệnh, cờ, JSON, mã thoát, mã lỗi); thư mục cài đặt và hồ sơ; cách gọi Paseo CLI; phần paseo-bm ghi vào `config.json` (của trình cài và của plugin); đóng gói hai gói npm và quy trình phát hành; plugin server: nhận vai agent, hook tạo agent, Manager, endpoint công cụ cho agent, các thông điệp `BM-*` của plugin, kiểm mẫu khối, đếm ngân sách review, sổ hỏi–đáp, dừng agent, dự phòng khi hết hạn mức; các slash command.
- **Không sở hữu:** câu chữ và hành vi của ba vai (thuộc `plugin/roles/*.md`); giao diện Metric/Beads/Setup, thẻ chat, pill, kho lưu vết (thuộc [Design Dashboard](./paseo-bm-dashboard.md)); chất lượng suy luận của model; nội dung skills bên thứ ba; nội bộ Paseo; thao tác git.

## 2. Kiến trúc

```
┌─ TRÌNH CÀI (npx paseo-bm) ─────────────────────────────────────────────────┐
│ cli · preflight · planner · applier · record · paseo adapter · skills       │
│ · roles (provider dẫn xuất + agent profile + công tắc công cụ)              │
└───────────┬────────────────────────────────────────────────────────────────┘
            │ ghi
            ▼
  ~/.paseo-bm/          install.json · plugin/<ver>/ · backups/ · .lock
                        + dữ liệu người dùng: traces/ · ui/ · role-*.json
  ~/.paseo/config.json  pluginsEnabled · agents.providers.bm-* · daemon.agentProfiles[bm-*]
                        · daemon.mcp.injectIntoAgents

┌─ PLUGIN (chạy trong daemon) ────────────────────────────────────────────────┐
│ client: sidebar + Command Center "Beads Manager", slash command, màn        │
│         Metric/Beads/Setup, thẻ chat (Design Dashboard)                     │
│ server: before("agent.create") → chỉ dẫn vai, Runtime facts, mode, công cụ  │
│         on("agent.created")    → gắn nhãn, kiểm công cụ Paseo (BM-TOOLS)    │
│         on("agent.turn_ended") → lưu vết, BM-FORMAT, ngân sách review,      │
│                                   sổ hỏi–đáp, dừng Reviewer, dự phòng,      │
│                                   hàng chờ thông báo                        │
│         RPC · endpoint MCP 127.0.0.1 (bm_report / bm_review / bm_answers)   │
└───────────┬────────────────────────────────────────────────────────────────┘
            │ tạo / nhắn / đọc trạng thái
            ▼
  người dùng ⇄ MANAGER (bm-manager) ──tạo──▶ WORKER (bm-worker) ──tạo──▶ REVIEWER (bm-reviewer)
  người dùng ⇄ WORKER                          Manager, Worker có công cụ Paseo; Reviewer không
```

Người dùng chat được với cả Manager lẫn Worker. Agent do agent khác tạo vẫn là agent hạng nhất trong workspace (chỉ mang thêm nhãn `paseo.parent-agent-id`); người dùng mở, nhắn, dừng, lưu trữ, xoá được. Vòng đời agent thuộc người dùng (ADR-005): plugin không bao giờ lưu trữ hay xoá agent, và không có RPC nào làm việc đó. Ngoại lệ duy nhất: một Manager chính `createManager` vừa tạo mà khởi động hỏng thì đúng agent đó bị lưu trữ trước khi báo lỗi (§7.3).

Plugin tồn tại vì ba việc một agent không làm được: lối vào ổn định mở đúng Manager của workspace; bảo đảm một Manager mỗi workspace; và các cơ chế cần mã (hook, đếm, kiểm mẫu, dự phòng).

## 3. Đóng gói và phát hành

### 3.1 Hai gói, một phiên bản

| Gói | Nội dung | Gốc tarball |
|---|---|---|
| `paseo-bm` | trình cài; `bin: { "paseo-bm": "dist/index.js" }`; `files: ["dist/", "plugin/", "!plugin/images/**"]` | `dist/`, `plugin/`, không có manifest plugin |
| `paseo-bm-plugin` | payload trong `plugin/` (`plugin/package.json`) | plugin nạp được: `paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`, `tsconfig.json`, `LICENSE`, `README.md` |

- Gói payload tồn tại vì paseo.cafe quét gốc tarball npm và đòi runtime entry Paseo 0.8 ngay ở đó (ADR-009). Hồ sơ registry nằm ở repo `paseo-cafe/paseo-cafe` (`registry/paseo-bm.json`, `path: "plugin"`, `package: "paseo-bm-plugin"`).
- `package.json`, `plugin/package.json` và `PLUGIN_VERSION` (`plugin/shared/version.ts`) luôn cùng phiên bản: `scripts/generate-plugin-version.mjs` (chạy trong `build`, nên cả trong `prepack`) ghi hai nguồn sau; một test đỏ khi ba nguồn lệch.
- `plugin/package.json` không có `dependencies` (Paseo cấp module runtime) và **không có script `test`**: không có test nào trong `plugin/`, và một script chỉ để mục health `hasTests` xanh là kiểm tra giả. Script `typecheck` chỉ chạy được từ checkout của repo.
- `plugin/LICENSE` là bản sao đúng từng byte của `LICENSE` gốc (gói payload là một bản phân phối riêng, MIT đòi kèm giấy phép); một test giữ hai file khớp.
- `plugin/images/` chỉ phục vụ trang listing, không vào tarball nào; `smoke:packed` khẳng định điều đó và khẳng định gốc tarball payload có manifest cùng hai entry.
- Gói trình cài không có phụ thuộc runtime: mọi thứ được `tsup` gói vào `dist/index.js`. Không có `preinstall` / `install` / `postinstall` (tải gói không được đổi máy người dùng); `prepack` được phép vì chạy trên máy người phát hành.
- Chỉ có **một** `paseo-plugin.json` trong repo (`plugin/paseo-plugin.json`: `{ "id": "paseo-bm", "requirements": { "paseo": ">=0.8.0" } }`); một test khẳng định điều đó.

### 3.2 CI và phát hành

- **`.github/workflows/ci.yml`** (mỗi push lên `main` và mỗi PR): một job ubuntu, Node 22 (mức `engines` thấp nhất): `npm ci`, typecheck gốc và plugin, lint, test. Bỏ qua commit chỉ đụng `docs/**`, `.beads/**`, `README.md`, `GUIDE.md`, `AGENTS.md`, `CLAUDE.md`, `assets/**`. `plugin/roles/*.md` cố ý không bị bỏ qua vì được nhúng vào bundle và có test.
- **`.github/workflows/release.yml`** chạy khi một GitHub Release được publish, hoặc chạy tay (`workflow_dispatch`, input `tag` tuỳ chọn, mặc định `v<version>`; luôn là dry-run). Không đổi tên file: trusted publisher npm của **cả hai** gói trỏ theo tên file này. Xác thực bằng OIDC, không có `NPM_TOKEN` hay secret nào.
  1. Job `verify`: ma trận `{ubuntu-latest, macos-latest} × Node 24`, `fail-fast: false`: typecheck gốc và plugin, lint, test, build, `smoke:packed`, kiểm không có script vòng đời cài đặt. Node 22 đã được `ci.yml` kiểm ở mọi commit; chiều hệ điều hành được giữ vì chính nó bắt được lỗi treo chỉ có trên Linux.
  2. Job `release` (`needs: verify`, `id-token: write`, npm ≥ 11.5.1): tag phải bằng `v<version>` của `package.json`; với sự kiện `release`, cờ prerelease của Release phải khớp hình dạng phiên bản (`version.includes("-")`), nên bản ổn định phải được tạo Release **không** đánh dấu prerelease. **Dist-tag theo loại phiên bản:** prerelease → `next`, bản ổn định → `latest`. Sau đó `npm ci` → kiểm → build → `smoke:packed` → "Assert both packages agree" (`plugin/package.json` có `name` `paseo-bm-plugin` và cùng phiên bản) → `npm publish --dry-run` cho cả hai gói. Chỉ khi sự kiện là `release`: publish `paseo-bm` rồi mới publish `paseo-bm-plugin` (cả hai `--provenance --access public --tag <dist-tag>`), rồi chờ `npm view <gói>@<dist-tag> version` bằng phiên bản mới (tối đa 20 lần × 15 giây, vì npm báo "being processed" một lúc sau khi publish).
  3. Script node của bước "Resolve version, tag and dist-tag" nằm trong chuỗi shell nháy đơn: không được có dấu nháy đơn hay apostrophe nào trong script.
- Bản ổn định **không** được đẩy thêm vào `next`: việc đó cần `npm dist-tag add`, một lệnh ghi khác `publish` mà quyền trusted publisher chưa được chứng minh là cho phép. `next` vì vậy ở lại bản prerelease cuối; dời nó (hay dời `latest` khi publish không tự dời) là việc tay của owner, cần OTP. Registry paseo.cafe đọc `paseo-bm-plugin@latest`.
- Bản đã publish không lùi được (npm chặn `unpublish` sau 72 giờ): đường lùi là phát hành bản vá, và chính GitHub Release là điểm phê duyệt của người.

## 4. CLI `paseo-bm`

### 4.1 Lệnh

| Lệnh | Ý nghĩa |
|---|---|
| `paseo-bm` | Có TTY: wizard. Không TTY: in bản xem trước rồi thoát mã 6 |
| `paseo-bm install` | Cài hoặc cập nhật (cùng một đường mã). Mặc định chỉ xem trước; cần `--apply` mới ghi |
| `paseo-bm doctor` | Kiểm tra sức khoẻ. **Không ghi gì**, chỉ gọi lệnh Paseo chỉ-đọc (`daemon status`, `plugin ls`), không gọi CLI `skills`, không chạm mạng, không lấy khoá |
| `paseo-bm uninstall` | Gỡ đúng những gì hồ sơ ghi. Mặc định chỉ xem trước |
| `--version`, `--help` | (`-v`, `-h`) |

Không có lệnh `configure`: người dùng app đổi vai trò trên màn "Roles & models" (§7.3.6); người dùng terminal dùng `install --role … --reconfigure`.

### 4.2 Cờ

| Cờ | Lệnh | Ghi chú |
|---|---|---|
| `--apply` | install, uninstall | Không có thì chỉ xem trước |
| `--yes` | install, uninstall | Bỏ qua xác nhận áp dụng; **không** ngầm đồng ý ranh giới tin cậy nào |
| `--enable-plugins` | install | Đồng ý cả hai việc trong **một** ranh giới tin cậy: bật `pluginsEnabled` và `daemon.mcp.injectIntoAgents`. Gộp vì bật plugin mà không mở công cụ thì Manager không tạo được Worker |
| `--install-skills` | install | Đồng ý chạy CLI `skills` |
| `--install-beads-tools` | install | Đồng ý cài `br` và `bv` còn thiếu khi không có terminal (có terminal thì luồng tương tác làm việc này) |
| `--skills-agents <list>` | install, doctor | Agent đích cho CLI `skills`, mặc định `claude,codex`; khi dựng lệnh, `claude` được đổi thành `claude-code` (tên CLI `skills` 1.5.26 dùng) |
| `--role <role>=<provider>/<model>` | install | Lặp lại được, ví dụ `--role worker=codex/gpt-5.6-sol` |
| `--reconfigure` | install | Hỏi lại toàn bộ cấu hình vai trò |
| `--skip-skills-check` | install, doctor | Bỏ hẳn phần skills |
| `--force` | install, uninstall | Cài: ghi đè `user-modified` (luôn backup). Gỡ: xoá cả file `user-modified` (sau khi chép vào backup) |
| `--ask-skills-again` | install | Xoá ghi nhớ "đừng hỏi lại" của bước skills |
| `--restore-backups` | uninstall | Khôi phục file payload từ backup trước khi xoá |
| `--prune` | install | Dọn payload cũ và backup, **chỉ** khi người dùng yêu cầu; luôn giữ backup cấu hình Paseo mới nhất |
| `--home`, `--paseo-home`, `--claude-home`, `--codex-home` | tất cả | Hoặc biến môi trường tương ứng (`PASEO_BM_HOME`, `PASEO_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`) |
| `--json`, `--verbose` | tất cả | |

Thứ tự ưu tiên: cờ > biến môi trường > mặc định. `--skills-agents` và `--role` được kiểm **lúc phân tích tham số**, trước preflight và trước mọi thao tác ghi: `--skills-agents` mỗi phần tử khớp `^[a-z0-9][a-z0-9_-]{0,31}$`, tối đa 8, loại trùng, từ chối phần tử bắt đầu bằng `-`; `--role` phải là `<vai>=<provider>/<model>` với vai là một trong ba. Sai → mã 2 (`E_BAD_SKILLS_AGENTS`, `E_BAD_ROLE_SPEC`). Cặp provider/model không có trong Paseo được kiểm sau, khi đã có adapter: `E_PROVIDER_UNAVAILABLE`, mã 3, vẫn trước mọi thao tác ghi.

### 4.3 Mã thoát

| Mã | Ý nghĩa |
|---|---|
| 0 | Thành công, xem trước theo chủ đích, hoặc `doctor` báo khoẻ |
| 1 | `doctor` phát hiện sai lệch thuộc phạm vi sở hữu |
| 2 | Dùng sai lệnh/cờ (gồm `--skills-agents`, `--role` sai định dạng) |
| 3 | Tiền đề môi trường không đạt — chưa ghi gì (gồm provider/model của `--role` không có trong Paseo) |
| 4 | Đã cài nhưng ranh giới tin cậy chưa được đồng ý (plugin chưa bật, hoặc công cụ chưa mở) |
| 5 | Dừng vì xung đột cần người quyết định |
| 6 | Không TTY và không `--apply`: đã in bản xem trước, chưa ghi gì |
| 7 | Đã chép file và ghi hồ sơ, nhưng Paseo không cài/không nạp được plugin (`paseo plugin logs paseo-bm`) |

Cảnh báo về skills và beads tools không bao giờ đổi mã thoát.

### 4.4 JSON

Khi bật `--json`, stdout chỉ có đúng một tài liệu JSON; output của tiến trình con đi ra stderr.

```jsonc
{
  "schemaVersion": 1,
  "command": "install",              // install | doctor | uninstall
  "mode": "preview",                 // preview | applied
  "paseoBmVersion": "…",
  "paseo": { "cliVersion": "…", "daemonVersion": "…", "home": "…", "pluginsEnabled": false },
  "actions": [
    { "kind": "create", "target": "installHome/plugin/<ver>/roles/worker.md", "reason": "missing" },
    { "kind": "config", "target": "paseoHome/config.json#daemon.agentProfiles[bm-worker]", "from": null, "to": "…", "consent": "interactive" }
  ],
  "roles": [{ "role": "worker", "provider": "codex", "model": "gpt-5.6-sol", "paseoTools": true, "loggedIn": true }],
  "skills": { "source": "cuongntr/agent-skills", "required": ["…"], "byAgent": { "claude": { "present": [], "missing": [] } },
              "suggestedCommand": "npx -y skills add …", "assisted": false, "outcome": null },
  "warnings": [{ "code": "W_BEADS_CLI_MISSING", "message": "…" }],
  "result": { "exitCode": 0, "pluginState": "running" }
  // thất bại có mã: "result": { "exitCode": 3, "pluginState": null, "error": { "code": "E_TARGET_NOT_WRITABLE", "message": "…" } }
}
```

- `result.error` **chỉ có mặt khi thất bại** với một mã trong sổ đăng ký.
- `doctor` thay `actions[]` bằng `checks[]` gồm `{ id, severity: "ok" | "warn" | "error", message, remediation }`. Id là hợp đồng, đổi tên là thay đổi phá vỡ: `paseo-daemon`, `paseo-version`, `install-record`, `install-version`, `files-missing`, `files-modified`, `plugin-registered`, `plugin-status`, `plugin-path`, `plugins-enabled`, `agent-tools`, `role-bm-manager`, `role-bm-worker`, `role-bm-reviewer`, `roles.changed-in-app`, `payload-versions`, `backups`, `beads-cli`, `beads-viewer`.
  - `plugin-path` so thư mục Paseo đang nạp với thư mục phiên bản active trong `install.json` (lệch → `error`, Paseo không báo đường dẫn → `warn`); `install-version` báo `error` cả khi `version` của hồ sơ khác phiên bản active.
  - `agent-tools` là công tắc `daemon.mcp.injectIntoAgents`.
  - `roles.changed-in-app` mang severity `ok` (hợp đồng không có `info`), xuất hiện một lần cho mỗi vai có `extends` của alias hay `model` của profile khác `roles[]`, và không bao giờ nâng mã thoát.
- `uninstall` dùng `actions[]` với `kind: "delete" | "keep" | "config"`.

**Sổ mã lỗi của CLI** (`src/errors.ts`, một hằng số, có test chặn mã đặt tại chỗ; mỗi mục có thông điệp và cách khắc phục): `E_DAEMON_UNREACHABLE`, `E_VERSION_MISMATCH`, `E_UNSUPPORTED_OS`, `E_NODE_TOO_OLD`, `E_PASEO_CLI_MISSING`, `E_PASEO_OUTPUT_UNEXPECTED`, `E_CONFLICT`, `E_BAD_SKILLS_AGENTS`, `E_BAD_ROLE_SPEC`, `E_CONFIG_CONCURRENT_WRITE`, `E_RECORD_SCHEMA_TOO_NEW`, `E_LOCKED`, `E_PROVIDER_UNAVAILABLE`, `E_UNSAFE_INSTALL_HOME`, `E_PATH_ESCAPE`, `E_SYMLINK_IN_PATH`, `E_TARGET_NOT_WRITABLE` (ba mã chốt đường dẫn và mã này: thoát 3, chưa ghi gì), `E_PLUGIN_LOAD_FAILED` (thoát 7); cảnh báo `W_SKILLS_MISSING`, `W_SKILLS_ASSIST_FAILED`, `W_BEADS_CLI_MISSING`, `W_BEADS_VIEWER_MISSING`, `W_BEADS_TOOLS_INSTALL_FAILED`, `W_PROVIDER_NOT_LOGGED_IN`.

**Sổ mã lỗi của RPC plugin** (`DASHBOARD_ERROR_CODES` trong `plugin/shared/contracts.ts`; đi qua kênh RPC, không có mã thoát; thông điệp bắt đầu bằng mã): `E_TIMELINE_UNAVAILABLE`, `E_BEADS_STORE_UNREADABLE`, `E_TRACE_NOT_FOUND`, `E_TRACE_STORE_UNWRITABLE`, `E_TRACE_STORE_SCHEMA_TOO_NEW`, `E_TRACE_REASSIGN_INVALID`, `E_BEAD_NOT_FOUND`, `E_ROLE_EXTRA_INVALID`, `E_TOOL_PRESENT`, `E_TOOL_INSTALL_FAILED`, `E_ROLE_SETTINGS_INVALID`, `E_ROLE_SETTINGS_CONFLICT`, `E_ROLE_SETTINGS_WRITE_FAILED`, `E_FALLBACK_NOT_FOUND`, `E_FALLBACK_NOT_PENDING`, `E_FALLBACK_NO_CANDIDATE`, `E_FALLBACK_NO_RESET`, `E_FALLBACK_CREATE_FAILED`. `manager.ensure` ném `E_PROVIDER_UNAVAILABLE`.

### 4.5 Luồng cài và cập nhật

```
cli → preflight → record.load → hỏi vai trò + kiểm provider/model → planner → xem trước (gồm vai trò sẽ đăng ký)
  → xác nhận (mặc định "Không")
  → applier: plugin/<ver> (atomic, gồm roles/*.md) → hồ sơ tạm → đăng ký plugin (dưới)
  → pluginsEnabled / injectIntoAgents tắt? → cảnh báo tin cậy (một lần hỏi, hai hệ quả) → đồng ý? không → bỏ qua (mã 4)
       có → backup → sửa khoá → reload → xác minh
  → provider chưa đăng nhập? → mời chạy lệnh login của chính công cụ đó (Pi: in hướng dẫn, không có lệnh)
  → backup → ghi agents.providers.bm-* và daemon.agentProfiles[bm-*] (gộp, §6.1) → reload → xác minh
  → chốt install.json → skills: dò → thiếu → hiện đúng lệnh → đồng ý → chạy CLI skills → dò lại
  → beads tools (br, bv) thiếu → đề nghị cài → tóm tắt
```

- Câu hỏi vai trò và kiểm provider/model chạy **trước** bản xem trước, nên `E_PROVIDER_UNAVAILABLE` ra trước mọi thao tác ghi.
- "Đăng ký plugin trước, bật công tắc sau" là thứ tự hợp lệ: `paseo plugin install` thành công cả khi `pluginsEnabled` tắt, trả `status: "disabled"`. Luôn đọc `status`, không đọc `enabled`.
- **Đăng ký plugin theo phiên bản.** Paseo từ chối `plugin install` khi id đã cấu hình và không có lệnh đổi đường dẫn plugin thư mục (`update` chỉ cho Git). Vì vậy, đọc `paseo plugin ls --json` (thiếu thì lấy `paseo.pluginDir` của hồ sơ), so sau `path.resolve` (không `realpath`):
  - chưa cấu hình → `install <dir mới> --id paseo-bm`;
  - đã trỏ đúng thư mục mới → không gọi Paseo; nhưng nếu lượt này đã ghi ít nhất một file trong `plugin/<ver>` và plugin không `disabled` thì `paseo plugin reload paseo-bm --json` rồi chờ `running` (Paseo không nạp lại bundle khi file đổi tại chỗ);
  - trỏ thư mục khác → `remove paseo-bm` → `install <dir mới>`; lỗi → `remove` lần nữa (Paseo giữ mục của plugin không khởi động được, lỗi ở bước này bỏ qua) → `install <dir cũ>` → `E_PLUGIN_LOAD_FAILED` (mã 7) kèm nguyên văn lý do của Paseo (`error.message` của JSON lỗi, không có thì stderr) và kết quả đường lùi.
  - Thành công: `versions[].active` và `paseo.pluginDir` sang bản mới. Thất bại: hồ sơ giữ `pluginDir`/`active` cũ và ghi trả `version` cũ; payload mới vẫn nằm trên đĩa.
  - Không bao giờ restart/stop daemon, không sửa tay khoá `plugins`.
- **Luồng lỗi:** daemon không chạy / lệch phiên bản / thiếu CLI → dừng ở preflight, mã 3, chưa ghi gì. `plugin install` lỗi → giữ payload, không sửa `config.json`, in lệnh xem log. Plugin không `running` sau 30 giây → báo lỗi kèm lệnh log, hồ sơ ghi trạng thái thật, không tự tắt công tắc. Người dùng từ chối ranh giới tin cậy → vẫn cài xong, vai trò vẫn đăng ký, mã 4, `doctor` báo tiếp. Provider chưa đăng nhập → vai trò vẫn đăng ký, `W_PROVIDER_NOT_LOGGED_IN`. Thiếu `br` (beads CLI) hay `bv` → cảnh báo, không chặn; Worker gọi `br` trực tiếp trong workspace.

### 4.6 Gỡ cài đặt

`preflight nhẹ → đọc install.json → planner (chỉ đọc) → xem trước → xác nhận → paseo plugin remove → xoá mục bm-* trong agents.providers và daemon.agentProfiles (kể cả alias dự phòng) → trả daemon.mcp.injectIntoAgents về trạng thái trước nếu chính paseo-bm bật → xoá container config paseo-bm đã tạo mà nay rỗng → khôi phục backup nếu được yêu cầu → xoá payload theo versions[] → giữ file user-modified → hỏi tắt lại pluginsEnabled (chỉ khi chính paseo-bm bật và không còn plugin khác) → backup theo lựa chọn → install.json → báo cáo`.

- Chỉ duyệt thư mục `plugin/<version>` có trong `versions[]`. File không có trong hồ sơ được giữ và liệt kê.
- **Dữ liệu người dùng (§5.3) không bị chạm và không được liệt kê**: `traces/`, `ui/`, `role-extras.json`, `role-fallback.json`, `role-fallback-state.json` nằm lại.
- Daemon không chạy → vẫn xoá file, giữ `install.json` để lần sau hoàn tất phần Paseo.
- `paseo plugin remove` không xoá thư mục nguồn và để lại `plugins: {}`; khoá đó là của Paseo, paseo-bm không xoá.
- Không đụng agent đang tồn tại, skills, CLI `skills`, và mọi mục config không có tiền tố `bm-`. Không khôi phục nguyên file `config.json` từ backup (sẽ xoá mọi thay đổi sau lúc cài — ADR-006 QĐ8).

### 4.7 Tích hợp bên ngoài của trình cài

| Bên ngoài | Cách gọi | Lỗi |
|---|---|---|
| Paseo CLI | `daemon status\|reload --json`, `plugin install\|ls\|logs\|remove\|reload --json`, `provider ls\|models <p>\|diagnostic <p> --json` (chỉ lúc cài: kiểm vai trò và trạng thái đăng nhập), `--version`; tiến trình con, argv mảng, không shell, 15 giây mỗi lời gọi | Không tới được → dừng ở preflight, mã 3. JSON lạ → `E_PASEO_OUTPUT_UNEXPECTED` |
| Phiên bản Paseo | CLI và daemon phải cùng phiên bản và ≥ 0.8.0. Paseo 0.9.2 bỏ `cliVersion` khỏi `daemon status --json`: adapter lấy từ `paseo --version` | |
| `~/.paseo/config.json` | Đọc–sửa–ghi tối thiểu (§6.1); backup trước; reload sau; phát hiện ghi song song thì đọc lại và thử **một** lần | Lệch tiếp → `E_CONFIG_CONCURRENT_WRITE`, giữ bản của bên kia. Reload lỗi → khôi phục backup, reload lại, báo lỗi |
| CLI `skills` | Chỉ sau khi đồng ý; nguồn skills là hằng số trong gói (`cuongntr/agent-skills`); năm skill bắt buộc (`REQUIRED_SKILLS`, `src/skills/detect.ts`): `feature-workflow`, `reviewing-plan`, `converting-plan-to-beads`, `polishing-beads`, `implementing-beads` — thiếu thì `W_SKILLS_MISSING`; `architecture-premise-audit`, `authoring-workspace-protocol` chỉ là gợi ý, không bao giờ cảnh báo; chế độ symlink; in nguyên văn lệnh trước khi chạy; 300 giây, cảnh báo sau 60 giây không output; Ctrl+C chuyển tín hiệu cho tiến trình con, ghi `assistOutcome: "interrupted"` | Không chặn, không đổi mã thoát |
| Lệnh login của provider | Chỉ khi đồng ý; 300 giây | Thất bại → hướng dẫn thủ công; vai trò vẫn đăng ký; `W_PROVIDER_NOT_LOGGED_IN` |
| `br` / `bv` còn thiếu | Có terminal: nằm trong các thay đổi được áp (bản xem trước nêu đúng lệnh); không terminal: chỉ với `--install-beads-tools`. Có Homebrew → `brew install dicklesworthstone/tap/<tool>`; không thì script cài của dự án (`br` với `--skip-skills` để không ghi thư mục skills, `bv` ghim commit); 300 giây | Cảnh báo `W_BEADS_TOOLS_INSTALL_FAILED` kèm lệnh tay; không đổi mã thoát |

Chờ plugin `running`: tổng 30 giây, poll 500 ms. Không telemetry.

## 5. Dữ liệu trên đĩa

### 5.1 Thư mục cài đặt

```
~/.paseo-bm/                       (0700; --home hoặc PASEO_BM_HOME)
  install.json                     (0600) hồ sơ, nguồn sự thật về quyền sở hữu payload
  plugin/<ver>/                    payload từng phiên bản; bản cũ GIỮ LẠI, chỉ --prune xoá
  backups/<UTC>/                   paseo-config.json + file bị ghi đè có chủ đích
  .lock                            khoá của install/uninstall
  ── dữ liệu người dùng (§5.3) ──
  traces/                          (0700) kho lưu vết Dashboard: meta.json, <workspaceId>/{meta.json, events-<YYYYMM>.jsonl}
  ui/                              trạng thái bền của plugin: answer-marks.json, budget-told.json, qa-ledger.json, agent-tools.json
  role-extras.json                 (0600) chỉ dẫn bổ sung của người dùng cho từng vai
  role-fallback.json               (0600) chuỗi dự phòng và policy từng vai (§7.10)
  role-fallback-state.json         (0600) các sự cố dự phòng, tối đa 200
```

Plugin tìm thư mục cài đặt từ đường dẫn Paseo ghi khi đăng ký (`config.plugins["paseo-bm"].path` = `<home>/plugin/<ver>`, lùi hai cấp) và xác nhận bằng `install.json`; không chắc thì trả lý do thay vì ném, và các phần cần thư mục này tắt đi. Bundle server không dùng được `import.meta.url` (Paseo biên dịch thành CJS và fork không đặt cwd).

### 5.2 `install.json`

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `schemaVersion` | number | `1`; lớn hơn mức CLI hiểu → `E_RECORD_SCHEMA_TOO_NEW` |
| `version` | string | Phiên bản gói đã cài |
| `installedAt` / `updatedAt` | ISO 8601 UTC | |
| `installHome` | string | Đường dẫn tuyệt đối |
| `paseo.home` | string | Từ `paseo daemon status --json` |
| `paseo.pluginId` / `paseo.pluginDir` | string | |
| `paseo.pluginsEnabledSetByUs` | boolean | Căn cứ để lệnh gỡ đề nghị tắt lại |
| `paseo.pluginsEnabledPrevious` | `{ present, value }`, tuỳ chọn | Trạng thái trước lần bật đầu; ghi trước khi chạm `config.json`. Gỡ và người dùng chọn tắt lại: vắng → xoá khoá, `false` → `false`, chỉ khi giá trị hiện tại vẫn là `true`. Hồ sơ cũ không có trường này thì đặt `false` |
| `paseo.mcpInject` | `{ setByUs, previous: { present, value } }` | Phân biệt "vắng" với "`false`" để hoàn tác đúng (ADR-006 QĐ8) |
| `paseo.createdConfigContainers` | string[], tuỳ chọn | Container paseo-bm tự tạo, trong tập đóng `agents`, `agents.providers`, `daemon`, `daemon.agentProfiles`, `daemon.mcp`; chỉ ghi khi container chưa có, không bao giờ bớt. Gỡ: container trong danh sách mà nay rỗng thì xoá, từ trong ra ngoài |
| `roles[]` | `{ role, providerId, profileId, baseProvider, model, modeId, thinkingOptionId, paseoTools }` | **Lần ghi cuối của trình cài**, không phải cấu hình đang có hiệu lực (nguồn sự thật là cấu hình Paseo — ADR-008). Trình cài luôn ghi `modeId: null`, `thinkingOptionId: null` |
| `files[]` | `{ path, sha256, mode }` | Mọi file payload, gồm `roles/*.md` và `package.json` của payload |
| `versions[]` | `{ version, dir, installedAt, active }` | Giữ tất cả; chỉ `--prune` xoá |
| `backups[]` | `{ at, dir, reason }` | |
| `skills.agents[]` | string[] | |
| `skills.lastStatus` | `{ agent, skill, present }[]` | |
| `skills.assistDeclinedAt` | ISO \| null | "Đừng hỏi lại" |
| `skills.lastCommand` | string \| null | |
| `skills.assistOutcome` | `"ok" \| "failed" \| "interrupted" \| null` | |

Ghi atomic, `0600`, không chứa bí mật.

### 5.3 Phân loại quyền sở hữu

| Tình trạng | Điều kiện | Hành động mặc định |
|---|---|---|
| `unchanged` | có trong `files[]`, hash khớp | bỏ qua |
| `outdated` | hash khớp bản ghi cũ, khác bản mới | cập nhật |
| `user-modified` | hash không khớp bản ghi | giữ; hỏi khi tương tác; `--force` mới ghi đè, luôn backup |
| `conflict` | trên đĩa, không có trong `files[]` | bỏ qua, báo |
| `missing` | có trong `files[]`, không còn trên đĩa | tạo lại |
| `user-data` | `traces/`, `ui/`, `role-extras.json`, `role-fallback.json`, `role-fallback-state.json` | không hash, không backup, không so; cài, cập nhật, `--prune` và gỡ **đều không chạm** |

Nâng cấp luôn chép sang `plugin/<version mới>/` nên mọi đích là `missing`; ba trạng thái xung đột chỉ xảy ra khi cài lại cùng phiên bản, sửa chữa thư mục đang dùng, hoặc với chính `install.json`. `user-data` là dữ liệu tích luỹ do plugin tạo, không phải tài sản phiên bản; trình cài không tạo và không ghi vào đó. Dữ liệu trong `ui/` và `role-*.json` ghi atomic (file tạm → rename), `0600`, chặn symlink — trừ `ui/agent-tools.json` (chỉ chứa số cổng, §7.4: tạm → rename, quyền mặc định, không chặn symlink); file mang `schemaVersion` mới hơn plugin hiểu thì đọc như rỗng và **không ghi đè**; đọc không bao giờ sửa file.

## 6. Cấu hình Paseo

### 6.1 Phần paseo-bm ghi vào `config.json`

| Khoá | Ghi gì | Ai, khi nào |
|---|---|---|
| `pluginsEnabled` | `true` | Trình cài, có đồng ý (REQ-006) |
| `plugins` | Do **Paseo** ghi khi `paseo plugin install` | paseo-bm không tự ghi |
| `daemon.mcp.injectIntoAgents` | `true` | Trình cài, gộp chung một lần đồng ý với `pluginsEnabled`. Cảnh báo nêu đủ: plugin là mã không sandbox, và **mọi** agent trên máy được tạo, nhắc, dừng agent khác |
| `agents.providers.bm-manager` / `bm-worker` / `bm-reviewer` | `{ extends, label, paseoTools }`, không `command`, không `env`. Reviewer không bao giờ có `paseoTools` | Trình cài; plugin chỉ đổi `extends` (§7.3.6) |
| `agents.providers.bm-<vai>-fallback-<n>` (n = 1…3) | Manager/Worker: `{ extends, label: "<Role> (fallback <n>)", paseoTools: { enabled: true } }`; Reviewer: không `paseoTools`. Không có profile | Plugin, khi người dùng lưu chuỗi dự phòng |
| `daemon.agentProfiles[]` | Chỉ các mục `id` bắt đầu bằng `bm-`; mục khác và thứ tự giữ nguyên | Trình cài; plugin chỉ đổi `model` / `thinkingOptionId` / `modeId` của mục `bm-<vai>` đã có |

**Trình cài gộp, không thay nguyên.** Mục vai trò là `bm-manager`, `bm-worker`, `bm-reviewer`:

| Mục đã có | Cài/cập nhật không nêu vai đó | Cài có nêu vai đó (`--role`, `--reconfigure`, hoặc `roles[]` không có mục dùng được: lần cài đầu, provider đã ghi không còn trong Paseo) |
|---|---|---|
| alias `bm-<vai>` | giữ mọi khoá; chỉ bảo đảm `paseoTools.enabled === true` cho Manager và Worker (gộp vào `paseoTools` đang có, `disabledTools` còn nguyên); thiếu `extends` thì lấy từ `roles[]` | đặt `extends` và `label` mới; khoá khác giữ |
| profile `bm-<vai>` | giữ mọi khoá; chỉ bảo đảm `provider === "bm-<vai>"`; thiếu `model`/`name` thì lấy từ `roles[]` | đặt `name`, `model`; **xoá** `thinkingOptionId` khi model đổi (thinking thuộc về model); khoá khác giữ |
| alias `bm-<vai>-fallback-<n>` | không đụng | không đụng (không có cờ CLI cho chuỗi dự phòng) |
| chưa có | tạo từ `roles[]` | tạo từ lựa chọn mới |

Mục tạo mới: alias `{ extends, label, paseoTools?: { enabled: true } }`; profile `{ id, name, provider: "bm-<vai>", model, notes }` (`notes` là ghi chú "khi nào dùng" của vai), không bao giờ ghi `modeId`/`thinkingOptionId`. Chạy lại trên mục đã đủ khoá → không có thay đổi (idempotent). Gỡ xoá mọi mục có tiền tố `bm-`.

### 6.2 Plugin ghi cấu hình (`plugin/server/config-writer.ts`, ADR-008)

Chỉ khi người dùng bấm Lưu trên "Roles & models". Mọi lần ghi đi qua một mutex trong tiến trình và qua `config.patch` của SDK (khoá phẳng: `providers` là `agents.providers`, được gộp sâu; `agentProfiles` là `daemon.agentProfiles`, thay nguyên mảng; `removeProviders: string[]` xoá alias). Không bao giờ sửa file trực tiếp, không bao giờ gọi `daemon reload`.

Phạm vi: chỉ id bắt đầu bằng `bm-`; alias chính phải có sẵn và không bao giờ bị plugin xoá (`removeProviders` chỉ dành cho alias dự phòng); chỉ ba profile vai trò, và chỉ khi đã có. `agentProfiles` chỉ được gửi khi có sửa profile, nên lần lưu chuỗi dự phòng (chỉ alias) không đè được profile nào. Settings → Agent profiles của Paseo sửa cùng dữ liệu: sửa ở đó khi màn đang mở thì lần Lưu sau bị `E_ROLE_SETTINGS_CONFLICT`.

1. `config.get()` → tính `revision` = sha256 của JSON chuẩn hoá (khoá sắp xếp) gồm `{ providers: mọi mục bm-*, profiles: toàn bộ mảng agentProfiles }`. Khác `input.revision` → `E_ROLE_SETTINGS_CONFLICT`, không ghi.
2. Patch: `providers["bm-<vai>"] = { extends }`; `agentProfiles` = đúng mảng vừa đọc, chỉ thay mục `bm-<vai>` tại chỗ (`null` = xoá khoá). Profile `bm-<vai>` không có → `E_ROLE_SETTINGS_INVALID` ("run npx paseo-bm install first"): plugin không tạo mục vai trò.
3. `config.patch`. Lỗi → `E_ROLE_SETTINGS_WRITE_FAILED` kèm lời daemon.
4. Đọc lại, kiểm **chính mục `bm-*` vừa ghi**. Không khớp → `E_ROLE_SETTINGS_WRITE_FAILED`, không ghi lại.

Giới hạn đã chấp nhận: một thay đổi trong app rơi đúng giữa bước 1 và bước 3 bị lần ghi (thay nguyên mảng) trả về bản đã đọc, và **không phát hiện được**; plugin chỉ thu hẹp cửa sổ đó.

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
2. **Profile** (`applyRoleProfile`, Worker và Reviewer): `thinkingOptionId` của profile khi bên tạo không truyền và model của request (`config.model`, không thì phần sau dấu `/` đầu tiên) trùng model của profile hoặc không nêu; `featureValues` = `{ ...profile, ...bên tạo }` (bên tạo thắng). Profile tra theo alias thật của agent; alias dự phòng không có profile (thinking/mode của nó đến từ lần tạo). Manager không qua đây: `manager.ensure` tự truyền profile.
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
- `Worker skills`: plugin kiểm năm skill bắt buộc (§4.7) với thư mục skill của provider gốc của `bm-worker` (`claude` `$CLAUDE_CONFIG_DIR/skills`, mặc định `~/.claude/skills`; `codex` `~/.agents/skills` hoặc `$CODEX_HOME/skills`; `pi` `~/.pi/agent/skills`; `opencode` `~/.config/opencode/skill`): `all present.` hoặc ``missing `<tên>`, … — tell the user once, when you confirm the Worker, that it works with lower quality, and point to `npx paseo-bm doctor`.``. Provider gốc khác bốn provider này, hoặc không đọc được → không có dòng.
- Hai tra cứu mode và skill chạy song song. Runtime facts nằm ngoài bản nhúng, nên file `roles/*.md` và bản nhúng vẫn khớp từng byte.
- Agent đang sống mà dòng Runtime facts của nó đổi (người dùng đổi mode/provider của vai con) được báo bằng `BM-SETTINGS` (§7.5).

### 7.3 Manager (`manager.ts`)

**`manager.ensure { workspaceId }` → `{ agentId, created, otherManagerIds, modeNotice: string | null, toolsNotice?: string | null }`.**

- `findLiveManagers`: agent `roleOfAgent().role === "manager"` còn sống trong workspace, **bỏ** Manager có `bm.replacedBy` hoặc là agent của một sự cố Manager `switched`; xếp có nhãn trước, rồi mới nhất trước. Có → trả nó, `created: false`, các Manager còn lại trong `otherManagerIds` (báo, không bao giờ xoá). Manager bị người dùng xoá → lần sau tạo mới, không báo lỗi.
- Chưa có → đọc profile `bm-manager` (không có → `E_PROVIDER_UNAVAILABLE`, "re-run `npx paseo-bm`"), chọn mode rồi `createManager`.
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
- Cổng được lưu ở `~/.paseo-bm/ui/agent-tools.json` (`{ schemaVersion: 1, port }`) — luôn dưới install home **mặc định**, vì endpoint khởi động trước khi có handle Paseo; install home ở chỗ khác thì cổng không được lưu — và lấy lại ở lần chạy sau, nên agent đang sống giữ công cụ qua một lần nạp lại plugin. Cổng bị chiếm → cổng mới, agent cũ quay về viết tay. Endpoint không bao giờ tạo thư mục cài đặt. Lỗi → một dòng log, không có công cụ.
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

- Thiếu file hay thiếu vai → `{ policy: "ask", entries: [] }` (vẫn có thẻ với "Wait" và "I'll handle it"). File hỏng → dùng mặc định, log, màn cấu hình báo lỗi, và `roles.save-fallback` **từ chối ghi** bằng `E_ROLE_SETTINGS_INVALID` (không đè `patterns` người dùng sửa); không tìm được thư mục cài đặt → `E_ROLE_SETTINGS_WRITE_FAILED` ("run npx paseo-bm install"); khi lưu, khoá plugin không quản lý được giữ nguyên.
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

## 8. Plugin client (lối vào)

- Sidebar "Beads Manager" và Command Center (mở Manager của workspace hiện tại qua `manager.ensure`; mở Metric), hai slash command (§7.9), màn Settings "Beads Dashboard", bộ biến đổi và vẽ timeline cho thẻ chat, các workspace panel. Client không đọc được hệ thống file: mọi thứ cần đĩa đi qua RPC.
- Renderer của Paseo là Expo + `react-native-web`; mã client dùng primitive React Native, `useNativeDriver` phải là `false`. File trong `test/` không import `react-native` như một giá trị.
- Bố cục và hành vi màn hình: [Design Dashboard](./paseo-bm-dashboard.md).

## 9. Security và reliability

- **Ranh giới tin cậy 1 — bật plugin:** mã không sandbox. Đồng ý rõ ràng hoặc `--enable-plugins`; `--yes` không tính.
- **Ranh giới tin cậy 2 — chạy tiến trình ngoài:** CLI `skills`, lệnh login, cài `br`/`bv`. Argv mảng, không shell, in nguyên văn lệnh trước khi chạy, nguồn skills là hằng số.
- **Ranh giới tin cậy 3 — mở công cụ Paseo:** `daemon.mcp.injectIntoAgents` cho **mọi** agent trên máy quyền tạo, nhắc, dừng agent khác; gộp một lần hỏi với ranh giới 1; `doctor` hiển thị.
- **Phạm vi ghi của trình cài:** chỉ `<install home>/**` và các khoá ở §6.1; có test chứng minh không ghi ra ngoài, kể cả thư mục skills. Plugin ghi `ui/`, `traces/`, `role-*.json` trong install home, và `config.json` chỉ qua §6.2.
- **Chống thoát thư mục:** mọi đường dẫn `resolve` rồi kiểm nằm trong gốc cho phép; từ chối install home trùng/chứa `$HOME`, `~/.paseo`, thư mục cấu hình agent; `lstat` trước khi ghi, không đi xuyên symlink.
- **Bí mật:** không đọc, ghi, in credential; trong `~/.paseo` chỉ đọc `config.json`; che `PASEO_PASSWORD`, `PASEO_DAEMON_PASSWORD` và token dạng mật khẩu ở mọi kênh. Tin người dùng đi vào bàn giao, sổ hỏi–đáp, sự cố dự phòng và lưu vết đều qua bộ che bí mật. `listUsage` là daemon gọi bằng phiên của nó, chỉ sau một sự cố L1 của Claude/Codex khi policy khác `off`, một lần mỗi sự cố — ngoại lệ mạng duy nhất.
- **Quyền của agent:** Manager và Worker chạy ở mode không hỏi quyền của provider, nên ranh giới hành vi của chúng (không git, không phá, không ra ngoài workspace, không đọc bí mật, hỏi trước khi cài/mạng/migration/deploy) **chỉ còn trong chỉ dẫn vai**. Reviewer không bao giờ chạy mode `dangerous`/`planning` và không bao giờ tự duyệt (`auto_accept: false`); trên Pi không có lớp duyệt nào và trên OpenCode chạy với quyền agent OpenCode được chọn — ở hai trường hợp đó luật chỉ-đọc cũng chỉ còn trong chỉ dẫn. Alias Reviewer không bao giờ có `paseoTools`; ràng buộc "Reviewer không tạo agent" nằm trong chỉ dẫn (câu hỏi mở ở §13).
- **Endpoint công cụ:** chỉ `127.0.0.1`, từ chối `Origin` và `Host` lạ, giới hạn body; công cụ không có tác dụng phụ.
- **Tạo agent của plugin:** chỉ ở `manager.ensure`, `fallback.act` và chế độ Auto người dùng bật.
- **Atomic:** mọi file ghi qua tạm → `fsync` → `rename` (ngoại lệ `ui/agent-tools.json`, §5.3). **Idempotent:** chạy lại cùng phiên bản cho 0 Action. **Khoá:** `.lock` cho install/uninstall. **Ctrl+C:** file dở ở dạng tạm nên bị bỏ; payload chưa vào hồ sơ thì lần sau dọn.
- **Không tác vụ nền, không cron, không watcher.** Mọi thứ của plugin chạy theo sự kiện hay RPC. Ngoại lệ hẹp duy nhất: hẹn giờ "Wait" (§7.10).
- **Agent mồ côi / chết giữa chừng:** Worker còn chạy khi Manager đã bị xoá không bị ảnh hưởng và hiện ở nhánh gốc của cây; tài liệu và bead đã ghi vẫn hợp lệ; paseo-bm không tự dọn và không tự tạo lại Worker.
- Mọi thứ nhớ trong bộ nhớ tiến trình (hàng chờ, đếm `BM-FORMAT`, danh sách mode gần nhất, kết quả kiểm công cụ, nhãn đã gắn) mất khi plugin nạp lại; mỗi thành phần đã nêu đường lùi của nó.
- Yêu cầu rà soát trước bản phát hành: sửa `config.json` (trình cài và `config-writer.ts`), chạy tiến trình ngoài, phần plugin tạo agent (`manager.ts`, `fallback.act`).

## 10. Chỉ dẫn vai trò — cơ chế

- `plugin/roles/{manager,worker,reviewer}.md` là nguồn sự thật cho hành vi của ba vai: phân mức, khi nào dùng bead, khi nào review, cách hỏi, báo cáo, dừng. Tài liệu này không chép lại chúng.
- Chúng được đóng trong payload, có hash trong `install.json` như mọi file payload, và được nhúng vào bundle server lúc build (`npm run generate:role-instructions`). Nạp vào agent qua hook §7.2, không phụ thuộc việc người dùng đã cài skills.
- Paseo đưa `config.systemPrompt` tới từng provider một kiểu (Claude: `append` sau preset `claude_code`; Codex: `developerInstructions`; OpenCode: `system`); phân tích ở [research-20260918-instructions-by-model](./paseo-bm-research-20260918-instructions-by-model.md).
- Mọi nội dung dành cho agent viết bằng **tiếng Anh**. Tài liệu Worker tạo cho repo đích theo ngôn ngữ repo đó, mặc định tiếng Anh.
- `test/roles-content.test.ts` ghim nguyên văn chỉ những gì mã hay vai khác phụ thuộc (mẫu khối, tên nhãn, tên phase, thông điệp plugin mà vai phải nhận ra, câu trỏ tới Runtime facts) và kiểm các giới hạn cứng theo ý, trên khối `## RULES`.
- Quyền tự điều phối của Manager — tự đánh thức một Worker đang chờ khi kiểm chứng được điều kiện, tự trả lời câu hỏi chỉ hỏi một sự thật, giữ thứ tự khi hai Worker va nhau — là quyết định sản phẩm ở [ADR-011](../adr/ADR-011-manager-coordinates-workers.md) và [PRD REQ-025](../product/paseo-bm-prd.md#6-functional-requirements) (d)–(g); luật cụ thể chỉ nằm trong `manager.md`.
- Agent chỉ nhận chỉ dẫn lúc được tạo: agent đang sống giữ bản cũ tới khi người dùng tạo phiên mới; thay đổi chỉ dẫn phải ghi trong ghi chú phát hành.

## 11. Testing

- Vitest. Tích hợp chạy trên `$HOME` giả với `paseo`, `skills` giả trên `PATH` ghi lại argv; plugin test với Paseo SDK giả; không test nào chạm daemon thật. CI không chạy agent thật (không xác định, tốn tiền, cần đăng nhập).
- Tầng chính: unit (phân loại quyền sở hữu, hash, cờ/env, argv, JSON Paseo, che bí mật, hợp nhất `agentProfiles`); luồng install/doctor/uninstall; bất biến an toàn (không ghi ngoài install home và `config.json`, không ghi thư mục skills, không đọc credential); hợp nhất cấu hình trên fixture thật đã ẩn danh (mọi mục không `bm-` giữ từng byte); gián đoạn và idempotent; ma trận skills; hợp đồng RPC và các module server; nội dung chỉ dẫn; gói đã đóng (`smoke:packed`).
- Test không được treo cả tiến trình: một lời gọi đồng bộ bị chặn thì `testTimeout` của Vitest không cắt được (đã xảy ra với `mkdirSync(…, { recursive: true })` dưới `/proc` trên Linux). Đường dẫn "không ghi được" trong test được dựng bằng một **file thường đứng ở vị trí thư mục** trong thư mục tạm của test (`ENOTDIR` ngay trên mọi hệ điều hành, không phụ thuộc quyền root).
- Nghiệm thu điều phối trên daemon thật là thủ công, bắt buộc trước bản phát hành lớn; checklist và biên bản ở `docs/operations/`.

## 12. Tương thích

- `install.json` `schemaVersion` 1; mọi trường thêm sau là tuỳ chọn, hồ sơ cũ vẫn đọc được.
- Hợp đồng JSON và mã thoát của CLI là công khai: trong cùng major chỉ thêm, không đổi nghĩa.
- Văn bản khối `BM-REPORT` là hợp đồng đang được Dashboard, thẻ, trace và sổ hỏi–đáp tiêu thụ; đổi nó cần cập nhật mọi bên đọc và bộ đọc khoan dung.
- Kho lưu vết và các file `ui/` có lược đồ riêng đánh số độc lập; bản ghi mới chỉ thêm trường tuỳ chọn.
- Bản plugin cũ gặp alias `bm-*-fallback-*` không nhận ra vai của nó; lệnh gỡ của bản cũ vẫn xoá alias đó (luật tiền tố `bm-`).
- Khi Paseo đổi phiên bản: xem lại `requirements.paseo`, mức kiểm ở preflight, khoá cấu hình ở §6, hình dạng `daemon status --json` (0.9.2 đã bỏ `cliVersion`), và danh sách `TOOL_PROVIDERS`.

## 13. Câu hỏi mở

| ID | Câu hỏi | Owner | Status |
|---|---|---|---|
| Q-028 | Khi công tắc MCP toàn cục bật, `paseoTools` ở mức provider có thật sự tước công cụ của `bm-reviewer` không? Nếu không, "Reviewer không tạo agent" chỉ nằm ở chỉ dẫn (ADR-006 QĐ9) | hieu.nt10 | open |
| Q-025 | Một workspace đúng một Manager; người dùng cố tình tạo cái thứ hai thì xử lý gì ngoài "chọn cái có nhãn, mới nhất, và báo"? | hieu.nt10 | open |
| Q-039b | Lệnh gỡ xử lý kho lưu vết thế nào (hỏi riêng rồi xoá, hay luôn giữ), và tên cờ không tương tác (đề xuất `--purge-traces`). Hiện mã luôn giữ `traces/` | hieu.nt10 | open |
| Q-043 | `doctor` có báo kho lưu vết (số trace, dung lượng, lược đồ) không? | hieu.nt10 | open |

## 14. Revision History

| Date | Author | Change |
|---|---|---|
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
