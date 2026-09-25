# Design delta — Đường phát hành nhận bản ổn định, dist-tag theo loại phiên bản

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260925b-stable-release` |
| Design gốc | [Technical Design paseo-bm](../../design/paseo-bm.md) (Active) §10 và errata 2026-09-18. **Không sửa tại chỗ** |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-25 |
| Request | `req-20260925T033834Z` — "Tôi muốn tạo một bàn release 0.1.0 trên paseo.cafe và npm, hãy xem quy trình triển khai hiện tại và release phiên bản giúp tôi" |
| Quyết định của owner | Q1 a (bản ổn định `0.3.0` thay cho `0.1.0`), Q2 a (commit phần việc REQ-069 đang treo rồi phát hành), Q3 a (sửa `release.yml` nhận bản ổn định, đặt dist-tag `latest`), Q4 a (cập nhật hồ sơ trên nhánh PR #215 và nhắc maintainer) |
| Source PRD | [PRD](../../product/paseo-bm-prd.md) §11 Phase 1 — điều kiện *"một phiên bản prerelease có trên npm kèm provenance"* **đã đạt** từ `0.1.0-alpha.0`; delta này không thêm hay đổi một REQ nào |
| ADR | Không ADR mới. Delta này chạy trong khuôn [ADR-009](../../adr/ADR-009-payload-as-npm-package.md) (một lần phát hành, hai gói) và giữ nguyên quyết định "không NPM_TOKEN, chỉ OIDC" |
| Phase | **Phase 2a-21 — Phát hành bản ổn định `0.3.0`** |

## 0. Routing Decision

| Trigger | Có? | Hệ quả |
|---|---|---|
| Public contract đổi | **Có** — bản phát hành mà `npx paseo-bm` lấy về chuyển từ prerelease sang ổn định | Cần design delta này + delta plan; không cần PRD delta vì không REQ nào đổi |
| Rollback yếu (R3) | **Có** — `npm publish` không lùi được sau 72 giờ | Chủ rủi ro: owner. Diễn tập: dry-run `release.yml`. Điểm phê duyệt: tạo GitHub Release |
| Schema / auth / dữ liệu thật | Không | — |
| Cross-stack | Không | Một repo, cộng một PR ở repo `paseo-cafe/paseo-cafe` (ngoài tầm repo này, chỉ là một file JSON) |

Đường đi: **design delta + delta plan + beads**, gates `design-ready` (tự chấm ở §6) và `plan-ready-for-beads` (ở delta plan).

## 1. Điều đang có

`.github/workflows/release.yml`, bước `Resolve version, tag and dist-tag`, chặn thẳng mọi bản không phải prerelease:

```js
const prerelease = version.includes("-");
if (!prerelease) {
  console.error(`Phase 1 publishes prereleases only, under dist-tag next; ${version} is not a prerelease.`);
  process.exit(1);
}
const distTag = "next";
```

Hệ quả hôm nay: `0.3.0` **không đi qua được workflow**, và mọi bản chỉ vào dist-tag `next`; `latest` — thứ `npx paseo-bm` lấy — do owner dời tay bằng `npm dist-tag add`, cần OTP.

## 2. Quyết định

### 2.1 Workflow nhận bản ổn định

Bỏ đúng cái chặn ở §1. Phép kiểm **giữ lại**: tag phải bằng `v<version>` của `package.json`, và cờ `prerelease` của GitHub Release phải khớp với hình dạng phiên bản (`version.includes("-")`). Nghĩa là một bản ổn định phải được tạo Release **không** đánh dấu prerelease; đánh dấu sai thì workflow đỏ trước khi publish.

### 2.2 dist-tag theo loại phiên bản

```js
const distTag = prerelease ? "next" : "latest";
```

Một dòng, và nó xoá bước tay cần OTP cho mọi bản ổn định về sau: `npm publish --tag latest` chạy bằng OIDC trong cùng lần chạy đã publish gói, nên không có yếu tố thứ hai nào phải nhập. Bước `Verify published version` và `Verify published payload` vốn đã đọc `npm view <gói>@${DIST_TAG} version`, nên chúng tự kiểm đúng tag mới, không cần sửa.

### 2.3 `next` giữ nguyên ở bản prerelease cuối

Bản ổn định **không** được đẩy thêm vào `next` trong cùng lần chạy. Lý do: việc đó cần `npm dist-tag add`, một lệnh ghi khác với `publish`, và cấu hình trusted publisher của hai gói chỉ ghi `permissions: publish, stage publish` — chưa có bằng chứng nào cho thấy token OIDC dời được dist-tag. Không đưa một lệnh ghi **chưa kiểm chứng** vào giữa một lượt phát hành không đảo ngược được.

Trạng thái sau khi phát hành `0.3.0`, và nó là trạng thái bình thường của npm: `latest` → `0.3.0`, `next` → `0.3.0-alpha.7`. Ai muốn `@next` cũng trỏ bản ổn định thì owner chạy tay `npm dist-tag add paseo-bm@0.3.0 next` và tương tự cho `paseo-bm-plugin` — **không** thuộc phạm vi delta này.

### 2.4 Những gì không đổi

Tên file `release.yml` (trusted publisher của **cả hai** gói trỏ theo tên file); xác thực OIDC, không secret; `--provenance --access public`; thứ tự publish gói trình cài trước, payload sau; toàn bộ ma trận `verify` (macOS + Linux × Node 24), `smoke:packed`, bước chặn "Assert both packages agree"; và luật một phiên bản cho hai gói.

## 3. Ảnh hưởng tới paseo.cafe

- Cổng 3 của registry so phiên bản `paseo-bm-plugin` mà nó phân giải trên npm với `plugin/package.json` trên nhánh mặc định. Sau khi phát hành, cả hai là `0.3.0` — khớp. `resolveNpmPackage` đọc `paseo-bm-plugin@latest`, mà từ §2.2 `latest` **tự** trỏ bản mới, nên cái bẫy số 3 ở [hồ sơ listing](../../operations/paseo-bm-cafe-listing-20260923.md) §9 không còn cần bước tay.
- Hồ sơ `registry/paseo-bm.json` trên nhánh PR `hieunt286:add-paseo-bm` có caveat *"Prerelease 0.3.0-alpha: …"* — câu này sai ngay khi `0.3.0` lên npm, nên phải sửa cùng lần phát hành (Q4 a). PR [#215](https://github.com/paseo-cafe/paseo-cafe/pull/215) vẫn **OPEN** từ 2026-09-23, chưa merge, nên paseo-bm **chưa** có trang listing; việc merge thuộc maintainer bên đó và không phải điều kiện ra của phase này.
- Sửa file hồ sơ vẫn phải giữ hai luật đã học: Biome của họ giữ mảng ngắn trên một dòng, và không ghi file từ một giá trị chưa kiểm là khác rỗng.

## 4. Errata các tài liệu nói "prerelease" hoặc "chỉ `next`"

Bản ổn định làm **bảy câu** đang đúng trở thành sai, nằm trong **năm file**. Sửa đúng những câu đó, không viết lại tài liệu:

| File | Câu hiện tại | Thành |
|---|---|---|
| `README.md` dòng 12 | *"Status: prerelease (`0.3.0-alpha.*`)"* | trạng thái ổn định `0.3.0`, giữ nguyên câu về public contract |
| `GUIDE.md` dòng 78 | *"`latest` … moved by hand, and while a prerelease is the newest build it may still point at an older one"* | `latest` do `release.yml` đặt cho bản ổn định; `next` là nơi bản prerelease đi vào |
| `GUIDE.md` dòng 413 | *"`npx paseo-bm@next` takes the newest prerelease … may be older than `next`"* | cùng luật như trên |
| `AGENTS.md` dòng 30 (bảng Tech stack, dòng "Release") | *"prereleases go to dist-tag `next`"* — còn đúng nhưng không còn là cả luật, và đây là dòng một agent đọc trước tiên | prerelease → `next`, bản ổn định → `latest`, cả hai do workflow đặt |
| `AGENTS.md` mục "Two packages, one release", gạch đầu dòng "Forgetting the dist-tag" | *"`release.yml` only sets `next`. Moving `latest` needs a one-time password, so it is the owner's step"* | prerelease → `next`, bản ổn định → `latest`, cả hai do workflow đặt; `next` cho một bản ổn định vẫn là việc tay của owner |
| `docs/operations/paseo-bm-release-runbook.md` | §2 chỉ mô tả luồng prerelease (`--prerelease`) | thêm §4: luồng bản ổn định (Release **không** đánh dấu prerelease, dist-tag `latest` tự đặt) |
| `docs/operations/paseo-bm-cafe-listing-20260923.md` §9 mục 3 | *"Lệnh này đòi OTP nên là việc của owner"* | chỉ còn đúng cho prerelease; bản ổn định workflow tự đặt `latest` |

## 5. Rủi ro và đường lùi

| Rủi ro | Xử lý |
|---|---|
| `latest` không dời sang bản mới sau khi publish | **Diễn tập không kiểm được chuyện này**: `npm publish --dry-run` đóng gói tại chỗ và không hỏi registry publish, nên nó chỉ chứng minh workflow tính ra `dist-tag=latest` và tarball đóng gói được. Nếu `0.3.0` lên npm mà `latest` vẫn ở bản cũ thì đường chặn là bước tay vẫn dùng tới hôm nay: owner chạy `npm dist-tag add paseo-bm@0.3.0 latest` (và cho gói payload), đúng như mọi lần trước. Gói đã publish không bị ảnh hưởng |
| Publish gói trình cài xong rồi đứt ở gói payload | Không đổi so với trước: "Assert both packages agree" chạy trước mọi publish, và trusted publisher của gói payload đã xác nhận ([listing record §12](../../operations/paseo-bm-cafe-listing-20260923.md)) |
| Bản ổn định hoá ra có lỗi | Đường lùi vẫn là **phát hành bản vá** (`0.3.1`), không `npm unpublish`. Ghim `npx paseo-bm@0.3.0-alpha.7` chỉ là đường lùi cho người đang dùng **Paseo 0.8**: trên Paseo 0.9.2 bản đó không cài được vì thiếu bản vá `cliVersion` của bead `bm-qh4c`, nó dừng ở `E_PASEO_OUTPUT_UNEXPECTED` (exit 3) |
| `latest` nhảy từ `0.3.0-alpha.7` sang `0.3.0` | Không phải bước lùi: cùng mã, cộng REQ-069 và bản vá trình cài đặt cho Paseo 0.9.2 (`bm-qh4c`). Ghi chú phát hành nói rõ ở mục "Cần biết khi nâng cấp" |

## 6. Gate design-ready — tự chấm

| Mục | Kết quả |
|---|---|
| Quyết định đủ để implement không phải đoán | **Đạt** — §2.1 và §2.2 cho đúng mã sẽ nằm trong workflow; §2.3 nói rõ điều **không** làm |
| Hợp với ADR đang Active | **Đạt** — ADR-009 giữ nguyên (hai gói, một phiên bản, một workflow); quyết định "không NPM_TOKEN" giữ nguyên |
| Ảnh hưởng tài liệu đã liệt kê | **Đạt** — §4, bảy chỗ trong năm file |
| Rollback | **Đạt** — §5: bản vá `0.3.1` là đường lùi sau publish, và nếu `latest` không dời thì đường chặn là `npm dist-tag add` của owner (diễn tập **không** kiểm được chuyện đó) |
| Phần chưa quyết | Không còn: bốn câu hỏi của request đã có trả lời của owner |

**Verdict: PASS — 2026-09-25.**

## Revision history

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: `release.yml` nhận bản ổn định, dist-tag theo loại phiên bản, errata bảy chỗ tài liệu trong năm file |
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo review lô `b1`: §5 nói đúng việc `npm publish --dry-run` không hỏi registry và nêu đường chặn thật (`npm dist-tag add` của owner); §4 thêm dòng `AGENTS.md` dòng 30; hai dòng rollback mang cảnh báo Paseo 0.9.2 (`0.3.0-alpha.7` không cài được ở đó); §6 chấm lại theo nội dung mới |
