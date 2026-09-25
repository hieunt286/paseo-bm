# ADR-003 — Uỷ quyền việc cài skills cho CLI `skills`, paseo-bm không tự ghi file skills

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-007, REQ-015, Phụ lục A](../product/paseo-bm-prd.md#12-phụ-lục-a--khảo-sát-nguồn-skills-khuyến-nghị), [ADR-002](ADR-002-install-ownership-model.md), [Technical Design](../design/paseo-bm.md) |

## Context

Plugin phát huy tác dụng khi máy đã có bộ bead skills. PRD chốt hai điều tưởng như ngược nhau: paseo-bm **không tự copy skills** (REQ-007c), nhưng vẫn phải **hỗ trợ người dùng cài** khi thiếu (REQ-007d, e).

Thực tế trên máy (2026-09-14):

- Thư mục skills đã có nhiều chủ: `~/.agents/skills` là nơi chứa thật, `~/.claude/skills` phần lớn là symlink trỏ sang đó; các bản cài được `~/.agents/.skill-lock.json` theo dõi kèm `source`, `sourceType`, `skillFolderHash`.
- 5 skill bead trên máy owner đang do CLI `skills` quản lý, nguồn là kho nội bộ, và **giống hệt từng byte** với repo công khai `cuongntr/agent-skills`.
- CLI `skills` (npm `skills`, bản 1.5.26) có: `add <repo>` với `-g/--global`, `-a/--agent`, `-s/--skill`, `-y/--yes`, `--copy`, `--all`, và `-l/--list` để **liệt kê skills trong repo mà không cài**. Khi chạy trong môi trường agent, nó tự nhận biết và chuyển sang chế độ không tương tác.

Nếu paseo-bm tự copy skills, nó sẽ ghi đè lên file do CLI `skills` sở hữu, làm hỏng lockfile của công cụ đó, và tự nhận trách nhiệm phát hành lại nội dung của tác giả khác (repo hiện chưa có LICENSE).

## Decision

1. paseo-bm **không bao giờ** tạo, sửa, xoá hay backup file trong thư mục skills. Quyền ghi ở đó thuộc CLI `skills`.
2. **Dò** bằng cách đọc hệ thống file: với mỗi skill trong danh sách bắt buộc, kiểm tra `<skills dir>/<tên skill>/SKILL.md` có tồn tại không, ở `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, có tôn trọng `CLAUDE_CONFIG_DIR` và `CODEX_HOME`, và đi theo symlink. Không gọi CLI `skills` để dò, vì dò phải nhanh, chạy offline và không có tác dụng phụ.
3. **Hỗ trợ cài** bằng cách gọi đúng CLI `skills` với nguồn `cuongntr/agent-skills`, chỉ sau khi người dùng đồng ý và đã thấy nguyên văn lệnh sẽ chạy. Ở chế độ không tương tác, phải có cờ cho phép riêng.
4. **Nguồn skills là hằng số trong gói**; Phase 1 không cho ghi đè (Q-011). Phần duy nhất người dùng cấp được là **danh sách agent đích** (quyết định 2026-09-14, Q-014 trong Technical Design), qua cờ `--skills-agents` hoặc bước hỏi trong wizard, gợi ý mặc định `claude,codex`. Vì đây là dữ liệu người dùng đi vào lệnh chạy ngoài, mỗi phần tử phải khớp `^[a-z0-9][a-z0-9_-]{0,31}$`, tối đa 8 phần tử, loại trùng, từ chối phần tử bắt đầu bằng `-`; không hợp lệ thì dừng, không chạy gì.
5. Chạy lệnh đó như tiến trình con, truyền argv dạng mảng, **không qua shell**, output nối thẳng ra terminal để người dùng thấy đang xảy ra gì. Dùng **chế độ symlink mặc định** của CLI `skills`, không dùng `--copy` (Q-015), để khớp bố cục sẵn có trên máy: `~/.claude/skills` trỏ sang `~/.agents/skills`.
   *(Bổ sung 2026-09-15)* Khi bật `--json`, output của tiến trình con đi ra **stderr** chứ không nối vào stdout, để stdout luôn là đúng một tài liệu JSON (REQ-013c). Tiến trình con có hạn giờ **300 giây**, và **60 giây** không có output thì cảnh báo; hết giờ thì bị giết, ghi cảnh báo, không đổi mã thoát.
6. Sau khi lệnh kết thúc, **dò lại** và báo kết quả trước/sau. Thành công hay thất bại của bước này không đổi exit code của lệnh cài plugin.
7. Không có CLI `skills`, không có mạng, hoặc lệnh lỗi → in hướng dẫn thủ công (chính lệnh đó, để người dùng tự chạy) và tiếp tục.
8. Gỡ cài đặt paseo-bm **không** gỡ skills; bản tóm tắt chỉ ra lệnh của CLI `skills` để tự gỡ.
9. README nêu rõ nguồn skills là repo của tác giả khác, và việc cài do một công cụ bên thứ ba thực hiện — công cụ đó có thu thập dữ liệu cài đặt riêng, nằm ngoài cam kết "không telemetry" của paseo-bm.
   *(Bổ sung 2026-09-18, [delta short-readme](../archive/product/paseo-bm-prd-delta-20260918b-short-readme.md))* README nay ngắn: nó vẫn nêu nguồn skills là repo của tác giả khác; phần về CLI `skills` bên thứ ba, kênh thu thập dữ liệu riêng của nó và việc cài kiểu symlink nằm trong `GUIDE.md` ở gốc repo, được README trỏ tới.

## Consequences

**Tích cực**
- Không có tranh chấp quyền sở hữu file, không rủi ro làm lệch lockfile của CLI `skills`.
- Không phát hành lại nội dung của tác giả khác, nên tránh được vấn đề giấy phép.
- Người dùng mới vẫn được dẫn tới đích chỉ bằng một lệnh, đúng tinh thần PRD.
- Phần dò chạy offline, rẻ, nên dùng được cả trong `doctor`.

**Tiêu cực / phải chấp nhận**
- Phụ thuộc hai thứ ngoài tầm kiểm soát: CLI `skills` và repo của tác giả khác. Giao diện dòng lệnh hay tên thư mục skill đổi là luồng hỗ trợ gãy. Giảm thiểu bằng: lỗi không chặn, luôn có hướng dẫn thủ công, và kiểm thử với bản giả lập.
- Dò theo tên thư mục nên không biết nội dung skill có cũ hay không; repo chưa có tag nên Phase 1 không so phiên bản (Q-013).
- Chạy một tiến trình tải mã từ mạng là một ranh giới tin cậy thật. Giảm thiểu bằng: đồng ý rõ ràng, hiển thị nguyên văn lệnh, nguồn cố định trong gói.
- Cho người dùng nhập tên agent giúp không phải đoán định danh của CLI `skills`, nhưng mở một đường dữ liệu người dùng vào lệnh chạy ngoài. Kiểm định ở quyết định 4 là bắt buộc, và phải có test cho các đầu vào xấu.
- Chọn symlink nghĩa là skills của các agent dùng chung một bản; sửa bản gốc là mọi agent thấy ngay. Đó là hành vi mong muốn trên máy owner, nhưng cần nêu trong README để người dùng không bất ngờ.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Đóng skills vào gói npm rồi tự copy | Ghi đè file do công cụ khác sở hữu; phát hành lại nội dung của tác giả khác khi repo chưa có LICENSE; phải tự bảo trì bản sao |
| Tự `git clone` rồi copy | Vẫn là tự ghi vào thư mục skills, thêm việc tự xử lý cập nhật và xung đột — tức là viết lại CLI `skills` |
| Chỉ in hướng dẫn, không hỗ trợ gì | Yêu cầu rõ ràng của owner là hỗ trợ tới nơi; người mới sẽ dừng ở bước này |
| Dò bằng cách gọi `skills list` | Chậm hơn, cần công cụ đó tồn tại, và phụ thuộc định dạng output của bên thứ ba cho một việc chỉ cần đọc file |
| Cho đổi nguồn skills bằng cờ ngay từ Phase 1 | Mở đường truyền tham số do người dùng cấp vào lệnh chạy ngoài; hoãn tới khi có nhu cầu thật (Q-011) |
| Tự đoán định danh agent thay vì hỏi người dùng | Định danh do CLI `skills` quy định và có thể đổi; đoán sai là luồng hỗ trợ gãy im lặng |
| Dùng `--copy` để mỗi agent có bản riêng | Lệch với bố cục symlink mà máy đang dùng; tạo ra nhiều bản phải đồng bộ tay |

## Revision

| Date | Change |
|---|---|
| 2026-09-14 | Bản đầu, Accepted |
| 2026-09-14 | Sửa quyết định 4 và 5 theo chốt của owner: cho người dùng nhập danh sách agent (kèm quy tắc kiểm định) và dùng chế độ symlink mặc định. Bổ sung hệ quả và phương án đã loại tương ứng |
