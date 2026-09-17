# ADR-007 — Lưu vết trace của Dashboard trong thư mục cài đặt, người dùng xoá được

| Trường | Giá trị |
|---|---|
| Status | **Accepted** (2026-09-16) — owner duyệt cùng PRD tính năng |
| Date | 2026-09-16 |
| Owner | hieu.nt10 |
| Liên quan | [PRD Dashboard REQ-053 → REQ-057](../product/paseo-bm-dashboard-prd.md#6-functional-requirements) · [Technical Design Dashboard §3](../design/paseo-bm-dashboard.md) · [ADR-002](ADR-002-install-ownership-model.md) (quyền sở hữu trong thư mục cài đặt) · [ADR-005](ADR-005-manager-as-agent.md) (vòng đời agent thuộc người dùng) · [PRD gốc REQ-030](../product/paseo-bm-prd.md#6-functional-requirements) |

## Context

Dashboard cần trả lời "yêu cầu này đã phân rã ra gì, mất bao lâu, tạo bead nào, bỏ bước nào". Toàn bộ dữ liệu thô nằm trong timeline agent của Paseo.

Bốn dữ kiện định hình quyết định:

1. **Vòng đời agent thuộc người dùng (ADR-005).** Người dùng lưu trữ và xoá agent bất cứ lúc nào, và sản phẩm khuyến khích điều đó — Manager sinh ra một Worker cho mỗi yêu cầu, nên agent tích tụ rất nhanh. Nếu Dashboard chỉ dẫn xuất từ timeline lúc đọc thì **dọn agent đồng nghĩa với xoá lịch sử công việc**.
2. **Paseo không hứa giữ timeline mãi.** Timeline có `epoch`, `reset`, `gap` và `compaction`: nội dung cũ có thể bị thay thế hoặc nén mất văn bản. Dẫn xuất-khi-đọc vì vậy không phải một nguồn ổn định.
3. **Đọc lại timeline mỗi lần mở là đắt.** Một Manager sống lâu có timeline rất dài; dựng lại toàn bộ trace mỗi lần mở Dashboard sẽ không đạt ngưỡng 3 giây khi lịch sử lớn.
4. **Plugin đã có đường thu thập hợp lệ.** Hook `on("agent.turn_ended")` đã được dùng cho việc lan truyền lệnh dừng (bm-wq6). Nó là hook sự kiện, không phải cron hay watcher, nên ràng buộc "không tác vụ nền" của Technical Design gốc §8 không bị vi phạm.

Cái giá phải cân: lưu vết nghĩa là paseo-bm **bắt đầu ghi nội dung hội thoại của agent lên đĩa** — trước đây sản phẩm chỉ ghi payload plugin và một hồ sơ cài đặt không chứa bí mật. Đó là một ranh giới mới về quyền riêng tư, và là dữ liệu sẽ phình theo thời gian.

## Decision

1. **Có lưu vết bền.** Bộ thu thập bám hook `agent.turn_started` / `agent.turn_ended` của các agent `bm-*` và ghi lại từng lượt ngay khi nó kết thúc. Trace vì vậy sống sót qua reload plugin, khởi động lại daemon, và qua việc người dùng lưu trữ hoặc xoá agent.
2. **Kho nằm trong thư mục cài đặt của paseo-bm**, tại `<install home>/traces/`, tách theo `workspaceId` rồi theo tháng. Thư mục cài đặt được suy ra từ `paseo.config.get().config.plugins["paseo-bm"].path` (`<install home>/plugin/<version>`), nên nó đúng cả khi người dùng đổi vị trí bằng `--home`; bundle server không có cwd nên không có cách nào khác.
3. **Không bao giờ ghi vào workspace của người dùng.** Lịch sử này là dữ liệu của công cụ, không phải của repo; đưa nó vào repo sẽ làm bẩn git và có thể lộ nội dung hội thoại qua một lần commit.
4. **Che bí mật trước khi ghi, không phải trước khi render.** Dữ liệu đã lên đĩa thì không sửa lại được. Quyền `0700` cho thư mục, `0600` cho file, giống `install.json`.
5. **Nối thêm, không sửa; xoá là thao tác sửa duy nhất.** Một lượt là một dòng JSON; ghi bằng `O_APPEND` + `fsync`. Việc xoá viết lại file theo nguyên tắc tạm → `fsync` → `rename` của Technical Design gốc §8.
6. **Người dùng xoá được, và chỉ người dùng xoá.** Ba phạm vi: một trace, mọi trace cũ hơn một mốc, toàn bộ trace của một workspace. Luôn có bước xem trước (số trace và dung lượng) với xác nhận mặc định "Không". **Không tự xoá, không tự nén, không xoay vòng theo tuổi hay dung lượng** — sản phẩm chỉ **cảnh báo** khi kho vượt ngưỡng. Lý do: đây là lịch sử công việc của người dùng, và một cơ chế tự xoá sẽ xoá đúng thứ người ta cần vào lúc người ta cần nó nhất.
7. **Lỗi lưu vết không bao giờ làm chết agent.** Hết đĩa, thiếu quyền, kho có lược đồ mới hơn — tất cả đều bị nuốt trong hook, log một dòng, và Dashboard hiện "có thể thiếu trace".
8. **Kho có `schemaVersion`.** Bản cao hơn mức hiểu được thì đọc hạn chế và **không ghi**, để một bản cũ không phá dữ liệu của bản mới.
9. **Quyền sở hữu: do paseo-bm tạo, thuộc người dùng.** Kho không có hash trong `install.json` và không được backup. Đây là một loại mới so với năm loại trong Technical Design gốc §3.3, nên nó đi kèm một delta-change cho PRD gốc REQ-010/REQ-012 và design gốc §3.1/§3.3.
10. **Cập nhật phiên bản không bao giờ xoá kho** (owner chốt 2026-09-16). Không khi payload sang thư mục phiên bản mới, không với `--prune`, và không khi lược đồ kho cần di trú — di trú ghi bản mới rồi mới bỏ bản cũ. Chỉ **lệnh gỡ** được phép xoá, và chỉ sau khi hỏi; chế độ không tương tác cần một cờ riêng (tên cờ còn chờ chốt).
11. **Trace của một workspace không còn thì không bị xoá ngầm, cũng không bị đoán bừa.** Nó vào một nhóm "workspace không còn", mang theo tên và đường dẫn cuối cùng paseo-bm biết (một `meta.json` cho mỗi workspace), để người dùng nhận ra đó là repo nào. Khi người dùng mở lại repo đó, **chính người dùng** gán lại trace sang workspace mới; sản phẩm không tự khớp theo tên hay đường dẫn, vì đoán sai sẽ trộn lịch sử của hai repo khác nhau. Trường `workspaceId` trong từng bản ghi giữ nguyên giá trị lịch sử; vị trí thư mục mới là thứ quyết định trace thuộc workspace nào.

## Consequences

**Được**

- REQ-030 (lịch sử phiên làm việc) trở thành sự thật, không phụ thuộc việc người dùng có giữ agent hay không.
- Dashboard mở nhanh cả khi lịch sử lớn: đọc kho đã dựng sẵn thay vì dựng lại từ timeline.
- Dữ liệu ổn định trước `compaction` và `reset` của Paseo.
- Có một chỗ duy nhất, có phiên bản, để về sau thêm số liệu mà không phải đổi cách đọc.

**Mất và phải sống với nó**

- **Nội dung hội thoại agent nằm trên đĩa.** Giảm nhẹ bằng: che bí mật trước khi ghi, quyền `0600`, cắt độ dài, và một câu nói rõ trên giao diện. Không loại bỏ được hoàn toàn: nếu agent nói ra một đoạn mã nguồn thì đoạn đó sẽ được lưu.
- **Kho phình theo thời gian.** Giảm nhẹ bằng đường xoá ba phạm vi cộng cảnh báo dung lượng, với ngưỡng người dùng đổi được trong phần cài đặt plugin (phạm vi toàn máy — Paseo không cấp phạm vi theo workspace); chấp nhận rằng người dùng phải tự dọn.
- **Plugin trở thành bên có ghi đĩa**, nên bề mặt kiểm thử phủ định lớn hơn: phải chứng minh nó chỉ ghi trong `traces/`.
- **Tài liệu đã đóng băng phải được sửa bằng delta-change** trước khi implement; đây là công việc thật, không phải hình thức.
- Bộ thu thập phụ thuộc hook có chạy. Host Paseo không có hook, hoặc plugin bị tắt trong lúc agent chạy, thì lượt đó không có trace và Dashboard phải nói "có thể thiếu".

## Alternatives considered

| Phương án | Vì sao không chọn |
|---|---|
| **Dẫn xuất khi đọc, không lưu gì** (đề xuất ban đầu) | Không thêm kho dữ liệu và không có rủi ro riêng tư mới, nhưng lịch sử chết theo agent — trái với chính lý do tồn tại của REQ-030 — và không đạt ngưỡng thời gian khi lịch sử lớn. Owner chốt bỏ phương án này (Q-030, 2026-09-16) |
| **Lưu trong workspace (ví dụ `.beads/traces/`)** | Làm bẩn repo của người dùng, có thể bị commit, và vi phạm ranh giới "không ghi vào repo ngoài phần bead và tài liệu do Worker tạo" |
| **Lưu qua `registerSettings` của Paseo** | Cơ chế đó dành cho cấu hình nhỏ do Paseo quản lý, không phải dữ liệu nối thêm hàng nghìn bản ghi; và nó không cho xoá theo phạm vi |
| **SQLite trong thư mục cài đặt** | Truy vấn tốt hơn JSONL, nhưng thêm một phụ thuộc nhị phân vào payload plugin, trái nguyên tắc "phụ thuộc runtime tối thiểu"; và một file hỏng làm mất cả kho, còn JSONL hỏng một dòng thì chỉ mất một dòng |
| **Tự xoay vòng theo tuổi hoặc dung lượng** | Đơn giản cho người vận hành nhưng xoá dữ liệu của người dùng mà không hỏi. Owner chốt: chỉ cảnh báo, người dùng tự xoá |
| **Xoá trace khi workspace bị xoá khỏi Paseo** | Gọn hơn, nhưng người dùng thường xoá workspace rồi mở lại repo đó sau — và lúc đó lịch sử đã mất. Owner chốt: giữ lại ở nhóm "workspace không còn" và cho gán lại |
| **Tự khớp workspace cũ với workspace mới theo đường dẫn repo** | Tiện, nhưng hai workspace trỏ cùng đường dẫn không chắc là cùng một dòng công việc, và khớp sai thì trộn lịch sử hai repo. Việc gán lại vì vậy luôn do người dùng bấm |
