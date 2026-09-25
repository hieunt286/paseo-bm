# ADR-004 — Tích hợp Paseo qua CLI; bật `pluginsEnabled` bằng sửa tối thiểu `config.json` rồi reload

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Liên quan | [PRD REQ-005, REQ-006, REQ-010d](../product/paseo-bm-prd.md#6-functional-requirements), [ADR-001](ADR-001-plugin-distribution.md), [ADR-002](ADR-002-install-ownership-model.md), [Technical Design](../design/paseo-bm.md) |
| Sửa đổi bởi | [ADR-008](ADR-008-role-settings-written-by-plugin.md), quyết định 1 (Accepted 2026-09-22) |

## Context

paseo-bm cần ba việc ở phía Paseo: đọc trạng thái daemon, đăng ký/gỡ plugin, và bật công tắc `pluginsEnabled` khi người dùng đồng ý.

Khảo sát trên máy (Paseo 0.8.0, 2026-09-14):

- `paseo daemon status --json` trả về `home`, `cliVersion`, `daemonVersion`, `listen`, `localDaemon`, `connectedDaemon` — đủ cho toàn bộ bước kiểm tra môi trường.
  - *Errata 2026-09-25 (bm-qh4c):* Paseo 0.9.2 bỏ `cliVersion` khỏi `daemon status --json`. Lớp thích ứng khi đó lấy phiên bản CLI từ `paseo --version`; quyết định ở mục 2 không đổi.
- `paseo plugin install|ls|logs|enable|disable|remove` đều có `--json` và `--host`.
- **Không có lệnh CLI nào để đặt một trường cấu hình tuỳ ý.** `paseo daemon` chỉ có `start`, `pair`, `reload`, `status`, `stop`, `restart`, `set-password`.
- `paseo daemon reload --json` (bí danh `paseo reload`) nạp lại `config.json` mà không cần khởi động lại daemon.
- `~/.paseo/config.json` hiện có các khoá `version`, `daemon`, `app`, `agents`, `features`; **không có** `pluginsEnabled` và `plugins` — thiếu nghĩa là tắt.
- SDK `@getpaseo/client` (npm `0.8.0`) có `config.patch`, là cách paseo-room dùng. Nhưng paseo-room ghim SDK đúng `0.8.0-beta.1`, và cách ghi của nó đọc rồi ghi đè **cả mảng** `agentProfiles`, nên có thể nuốt mất thay đổi song song từ ứng dụng.
- Tài liệu plugin chính thức hướng dẫn đúng trình tự: giữ nguyên phần còn lại của `config.json`, đặt `pluginsEnabled` ở cấp gốc, chạy `paseo reload --json`, rồi kiểm tra `pluginsEnabled` có trong `appliedPaths`.
- Cũng tài liệu đó cảnh báo: **không khởi động lại daemon** để nạp thay đổi, vì có thể giết agent đang chạy.

## Decision

1. **Mặc định tích hợp qua CLI `paseo`**, không phụ thuộc SDK. Mọi lệnh gọi đều dùng `--json` và được bọc trong một lớp thích ứng duy nhất.
2. **Kiểm tra môi trường** bằng `paseo daemon status --json`: daemon phải chạy, `cliVersion` phải khớp `daemonVersion`, phiên bản phải `>=0.8.0`, và `home` là nguồn sự thật cho đường dẫn Paseo (`PASEO_HOME` và cờ chỉ để ghi đè khi dò).
3. **Đăng ký và gỡ plugin** bằng `paseo plugin install|remove|ls|logs`, không sửa tay khoá `plugins` trong `config.json`.
4. **Bật `pluginsEnabled`**, chỉ sau khi có đồng ý rõ ràng, theo đúng trình tự:
   1. Đọc `config.json`, backup vào thư mục cài đặt của paseo-bm.
   2. Đọc–sửa–ghi ngay trước khi ghi, chỉ đặt **một trường ở cấp gốc**, giữ nguyên mọi khoá khác và thứ tự khoá. Ghi atomic theo ADR-002.
   3. `paseo daemon reload --json`, yêu cầu thấy `pluginsEnabled` trong `appliedPaths`; nếu `appliedPaths` rỗng thì đọc lại file và kiểm tra trạng thái thực tế.
   4. Xác nhận bằng `paseo plugin ls --json` cho tới khi `paseo-bm` đạt `running`, có giới hạn thời gian chờ.
   5. Reload thất bại hoặc daemon từ chối cấu hình → khôi phục backup, reload lại, báo lỗi.
5. **Không bao giờ** chạy `paseo daemon restart` hay `stop`.
6. **Ghi lại ai bật**: nếu chính paseo-bm bật công tắc thì ghi vào hồ sơ cài đặt. Chỉ khi đó, và khi không còn plugin nào khác trong `paseo plugin ls`, lệnh gỡ mới đề nghị tắt lại.
7. ~~**Không chạm** tới `agents.providers`, `daemon.agentProfiles` hay bất kỳ khoá nào khác — khác hẳn phạm vi của paseo-room.~~
   **Sửa 2026-09-15 — [ADR-006](ADR-006-role-registration.md) thay thế điều khoản này.** Khi sản phẩm mở rộng sang phần điều phối, paseo-bm buộc phải đăng ký vai trò agent, nên nó ghi thêm vào `agents.providers` và `daemon.agentProfiles`, và có thể cả `daemon.mcp.injectIntoAgents`. Nguyên tắc của ADR này vẫn giữ nguyên và áp dụng cho phạm vi mới: chỉ ghi phần mang tiền tố `bm-`, giữ nguyên mọi mục khác, backup trước khi ghi, không bao giờ thay cả mảng, và xác minh lại sau khi reload.
8. Phát hiện xung đột ghi song song bằng cách so nội dung file ngay trước khi ghi với nội dung vừa đọc; khác thì đọc lại và thử lại một lần, vẫn khác thì dừng và báo người dùng đóng màn hình Settings.

## Đã kiểm chứng trên daemon thật (2026-09-14, Paseo 0.8.0)

Cài rồi gỡ một plugin rỗng ở `/tmp`, đối chiếu `config.json` trước và sau:

- `paseo plugin install <dir>` **thành công khi `pluginsEnabled` chưa được đặt**, mã thoát 0, trả `{"id","path","enabled":true,"status":"disabled"}`. Do đó thứ tự "đăng ký trước, xin đồng ý bật sau" là hợp lệ.
- `enabled` là công tắc riêng của plugin; `status` mới phản ánh trạng thái thực (`disabled` khi công tắc toàn cục tắt). Mọi kiểm tra "plugin đã chạy chưa" phải đọc `status`.
- Chính Paseo ghi khoá `plugins: { "<id>": { "source": "directory", "path": "…", "enabled": true } }` vào `config.json`. Khẳng định lại quyết định 3: paseo-bm không tự ghi khoá này.
- `paseo plugin remove` xoá mục của plugin nhưng **để lại khoá `plugins: {}`** và **không xoá thư mục nguồn**. Vì vậy paseo-bm tự xoá payload của mình và không đụng vào khoá `plugins`.

## Consequences

**Tích cực**
- Không có phụ thuộc SDK bị ghim phiên bản — đúng điểm gãy đã thấy ở paseo-room.
- Phạm vi ghi vào cấu hình của người khác thu về đúng **một trường boolean**, nên rủi ro và bề mặt kiểm thử đều nhỏ.
- Dùng đúng trình tự mà tài liệu Paseo khuyến nghị, nên ít khả năng lệch khi Paseo nâng cấp.
- Không có nguy cơ giết agent đang chạy.

**Tiêu cực / phải chấp nhận**
- Phụ thuộc vào định dạng JSON của CLI. Giảm thiểu: parse phòng thủ, chỉ lấy trường cần, có thông điệp lỗi rõ khi hình dạng đổi, và kiểm thử với CLI giả lập.
- Gọi tiến trình con chậm hơn SDK. Không đáng kể ở quy mô vài lệnh mỗi lần chạy.
- Vẫn còn khe hở ghi song song rất hẹp giữa lúc đọc và lúc `rename`. Giảm thiểu bằng kiểm tra lại trước khi ghi và thử lại một lần.
- Sửa file trực tiếp nghĩa là phải giữ được định dạng: dùng đọc–sửa–ghi trên cấu trúc JSON, chấp nhận có thể chuẩn hoá lại khoảng trắng. Backup luôn được tạo trước.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Dùng `@getpaseo/client` `config.patch` | Thêm một phụ thuộc nữa phải bám theo phiên bản Paseo; paseo-room đã cho thấy ghim SDK là điểm gãy; chỉ để đặt một trường boolean thì không xứng. Giữ làm phương án dự phòng nếu CLI thiếu thứ cần |
| Yêu cầu người dùng tự bật trong Settings | Thêm một bước tay đúng vào chỗ hay quên nhất — chính vấn đề mà PRD muốn xoá bỏ. Vẫn giữ như hướng dẫn khi người dùng từ chối cho paseo-bm sửa |
| Khởi động lại daemon cho chắc | Tài liệu cấm rõ; có thể giết agent đang chạy |
| Ghi thẳng khoá `plugins` vào `config.json` thay vì gọi `paseo plugin install` | Bỏ qua bước xác thực của Paseo; định dạng nguồn plugin là chi tiết nội bộ có thể đổi |
