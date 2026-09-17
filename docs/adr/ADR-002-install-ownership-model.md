# ADR-002 — Hồ sơ cài đặt có checksum, ghi atomic, backup; không dùng journal giao dịch đầy đủ

| Trường | Giá trị |
|---|---|
| Status | Accepted (bổ sung 2026-09-16 — xem mục cuối) |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-004, REQ-008, REQ-009, REQ-010, REQ-012](../product/paseo-bm-prd.md#6-functional-requirements), [ADR-001](ADR-001-plugin-distribution.md), [Technical Design](../design/paseo-bm.md) |

## Context

paseo-bm ghi vào máy người dùng và phải đáp ứng bốn yêu cầu của PRD cùng lúc: chạy lại không đổi gì (REQ-009), không ghi đè file người dùng đã sửa (REQ-008), gỡ sạch đúng phần mình sở hữu (REQ-012), và không để lại file ghi dở khi bị ngắt (REQ-010c).

Hai hình mẫu đã khảo sát:

- **paseo-room**: mỗi mục là `dir` / `file` / `link`, so sánh với đĩa rồi `rm` + ghi lại khi khác. Không backup, không atomic, không có danh sách file trong marker `room.json`. Hệ quả: sửa tay bị ghi đè im lặng; gỡ là `rm -rf` cả thư mục. Nhóm này đã **chủ động bỏ** installer v1 có journal, rollback và lock (~10k dòng) vì quá nặng.
- **Trình cài skills của chính Paseo**: ghi theo giao dịch với thư mục `.paseo-skills-transaction-*`, `transaction.json`, `backup/`, vùng cách ly `.paseo-skills-recovered-*`, cộng với `.paseo-managed-files.json` chứa sha256 từng file.

Khác biệt quan trọng về phạm vi: paseo-bm chỉ ghi **một cây thư mục payload do mình sở hữu hoàn toàn** cộng **một thay đổi nhỏ trong `config.json` của Paseo** (ADR-004). Nó không rải file vào thư mục của người khác — đó là lý do không cần tới bộ máy giao dịch đầy đủ.

## Decision

1. **Hồ sơ cài đặt** `<install home>/install.json`, có `schemaVersion`, ghi: phiên bản, thời điểm, đường dẫn Paseo home đã dùng, danh sách từng file payload kèm `sha256` và quyền, các thay đổi đã thực hiện lên Paseo, và trạng thái tương tác về skills. Đây là **nguồn sự thật về quyền sở hữu**: không có trong hồ sơ nghĩa là không phải của paseo-bm.
2. **Ghi atomic từng file**: ghi ra file tạm cùng thư mục, `fsync`, rồi `rename`. Không bao giờ `rm` rồi ghi lại.
3. **Chỉ ghi khi khác**: so `sha256` trước; giống thì không chạm vào file (bảo đảm REQ-009).
4. **Phân loại đích trước khi ghi**: *của ta và khớp hash* → cập nhật được; *của ta nhưng hash khác* → người dùng đã sửa, mặc định giữ; *không có trong hồ sơ mà đã tồn tại* → xung đột, bỏ qua.
5. **Backup trước mọi ghi đè có chủ đích**, vào `<install home>/backups/<timestamp>/`, giữ nguyên đường dẫn tương đối, và in đường dẫn ra cho người dùng.
6. **Không có journal, không rollback toàn cục.** Khôi phục dựa trên ba tính chất: ghi atomic từng file, tính idempotent, và hồ sơ cài đặt. Bị ngắt giữa chừng thì chạy lại lệnh cài là về trạng thái nhất quán.
7. **Cài phiên bản mới không ghi đè phiên bản cũ**: payload mới vào `plugin/<version mới>/`. Đây là cách đạt REQ-010c mà không cần rollback. *(Sửa 2026-09-15: bản đầu viết "dọn bản cũ, giữ tối đa N bản". Owner đã chốt **giữ tất cả**, chỉ dọn khi người dùng chạy `--prune` — xem Technical Design Q-016. Không có cơ chế dọn tự động nào.)*
   **Hệ quả về phạm vi của các trạng thái ở quyết định 4:** vì bản nâng cấp luôn vào thư mục mới, mọi đích đều là `missing` → tạo mới, nên `user-modified`, `outdated` và `conflict` **chỉ xảy ra trong thư mục phiên bản đang hoạt động** (cài lại cùng phiên bản, hoặc sửa chữa file bị xoá/bị sửa) và với chính `install.json`. File người dùng đã sửa trong thư mục phiên bản **cũ** được để nguyên, liệt kê trong bản tóm tắt, và `--prune` không bao giờ xoá.
8. **Quyền**: thư mục `0700`, file `0600`.
9. `schemaVersion` lớn hơn mức CLI hiểu → dừng và yêu cầu người dùng nâng cấp, không đoán.

## Consequences

**Tích cực**
- Ba yêu cầu khó (idempotent, không ghi đè im lặng, gỡ sạch) đều suy ra trực tiếp từ hồ sơ cài đặt.
- Không có trạng thái nửa vời khó hiểu: file hoặc là bản cũ nguyên vẹn, hoặc là bản mới nguyên vẹn.
- Đơn giản hơn hẳn journal, nên ít mã và ít cách hỏng.

**Tiêu cực / phải chấp nhận**
- Bị ngắt giữa chừng có thể để lại **thư mục payload phiên bản mới chưa hoàn tất**. Xử lý: bản chưa được ghi vào hồ sơ thì coi là rác, lần chạy sau dọn.
- Hồ sơ bị xoá tay là mất dấu vết sở hữu; khi đó paseo-bm coi như chưa cài và báo mọi đích hiện có là xung đột, thay vì đoán.
- `sha256` chỉ phát hiện nội dung khác, không biết ai sửa. Đủ cho mục tiêu "không ghi đè im lặng".
- Backup tích tụ theo thời gian; cần chính sách dọn và một lệnh liệt kê.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Kiểu paseo-room: `rm` + ghi lại, marker không có danh sách file | Vi phạm thẳng REQ-008 và REQ-012; chính tác giả cũng ghi nhận đây là điểm yếu |
| Journal giao dịch đầy đủ như trình cài skills của Paseo | Phù hợp khi ghi vào thư mục dùng chung với công cụ khác. paseo-bm chỉ ghi trong thư mục của chính mình nên chi phí không tương xứng |
| Dựa vào `mtime`/kích thước thay cho hash | Không tin cậy khi copy hay checkout; dễ vừa bỏ sót vừa báo nhầm |
| Ghi đè trực tiếp rồi sửa nếu lỗi | Không có điểm khôi phục; đúng thứ mà REQ-010c cấm |

## Bổ sung 2026-09-16 — loại `user-data` đứng ngoài mô hình hash

Theo delta [`design-delta-20260916-trace-store`](../design/paseo-bm-delta-20260916-trace-store.md) do owner duyệt, thư mục `<install home>/traces/` (kho lưu vết của Dashboard) là **dữ liệu do paseo-bm tạo nhưng thuộc người dùng**, và **không** áp mô hình hồ sơ–hash của ADR này:

- không nằm trong `files[]`, không có `sha256`, không sinh `backups[]`;
- không có bốn trạng thái `unchanged` / `outdated` / `user-modified` / `conflict` — nó không phải tài sản phiên bản nên không có "bản đúng" để so;
- cài và cập nhật (gồm cả `--prune`) **không bao giờ** chạm tới nó (PRD REQ-010f);
- chỉ lệnh gỡ được xoá, và phải hỏi riêng (PRD REQ-012i).

Lý do quyết định này không làm yếu ADR-002: mô hình hash tồn tại để trả lời "file này của ai và có bị sửa tay không". Với dữ liệu tích luỹ thì câu hỏi đó vô nghĩa — mọi thay đổi đều là dữ liệu mới hợp lệ. Áp hash lên nó sẽ luôn báo `user-modified` và biến một tính năng đúng thành một cảnh báo sai. Chi tiết ở [ADR-007](ADR-007-dashboard-trace-store.md) và [Technical Design](../design/paseo-bm.md) §3.3.
