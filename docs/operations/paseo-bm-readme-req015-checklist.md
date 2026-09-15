# Đối chiếu README với REQ-015 — paseo-bm

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-118-4s4.1` (WP-118) |
| Yêu cầu | [PRD REQ-015](../product/paseo-bm-prd.md) |
| Đối tượng kiểm | [`README.md`](../../README.md) ở gốc repo (tiếng Anh, dành cho người dùng npm và GitHub) |
| Ngày | 2026-09-15 |
| Nguồn đối chiếu | PRD REQ-015 và REQ-026(c); Technical Design §2.6 (errata bm-msy, bm-wq6), §3.4, §4.2–§4.4, §7, §8, §9 (errata bm-vey, bm-i52); `node dist/index.js --help` và help của `install`, `uninstall`, `doctor`; `src/exit-codes.ts`, `src/errors.ts`, `src/preflight.ts`, `src/skills/assist.ts`, `src/skills/detect.ts`, `src/commands/uninstall.ts`, `src/commands/prune.ts`, `src/commands/install/enable.ts`; biên bản nghiệm thu Phase 1a và điều phối lượt 4/5; bình luận trên bead |

## 1. Từng mục của REQ-015

| # | Mục REQ-015 | Đạt | Mục README |
|---|---|---|---|
| 1 | Yêu cầu hệ thống | [x] | **Requirements**: macOS/Linux, Node ≥ 22, Paseo CLI và daemon ≥ 0.8.0 cùng phiên bản, `paseo` trên PATH, beads CLI, provider đã đăng nhập, mạng |
| 2 | Lệnh cài một dòng | [x] | **Install**: `npx paseo-bm`, kèm `npx paseo-bm@next` cho bản prerelease |
| 3 | Bảng **mọi vị trí** paseo-bm ghi vào | [x] | **Everything paseo-bm writes**: bảng `~/.paseo-bm/**` (`plugin/<version>/`, `install.json`, `backups/`, `.lock`); bảng khoá trong `~/.paseo/config.json` (`pluginsEnabled`, `daemon.mcp.injectIntoAgents`, `agents.providers.bm-manager/bm-worker/bm-reviewer`, `daemon.agentProfiles[bm-*]`); file tạm `.config.json.*.tmp`; khoá `plugins` do Paseo ghi |
| 4 | Nêu rõ paseo-bm không tự ghi skills mà gọi công cụ chính thức khi được đồng ý | [x] | **Everything paseo-bm writes → What paseo-bm never writes**; **Agent skills → How paseo-bm helps** |
| 5 | Tham chiếu nguồn `https://github.com/cuongntr/agent-skills`, ghi nhận là repo của tác giả khác | [x] | **Agent skills**, gạch đầu dòng "Source" |
| 6 | Danh sách skills khuyến nghị | [x] | **Agent skills**: 5 skill bắt buộc và 2 skill tuỳ chọn, khớp `REQUIRED_SKILLS` / `OPTIONAL_SKILLS` |
| 7 | Lệnh cài thủ công tương đương | [x] | **Agent skills → How paseo-bm helps**: lệnh dựng đúng theo `skillsAddCommand` với agent mặc định (`claude` → `claude-code`) |
| 8 | Cảnh báo tin cậy plugin | [x] | **Before you install → 1. Plugin trust** |
| 9 | Cách cập nhật | [x] | **Updating**: phiên bản mới (`remove` + `install`, đường lùi, mã 7), cùng phiên bản (không hỏi gì, tự reload), file sửa tay, hạ cấp, `--reconfigure`, `--prune` |
| 10 | Cách gỡ | [x] | **Uninstalling** |
| 11 | Cách gỡ skills bằng công cụ của nó | [x] có lưu ý | **Agent skills → Removing skills**: gỡ bằng CLI `skills`, xem cú pháp qua `npx skills --help`. Tên lệnh con để gỡ **chưa xác nhận được** từ nguồn trong repo (xem mục 4) |
| 12 | Bảng mã thoát | [x] | **Exit codes and JSON output**: bảng 0 → 7, chép nguyên văn từ `src/exit-codes.ts` và `--help` |
| 13 | Xử lý sự cố thường gặp | [x] | **Troubleshooting** |

## 2. Các mục bead và plan v2 WP-118 yêu cầu thêm

| Mục | Đạt | Mục README |
|---|---|---|
| Cảnh báo quyền tạo agent (`injectIntoAgents` mở công cụ Paseo cho **mọi** agent) | [x] | **Before you install → 2. Agent-creation permission** |
| Một cảnh báo và **một** lần đồng ý cho cả hai công tắc; không tương tác chỉ có `--enable-plugins`; `--yes` không bao giờ là đồng ý | [x] | **Before you install**; **Install → Non-interactive install** |
| Chế độ quyền của agent con: Worker không hỏi quyền (Claude `bypassPermissions`, Codex `full-access`), Reviewer `auto`; ranh giới Worker chỉ còn nằm ở chỉ dẫn vai trò | [x] | **Before you install → 3. Sub-agent permission modes** |
| Skills cài kiểu symlink nên các agent dùng chung một bản | [x] | **Agent skills → How paseo-bm helps** |
| CLI `skills` là bên thứ ba, có kênh thu thập dữ liệu riêng | [x] | **Agent skills → How paseo-bm helps** |
| `--skills-agents` mặc định `claude,codex`, `claude` truyền thành `claude-code` | [x] | **Agent skills → How paseo-bm helps** |
| Vòng lặp điều phối: mở Manager từ sidebar/Command Center, Manager giao ngay Worker cùng workspace, Worker phân loại Nhỏ/Vừa/Lớn, bám feature-workflow tới implement, Reviewer theo lô | [x] | **Using it: the orchestration loop**, bước 1–6 |
| Lan can review/polish là hành vi, không phải chặn cứng | [x] | **Using it → Limits you should know about** |
| Worker không commit/push; hỏi trước phụ thuộc, mạng, migration | [x] | **Using it → Limits you should know about** |
| Chỉ người dùng lưu trữ hoặc xoá agent | [x] | **Using it**, bước 6 |
| Dừng Worker kéo theo dừng Reviewer đang chạy (thông báo dừng của plugin cộng quy tắc vai trò), không phải huỷ cứng, giới hạn Paseo 0.8 | [x] | **Using it → Limits you should know about** |
| `--json` có `result.error {code, message}` | [x] | **Exit codes and JSON output** |
| `--restore-backups` chỉ khôi phục file payload, không bao giờ cả file config | [x] | **Uninstalling** |
| Bỏ backup và tắt lại plugins chỉ hỏi được khi tương tác | [x] | **Uninstalling** |
| `--prune` giữ backup config Paseo mới nhất | [x] | **Updating** |
| `doctor` | [x] | **Checking health: `doctor`** |
| Sự cố: plugin không running (`paseo plugin logs paseo-bm`, `doctor`), daemon không chạy, thiếu skills, xung đột (mã 5), `E_PLUGIN_LOAD_FAILED` (mã 7), vai trò hoặc provider chưa đăng nhập | [x] | **Troubleshooting** |
| Không hứa tính năng Phase 2 (REQ-016, REQ-017, REQ-028 `configure`, REQ-029, REQ-030) | [x] | **Not available yet** |
| Chỉ mô tả hành vi đã kiểm chứng, không biến số đo thành cam kết | [x] | README không nêu số đo M-1 → M-18; lan can và dừng lan truyền được mô tả kèm giới hạn |

## 3. Đọc thử như người mới cài trên máy sạch

Đi lần lượt theo README, đối chiếu với `node dist/index.js install --help` và mã nguồn:

1. Đọc cảnh báo → đọc Requirements → mở app Paseo, kiểm `paseo --version`, Node ≥ 22. Đủ thông tin.
2. Gõ `npx paseo-bm` (hoặc `@next`) trong terminal thật. Thứ tự câu hỏi trong README khớp mã: cấu hình vai trò chạy trước bản xem trước (design §9.1 errata), rồi `Apply these changes?`, đăng ký plugin, câu hỏi tin cậy, lời mời đăng nhập provider, bước skills. Chuỗi câu hỏi được chép nguyên văn từ `APPLY_QUESTION`, `TRUST_QUESTION`, `SKILLS_QUESTION` và `uninstall.ts`.
3. Mở Paseo → sidebar **Beads Manager** / Command Center **Open Beads Manager** (khớp `plugin/index.client.tsx`) → chat.

Khoảng trống phát hiện khi đọc thử:

- **G-1: help của `install` lệch hành vi thật.** Help ghi `install` là "preview only without --apply", nhưng trong terminal `install` không có `--apply` vẫn hỏi `Apply these changes?` rồi ghi (`mayApply = flags.apply || interactive`, `src/commands/install/index.ts`). `uninstall` thì đúng là chỉ xem trước. README mô tả theo hành vi thật (bảng lệnh ghi "Without a terminal and without `--apply`, only previews"); **Đã sửa help text theo hành vi thật ở `bm-zj7`**; hành vi giữ nguyên vì đã được nghiệm thu Phase 1a (M-1).
- **G-2: gói chưa có trên npm.** Bead phát hành prerelease `bm-wp-118-4s4.2` chưa làm, nên người mới chưa chạy được `npx paseo-bm@next` lúc này. Ngoài ra chưa rõ `npx paseo-bm` (không tag) có tới được bản prerelease không khi chỉ publish dưới dist-tag `next`.
- **G-3: tên lệnh con gỡ skills.** Nguồn trong repo không ghi lệnh gỡ của CLI `skills`, và theo quy tắc an toàn không được chạy `npx` để xem. README chỉ trỏ tới `npx skills --help`.
- **G-4: model mẫu trong lệnh không tương tác.** README dùng chỗ trống `<model>` thay vì tên model cụ thể, vì danh sách model phụ thuộc Paseo trên máy người dùng.

## 4. Sự thật chưa xác nhận được từ nguồn

- Cú pháp lệnh gỡ skills của CLI `skills` (G-3).
- Quyền thư mục 0700/0600 của install home: design §3.1 có ghi, nhưng README không nêu vì chưa đối chiếu mã.
- Hành vi phân giải `npx paseo-bm` khi chỉ có bản dưới dist-tag `next` (G-2).
- Q-028 (design §13, còn open): công tắc MCP toàn cục có thật sự tước công cụ Paseo của `bm-reviewer` không. README chỉ nói Reviewer "is not granted Paseo tools" theo cấu hình vai trò; nghiệm thu lượt 4 ghi 0 lần Reviewer gọi công cụ agent, nhưng đó là quan sát.
- Repo chưa có file `LICENSE` dù `package.json` khai `MIT`; README chỉ trỏ tới `package.json`.
