# paseo-bm 0.3.0-alpha.5

Bản **đóng gói**, không có tính năng mới và không đổi hành vi của agent hay của trình cài. Mục đích duy nhất: đưa `paseo-plugin.json` vào **gốc tarball npm**, điều kiện để paseo-bm được liệt kê trên [paseo.cafe](https://paseo.cafe). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

**Cài bản này:** `npx paseo-bm@next`, hoặc ghim cứng `npx paseo-bm@0.3.0-alpha.5`. `npm view paseo-bm dist-tags` cho biết `latest` hiện ở đâu.

## Thay đổi

### Gói npm

- **`paseo-plugin.json` giờ nằm ở gốc tarball** cạnh `package.json`, `README.md` và `LICENSE`; `dist/` và `plugin/` không đổi, `plugin/paseo-plugin.json` vẫn ở nguyên chỗ cũ. CI của paseo.cafe tải gói đã publish rồi đọc manifest **ở gốc tarball** và không áp trường `path`, nên không có file này thì hồ sơ không qua được. Trình cài không bị ảnh hưởng: `findPayloadRoot` tìm `<thư mục>/plugin/paseo-plugin.json`, không phải file ở gốc.

### Kho mã (không vào gói npm)

- `paseo-plugin.json` ở gốc repo, bản sao byte-for-byte của `plugin/paseo-plugin.json`, kèm một test làm đỏ ngay khi hai file lệch nhau. Đây là file mà bộ quét của paseo.cafe đọc trên GitHub.
- README đổi tên hai mục thành `Install` và `Limitations and warnings`, đúng tên mà bộ quét tìm. Nội dung không đổi một chữ.
- `images/` có ba ảnh chụp màn hình: màn Beads, một request trên màn Metric, và trình cài hỏi ba vai trò.
- `docs/operations/paseo-bm-cafe-listing-20260923.md` ghi toàn bộ hồ sơ: nội dung file registry, ba cổng CI của họ, rủi ro đã chấp nhận và các bước còn lại.

## Cảnh báo: đừng cài bằng `paseo plugin add npm:`

Vì gốc tarball nay có manifest, lệnh `paseo plugin add npm:paseo-bm@0.3.0-alpha.5` sẽ **tìm thấy plugin nhưng nạp lỗi**: gốc gói không có `index.client.tsx` và `index.server.ts` — payload thật nằm trong `plugin/`, và bản thân payload cũng không tự đăng ký ba vai trò `bm-*` được. Paseo giữ lại mục hỏng trong cấu hình; gỡ bằng `paseo plugin remove paseo-bm`.

**Cách cài duy nhất được hỗ trợ vẫn là `npx paseo-bm`**, vì nó vừa chép payload, vừa đăng ký plugin, vừa đăng ký ba vai trò và hỏi đồng ý. Hồ sơ trên paseo.cafe nói đúng chuyện này trong hai caveat đầu.

## Không đổi

- Không sửa mã trình cài, mã plugin, chỉ dẫn vai trò hay hợp đồng `--json`.
- dist-tag `latest` do owner dời tay; `release.yml` chỉ đặt `next`. Kiểm ngày 2026-09-23 bằng `npm view paseo-bm dist-tags`: `latest` và `next` cùng ở `0.3.0-alpha.4`, nên khi owner dời `latest` sang bản này, người dùng `npx paseo-bm` trần đi từ `0.3.0-alpha.4` lên `0.3.0-alpha.5` — một bước đóng gói, không có thay đổi hành vi. (Bảng dist-tag trong [hồ sơ chạy 20260923](./paseo-bm-release-run-20260923.md) chụp thời điểm ngay sau workflow, khi `latest` còn ở `0.2.0-alpha.1`; owner đã dời sau đó.)

## Nguồn

- Yêu cầu `req-20260923T063441Z` — đăng ký plugin lên paseo.cafe.
- [Hồ sơ liệt kê paseo.cafe](./paseo-bm-cafe-listing-20260923.md), đặc biệt §4 (vì sao hồ sơ mới bắt buộc khai npm) và §9 (các bước phát hành).
- PR [paseo-cafe/paseo-cafe#215](https://github.com/paseo-cafe/paseo-cafe/pull/215).
