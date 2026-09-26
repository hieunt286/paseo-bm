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

## 5. Vòng trên gói npm thật (`0.4.0-alpha.0` trên `next`)

Publish: commit `3e64f5e`, CI run 36219007086, diễn tập 36219071445, release run 36219193860; cả hai gói `0.4.0-alpha.0` trên `next` có SLSA provenance v1, `latest` giữ `0.3.1`. Daemon cô lập **không** có registry thử: npm đọc thẳng registry.npmjs.org.

| # | Mục | Kết quả | Bằng chứng |
|---|---|---|---|
| R1.1 | `paseo plugin add npm:paseo-bm-plugin@next` | đạt | `resolved` = `https://registry.npmjs.org/paseo-bm-plugin/-/paseo-bm-plugin-0.4.0-alpha.0.tgz`, `integrity` khớp `npm view … dist.integrity`; `running` |
| R1.2 | Mở Manager khi công cụ agent tắt → bấm cho phép → mở lại | đạt | lần đầu `E_PROVIDER_UNAVAILABLE` với câu chỉ tới nút; lần sau Manager được tạo |
| R1.3 | Việc Medium có Reviewer (Claude) | đạt | 2 bead tạo và đóng, Reviewer `auto` pass, 5/5 test, báo cáo `finished` |
| R1.4 | Đổi Worker/Reviewer sang Codex, Manager cũ, việc mới không nêu model | đạt | Manager gọi `create_agent` với `bm-worker/claude-opus-5-5`; plugin log `… starting it on "gpt-5.6-sol"`; Worker Codex `full-access`, Reviewer Codex `auto`, 7/7 test. Hook cũng đưa một Reviewer xin model `default` về model của profile |
| R2.1 | `paseo plugin add npm:paseo-bm-plugin@next` đè lên bản cài thư mục `0.3.1` | đạt | Paseo từ chối: `Plugin ID "paseo-bm" is already configured; choose another ID with --id` |
| R2.2 | `npx paseo-bm@next --apply` | đạt | thoát 0, `migrated`, plugin npm `running` |
| R2.3 | `npx paseo-bm@0.3.1 install --apply` sau đó | đạt | thoát 3 |
| R2.4 | `npx paseo-bm` không phiên bản | ghi nhận | vẫn ra `0.3.1` cho tới khi bản ổn định lên `latest` |
| R3 | Quét bảo mật paseo.cafe trên tarball tải từ npm | đạt | 0 blocking, 0 advisory |

**Ghi nhận về hành vi Manager (có từ 0.3.x, không mới ở 0.4.0):**

- Sau khi nhận `BM-REPORT` (tiếng Anh, đến như một tin `user_message`), Manager chuyển sang trả lời tiếng Anh dù người dùng viết tiếng Việt. Sửa ở `0.4.0`: `roles/manager.md` nói rõ ngôn ngữ của người dùng là ngôn ngữ người dùng gõ, báo cáo hay thông báo không đổi nó.
- Một lần Manager nhắc với người dùng về connector Canva của claude.ai (thông báo connector nạp vào phiên Claude Code), dù chỉ dẫn đã cấm; để nguyên, theo dõi ở lần nghiệm thu sau.

## 6. Tiền kiểm bản ổn định `0.4.0` (registry thử, `latest` = `0.4.0`)

| # | Mục | Kết quả | Bằng chứng |
|---|---|---|---|
| P1 | Cài `@next` (bản thật `0.4.0-alpha.0`) rồi `paseo plugin update paseo-bm` không cờ | đạt | `--check` nhắm `0.4.0`; `updated`, `running`, `currentRevision: 0.4.0` |
| P2 | `npx paseo-bm --version` không phiên bản | đạt | `0.4.0` |
| P3 | Quét bảo mật paseo.cafe trên tarball `0.4.0` | đạt | 0 blocking, 0 advisory |
| P4 | Việc Medium có Reviewer, Manager mới (`bm.version` `0.4.0`) | đạt, kèm ghi nhận | chạy đủ, 3 bead, Reviewer pass; **Manager trả lời tiếng Anh ngay câu đầu** dù người dùng viết tiếng Việt |
| P5 | Thí nghiệm ngôn ngữ: cùng yêu cầu tiếng Việt, system prompt thật chỉ khác đoạn "How you talk" (A = lời 0.3.x, B = lời 0.4.0), 3 lượt mỗi bên, Worker bị dừng ngay | ghi nhận | 6/6 câu trả lời đầu bằng tiếng Việt. P4 là một lần trượt ngẫu nhiên của model, không do lời mới; lời mới giữ lại vì nhắm đúng tình huống đã thấy (chuyển ngôn ngữ sau `BM-REPORT`), và được theo dõi ở lần nghiệm thu sau |

## 7. Nghiệm thu bản ổn định `0.4.0` trên registry thật

Publish: commit `d910795` trên `main`, CI run 36220348210, diễn tập 36220407516 (dry-run nêu dist-tag `latest` cho cả hai gói), release run 36220562608. `npm view`: cả hai gói `latest` = `0.4.0`, `next` = `0.4.0-alpha.0`, SLSA provenance v1.

| # | Mục | Kết quả | Bằng chứng |
|---|---|---|---|
| F1 | `paseo plugin add npm:paseo-bm-plugin` (không tag) trên daemon mới | đạt | `currentRevision: 0.4.0`, `resolved` từ registry.npmjs.org, `integrity` khớp `npm view` |
| F2 | Mở Manager khi công cụ agent tắt → cho phép → việc Medium có Reviewer | đạt | từ chối có hướng dẫn, rồi Worker, 3 bead, Reviewer pass, 4/4 test; Manager trả lời tiếng Việt suốt, kể cả sau `BM-REPORT` |
| F3 | Bản cài thư mục `0.3.1` → `npx paseo-bm --apply` (không phiên bản) | đạt | `paseoBmVersion: 0.4.0`, `migrated` sang `npm:paseo-bm-plugin@0.4.0`, plugin `running` |
| F4 | Cài `@next` (`0.4.0-alpha.0`) → `paseo plugin update paseo-bm` không cờ | đạt | `updated`, `running`, `0.4.0` |
| F5 | `scripts/validate-registry.ts` của paseo.cafe (bản `main`) trên mục `registry/paseo-bm.json` hiện có | đạt | `✓ 1 registry entry validated OK.` |
| F6 | `scanNpmTarget` của paseo.cafe trên `paseo-bm-plugin@latest` | đạt | `status: passed`, 0 blocking, 0 advisory, 104 file, 1 341 316 byte |

Máy thật không đổi suốt buổi: `~/.paseo/config.json` giữ mtime 09:57, `~/.paseo-bm` không có file mới, daemon thật ở 6767 chạy liên tục.

