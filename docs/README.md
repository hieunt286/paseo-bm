# Tài liệu paseo-bm — đọc từ đây

Tài liệu trong `docs/` là **tài liệu sống**: mỗi file tả sản phẩm **như nó đang chạy**, được sửa tại chỗ cùng commit với code và thêm một dòng Revision History. Muốn biết vì sao một điều từng được quyết thì xem mục "Lịch sử" cuối mỗi design, rồi tới `archive/`. Cách chọn quy trình cho một thay đổi (Direct / Tracked / Designed) nằm ở [`AGENTS.md`](../AGENTS.md), mục *Process*.

## Sản phẩm làm gì — PRD

| Tài liệu | Nội dung |
|---|---|
| [paseo-bm-prd.md](product/paseo-bm-prd.md) | Trình cài đặt, vai trò Manager / Worker / Reviewer, ranh giới an toàn, review, báo cáo, dự phòng provider |
| [paseo-bm-dashboard-prd.md](product/paseo-bm-dashboard-prd.md) | Màn Metric, Beads, Setup, thẻ trong chat, kho lưu vết |

PRD nói **kết quả người dùng nhận được**. Chi tiết như màu, nhãn, giới hạn và con số nằm ở design, code và test. Yêu cầu nào chưa có trong code được ghi *"Chưa làm"* ngay trong dòng của nó.

## Sản phẩm làm thế nào — Technical Design

| Tài liệu | Nội dung |
|---|---|
| [paseo-bm.md](design/paseo-bm.md) | Đóng gói và phát hành, CLI, dữ liệu trên đĩa, cấu hình Paseo, phía server của plugin: hook tạo agent, Manager, tool của agent, thông báo `BM-*`, ngân sách review, sổ hỏi–đáp, dự phòng, trace |
| [paseo-bm-dashboard.md](design/paseo-bm-dashboard.md) | Kho lưu vết, dựng trace theo request, bước quy trình, màn Metric / Beads / Setup (kể cả Roles & models), thẻ chat, pill, thẻ dự phòng |
| [paseo-bm-research-20260918-instructions-by-model.md](design/paseo-bm-research-20260918-instructions-by-model.md) | Chỉ dẫn vai trò tới Claude, Codex, OpenCode thế nào |

Hành vi của từng vai trò nằm trong chính chỉ dẫn của nó: [`plugin/roles/manager.md`](../plugin/roles/manager.md), [`worker.md`](../plugin/roles/worker.md), [`reviewer.md`](../plugin/roles/reviewer.md). Design không chép lại.

## Quyết định kiến trúc — ADR

| ADR | Quyết định |
|---|---|
| [ADR-001](adr/ADR-001-plugin-distribution.md) | Payload đi kèm gói npm, đăng ký từ thư mục cục bộ |
| [ADR-002](adr/ADR-002-install-ownership-model.md) | Hồ sơ cài đặt có checksum, ghi atomic, backup |
| [ADR-003](adr/ADR-003-skills-delegation.md) | Uỷ quyền việc cài skills cho CLI `skills` |
| [ADR-004](adr/ADR-004-paseo-config-mutation.md) | Tích hợp Paseo qua CLI; sửa tối thiểu `config.json` |
| [ADR-005](adr/ADR-005-manager-as-agent.md) | Beads Manager là một agent; plugin là lối vào và bảng quan sát |
| [ADR-006](adr/ADR-006-role-registration.md) | Đăng ký vai trò bằng provider dẫn xuất và agent profile |
| [ADR-007](adr/ADR-007-dashboard-trace-store.md) | Kho lưu vết trong thư mục cài đặt, người dùng xoá được |
| [ADR-008](adr/ADR-008-role-settings-written-by-plugin.md) | Plugin ghi cấu hình vai trò qua `config.patch`; alias dự phòng |
| [ADR-009](adr/ADR-009-payload-as-npm-package.md) | Payload là gói npm riêng `paseo-bm-plugin`, cùng lần phát hành |
| [ADR-010](adr/ADR-010-plugin-hosted-agent-tools.md) | Plugin phục vụ tool có schema cho agent qua MCP HTTP |
| [ADR-011](adr/ADR-011-manager-coordinates-workers.md) | Manager tự điều phối Worker trong phạm vi người dùng đã quyết |

ADR không bao giờ được viết lại; quyết định mới thì viết ADR mới thay thế nó.

## Vận hành — `operations/`

| Tài liệu | Dùng khi |
|---|---|
| [Runbook phát hành](operations/paseo-bm-release-runbook.md) | Phát hành một phiên bản (hai gói, cùng một lần chạy `release.yml`) |
| [Checklist trình cài đặt](operations/paseo-bm-install-checklist.md) | Nghiệm thu `install` / `doctor` / `uninstall` trên daemon thật |
| [Checklist điều phối](operations/paseo-bm-orchestration-checklist.md) | Nghiệm thu Manager → Worker → Reviewer với bộ yêu cầu mẫu |
| [Checklist vai trò và dự phòng](operations/paseo-bm-worker-fallback-checklist.md) | Nghiệm thu cài đặt vai trò và dự phòng provider |
| [Hồ sơ paseo.cafe](operations/paseo-bm-cafe-listing-20260923.md) | Liệt kê paseo-bm trên paseo.cafe; các bẫy của registry |
| [Đề nghị gửi Paseo: huỷ agent](operations/paseo-upstream-request-agent-cancel.md), [điều hướng timeline](operations/paseo-upstream-request-timeline-navigation.md) | Hai đề nghị còn mở gửi maintainer của Paseo (tiếng Anh) |

## Ghi chú phát hành — `releases/`

Mỗi phiên bản một file `paseo-bm-release-notes-<version>.md`; file đó là body của GitHub Release. Bản mới nhất: [0.3.0](releases/paseo-bm-release-notes-0.3.0.md).

## Lưu trữ — `archive/`

Chỉ đọc, không sửa. Code và các tài liệu cũ trích delta theo tên và số mục (ví dụ "delta 20260917c §4.7"); tìm chúng ở đây.

| Thư mục | Chứa |
|---|---|
| `archive/design/` | Các design delta và proposal đã gộp vào hai Technical Design |
| `archive/product/` | Các PRD delta đã gộp vào hai PRD |
| `archive/plans/` | Mọi implementation plan đã hoàn tất |
| `archive/operations/` | Biên bản các lần chạy nghiệm thu và phát hành, chẩn đoán, checklist của các phase đã đóng |
