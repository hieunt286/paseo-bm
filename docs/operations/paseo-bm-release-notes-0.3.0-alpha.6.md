# paseo-bm 0.3.0-alpha.6

Bản **đóng gói**, không có tính năng mới và không đổi hành vi của agent hay của trình cài. Từ bản này, mỗi lần phát hành cho ra **hai gói npm** cùng phiên bản: `paseo-bm` (trình cài, như cũ) và `paseo-bm-plugin` (payload, gốc gói là plugin nạp được). Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

**Cài bản này:** `npx paseo-bm@next`, hoặc ghim cứng `npx paseo-bm@0.3.0-alpha.6`. Không có gì trong cách cài đổi cả.

## Vì sao có gói thứ hai

[paseo.cafe](https://paseo.cafe) chỉ liệt kê được plugin mà **gốc gói npm chính là payload nạp được**: bộ quét an ninh của họ đòi `index.client.ts(x)` hoặc `index.server.ts(x)` ngay gốc plugin, và với npm nó luôn quét gốc tarball. Gói `paseo-bm` là trình cài đặt nên không bao giờ qua được cửa đó — chi tiết bốn cổng ở [hồ sơ liệt kê](./paseo-bm-cafe-listing-20260923.md) §4 và §10, quyết định ở [ADR-009](../adr/ADR-009-payload-as-npm-package.md).

## Thay đổi

- **`paseo-bm-plugin` là gói mới**, gốc gói gồm `paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`, cộng `README.md` và `LICENSE` của riêng nó. Phiên bản luôn bằng `paseo-bm`, publish cùng một lần chạy `release.yml`, cùng provenance.
- **Ba nguồn phiên bản không thể lệch nhau**: `package.json` ở gốc, `plugin/package.json`, và `PLUGIN_VERSION`. Trình sinh ghi hai cái sau từ cái đầu, và một test làm đỏ khi chúng khác nhau.
- **Ảnh chụp màn hình chuyển vào `plugin/images/`** cho trang listing, và **không** nằm trong tarball nào: gói payload không liệt kê chúng, gói trình cài loại chúng bằng mẫu phủ định, và `smoke:packed` kiểm điều đó trên tarball thật.
- `plugin/LICENSE` xuất hiện vì MIT đòi kèm giấy phép trong mọi bản sao, mà gói payload là một bản phân phối độc lập.

## Cảnh báo: cài thẳng gói payload thì thiếu vai trò

`paseo-bm-plugin` **nạp được**, nhưng nó chỉ là payload: ba vai trò `bm-manager`, `bm-worker`, `bm-reviewer` do **trình cài** đăng ký, không phải do payload. Cài thẳng thì màn hình lên nhưng Beads Manager không tạo được Worker, tức sản phẩm không chạy đầu-cuối.

Lệnh cài thẳng khác nhau theo phiên bản Paseo — 0.9 trở lên mới có nguồn npm:

```bash
# Paseo 0.9+
paseo plugin add npm:paseo-bm-plugin@0.3.0-alpha.6
# Paseo 0.8
paseo plugin add hieunt286/paseo-bm --ref <commit> --path plugin
```

**Cách cài được hỗ trợ vẫn là `npx paseo-bm`.**

## Không đổi

- Mã trình cài, mã plugin, chỉ dẫn vai trò, hợp đồng `--json`, lệnh và mã thoát: giữ nguyên.
- dist-tag `latest` của `paseo-bm` do owner dời tay; `release.yml` chỉ đặt `next`.

## Nguồn

- Yêu cầu `req-20260923T063441Z`; [ADR-009](../adr/ADR-009-payload-as-npm-package.md); [delta thiết kế](../design/paseo-bm-delta-20260923-payload-npm-package.md); [delta plan](../plans/paseo-bm-implementation-plan-delta-20260923-payload-npm-package.md) phase 2a-20.
