# Biên bản cài trắng 0.4.0-alpha.0 — daemon cô lập, 2026-09-26

| Trường | Giá trị |
|---|---|
| Ngày | 2026-09-26 |
| Người chạy | Claude, theo yêu cầu của hieu.nt10 ("release và test đi cho chắc chắn … test cần kỹ càng chuẩn chỉ") |
| Paseo | CLI và daemon 0.9.2 (Paseo.app) |
| Bản thử | cây làm việc của nhánh `feat/single-source-040` sau các sửa ở §3, đóng gói bằng `npm pack` (cả `paseo-bm` và `paseo-bm-plugin`, `0.4.0-alpha.0`) |
| Kết luận | **Đạt**, sau ba lỗi tìm ra và sửa trong lần chạy (§3). Còn hai điểm ghi nhận không chặn (§4). Vòng lặp lại trên gói npm thật sau khi publish ghi ở §5 |

## 1. Cách dựng

Không đụng máy thật: `~/.paseo/config.json`, `~/.paseo-bm` và thư mục skills thật không đổi (kiểm bằng mtime cuối buổi); daemon thật ở cổng 6767 chạy suốt.

- **Daemon cô lập:** `paseo start --home <tạm>` với `config.json` tối thiểu (`listen` cổng riêng 6869–6874, relay tắt, `pluginsEnabled: true`), mỗi vòng một home. Biến `PASEO_HOME` truyền xuống daemon, nên lệnh `paseo` mà plugin chạy bên trong (`paseo-cli.ts`) cũng trỏ về daemon cô lập.
- **Registry npm thử:** Paseo chỉ nhận `npm:<tên>[@spec]` (không nhận file `.tgz`) và chạy `npm install` trong thư mục cài, nên daemon được khởi động với `npm_config_registry` trỏ vào một server nhỏ. Server trả packument **thật** của npm cộng phiên bản cục bộ (`package.json` lấy từ tarball) và dist-tag `next` = `0.4.0-alpha.0`, `latest` giữ `0.3.1` — đúng trạng thái registry sau khi publish prerelease; mọi gói khác chuyển thẳng lên registry.npmjs.org.
- **Dữ liệu:** vòng dùng HOME thật (để provider đăng nhập được) đặt `PASEO_BM_HOME` vào thư mục tạm; vòng chuyển đổi dùng HOME giả (đăng nhập Claude/Codex gắn với HOME thật nên agent không chạy được ở đó — các vòng đó chỉ kiểm cơ chế).
- **Thao tác như app:** RPC plugin qua `DaemonClient.invokePluginRpc`, tin nhắn người dùng qua `sendAgentMessage` có `messageId` (mang `clientMessageId`).

## 2. Kết quả theo mục

| # | Mục | Kết quả | Bằng chứng |
|---|---|---|---|
| S1 | `npm run verify` trên cây sạch | đạt | 107 file, 2809 test |
| S2 | `npm run smoke:packed` | đạt | mọi mục `ok` |
| S3 | Quét bảo mật của paseo.cafe (`scripts/plugin-security/static-scan.ts` bản `main`), gốc tarball npm và nguồn Git `path: plugin` | đạt | 0 blocking, 0 advisory; 104 file, 1 341 316 byte (giới hạn 2 000 000) |
| T1.1 | `paseo plugin add npm:paseo-bm-plugin@next --json`, không TTY | đạt | không hỏi tin cậy; không bật `pluginsEnabled` (daemon có công tắc tắt: `status: "disabled"`, công tắc vẫn `false`); `{ id, path, enabled, status: "running", installation: { identity: { kind: "npm", packageName: "paseo-bm-plugin", pluginPath: "." }, currentRevision } }`; log `Loading plugin` → `Plugin ready` |
| T1.2 | Mở Beads Manager khi công cụ agent còn tắt | đạt (sau sửa L1) | vai trò được tạo (`claude · claude-opus-5-5`), **không** tạo Manager, `E_PROVIDER_UNAVAILABLE` với câu chỉ tới nút |
| T1.3 | Setup: `setup.status` | đạt | vai trò đủ, `agentTools` tắt, đăng nhập claude `logged-in`, `dataHome.source: "env"`, `br`/`bv` thấy |
| T1.4 | `setup.grant-agent-tools` | đạt | thiếu `confirmed` → từ chối; có → `injectIntoAgents: true`, `setup-state.agentTools = { setBy: "plugin", previous: false }` |
| T1.5 | Việc Medium có Reviewer, đầu cuối (Claude) | đạt | Manager tạo Worker bằng `create_agent`; 2 bead tạo và đóng; Reviewer (`auto`) không có finding; 10/10 test; `BM-REPORT` qua endpoint MCP của plugin; Manager tóm tắt đúng |
| T1.6 | RPC của Dashboard, Beads, Metric | đạt | `workspaces.overview`, `traces.workspaces`, `traces.list`, `traces.get` (tier, beads, usage, 12 bước), `beads.list`, `agents.list`, `roles.*`, `chat.*`, `fallback.incidents` trả lời không lỗi |
| T2.1 | Chuyển Worker và Reviewer sang Codex (`roles.save-settings`) rồi giao việc mới | đạt (sau sửa L3) | Worker Codex `gpt-5.6-sol` `full-access`, Reviewer Codex `auto`, 12/12 test |
| T2.2 | Hook sửa model cũ | đạt | `paseo run --provider bm-worker/claude-opus-5-5` → agent chạy trên `gpt-5.6-sol`, log `bm-worker was asked for model "claude-opus-5-5", but its profile names "gpt-5.6-sol"` |
| T2.3 | `paseo plugin update paseo-bm` (Q-046) | đạt | thư mục `<uuid>` mới, thư mục cũ bị xoá, dữ liệu giữ nguyên |
| T2.4 | `paseo plugin update` trên bản cài từ `@next` | **ghi nhận** | Paseo đề xuất bản `latest` (`0.3.1`) — hạ phiên bản; release notes nay dặn `--version next` (L2) |
| T3.1 | Cài `paseo-bm@0.3.1` thật (HOME giả) | đạt | cài thư mục, `install.json` schema 1, `injectIntoAgents` bật |
| T3.2 | Xem trước chuyển đổi, không TTY, không `--apply` | đạt | thoát 6, không ghi gì |
| T3.3 | `npx paseo-bm@next --apply` (tình huống A, home mặc định) | đạt | thoát 0, `migrated`, plugin `running` từ npm; `config.json` chỉ đổi `plugins.paseo-bm.path`; `install.json` schema 2 + `migratedTo`; `agentTools` mang sang (`setBy: "installer"`) |
| T3.4 | Plugin mới đọc dữ liệu cũ | đạt | `traces.workspaces` thấy workspace của 0.3.1; Manager cũ được mở lại |
| T3.5 | Chạy lại chuyển đổi | đạt | `already-npm`, thoát 0, 0 hành động |
| T3.6 | `npx paseo-bm@0.3.1 install --apply` sau chuyển đổi (REQ-070 e) | đạt | thoát 3, `E_RECORD_SCHEMA_TOO_NEW`, `config.json` không đổi |
| T4.1 | Bản 0.3.1 cài với `--home`, chuyển không `--home` | đạt | thoát 5, `not-ours`, `E_CONFLICT` gợi ý `--home` (tình huống C) |
| T4.2 | Chuyển với `--home` | đạt | thoát 0; ghi `~/.paseo-bm/home.json`; plugin báo `dataHome.source: "pointer"` |
| T5 | Nút Install skills (HOME giả) | đạt | lệnh hiện nguyên văn, thoát 0, thiếu bắt buộc claude/codex 5 → 0; chỉ ghi trong HOME giả |
| T6 | Gỡ cấu hình có xoá dữ liệu, nạp lại, gỡ plugin | đạt | mục `bm-*` hết, công tắc `restored` về `false`; xoá đúng file plugin tạo, giữ `ui/setup-state.json` và phần của trình cài; nạp lại → `skipped: "cleaned-up"`; `plugin remove` sạch |

## 3. Lỗi tìm ra và đã sửa trong lần chạy

- **L1 — Manager tạo khi công cụ agent còn tắt không bao giờ có công cụ Paseo.** Thứ tự tự nhiên của người mới: mở Beads Manager → thấy nhắc → bấm Allow agent tools → quay lại chat. Manager đó chỉ nhận công cụ lúc được tạo; nó tự chế `paseo run` trong shell để tạo Worker (chạy được nhờ may, không theo chỉ dẫn). Sửa: `manager.ensure` không tạo Manager khi công tắc tắt (design §7.3, §7.13.2; PRD REQ-031 c).
- **L2 — `paseo plugin update` trên bản `next` hạ về `0.3.1`.** Không sửa được ở phía plugin (Paseo theo `latest`); release notes của prerelease dặn `--version next`.
- **L3 — Worker hỏng ngay lượt đầu sau khi đổi provider trên Setup.** Manager đọc profile một lần rồi nhớ: sau khi Worker chuyển sang Codex, Manager vẫn xin `bm-worker/claude-opus-5-5` và Codex từ chối model. `BM-SETTINGS` chỉ mang dòng mode. Sửa: hook `before("agent.create")` đổi model của Worker/Reviewer về model của profile (design §7.2).
- Kèm theo: `notes` của profile Worker mô tả cách làm theo cỡ việc (design §6.1).

## 4. Ghi nhận không chặn

- JSON của lệnh chuyển đổi luôn ghi `paseo.pluginsEnabled: false` (`src/commands/migrate.ts` không đọc công tắc đó mà điền cứng). Sai sự thật trong một trường hợp đồng, nhưng không lệnh nào đọc nó; sửa là đổi hợp đồng `--json` của bản CLI cuối cùng, nên để nguyên và ghi ở đây.
- Thông điệp `E_RECORD_SCHEMA_TOO_NEW` của 0.3.1 khuyên `npx paseo-bm@latest`; trong thời gian prerelease `latest` vẫn là `0.3.1`, nên người dùng cần `@next`. Hết khi `0.4.0` lên `latest`.
- Log daemon có `Agent MCP transport error … Unsupported protocol version: 2026-07-28` từ endpoint MCP của **Paseo** (không phải của paseo-bm); agent vẫn dùng được công cụ Paseo.

## 5. Vòng trên gói npm thật

Chạy lại sau khi publish, ghi bổ sung vào mục này.
