# Biên bản nghiệm thu Phase 1a trên daemon thật — 2026-09-15

| Trường | Giá trị |
|---|---|
| Status | PASS |
| Date | 2026-09-15 |
| Người chạy | hieu.nt10 (thao tác trong terminal) · Claude (chuẩn bị, chấm, sửa lỗi) |
| Checklist | [paseo-bm-phase1a-checklist.md](paseo-bm-phase1a-checklist.md) |
| Bead | `bm-wp-120-b2e.1.2` |
| Máy | macOS, Paseo CLI/daemon 0.8.0, Node v26.8.2, npm 11.19.1 |
| Bằng chứng | `~/bm-acceptance/20260915/phase1a/evidence-attempt1` … `evidence-attempt5`, `evidence` (lượt đo lại M-2) — ngoài repo |

## 1. Kết luận

**PASS.** M-1 → M-9 đều đạt ngưỡng: M-1, M-3 → M-9 ở lượt 5 (commit `520b90f`), M-2 ở lượt đo lại (commit `86c8caf`). Máy được trả về đúng trạng thái trước khi chạy: `~/.paseo/config.json` khớp từng khoá bản gốc (bỏ qua khoá `plugins` do Paseo giữ), không còn plugin `paseo-bm`, không còn file tạm.

Nghiệm thu thật đã làm đúng việc của nó: tìm ra **10 lỗi** mà test giả lập không bắt được. Tất cả đã được sửa, có test hồi quy và CI xanh trước khi chạy lại.

## 2. Các lượt chạy

| Lượt | Commit | Kết quả | Phát hiện |
|---|---|---|---|
| 1 | `4ffc74f`… | Không dùng làm bằng chứng | Hướng dẫn dùng `\| tee` làm mất TTY: không hỏi gì, lệnh `--apply` cài với mặc định. Sửa quy trình: chạy lệnh tương tác qua `script -q` |
| 2 | `36993ad` | Dừng ở A3 | `bm-dnc` plugin không nạp (`Invalid URL`); `bm-lev` tên vai trò bị reset; `bm-ym3` doctor đọc sai `paseoTools`; `bm-zxa` CLI skills lỗi 127; `bm-os3` (không tái hiện được) |
| — | `6561936` | Kiểm tay trên daemon (owner cho phép) | Sau khi hết `Invalid URL`, daemon báo `Plugin server bundle must default export a function` → sửa export mặc định dạng hoisted; bản tạm `paseo-bm-verify` đạt `running` rồi gỡ |
| 3 | `6561936` | Dừng ở A3 | `bm-ozd` Codex skills nằm ở `~/.agents/skills` nhưng paseo-bm chỉ dò `~/.codex/skills` |
| 4 | `aa9f135` | Không dùng cho M-1/M-9 | HOME sạch không có `.claude`/`.codex` nên bước skills bị bỏ qua; CLI provider tạo `.codex` giữa chừng. Sửa quy trình: tạo sẵn thư mục agent. Lượt này lộ `bm-d3q` (cập nhật prerelease mã 5) và `bm-tm2` (gỡ để lại `pluginsEnabled: false` và container rỗng) |
| 5 | `520b90f` | M-1, M-3 → M-9 đạt | `bm-vey` cập nhật mã 7 (Paseo từ chối `install` khi id đã cấu hình); `bm-p48` doctor không thấy plugin chạy từ thư mục cũ |
| Đo lại M-2 | `86c8caf` | M-2 đạt | — |

## 3. Chỉ số

| Chỉ số | Ngưỡng | Số đo | Đạt | Bằng chứng |
|---|---|---|---|---|
| M-1 | 1 lệnh, đúng 3 xác nhận | 3: `Apply these changes?`, `Enable Paseo plugins and grant Paseo tools to agents?`, `Run the skills CLI now…?` | ✅ | `evidence-attempt5/install-1.log` |
| M-2 | ≤ 60 s | `real 7.97` (cập nhật `0.1.0-alpha.0 → 0.1.0-alpha.1`, không tương tác, exit 0, plugin chạy từ `plugin/0.1.0-alpha.1`) | ✅ | `evidence/update.time`, `update.json`, `plugins.after-update.json`, `doctor-2.json` |
| M-3 | 0 thay đổi khi chạy lại | Không câu hỏi nào; `26 actions: 26 skip`; `--apply --json` 0 Action khác skip, 0 cảnh báo; hash `config.json` và install home không đổi | ✅ | `evidence-attempt5/install-rerun.log`, `install-rerun.json`, `*.rerun-*.sha256` |
| M-4 | 0 ghi ngoài phạm vi | Bộ test `integration/install` (guard chặn ghi toàn tiến trình) xanh trên các commit nghiệm thu; lượt thật không có ghi sai chỗ; room-* không đổi | ✅ | CI `34958576114`, `34960353287` |
| M-5 | 0 thứ còn sót sau gỡ | Install home đã xoá; không `bm-*`; không plugin; không `.config.json.*.tmp`; `config.json` bỏ `plugins` khớp bản gốc; `pluginsEnabled` về lại vắng mặt; `injectIntoAgents` giữ `true` như trước | ✅ | `evidence-attempt5/config.after-uninstall.json`, `plugins.after-uninstall.json`, `paseo-home-listing.txt`; lượt đo lại cũng sạch |
| M-6 | 100% ma trận CI | 4/4 job (ubuntu, macOS × Node 22, 24) gồm smoke trên gói đã đóng gói | ✅ | CI `34958576114` (`520b90f`), `34960353287` (`86c8caf`) |
| M-7 | `running` | `paseo-bm` status `running` sau cài và sau cập nhật | ✅ | `evidence-attempt5/plugins.after-install.json`, `evidence/plugins.after-update.json` |
| M-8 | 100% ma trận dò skills | `npm test -- skills-detect` xanh (thêm ma trận Codex dùng thư mục chung) | ✅ | CI các commit trên |
| M-9 | Đủ skills sau hỗ trợ | CLI skills chạy thật (`assistOutcome: ok`); `skills-agents`, `skills-claude`, `skills-codex` đều `ok` với đủ 5 skill | ✅ | `evidence-attempt5/doctor-after-install.json` |

Kiểm bổ sung theo điều kiện ra của WP-120:

| Kiểm | Kết quả |
|---|---|
| `doctor` báo đủ ba vai trò và quyền công cụ | `role-bm-manager`, `role-bm-worker`, `role-bm-reviewer`, `agent-tools` đều `ok` (lượt 5) |
| Độ trễ `doctor` ≤ 5 s | 4,78 / 3,27 / 2,88 s khi chạy thẳng bản đã cài (lượt 3). Qua `npx` chậm hơn (21 / 13 / 5 s) do `npx` tự dò gói, không phải paseo-bm |
| room-* không đổi | Máy này không có mục `room-*`; test tự động `role-registration` (fixture 6 provider + 6 profile) xanh |
| Công tắc MCP về trạng thái trước | `pluginsEnabled` vắng mặt như trước; `injectIntoAgents` `true` như trước |
| Sau gỡ `doctor` báo chưa cài | `install-record warn: paseo-bm is not installed here` |

## 4. Lỗi tìm ra và bản sửa

| Bead | Lỗi | Nguyên nhân | Commit |
|---|---|---|---|
| `bm-dnc` | Plugin không nạp: `Invalid URL`, rồi `must default export a function` | Paseo 0.8 bundle CJS, fork không `cwd`; interop "eager" copy default export đặt muộn | `5598b29`, `6561936` |
| `bm-lev` | Tên vai trò người dùng bị reset khi chạy lại | `roles[]` không lưu tên, tái dùng đặt tên mặc định | `5598b29` |
| `bm-ym3` | doctor báo lỗi vai trò giả | So `paseoTools === true` thay vì `{ enabled }` | `5598b29` |
| `bm-zxa` | CLI skills lỗi 127 | Thừa hưởng `npm_config_package` từ `npx` bên ngoài | `5598b29` |
| `bm-os3` | Cảnh báo in lặp | Không tái hiện được (hai lệnh liên tiếp); khoá bằng test | `5598b29` |
| `bm-ozd` | Codex vẫn báo thiếu skills, chạy lại vẫn hỏi | CLI skills 1.5.26 cài Codex (agent universal) vào `~/.agents/skills` | `aa9f135` |
| `bm-d3q` | Cập nhật giữa hai prerelease dừng mã 5 | So phiên bản bỏ qua định danh prerelease | `df37025` |
| `bm-tm2` | Gỡ để lại `pluginsEnabled: false` và `agents.providers: {}` | Hồ sơ chỉ lưu boolean; không dọn container | `520b90f` |
| `bm-vey` | Cập nhật mã 7 | Paseo 0.8 từ chối `install` khi id đã cấu hình; không có lệnh đổi đường dẫn | `86c8caf` |
| `bm-p48` | doctor báo ổn khi plugin chạy thư mục cũ | Không so đường dẫn plugin với phiên bản active | `86c8caf` |

Việc tồn đọng không chặn: `bm-6uy` (P3, `--role` khi chạy lại đặt lại tên vai trò đó), `bm-izm` (P2, test hạn giờ `paseo-adapter` chập chờn khi máy tải nặng).

## 5. Bài học quy trình (đã ghi vào checklist)

- Lệnh tương tác phải chạy qua `script -q`, không qua `| tee`.
- Phép `diff` cấu hình phải kèm `test -s` để biến chưa đặt không cho kết quả "giống nhau" giả.
- HOME sạch phải tạo sẵn `.claude` và `.codex`; các CLI provider do Paseo gọi tự tạo thư mục trong HOME tạm và đó không phải paseo-bm ghi.
- Không viết `HOME=… PASEO_HOME="$HOME/.paseo"` trên cùng một dòng.
