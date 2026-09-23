# paseo.cafe — hồ sơ liệt kê paseo-bm

| Trường | Giá trị |
|---|---|
| Mã | `cafe-listing-20260923` |
| Status | **Active** — repo đã sẵn sàng, chờ owner push và mở PR |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Yêu cầu | `req-20260923T063441Z`: "Bây giờ tôi muốn đăng ký plugin của mình lên trang này : https://paseo.cafe/submit , tôi cần làm gì và bạn có thể hỗ trợ tôi làm được những gì" |
| Quyết định của owner | Q1a (manifest ở gốc repo, entry không khai `path`), Q2a (chưa khai `package`), Q3a (sửa trong working tree, owner tự commit), Q4a (owner gửi ảnh chụp màn hình), Q5a (dùng bản nháp metadata) |
| Nguồn đã đọc (2026-09-23) | `paseo-cafe/paseo-cafe`: `README.md`, `scripts/validate-registry.ts`, `scripts/scan.ts`, `src/lib/registry-schema.ts`, `registry/paseo-beads.json`; trang `paseo.cafe/submit` và `paseo.cafe/plugins/paseo-beads` |

## 1. paseo.cafe nhận hồ sơ thế nào

- Directory cộng đồng, **không chính thức**; trang chủ tự ghi các mục "not reviewed, audited, or vouched for".
- Một plugin là **một file** `registry/<plugin-id>.json` trong repo `github.com/paseo-cafe/paseo-cafe`. Tên file phải trùng plugin id dạng kebab-case: với chúng ta là `registry/paseo-bm.json`.
- Hai đường nộp: form https://paseo.cafe/submit điền sẵn rồi mở issue (bot chuyển thành PR), hoặc tự mở PR thêm file.
  **Hồ sơ này đi đường PR thủ công.** Form bắt buộc điền npm package, và hoá ra CI của họ cũng vậy với hồ sơ mới — xem §4.

## 2. Nội dung file sẽ nộp

```json
{
  "repo": "hieunt286/paseo-bm",
  "categories": ["orchestration", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [
    "Install with `npx paseo-bm`: it also registers the three bm-* agent roles the plugin needs. There is no other supported install.",
    "The install command this page generates fails to load paseo-bm; undo it with `paseo plugin remove paseo-bm`.",
    "Prerelease 0.3.0-alpha: commands, flags, exit codes and the --json shape can still change.",
    "Requires Paseo 0.8.0+, Node 22+, the paseo CLI on PATH, macOS or Linux (no Windows), plus the br and bv Beads CLIs.",
    "Enabling Paseo's agent tools grants them to every agent on the machine, not only paseo-bm's roles.",
    "The Worker runs without permission prompts; its limits are role instructions only, so review git diff before you commit."
  ],
  "submittedBy": "hieunt286"
}
```

`registryEntrySchema` khai `.strict()`: chỉ nhận đúng các trường `repo`, `path`, `package`, `categories`, `platforms`, `caveats`, `submittedBy`; thêm trường lạ là hỏng. `caveats` tối đa 6 câu, mỗi câu tối đa 140 ký tự — bản trên dài lần lượt 128, 108, 90, 115, 98, 120.

`categories` là chuỗi tự do (`z.array(z.string().min(1))`), nhưng `platforms` là **enum** (`z.array(z.enum(PLATFORMS))`): giá trị `macos` đã được xác nhận bằng một hồ sơ thật đang nằm trong registry (`registry/launchd-jobs.json`), nên viết thường như trên.

Hai caveat đầu nói thẳng chuyện ở §7: chỉ `npx paseo-bm` mới cài được, còn lệnh trang tự sinh sẽ lỗi nạp và phải gỡ bằng `paseo plugin remove paseo-bm`. Bản nháp đầu (owner duyệt ở Q5a) chỉ nói lệnh đó "sets up the payload only", nhẹ hơn sự thật; review lô b1 bắt lỗi này nên hai câu được viết lại và hai câu yêu cầu hệ thống gộp làm một để không vượt mức 6 câu.

## 3. CI của họ kiểm gì

| Kiểm | Hồ sơ này |
|---|---|
| Tên file là plugin id kebab-case hợp lệ | `paseo-bm` — đạt |
| `<path>/paseo-plugin.json` tồn tại trên GitHub và `id` khớp tên file | không khai `path` nên nó đọc **gốc repo** — đạt nhờ file mới ở §5 |
| Khai `package` thì tải tarball npm, đòi `paseo-plugin.json` **ngay gốc tarball**, `name` khớp, `version` khớp npm và khớp `package.json` trên Git | chưa chạy tới, vì bị chặn ở dòng dưới |
| `scripts/plugin-security/targets.ts` dòng 99: hồ sơ **mới** mà không khai `package` thì **ném lỗi ngay** | **ĐỎ** — xem §4 |

Hai cổng này khác nhau: `validate-registry.ts` coi `package` là tuỳ chọn, `plugin-security/targets.ts` thì không, và job `Registry admission` đòi cả hai xanh.

CI đọc nhánh mặc định (`HEAD`) của repo, nên `paseo-plugin.json` ở gốc **phải có trên `main` trước khi mở PR**.

## 4. Hồ sơ mới **bắt buộc** khai `package`

**Đính chính 2026-09-23, sau khi PR thật bị CI chặn.** Bản đầu của tài liệu này nói `package` là tuỳ chọn, dựa trên `registryEntrySchema` (`package` không bắt buộc) và trên `validate-registry.ts` (cả khối npm nằm trong `if (entry.package)`). Đúng với hai chỗ đó, nhưng **thiếu một cổng thứ ba**: `scripts/plugin-security/targets.ts` dòng 99 ném lỗi với mọi hồ sơ mới không khai `package`, và job `Registry admission` đòi bước đó xanh.

Bằng chứng: PR [paseo-cafe/paseo-cafe#215](https://github.com/paseo-cafe/paseo-cafe/pull/215), run [35834044223](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35834044223) — `VALIDATE_OUTCOME: success` (phần §3 của tài liệu này đúng: manifest ở gốc repo được chấp nhận), nhưng `TARGETS_OUTCOME: failure` với

```
error: new registry entry "paseo-bm" must declare a public npm package
    at selectPullRequestTargets (scripts/plugin-security/targets.ts:100:17)
```

Hồ sơ cũ không khai `package` (ví dụ mục nào đó đã nằm sẵn trong registry) không bị đụng tới: điều kiện là `!previous && !baseIds.has(entry.id)`, tức chỉ áp cho mục mới.

Hệ quả: muốn có listing thì **phải** khai `package: "paseo-bm"`, và muốn khai được thì tarball npm phải có `paseo-plugin.json` ngay ở gốc — tức thêm nó vào `files` rồi **phát hành một bản mới** (§9). Không có đường vòng: bỏ `package` là bị chặn, khai `package` mà tarball đã publish chưa có manifest thì `validate-registry.ts` chặn.

Sau khi khai `package`, một cổng nữa mới bắt đầu chạy — `SCAN_OUTCOME` (quét an ninh gói npm) lần này bị `skipped`. Chưa biết nó soi gì, nên đừng coi việc phát hành là xong chuyện.

## 5. Thay đổi trong repo này

| File | Việc |
|---|---|
| `paseo-plugin.json` (gốc repo) | **File mới**, nội dung y hệt `plugin/paseo-plugin.json`. Đây là thứ CI của paseo.cafe đọc. **Đừng xoá vì tưởng trùng lặp.** Nó không nằm trong `files` nên không đi vào gói npm. |
| `test/plugin-structure.test.ts` | Thêm test giữ hai manifest không lệch nhau |
| `README.md` | Đổi tiêu đề mục `Quick start` thành `Install` và `Before you install` thành `Limitations and warnings`, để bộ đọc của paseo.cafe nhận ra mục cài đặt và mục giới hạn. Nội dung không đổi, nên REQ-015 không đổi. |
| `AGENTS.md` | Ba dòng trong khối "Repository layout" nói rõ manifest ở gốc là gì, để không ai xoá nhầm. Đi cùng file ở dòng trên: commit chung, revert chung. |
| `images/` | Ba ảnh chụp màn hình thật, owner cung cấp (Q4a): `01-beads-screen.jpg` (màn Beads), `02-metric-request.jpg` (màn Metric), `03-installer-roles.png` (trình cài hỏi vai trò). Chép nguyên bản từ `paseo-bm-site/src/assets/media`, không nằm trong `files` nên không vào gói npm. |

## 6. Trang listing sẽ hiện gì (`scripts/scan.ts`)

Mọi đường dẫn đều tính theo `path`; không khai `path` nên tất cả đọc từ gốc repo:

- **Mô tả**: `package.json.description` — "Beads Management for Paseo: installs the paseo-bm plugin and its agent roles".
- **Version**: `package.json.version` — 0.3.0-alpha.4.
- **Ảnh**: thư mục `images/` trước, rồi ảnh tham chiếu trong README (đường dẫn cục bộ được đổi sang URL raw của GitHub). `images/` đánh số 01-03 để cố định thứ tự, nên ảnh dẫn đầu là màn Beads; sau đó tới `assets/paseo-bm-flow.svg` mà README đang trỏ. Ba ảnh này là ảnh thật của sản phẩm, đã soi từng tấm: không có credential, token hay đường dẫn riêng tư, và không có khối Exif.
- **Health 6 mục**: `manifestValid` (đạt nhờ §5), `hasReadme`, `hasLicense`, `hasTests` (script `test`), `hasTypecheckScript` (script `typecheck`), `updatedRecently` (180 ngày) — đủ cả sáu.
- Lịch quét: gói npm 15 phút một lần, nguồn Git 6 giờ một lần.

## 7. Rủi ro đã chấp nhận

Trang listing tự sinh lệnh cài dạng `paseo plugin add hieunt286/paseo-bm --ref <sha>`. Lệnh đó sẽ **lỗi nạp plugin**: gốc repo có manifest nhưng không có `index.client.tsx` và `index.server.ts`. Paseo giữ lại entry hỏng trong config, gỡ bằng `paseo plugin remove paseo-bm`. Caveat số 1 nói thẳng phải cài bằng `npx paseo-bm`.

Owner đã cân nhắc và chọn phương án này thay cho `path: "plugin"`: ở đó lệnh cài chạy được nhưng chỉ nạp giao diện, không có ba role `bm-*` do trình cài đăng ký (ADR-006), tức một sản phẩm nửa vời khó hiểu hơn nhiều so với một lỗi to và rõ. Lối thoát thật sự cho chuyện này là để plugin tự đăng ký role khi được cài thẳng — một tính năng riêng, nằm ngoài yêu cầu này.

## 8. Các bước owner làm

1. ~~Commit các thay đổi ở §5 và đưa lên nhánh mặc định `main`~~ — **xong 2026-09-23**, `main` ở `5c7daa5`, CI của repo xanh (run 35832961123).
2. ~~Fork `paseo-cafe/paseo-cafe`, thêm `registry/paseo-bm.json`, mở PR~~ — **xong**: [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) từ nhánh `hieunt286:add-paseo-bm`. Đang **đỏ** vì §4: hồ sơ mới bắt buộc khai `package`.
3. **Việc kế tiếp, cần owner quyết**: làm §9 (thêm `paseo-plugin.json` vào `files`, phát hành bản mới, rồi thêm `"package": "paseo-bm"` vào chính PR #215). Không làm thì PR không bao giờ xanh.
4. Sau khi PR được merge và tới lần quét kế tiếp, mở trang listing xem ba ảnh trong `images/` có hiện đúng không — đây là phép kiểm duy nhất phải chờ bên ngoài, nên nó nằm ở đây chứ không nằm trong tiêu chí của bead. Thêm hay đổi ảnh về sau chỉ cần push, không cần PR mới.

## 9. Phát hành một bản mới — điều kiện bắt buộc, không còn là tuỳ chọn

1. Thêm `"paseo-plugin.json"` vào `files` trong `package.json`, để tarball có manifest **ngay ở gốc** (chỗ `validate-registry.ts` đọc, không áp `path`).
2. Phát hành bản mới theo `paseo-bm-release-runbook.md`. Hai điều kiện của `validate-registry.ts`: `package.json.version` trên `main` phải **bằng** phiên bản npm mà nó phân giải, và dist-tag phải trỏ đúng bản đó — `latest` do owner dời tay, `release.yml` chỉ dời `next`.
3. Thêm `"package": "paseo-bm"` vào `registry/paseo-bm.json` và push lên nhánh `add-paseo-bm` của fork; PR #215 tự chạy lại, không cần PR mới.
4. Lần này `SCAN_OUTCOME` sẽ thực sự chạy (quét an ninh gói npm) thay vì `skipped`. Chưa rõ nó soi gì; nếu đỏ thì đọc log rồi tính tiếp.

Sau bước đó, lệnh `paseo plugin add npm:paseo-bm@<version>` mà trang tự sinh vẫn lỗi nạp vì gốc gói không phải payload — rủi ro §7 không đổi, hai caveat đầu vẫn nói đúng chuyện đó.

## 10. Cổng thứ tư: quét an ninh đòi plugin root **nạp được thật**

Sau khi khai `package`, lần chạy thứ hai của `Registry admission` (run [35838506116](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35838506116)) cho kết quả: `VALIDATE_OUTCOME: success`, `TARGETS_OUTCOME: success` — hai cổng cũ đã qua — nhưng `SCAN_OUTCOME: failure`. Bước "Scan changed plugins" đặt `continue-on-error`, nên nhìn danh sách bước thì tưởng xanh; giá trị thật nằm ở bước "Enforce admission result".

Báo cáo bot dán vào PR:

```
## paseo-bm
Status: failed          Blocking findings: 1
- [entrypoint] missing . plugin has no Paseo 0.8 runtime entry
npm package: paseo-bm   npm status: failed   npm version: 0.3.0-alpha.5
- [npm/entrypoint] missing . plugin has no Paseo 0.8 runtime entry
```

Luật `entrypoint/missing` trong `scripts/plugin-security/static-scan.ts` đòi **một trong bốn file** `index.client.ts(x)` hoặc `index.server.ts(x)` nằm ngay thư mục gốc của plugin, và nó **blocking**.

Hai lần quét, hai thư mục khác nhau (`scripts/plugin-security/scan.ts`):

| Quét | Thư mục | Dòng |
|---|---|---|
| Kho Git | `target.path ?? "."` — **có** áp `path` | 229 |
| Gói npm | `pluginPath: "."` — **luôn là gốc tarball**, không áp `path` | 322 |

Hệ quả, và đây là điểm chặn thật sự của cả yêu cầu này:

- Khai `path: "plugin"` thì lần quét Git qua được, vì `plugin/` có đủ `index.client.tsx`, `index.server.ts` và manifest.
- Nhưng lần quét npm **không bao giờ** qua được với gói `paseo-bm`, vì gốc gói là trình cài đặt chứ không phải payload. Thêm manifest vào gốc tarball (0.3.0-alpha.5) không cứu được: nó đòi **runtime entry**, không phải manifest.
- Mà bỏ `package` cũng không được, vì §4: hồ sơ mới bắt buộc khai.

Nói cách khác, registry chỉ nhận plugin mà **gốc gói npm chính là payload nạp được**. Đó là hình dạng của `@omercnet/paseo-beads` (repo có `path`, gói npm riêng cho payload). paseo-bm hiện không có hình dạng đó, và đây là quyết định đóng gói của sản phẩm chứ không phải một chỗ sửa nhỏ — xem ADR-001.

Bot review của họ (CodeRabbit) cũng độc lập nêu đúng mối lo trong hai caveat của ta: "The registry's generated install command cannot load Paseo BM, so users must use its separate `npx paseo-bm` installer."

## 11. Đối chiếu payload với toàn bộ luật quét (WP-317, trước khi publish)

Đo ngày 2026-09-23 trên `plugin/` ở trạng thái cuối (đã có `package.json`, `README.md`, `LICENSE`, `images/`). Nguồn luật: `scripts/plugin-security/static-scan.ts` — **mọi** luật đều blocking, không có mức khuyến nghị.

| Luật | Bằng chứng | Kết quả |
|---|---|---|
| `manifest/missing`, `manifest/json` | `plugin/paseo-plugin.json` parse được | đạt |
| `manifest/id` | `id` là `paseo-bm`, khớp `PLUGIN_ID = /^[a-z][a-z0-9-]*$/` và khớp tên file hồ sơ `registry/paseo-bm.json` | đạt |
| `manifest/requirements`, `.paseo`, `.unknown` | khoá cấp cao chỉ có `id` và `requirements`; `requirements` chỉ có `paseo` là `>=0.8.0` | đạt |
| `manifest/build` | không khai `build` | đạt |
| `manifest/unknown:<key>` | không có khoá lạ | đạt |
| `entrypoint/missing` | `index.client.tsx` và `index.server.ts` ngay gốc `plugin/` | đạt |
| `entrypoint/legacy-index` | không có `index.ts` hay `index.tsx` ở gốc payload (đếm: 0) | đạt |
| `boundary/unsupported-sdk-import` | subpath dùng: `@getpaseo/plugin`, `/client`, `/client/react-native`, `/server` — cả bốn nằm trong `SUPPORTED_SDK` của họ; số subpath ngoài danh sách: 0 | đạt |
| `boundary/runtime-module-import` | `node:` builtin ngoài `server/`: 0 file; SDK server-only ngoài `server/`: 0; module client-only (`react`, `react-dom`, `react-native`, `use-sync-external-store`, `@tanstack/react-query`) ngoài `client/`: 0 | đạt |
| `boundary/cross-runtime-import` | `test/plugin-structure.test.ts` canh sẵn: client không với vào `server/`, server không với vào `client/`, `shared/` không import Node lẫn react-native — chạy trong `npm run verify` | đạt |
| `boundary/invalid-module-location` | mọi import tương đối phân giải trong `client/`, `server/`, `shared/` hoặc cùng thư mục | đạt |
| `scanner/symlink` | `find plugin -type l`: 0 | đạt |
| `scanner/size-limit` (2 MB) | file lớn nhất là `plugin/images/02-metric-request.jpg` 154,8 KB; số file vượt 2 MB: 0 | đạt |
| `scanner/incomplete` | không có gì chặn đọc: không symlink, không file khổng lồ, không `node_modules` trong payload | đạt |

**Không luật nào đỏ**, nên theo quyết định Q15 a của owner thì đi tiếp sang bước phát hành. Đây vẫn là đọc luật cộng đo tại chỗ, không phải chạy chính bộ quét của họ — bằng chứng cuối cùng vẫn là lần chạy `Registry admission` sau khi publish.
