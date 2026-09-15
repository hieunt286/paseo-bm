# Delta-change — Agent con chạy ở chế độ không hỏi quyền

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260915-subagent-modes` |
| Tài liệu gốc | [paseo-bm PRD](paseo-bm-prd.md) (Accepted 2026-09-15) — **không sửa tại chỗ khi chưa duyệt** |
| Status | **Draft — chờ owner duyệt** |
| Owner | hieu.nt10 |
| Created | 2026-09-15 |
| Accepted | (điền khi owner duyệt) |
| Applied | (điền khi đã sửa các tài liệu ở §4) |
| Bead | `bm-msy` (chặn `bm-wp-117-9vy.2`) |
| Nguồn | Quyết định của owner sau [biên bản nghiệm thu điều phối 2026-09-15](../operations/paseo-bm-orchestration-run-20260915.md): "khi spawn các sub agents nên cho chế độ by pass với Claude hoặc chế độ tương tự với OpenCode hoặc Codex để tránh phải chờ đợi confirm" |

## 1. Tóm tắt

Owner quyết định Beads Worker (do Manager tạo) và Reviewer (do Worker tạo) chạy ở **chế độ không hỏi quyền** của provider: Claude `bypassPermissions`, Codex `full-access`, OpenCode chế độ tương đương. Chỉ dẫn vai trò đã được sửa theo quyết định này (`bm-msy`, errata Technical Design §2.6). Quyết định này **trái hai câu trong PRD đang Accepted**, nên cần delta để owner duyệt và ghi vào PRD.

## 2. Vì sao

- Trong lượt nghiệm thu 2026-09-15, agent ở chế độ `default` phát sinh 20–42 lời hỏi quyền mỗi fixture (F-3 42, F-5 33, F-4 20); agent phải dừng chờ cho tới khi có người trả lời.
- Mọi lời hỏi quyền trong lượt đó đều là việc thường trong repo nháp và đều được cho phép; không lời hỏi nào rơi vào ranh giới cấm.

## 3. Rủi ro phải chấp nhận có ý thức

- **Cổng hỏi trước khi làm của Worker và luật chỉ đọc của Reviewer chỉ còn là lan can hành vi.** Không còn lời hỏi quyền của Paseo làm lớp chặn thứ hai: một Worker phớt lờ chỉ dẫn có thể commit, push, cài phụ thuộc, chạy lệnh cần mạng hay lệnh phá huỷ mà không ai phải bấm duyệt.
- Codex `full-access` còn mở **quyền mạng** cho Reviewer. Theo kiểm chứng Q-028, Reviewer không có công cụ agent của Paseo nhưng có công cụ cộng tác sẵn của Codex (`spawn_agent`…); chặn tạo agent và chặn dùng mạng của Reviewer giờ chỉ dựa vào `reviewer.md`.
- M-13 (0 lần tự commit/push) và M-17 trở thành bằng chứng quan sát về chỉ dẫn, không còn được lời hỏi quyền hỗ trợ.
- Manager **không đổi**: nó vẫn không được duyệt quyền thay người dùng.

## 4. Ảnh hưởng — các dòng sẽ đổi nếu được duyệt

| # | Tài liệu và vị trí | Hiện tại | Đề xuất |
|---|---|---|---|
| 1 | `docs/product/paseo-bm-prd.md`, REQ-026 ý (c) | `(c) Yêu cầu quyền vượt ngoài ranh giới phải để người dùng tự phê duyệt trong Paseo, không tự động chấp thuận.` | `(c) Manager không tự phê duyệt yêu cầu quyền thay người dùng. Worker và Reviewer được tạo ở chế độ không hỏi quyền của provider (Claude bypassPermissions, Codex full-access, OpenCode tương đương) theo quyết định owner 2026-09-15; ranh giới ở ý (a) và luật chỉ đọc của Reviewer (REQ-024e) do chỉ dẫn vai trò bảo đảm và là lan can hành vi, không còn lời hỏi quyền của Paseo làm lớp chặn thứ hai.` |
| 2 | `docs/product/paseo-bm-prd.md`, nhóm NFR phần điều phối, gạch đầu dòng **Quyền** | `Worker và Reviewer chạy bằng quyền của chính người dùng trong workspace đó. Không nâng quyền, không tự phê duyệt các yêu cầu quyền, không tắt cơ chế hỏi phê duyệt của Paseo.` | `Worker và Reviewer chạy bằng quyền của chính người dùng trong workspace đó, ở chế độ không hỏi quyền của provider (REQ-026c). Manager không tự phê duyệt yêu cầu quyền. Rủi ro đã biết: ranh giới an toàn của Worker và Reviewer chỉ còn nằm trong chỉ dẫn vai trò.` |
| 3 | `docs/product/paseo-bm-prd.md`, Revision History | — | Thêm dòng: `2026-MM-DD \| hieu.nt10 \| REQ-026c và NFR Quyền: agent con chạy ở chế độ không hỏi quyền theo delta prd-delta-20260915-subagent-modes` |
| 4 | `docs/design/paseo-bm.md` §7 (câu "Vượt ranh giới thì để người dùng phê duyệt trong Paseo") | giữ nguyên chữ; errata §2.6 (`bm-msy`) đã ghi câu này không còn áp dụng cho Worker và Reviewer | Thêm một câu errata ngay sau câu đó trỏ về §2.6 |
| 5 | `docs/adr/ADR-006-role-registration.md` quyết định 9 | "…lớp chỉ dẫn là thứ duy nhất chặn review đệ quy và điều đó phải được ghi nhận như một rủi ro đã biết." | Không sửa ADR; ghi trong biên bản nghiệm thu lượt sau rằng rủi ro này nay rộng hơn (cả ghi file và mạng của Reviewer) |

## 5. Những gì KHÔNG đổi

- Ranh giới REQ-026 (a), (d), (e), (f), (g): cấm commit, push, pull request, lệnh phá huỷ, ghi ngoài workspace, đọc credential; phải hỏi trước khi cài phụ thuộc, dùng mạng, chạy migration, deploy; chỉ người dùng lưu trữ hay xoá agent.
- REQ-024 (e): Reviewer chỉ đọc và không tạo agent.
- Chế độ quyền của Manager và việc Manager không duyệt quyền thay người dùng.
- `bm-reviewer` vẫn không được bật `paseoTools` (REQ-031b).

## 6. Câu hỏi mở cho owner

1. Có muốn Reviewer (chỉ đọc) dùng chế độ chặt hơn `full-access` của Codex (ví dụ `auto`, không mở mạng) và chấp nhận Reviewer có thể hỏi quyền, hay giữ đúng quyết định "không chờ confirm" cho mọi agent con?
2. Trong nghiệm thu, Manager có chạy chế độ không hỏi quyền không? (liên quan câu hỏi mở 2 của `plan-v2-delta-20260915-m10`)

## 7. Duyệt

- [ ] Owner đồng ý các thay đổi ở §4 và chấp nhận rủi ro ở §3
- [ ] Trả lời câu hỏi mở 1 và 2
- Approved-by: ______________________, ngày ____-__-__

Sau khi duyệt: sửa các vị trí 1–4 ở §4, đổi Status thành Accepted rồi Applied, đóng `bm-msy` kèm bằng chứng.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Tạo bản Draft theo quyết định owner và các dòng xung đột do `bm-msy` phát hiện |
