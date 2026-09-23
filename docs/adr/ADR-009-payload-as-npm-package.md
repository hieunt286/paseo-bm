# ADR-009 — Payload được publish thành gói npm riêng `paseo-bm-plugin`, cùng repo và cùng lần phát hành

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-23 |
| Owner | hieu.nt10 |
| Liên quan | Sửa đổi [ADR-001](ADR-001-plugin-distribution.md) quyết định 1 và mục "Alternatives considered"; [hồ sơ liệt kê paseo.cafe](../operations/paseo-bm-cafe-listing-20260923.md) §4 và §10 |
| Request | `req-20260923T063441Z` — owner trả lời Q10 "other", Q11 a, Q12 b, Q13 b trong chat với Beads Worker |

## Context

Yêu cầu của owner: mỗi lần phát hành vừa lên npm, vừa giữ cho hồ sơ trên [paseo.cafe](https://paseo.cafe) hợp lệ.

Directory ấy có bốn cổng, đã kiểm bằng một PR thật ([#215](https://github.com/paseo-cafe/paseo-cafe/pull/215)) chứ không phải đọc tài liệu:

1. `validate-registry.ts` — `<path>/paseo-plugin.json` trên GitHub phải có `id` khớp tên file hồ sơ. **Đạt** từ khi có manifest ở gốc repo.
2. `plugin-security/targets.ts` dòng 99 — hồ sơ **mới** bắt buộc khai `package`. **Đạt** sau khi khai `paseo-bm`.
3. `validate-registry.ts` phần npm — tarball đã publish phải có `paseo-plugin.json` **ngay gốc**, `name` và `version` khớp. **Đạt** từ 0.3.0-alpha.5.
4. `plugin-security/static-scan.ts` — luật `entrypoint/missing`, blocking: phải có `index.client.ts(x)` hoặc `index.server.ts(x)` **ngay thư mục gốc của plugin**. Quét hai gốc: gốc Git **có** áp `path` (`scan.ts:229`), còn gốc npm **luôn là gốc tarball** (`scan.ts:322`). **Đỏ.**

Cổng 4 là cái không thể lách. Gói `paseo-bm` là trình cài đặt: gốc tarball có `dist/` và `plugin/`, không có runtime entry, và sẽ không bao giờ có — thêm manifest vào đó không cứu được vì luật đòi *entry*, không đòi manifest. Bỏ `package` thì vướng cổng 2. Nói cách khác, registry chỉ nhận plugin mà **gốc gói npm chính là payload nạp được**; đó là hình dạng của `@omercnet/paseo-beads` (repo khai `path`, gói npm riêng cho payload).

ADR-001 quyết định 1 đặt payload trong `plugin/` và đóng vào **gói của trình cài đặt**. Mục "Alternatives considered" của nó loại phương án "tách plugin sang repo riêng và publish độc lập" vì chi phí đồng bộ hai repo ở Phase 1. Quyết định dưới đây **không** tách repo; nó publish đúng thư mục ấy thành gói thứ hai từ cùng một repo và cùng một lần phát hành, nên lý do loại trừ cũ không còn áp dụng.

## Decision

1. **`plugin/` là một gói npm: `paseo-bm-plugin`.** Thư mục có `package.json` riêng; gốc gói chính là payload (`paseo-plugin.json`, `index.client.tsx`, `index.server.ts`, `client/`, `server/`, `shared/`, `roles/`).
2. **Phiên bản hai gói luôn bằng nhau.** `scripts/generate-plugin-version.mjs` sinh cả `plugin/shared/version.ts` lẫn trường `version` của `plugin/package.json` từ `package.json` gốc; một test làm đỏ khi ba chỗ lệch nhau.
3. **Một lần phát hành, hai gói.** `release.yml` publish `paseo-bm` rồi `paseo-bm-plugin`, cùng dist-tag, cùng `--provenance`. Trusted publisher của gói thứ hai trỏ cùng file workflow này.
4. **Đường cài được hỗ trợ không đổi: `npx paseo-bm`.** ADR-001 quyết định 2 → 6 giữ nguyên: trình cài vẫn chép payload từ gói của chính nó sang `~/.paseo-bm/plugin/<version>/` rồi đăng ký, không lấy từ `paseo-bm-plugin`. Gói thứ hai **không** nằm trên đường cài.
5. **Gói thứ hai hứa đúng một điều: nạp được** — và phải nói đúng bằng lệnh nào. Paseo **0.8 không có nguồn npm**: `paseo plugin add --help` chỉ nhận thư mục trên máy hoặc nguồn Git, nên trên 0.8 lệnh cài thẳng là `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin`; dạng `npm:<gói>@<v>` là của **0.9 trở lên**, và trang listing tự gắn đúng hai nhãn ấy. Cả hai đường đều cho giao diện nhưng **không** có ba vai trò `bm-*` — trình cài mới đăng ký chúng. Hai caveat của hồ sơ nói thẳng điều này. Việc cho payload tự đăng ký vai trò lần đầu là **một yêu cầu riêng**, làm sau khi liệt kê xong (owner chốt Q12 b).
6. **Hồ sơ registry** khai `path: "plugin"` và `package: "paseo-bm-plugin"`.

## Consequences

**Tích cực**
- Qua được cả bốn cổng: cổng 4 quét `plugin/` cho nguồn Git và gốc gói mới cho npm, cả hai đều có runtime entry thật.
- Gói thứ hai là payload đúng nghĩa, đọc được, kiểm được, có provenance — ai muốn soi mã trước khi tin thì tải đúng thứ chạy trên máy mình.
- Không tách repo, không thêm lịch phát hành thứ hai: cùng một tag, cùng một workflow.

**Tiêu cực / phải chấp nhận**
- **Một artifact công khai nữa** mà người ta cài thẳng được và nhận một sản phẩm thiếu vai trò. Trả bằng caveat, và bằng yêu cầu tiếp theo (QĐ 5).
- Publish hai gói trong một job: nếu gói thứ hai hỏng sau khi gói thứ nhất đã lên, không lùi được gói thứ nhất. Thiết kế phải kiểm mọi thứ kiểm được **trước** bước publish đầu tiên.
- Lần đầu phải publish bản giữ chỗ rồi `npm trust github` cho tên mới, vì trusted publishing chỉ cấu hình được cho gói đã tồn tại (runbook §1).
- Metadata của listing chuyển sang đọc trong `plugin/`, nên `plugin/` cần `package.json` và `README.md` của riêng nó.

## Alternatives considered

| Phương án | Lý do loại |
|---|---|
| Thêm `index.client.tsx` và `index.server.ts` ở gốc repo, chỉ re-export từ `plugin/` | Làm gốc repo *trông như* plugin trong khi payload thật ở chỗ khác; chưa kiểm chứng bundler của Paseo có theo được import tương đối khi nạp từ gốc; và gốc tarball npm vẫn phải có shim ấy, tức vẫn publish một thứ nạp ra sản phẩm thiếu vai trò — bằng đúng cái giá của QĐ 1 nhưng mập mờ hơn |
| Xin maintainer một ngoại lệ | Cổng 4 là kiểm tự động trong CI của họ, không phải ý kiến con người; bot review của chính họ cũng đã nêu đúng mối lo |
| Bỏ chuyện liệt kê | Trái yêu cầu của owner |
| Đưa trình cài vào chính gói payload | Trộn hai thứ khác nhau vào một gói; `npx` một gói payload là chuyện vô nghĩa, và gốc gói khi ấy lại có thêm `dist/` của CLI |
