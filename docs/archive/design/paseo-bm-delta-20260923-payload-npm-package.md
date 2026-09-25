# Delta-change — Payload thành gói npm `paseo-bm-plugin`, phát hành cùng `paseo-bm`

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260923-payload-npm-package` |
| Tài liệu gốc | [Technical Design](../../design/paseo-bm.md) §2.4 (payload plugin). **Không sửa tại chỗ khi chưa duyệt** |
| ADR | [ADR-009](../../adr/ADR-009-payload-as-npm-package.md) (mới, Accepted 2026-09-23); sửa đổi [ADR-001](../../adr/ADR-001-plugin-distribution.md) QĐ1 |
| Plan | [plan-delta-20260923-payload-npm-package](../plans/paseo-bm-implementation-plan-delta-20260923-payload-npm-package.md) |
| Nguồn sự thật đã kiểm | [Hồ sơ liệt kê paseo.cafe](../../operations/paseo-bm-cafe-listing-20260923.md) §3, §4, §10 — đo bằng PR thật #215, không suy từ tài liệu |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Request | `req-20260923T063441Z` |

## 1. Kết quả cần đạt

Một lần chạy `release.yml` cho ra hai gói npm cùng phiên bản, cùng provenance: `paseo-bm` (trình cài, như cũ) và `paseo-bm-plugin` (payload, gốc gói là plugin nạp được). Hồ sơ `registry/paseo-bm.json` chuyển sang `path: "plugin"` + `package: "paseo-bm-plugin"` và job `Registry admission` xanh cả bốn cổng.

## 2. Nền tảng — sự thật đã kiểm trong request này

| # | Sự thật | Nguồn |
|---|---|---|
| S1 | Luật `entrypoint/missing` đòi một trong `index.client.ts`, `index.client.tsx`, `index.server.ts`, `index.server.tsx` ngay gốc plugin; blocking | `plugin-security/static-scan.ts` |
| S2 | Quét Git dùng `target.path ?? "."`; quét npm dùng `pluginPath: "."` — luôn gốc tarball | `plugin-security/scan.ts:229`, `:322` |
| S3 | Quét npm chạy cho **cả** `releases.latest` lẫn `releases.next` | `plugin-security/scan.ts:189`, `:202` |
| S4 | Hồ sơ mới không khai `package` thì `targets.ts` ném lỗi | `plugin-security/targets.ts:99` |
| S5 | `validate-registry.ts` đọc `<path>/paseo-plugin.json` và `<path>/package.json` trên Git, nhưng đọc **gốc tarball** cho npm | `validate-registry.ts` |
| S6 | `resolveNpmPackage` phân giải `<gói>@latest` bằng pacote | `npm-registry.ts` |
| S7 | Listing đọc mô tả, version, README, LICENSE, `images/` **theo `path`**; sáu mục health: manifestValid, hasReadme, hasLicense, hasTests, hasTypecheckScript, updatedRecently | `scripts/scan.ts` |
| S8 | `files` của gói gốc đang là `dist/`, `plugin/`, `paseo-plugin.json`; `plugin/**` vào gói gốc nguyên vẹn | `package.json` |
| S9 | **Mọi** finding của `static-scan.ts` đều blocking, không có mục nào chỉ là khuyến nghị. Ngoài `entrypoint/missing` còn: `manifest/{missing,id,json,build,requirements,requirements.paseo,requirements.unknown,unknown:<key>}`, `entrypoint/legacy-index`, `boundary/{unsupported-sdk-import,runtime-module-import,invalid-module-location,cross-runtime-import}`, `scanner/{symlink,size-limit,incomplete}` | `plugin-security/static-scan.ts` |
| S10 | Node builtin, `node:child_process`, `node:fs`, `process.env` **không** bị soi riêng: chúng chỉ đỏ qua `boundary/runtime-module-import` khi bị import từ mã **không** thuộc `server/`. Mã trong `server/` dùng thoải mái | `plugin-security/static-scan.ts` |
| S11 | `scanner/size-limit` là 2 MB một file; `scanner/symlink` từ chối mọi symlink | `plugin-security/static-scan.ts` |
| S12 | `hasLicense = có file LICENSE/LICENSE.md/license **hoặc** license của repo trên GitHub`; `hasTests = có script `test` **hoặc** một mục tên khớp `/test/i` ngay thư mục `path` | `scripts/scan.ts` |
| S13 | Ảnh lấy từ thư mục `images` **ngay dưới `path`**, cộng ảnh tham chiếu trong README; URL tuyệt đối chỉ được giữ nếu `isTrustedRemoteImageUrl(ref)` — danh sách host tin cậy nằm ở module khác và **chưa kiểm** | `scripts/scan.ts` |
| S14 | Paseo 0.8 **không có nguồn npm**: `paseo plugin add --help` chỉ nhận "Host directory, Git source, or Git source:plugin/path". Trang listing tự gắn nhãn lệnh npm là "NPM (Paseo 0.9+)" và để lệnh Git làm "GitHub Fallback (Paseo 0.8)" | CLI 0.8.0 trên máy; trang `paseo.cafe/plugins/paseo-beads`; [ADR-001](../../adr/ADR-001-plugin-distribution.md) |

Hệ quả của S3 đáng chú ý: sau khi đổi hồ sơ, **cả `latest` lẫn `next`** của `paseo-bm-plugin` đều bị quét, nên đừng để một bản hỏng nằm ở `next`.

## 3. `plugin/package.json`

Trường bắt buộc và lý do từng trường:

```jsonc
{
  "name": "paseo-bm-plugin",
  "version": "<đồng bộ từ package.json gốc>",   // S5: validate-registry so version Git với npm
  "description": "...",                          // S7: listing lấy mô tả từ đây khi có path
  "license": "MIT",
  "type": "module",                              // giữ nguyên ngữ nghĩa module như gốc repo
  "repository": { "type": "git", "url": "git+https://github.com/hieunt286/paseo-bm.git", "directory": "plugin" },
  "files": ["paseo-plugin.json", "index.client.tsx", "index.server.ts", "client/", "server/", "shared/", "roles/", "tsconfig.json", "LICENSE", "README.md"],
  "scripts": { "typecheck": "tsc -p tsconfig.json" },   // chạy từ checkout của repo, không chạy được từ tarball
  "engines": { "node": ">=22" },
  "keywords": ["paseo", "paseo-plugin", "beads"]
}
```

Không có `dependencies`: Paseo cấp module runtime cho plugin (ADR-001 Context). Không có `bin`.

`scripts.typecheck` là lệnh **chạy từ checkout của repo**, đúng thứ `npm run typecheck:plugin` ở gốc đang chạy; từ tarball đã publish nó **không** chạy được vì gói không khai `dependencies` (typescript và các gói `@types/*` nằm ở devDependencies của repo). Ghi đúng như vậy chứ không gọi nó là lệnh chạy được ở mọi nơi.

**Không thêm script `test`**: trong `plugin/` không có test nào, và bịa một script cho qua mục health `hasTests` là làm cho kiểm tra trông xanh — cấm. Payload **có** được kiểm thật, bằng 71 file dưới `test/` ở gốc repo, nhưng chúng không nằm dưới `path` nên `hasTests` (S12) vẫn không đạt. Chấp nhận **5/6** mục health: `hasLicense` vẫn đạt nhờ license của repo (S12), chỉ `hasTests` không.

`plugin/tsconfig.json` được liệt kê trong `files` vì `scripts.typecheck` của chính gói tham chiếu nó.

## 4. Đồng bộ phiên bản

`scripts/generate-plugin-version.mjs` hiện sinh `plugin/shared/version.ts`. Mở rộng: cùng lúc ghi trường `version` của `plugin/package.json`, giữ nguyên mọi trường khác và thứ tự khoá, và vẫn idempotent (chỉ ghi khi nội dung đổi). Script này đã nằm trong `build`, mà `prepack` chạy `build`, nên mọi tarball đều mang phiên bản đúng.

Một test mới làm đỏ khi ba nguồn lệch nhau: `package.json`, `plugin/package.json`, `PLUGIN_VERSION`.

## 5. `release.yml`

Thêm vào job publish, **sau** bước "Publish to npm" hiện có và trước bước xác minh cuối:

1. `Publish payload to npm` — `npm publish --provenance --access public --tag "${DIST_TAG}"` chạy với `working-directory: plugin`.
2. `Verify published payload` — lặp `npm view "paseo-bm-plugin@${DIST_TAG}" version` cho tới khi bằng `VERSION`, cùng kiểu chờ như bước hiện có (npm trả "being processed").

Thứ tự này cố ý: gói trình cài là thứ người dùng thật sự cần, publish trước. Trước cả hai, thêm một bước kiểm **trước khi publish bất cứ gì**:

3. `Assert both packages agree` — `plugin/package.json` phải có `name` là `paseo-bm-plugin` và `version` bằng `VERSION`; `npm publish --dry-run` cho cả hai. Hỏng ở đây thì chưa có gì lên npm.

Trusted publisher cho `paseo-bm-plugin` trỏ cùng file `release.yml` (ghi chú đầu file đã cảnh báo: đổi tên file là gãy publish).

## 6. Metadata của listing khi `path: "plugin"`

| Mục | Đọc ở đâu | Cách đáp ứng |
|---|---|---|
| Mô tả | `plugin/package.json.description` | viết trong §3 |
| Version | `plugin/package.json.version` | đồng bộ, §4 |
| README | `plugin/README.md` | **file mới**: mô tả ngắn payload, nói thẳng `npx paseo-bm` mới là cách cài đầy đủ, link về README và GUIDE ở gốc |
| LICENSE | `plugin/LICENSE` **hoặc** license của repo (S12) | **Chép `LICENSE` vào `plugin/` và liệt kê trong `files`.** Không phải vì mục health — mục đó đã đạt nhờ license của repo — mà vì giấy phép: MIT đòi kèm bản quyền và giấy phép trong **mọi bản sao**, và gói payload là một bản phân phối độc lập. Một test giữ hai file không lệch nhau, như cách làm với manifest |
| Ảnh | `<path>/images` rồi tới ảnh trong README (S13) | **Chuyển** `images/` ở gốc repo sang `plugin/images/` — chuyển chứ không chép, vì sau khi hồ sơ khai `path: "plugin"` thì thư mục ở gốc không còn ai đọc. Không dựa vào URL tuyệt đối trong README: S13 cho thấy chúng chỉ được giữ nếu host nằm trong danh sách tin cậy mà ta **chưa** kiểm được, và ba tấm ảnh owner đưa thì không nên đem ra đánh cược |
| hasTests | script `test` hoặc một mục tên khớp `/test/i` ngay dưới `path` (S12) | **không đạt**, cố ý (§3) |

Ảnh **không** được vào tarball nào: `plugin/package.json` không liệt kê `images/`, còn `files` của gói trình cài thêm mẫu phủ định `"!plugin/images/**"`. `smoke:packed` khẳng định cả hai tarball đều không có ảnh — nếu npm không tôn trọng mẫu phủ định thì test đỏ ngay chứ không phải phát hiện sau.

## 7. Hồ sơ registry sau thay đổi

```json
{
  "repo": "hieunt286/paseo-bm",
  "path": "plugin",
  "package": "paseo-bm-plugin",
  "categories": ["orchestration", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [ "... hai caveat đầu giữ nguyên ý: npx paseo-bm mới là cách cài thật ..." ],
  "submittedBy": "hieunt286"
}
```

Caveat số 2 phải sửa lại, và phải sửa cho đúng **phiên bản Paseo** (S14): trên **0.8**, lệnh mà trang sinh ra cho nguồn Git — `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin` — từ nay **nạp được** giao diện, nhưng thiếu ba vai trò; lệnh dạng `npm:` chỉ chạy trên **0.9 trở lên**, và trang tự gắn nhãn như vậy. Câu caveat cũ nói "fails to load" sẽ thành sai ngay khi gói payload tồn tại. Nói sai kiểu nào cũng là nói sai.

## 8. Rủi ro và hoàn tác

| Rủi ro | Xử lý |
|---|---|
| Publish gói 1 xong, gói 2 hỏng | Mọi kiểm tra chạy trước bước publish đầu tiên (§5.3). Nếu vẫn hỏng: phát hành bản vá; không `npm unpublish` |
| Tên gói mới publish nhầm nội dung | Bước `--dry-run` liệt kê file; bead phải đọc danh sách đó trước khi cho publish thật |
| `plugin/package.json` làm lệch payload đã cài | Trình cài chép cả thư mục nên file mới cũng được chép và băm; kiểm bằng test cấu trúc payload và `smoke:packed` |
| Người dùng cài thẳng gói payload rồi tưởng hỏng | Caveat, `plugin/README.md`, và yêu cầu tiếp theo (ADR-009 QĐ5) |
| Quét npm soi cả `next` (S3) | Không để bản hỏng nằm ở `next`; bản `next` và `latest` đều là bản vừa phát hành |
| **Một luật blocking khác của `static-scan.ts` đỏ sau khi đã publish.** Đây là lần đầu toàn bộ payload bị quét: 93 file `.ts`/`.tsx`, `child_process` trong `server/paseo-cli.ts` và `server/setup-tools.ts`, `fs` và `process.env` rải trong `server/` | S9–S11 nói rõ luật nào có thể đỏ, và S10 nói Node builtin trong `server/` là hợp lệ. Nhưng đọc luật không thay cho chạy thử: **chạy đủ bộ luật ấy trên payload trước khi publish bất cứ gì** (§9, WP-317). Đây là rủi ro duy nhất trong danh sách này mà hậu quả không lùi được |

Hoàn tác: bỏ hai bước publish trong `release.yml`, trả hồ sơ registry về trạng thái trước, gỡ `plugin/package.json`. Gói đã publish thì ở lại npm vĩnh viễn — đó là phần không lùi được, đúng như ADR-009 đã ghi.

## 9. Testing Strategy

- Test đồng bộ phiên bản ba nguồn (§4), có đối chứng: làm lệch một nguồn thì đỏ.
- `test/plugin-structure.test.ts`: `plugin/package.json` vào danh sách file payload bắt buộc; khẳng định không có `dependencies` và không có script `test` giả.
- `scripts/smoke-packed.mjs`: đóng gói **cả hai** gói; khẳng định gốc gói payload có `paseo-plugin.json` cùng hai runtime entry — tức chính luật S1 mà registry sẽ kiểm.
- **Chạy bộ luật của họ trên payload trước khi publish** (WP-317): kiểm từng luật blocking ở S9 trên `plugin/` — manifest, entrypoint, ranh giới import client/server/shared, symlink, file quá 2 MB. Nếu không dựng lại được bộ quét thì ít nhất kiểm thủ công từng luật và ghi bằng chứng. Sau bước này mới được tạo Release.
- Kiểm bằng chính sự thật bên ngoài: sau khi phát hành, job `Registry admission` của PR #215 phải xanh. Đây là phép kiểm duy nhất chứng minh cả bốn cổng qua được, và nó nằm ngoài tầm repo.

## 10. Câu hỏi mở — đã trả lời

| # | Câu hỏi | Trả lời |
|---|---|---|
| Q11 | Tên gói | `paseo-bm-plugin` |
| Q12 | Gói payload có tự đăng ký vai trò không | Không trong đợt này; tách thành yêu cầu riêng sau khi liệt kê xong |
| Q13 | Ai làm bước giữ chỗ và `npm trust` | Beads Worker chạy bằng phiên npm sẵn có trên máy owner |
