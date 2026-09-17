# Delta-change — Kho lưu vết của Dashboard trong thư mục cài đặt

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260916-trace-store` |
| Tài liệu gốc | [paseo-bm Technical Design](paseo-bm.md) (Active) và [paseo-bm PRD](../product/paseo-bm-prd.md) (Accepted) — **không sửa tại chỗ** |
| Status | **Accepted, Applied** |
| Accepted | 2026-09-16 — owner hieu.nt10 duyệt bảy vị trí ở §3 |
| Applied | 2026-09-16 — áp dụng vị trí 1 → 9 (design §3.1, §3.3, §4.4, §5, §8; PRD REQ-010(f), REQ-012(i); ADR-002 mục bổ sung; ba Revision History) |
| Owner | hieu.nt10 |
| Created | 2026-09-16 |
| Nguồn | [PRD Dashboard điều phối](../product/paseo-bm-dashboard-prd.md) REQ-053 → REQ-057 · [Technical Design Dashboard](paseo-bm-dashboard.md) §3, §5, §14 · [ADR-007](../adr/ADR-007-dashboard-trace-store.md) (Proposed) |
| Quyết định của owner đứng sau delta này | Q-030 (có lưu vết), Q-039 (cập nhật không xoá kho), Q-040 (ngưỡng cấu hình trong plugin), Q-041 (workspace không còn thì gán lại) — chốt 2026-09-16 |

Ghi chú quy ước: theo mẫu `change.md` của feature-workflow, cùng kiểu với `plan-v2-delta-20260915-m10`. Delta này chạm **hai** tài liệu đã đóng băng nên được đặt cạnh tài liệu bị sửa nhiều hơn (Technical Design).

## 1. Tóm tắt

Tính năng Dashboard cần lưu lại trace của từng yêu cầu để lịch sử không chết cùng với agent (ADR-007). Kho lưu vết nằm ở `<install home>/traces/`, tức **bên trong thư mục cài đặt** mà Technical Design gốc §3.1 và §3.3 đang sở hữu, và lệnh gỡ ở PRD gốc REQ-012 đang định nghĩa phạm vi.

Đây là **thêm phạm vi**, không phải errata, nên nó phải đi qua delta. Delta này đề nghị sửa **bảy vị trí**: bốn ở Technical Design, hai ở PRD, một ở ADR-002.

Điểm cần chú ý nhất: kho lưu vết là **loại đích thứ sáu** trong bảng phân loại quyền sở hữu — dữ liệu do paseo-bm tạo nhưng thuộc người dùng, không có hash, không backup, cập nhật không bao giờ chạm, và chỉ lệnh gỡ được xoá sau khi hỏi.

## 2. Vì sao không làm cách khác

| Cách khác | Vì sao không |
|---|---|
| Không lưu gì, dẫn xuất khi mở | Owner đã bỏ phương án này (Q-030): xoá agent là mất lịch sử. Xem ADR-007 §Alternatives |
| Lưu ngoài thư mục cài đặt (ví dụ `~/.paseo-bm-traces`) | Thành hai thư mục nhà cho cùng một sản phẩm; lệnh gỡ và `doctor` phải biết cả hai; không tôn trọng `--home` |
| Lưu trong workspace | Làm bẩn repo người dùng, có thể bị commit |
| Coi kho như file payload thường (có hash, có backup) | Sai bản chất: payload là **tài sản đi kèm phiên bản**, kho là **dữ liệu tích luỹ của người dùng**. Hash sẽ luôn lệch, backup sẽ nhân đôi dung lượng, và `--prune` sẽ xoá mất lịch sử |

## 3. Ảnh hưởng — các vị trí sẽ đổi nếu được duyệt

Số dòng tính theo commit `0240c50`.

| # | Tài liệu và vị trí | Hiện tại | Đề xuất |
|---|---|---|---|
| 1 | `docs/design/paseo-bm.md` §3.1, khối bố cục thư mục cài đặt (dòng 203–214) | Khối liệt kê `install.json`, `plugin/<ver>/`, `backups/`, `.lock` | Thêm hai dòng vào khối, kèm chú thích một dòng: `traces/` (0700) chứa `meta.json` mức kho và một thư mục cho mỗi `workspaceId`, bên trong là `meta.json` của workspace và các file `events-<YYYYMM>.jsonl` (0600). Chú thích: *"dữ liệu lưu vết của Dashboard — do paseo-bm tạo nhưng thuộc người dùng; xem §3.3 và [ADR-007](../adr/ADR-007-dashboard-trace-store.md)"* |
| 2 | `docs/design/paseo-bm.md` §3.3, bảng phân loại quyền sở hữu (dòng 244–250) | Năm tình trạng: `unchanged`, `outdated`, `user-modified`, `conflict`, `missing` | Thêm một hàng thứ sáu: `user-data` — điều kiện *"nằm trong `<install home>/traces/`"*; hành động mặc định *"không hash, không backup, không so sánh; cài và cập nhật **không bao giờ** chạm; chỉ lệnh gỡ được xoá và phải hỏi trước"*. Kèm một câu sau bảng: *"Loại `user-data` là dữ liệu tích luỹ, không phải tài sản phiên bản, nên nó đứng ngoài mọi quy tắc hash, backup và `--prune`."* |
| 3 | `docs/design/paseo-bm.md` §4.4, câu "Sổ đăng ký mã lỗi" (dòng 346) | Danh sách 18 mã `E_*` và 4 mã `W_*`; câu cuối ghi năm mã bổ sung theo errata 2026-09-15 | Thêm sáu mã vào danh sách: `E_TIMELINE_UNAVAILABLE`, `E_BEADS_STORE_UNREADABLE`, `E_TRACE_NOT_FOUND`, `E_TRACE_STORE_UNWRITABLE`, `E_TRACE_STORE_SCHEMA_TOO_NEW`, `E_TRACE_REASSIGN_INVALID`. Kèm một câu: *"Sáu mã cuối thuộc các RPC của Dashboard (delta `design-delta-20260916-trace-store`); chúng đi qua kênh RPC của plugin nên **không** có mã thoát CLI."* |
| 4 | `docs/design/paseo-bm.md` §5, sau bảng ba RPC (dòng ~356) | Bảng ba RPC `manager.ensure`, `agents.list`, `roles.describe` | Thêm một dòng trỏ sang tài liệu con, **không** copy bảng: *"Các RPC của Dashboard (`traces.list`, `traces.get`, `traces.delete`, `traces.reassign`, `beads.stats`) được định nghĩa ở [Technical Design Dashboard §5](paseo-bm-dashboard.md). Ba RPC trên không đổi."* |
| 5 | `docs/design/paseo-bm.md` §8, dòng "**Không tác vụ nền, không cron, không watcher.**" (dòng ~402) | `- **Không tác vụ nền, không cron, không watcher.**` | Giữ nguyên câu, thêm một câu làm rõ: *"Bộ thu thập lưu vết của Dashboard bám hook `agent.turn_ended` của Paseo nên vẫn nằm trong quy tắc này: nó chạy theo sự kiện, không có đồng hồ, không quét đĩa, và lỗi ghi bị nuốt để không ảnh hưởng agent."* |
| 6 | `docs/product/paseo-bm-prd.md` REQ-010 (dòng 205) | (a) → (e) về cập nhật và an toàn khi bị ngắt | Thêm ý **(f)**: *"Cập nhật **không bao giờ** xoá hay ghi đè kho lưu vết của Dashboard, kể cả khi payload sang thư mục phiên bản mới, kể cả với `--prune`, và kể cả khi lược đồ kho cần di trú — di trú ghi bản mới rồi mới bỏ bản cũ."* |
| 7 | `docs/product/paseo-bm-prd.md` REQ-012 (dòng 207) | (a) → (h) về gỡ cài đặt | Thêm ý **(i)**: *"Kho lưu vết của Dashboard được liệt kê **riêng** trong bản xem trước, kèm số trace và dung lượng, và chỉ bị xoá sau khi người dùng đồng ý riêng cho nó; chế độ không tương tác chỉ xoá khi có cờ dành đúng cho việc này. Không đồng ý thì kho được giữ lại và bản tóm tắt nói rõ nó còn ở đâu."* |
| 8 | `docs/adr/ADR-002-install-ownership-model.md` | Mô hình quyền sở hữu theo hồ sơ và hash | Thêm một mục *"Bổ sung 2026-09-16"*: loại `user-data` đứng ngoài mô hình hash, và trỏ sang ADR-007 |
| 9 | Revision History của `docs/design/paseo-bm.md`, `docs/product/paseo-bm-prd.md` và `docs/adr/ADR-002-install-ownership-model.md` | — | Mỗi tài liệu thêm một dòng ghi rõ đã áp dụng delta `design-delta-20260916-trace-store` theo quyết định của owner ngày 2026-09-16 |

Các chỗ có nhắc thư mục cài đặt nhưng **không phải sửa chữ**:

- `docs/design/paseo-bm.md` §3.2 (`install.json`): kho lưu vết **không** được ghi vào hồ sơ — nó không có hash, không nằm trong `files[]`, và không sinh `backups[]`. Đây là điều delta cố ý giữ, nên bảng §3.2 không đổi.
- §7 Security: câu "Phạm vi ghi của trình cài đặt: chỉ `<install home>/**` và các khoá ở §3.4" vẫn đúng, vì `traces/` nằm trong `<install home>`. Việc **plugin** (không phải trình cài đặt) ghi vào đó được nêu ở Technical Design Dashboard §12, không cần sửa §7.
- §4.1 và §4.2 (lệnh và cờ): tên cờ cho việc xoá kho khi gỡ **chưa chốt** (xem §5), nên delta này chưa đề nghị sửa hai mục đó.

## 4. Những gì KHÔNG đổi

- Mọi REQ khác của PRD gốc, mọi mục khác của Technical Design gốc, và ADR-001, ADR-003 → ADR-006.
- Ba RPC hiện có và hành vi của chúng.
- `install.json` `schemaVersion` vẫn là `1`. Kho lưu vết có **lược đồ riêng**, đánh số độc lập, để một bản paseo-bm cũ vẫn đọc được hồ sơ như trước.
- Quy tắc hash, backup, `user-modified` và `--force` cho **file payload** — không đổi một chữ.
- Phạm vi ghi của trình cài đặt. Trình cài đặt **không** tạo và không ghi vào `traces/`; thư mục đó do plugin tạo khi cần.
- Bộ nghiệm thu Phase 1 và các biên bản đã ghi.

## 5. Câu hỏi mở cho owner

1. **Hành vi của lệnh gỡ** (phần còn lại của Q-039): giữ như đề xuất ở vị trí 7 — *hỏi riêng, không đồng ý thì giữ lại* — hay bạn muốn lệnh gỡ **luôn giữ** kho và chỉ xoá bằng một lệnh riêng về sau?
2. **Tên cờ** cho chế độ không tương tác. Đề xuất `--purge-traces` (chỉ xoá kho lưu vết, không liên quan `--prune` vốn dành cho backup và payload cũ). Tên cờ là hợp đồng công khai nên delta không tự đặt.
3. Có cần `doctor` báo thêm một dòng về kho lưu vết (số trace, dung lượng, lược đồ) không? Nếu có thì vị trí 3 của §3 phải thêm một check mới vào §4.4, và đây là phạm vi thêm cho WP của trình cài đặt.

## 6. Duyệt

- [x] Owner duyệt bảy vị trí ở §3
- [ ] Owner trả lời ba câu hỏi ở §5 — **còn mở**: câu 1 và 2 (hành vi lệnh gỡ và tên cờ, tức Q-039b) và câu 3 (`doctor`, tức Q-043). Hai câu này **chặn WP-213**, không chặn 13 WP còn lại
- Approved-by: hieu.nt10 (trả lời trong phiên làm việc với Claude), ngày 2026-09-16

Sau khi duyệt:
1. Áp dụng các vị trí 1 → 9.
2. Đổi Status của tài liệu này thành Accepted, rồi Applied.
3. Đưa ADR-007 sang Accepted.
4. Chỉ khi đó plan Dashboard mới được chuyển thành beads (WP-213 phụ thuộc trực tiếp vào delta này).

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Tạo bản Draft từ quyết định Q-030, Q-039, Q-040, Q-041 của owner và từ Technical Design Dashboard §14 |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | Owner duyệt; áp dụng đủ chín vị trí vào design gốc, PRD gốc và ADR-002. Ba câu hỏi ở §5 vẫn mở và được ghi là điều kiện chặn WP-213 |
