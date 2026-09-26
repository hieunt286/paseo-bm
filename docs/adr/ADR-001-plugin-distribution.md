# ADR-001 — Phân phối plugin bằng payload đi kèm gói npm, đăng ký từ thư mục cục bộ

| Trường | Giá trị |
|---|---|
| Status | **Superseded by [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25)** — sản phẩm là gói plugin `paseo-bm-plugin` cài từ paseo.cafe / npm; trình cài không còn chép payload và đăng ký thư mục |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Liên quan | [PRD §Q-004](../product/paseo-bm-prd.md#10-open-questions), [Technical Design](../design/paseo-bm.md) |

## Context

Paseo 0.8 nhận plugin từ hai nguồn: một thư mục trên máy daemon (`paseo plugin install <dir>`) hoặc một repo Git (`paseo plugin add owner/repo[:path] --ref <ref>`). Cấu hình daemon lưu nguồn plugin dưới dạng `plugins: record<id, PluginSource>`, và loại nguồn duy nhất được ghi cho bản cài cục bộ là `"directory"` — nghĩa là **đường dẫn thư mục phải tồn tại lâu dài**, không chỉ trong lúc chạy lệnh.

Ràng buộc đã kiểm chứng trên máy (Paseo CLI/daemon 0.8.0, 2026-09-14):

- `paseo plugin install --help` có `--id`, `--ref`, `--path`, `--json`, `--host`; `install` và `add` là cùng một lệnh.
- `paseo plugin update` chỉ áp dụng cho plugin nguồn Git.
- `paseo plugin remove` xoá checkout do Paseo quản lý với nguồn Git, nhưng **không bao giờ xoá thư mục nguồn cục bộ**.
- `paseo plugin init` tạo scaffold chỉ có `devDependencies` (`@getpaseo/plugin`, react, react-native, zod, typescript) phục vụ typecheck; Paseo cấp module runtime cho plugin, nên payload không cần `node_modules` khi chạy.
- PRD yêu cầu: người dùng biết chính xác mã plugin mình đang tin cậy, và sau khi `npx` tải gói thì phần cài plugin không cần mạng.

Vấn đề: `npx` chạy gói từ thư mục cache tạm. Nếu trỏ Paseo vào đó, cache bị dọn là plugin gãy.

## Decision

1. Mã plugin nằm trong chính repo `paseo-bm`, thư mục `plugin/`, và được đóng vào gói npm qua trường `files`.
2. Khi cài, CLI **copy** payload từ gói npm sang `<install home>/plugin/<version>/` (mặc định `~/.paseo-bm/plugin/<version>/`), là một đường dẫn ổn định do paseo-bm sở hữu.
3. Đăng ký với Paseo bằng `paseo plugin install <install home>/plugin/<version> --id paseo-bm --json`.
4. **Phiên bản plugin luôn bằng phiên bản gói npm.** Không dùng `paseo plugin update` (chỉ dành cho nguồn Git); đường cập nhật duy nhất là chạy lại `npx paseo-bm@<version>`.
5. Payload không kèm `node_modules`. `paseo-plugin.json` khai báo `requirements.paseo` là `>=0.8.0`.
6. Khi gỡ: `paseo plugin remove paseo-bm`, rồi paseo-bm tự xoá thư mục payload của mình (vì Paseo không xoá nguồn cục bộ).

## Consequences

**Tích cực**
- Cài plugin không cần mạng và không phụ thuộc GitHub lúc cài.
- Mã chạy đúng bằng mã trong phiên bản npm mà người dùng chọn; provenance của npm phủ luôn payload.
- Không cần bước `build` trong `paseo-plugin.json` (build là của quy trình phát hành), nên không có lệnh lạ chạy trên máy người dùng lúc cài.
- Giữ được nhiều phiên bản cạnh nhau dưới `plugin/<version>/`, nên hạ cấp hay khắc phục sự cố đơn giản.

**Tiêu cực / phải chấp nhận**
- Trùng lặp dữ liệu: payload nằm cả trong gói npm lẫn thư mục cài đặt. Chấp nhận được vì kích thước nhỏ.
- Mất tiện ích `paseo plugin update` và luồng cập nhật trong Settings của Paseo. Bù lại bằng thông điệp rõ ràng trong `doctor` và README.
- paseo-bm phải tự dọn thư mục payload khi gỡ; nếu bỏ sót sẽ còn rác. Ràng buộc bằng hồ sơ cài đặt (ADR-002) và tiêu chí M-5 của PRD.
- Mỗi phiên bản chiếm thêm dung lượng. *(Sửa 2026-09-15: bản đầu đề xuất "giữ tối đa N phiên bản". Owner đã chốt **giữ tất cả**, chỉ dọn khi người dùng chạy `--prune` — xem Technical Design Q-016.)*

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| `paseo plugin add hieunt286/paseo-bm:plugin --ref v<version>` (nguồn Git) | Cần mạng và quyền truy cập GitHub lúc cài; phiên bản plugin tách rời phiên bản npm nên dễ lệch; thêm một đường tin cậy thứ hai ngoài npm provenance. Vẫn giữ như phương án dự phòng nếu sau này cần luồng update của Paseo |
| Trỏ Paseo thẳng vào thư mục cache của `npx` | Cache là tạm; dọn cache là plugin gãy. Loại dứt khoát |
| Tách plugin sang repo riêng và publish độc lập | Phình chi phí phát hành cho một sản phẩm một người; đồng bộ phiên bản giữa hai repo là gánh nặng không cần thiết ở Phase 1 |
| Cài plugin dưới dạng gói npm toàn cục rồi trỏ vào `node_modules` | Paseo không có kiểu nguồn npm; đường dẫn `node_modules` toàn cục khác nhau giữa các trình quản lý phiên bản Node |
