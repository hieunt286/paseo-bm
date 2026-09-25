# paseo.cafe — hồ sơ liệt kê paseo-bm

| Trường | Giá trị |
|---|---|
| Mã | `cafe-listing-20260923` |
| Status | **Active** — hồ sơ qua đủ bốn cổng CI (§13); [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) vẫn **OPEN**, chờ maintainer merge (kiểm 2026-09-25) |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Yêu cầu | `req-20260923T063441Z`: "Bây giờ tôi muốn đăng ký plugin của mình lên trang này : https://paseo.cafe/submit , tôi cần làm gì và bạn có thể hỗ trợ tôi làm được những gì" |
| Quyết định của owner | Q3a (sửa trong working tree, owner tự commit), Q4a (owner gửi ảnh chụp màn hình), Q5a (dùng bản nháp metadata). Q1a (manifest ở gốc repo, không khai `path`) và Q2a (không khai `package`) **đã bị thay**: CI của registry bác cả hai (§4, §10), entry nay khai `path: "plugin"` và `package: "paseo-bm-plugin"` ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)) |
| Nguồn đã đọc (2026-09-23) | `paseo-cafe/paseo-cafe`: `README.md`, `scripts/validate-registry.ts`, `scripts/scan.ts`, `src/lib/registry-schema.ts`, `registry/paseo-beads.json`; trang `paseo.cafe/submit` và `paseo.cafe/plugins/paseo-beads` |

## 1. paseo.cafe nhận hồ sơ thế nào

- Directory cộng đồng, **không chính thức**; trang chủ tự ghi các mục "not reviewed, audited, or vouched for".
- Một plugin là **một file** `registry/<plugin-id>.json` trong repo `github.com/paseo-cafe/paseo-cafe`. Tên file phải trùng plugin id dạng kebab-case: với chúng ta là `registry/paseo-bm.json`.
- Hai đường nộp: form https://paseo.cafe/submit điền sẵn rồi mở issue (bot chuyển thành PR), hoặc tự mở PR thêm file.
  **Hồ sơ này đi đường PR thủ công.** Form bắt buộc điền npm package, và hoá ra CI của họ cũng vậy với hồ sơ mới — xem §4.

## 2. Nội dung file đang nộp

Đọc lại từ nhánh `hieunt286:add-paseo-bm` ngày 2026-09-25 (sau commit `d2213653` của lần phát hành `0.3.0`):

```json
{
  "repo": "hieunt286/paseo-bm",
  "path": "plugin",
  "package": "paseo-bm-plugin",
  "categories": ["orchestration", "productivity"],
  "platforms": ["macos", "linux"],
  "caveats": [
    "Install with `npx paseo-bm`: it also registers the three bm-* agent roles the plugin needs. There is no other supported install.",
    "Installed straight from this page the screens load, but the three bm-* agent roles are missing, so the Manager cannot create a Worker.",
    "Stable 0.3.0 on npm: commands, flags, exit codes and the --json shape are a public contract and change only with a new version.",
    "Requires Paseo 0.8.0+, Node 22+, the paseo CLI on PATH, macOS or Linux (no Windows), plus the br and bv Beads CLIs.",
    "Enabling Paseo's agent tools grants them to every agent on the machine, not only paseo-bm's roles.",
    "The Worker runs without permission prompts; its limits are role instructions only, so review git diff before you commit."
  ],
  "submittedBy": "hieunt286"
}
```

`registryEntrySchema` khai `.strict()`: chỉ nhận đúng các trường `repo`, `path`, `package`, `categories`, `platforms`, `caveats`, `submittedBy`; thêm trường lạ là hỏng. `caveats` tối đa 6 câu, mỗi câu tối đa 140 ký tự — bản trên dài lần lượt 128, 134, 127, 115, 98, 120.

`categories` là chuỗi tự do (`z.array(z.string().min(1))`), nhưng `platforms` là **enum** (`z.array(z.enum(PLATFORMS))`): giá trị `macos` đã được xác nhận bằng một hồ sơ thật đang nằm trong registry (`registry/launchd-jobs.json`), nên viết thường như trên.

Hai caveat đầu nói thẳng rủi ro ở §7: chỉ `npx paseo-bm` mới cài đủ, còn lệnh trang tự sinh nạp được màn hình nhưng thiếu ba vai trò. Caveat số 3 nhắc số hiệu phiên bản, nên phải sửa khi loại phiên bản đổi (lần gần nhất: prerelease → `0.3.0` ổn định).

## 3. CI của họ kiểm gì

Bốn cổng, và hồ sơ cuối cùng qua cả bốn (§13). Cấu hình đang nộp: `path: "plugin"`, `package: "paseo-bm-plugin"`.

| Cổng | Kiểm gì | Hồ sơ này |
|---|---|---|
| 1 | Tên file là plugin id kebab-case, và `<path>/paseo-plugin.json` trên nhánh mặc định có `id` khớp tên file | đọc `plugin/paseo-plugin.json`, `id` là `paseo-bm` — đạt |
| 2 | `plugin-security/targets.ts` dòng 99: hồ sơ **mới** không khai `package` thì ném lỗi ngay | khai `paseo-bm-plugin` — đạt (§4 kể vì sao ta từng trượt) |
| 3 | `validate-registry.ts` tải tarball npm, đòi `paseo-plugin.json` **ngay gốc tarball**, `name` khớp, `version` khớp npm và khớp `<path>/package.json` trên Git | gốc gói payload có manifest; ba phiên bản đồng bộ bằng generator và một test — đạt |
| 4 | `plugin-security/static-scan.ts`: plugin root phải có runtime entry thật, quét cả nguồn Git (áp `path`) lẫn gốc tarball npm (**không** áp `path`) | `plugin/` và gốc gói payload đều có `index.client.tsx` và `index.server.ts` — đạt (§10 kể vì sao ta từng trượt, §11 là bảng đối chiếu trước khi publish) |

Bốn cổng nằm trong cùng một job `Registry admission`, và bước tổng kết `Enforce admission result` đòi **tất cả** xanh. CI đọc **nhánh mặc định** của repo, nên mọi thứ cổng 1 và cổng 4 cần phải có trên `main` trước khi mở hoặc cập nhật PR.

## 4. Hồ sơ mới **bắt buộc** khai `package`

**Đính chính 2026-09-23, sau khi PR thật bị CI chặn.** Bản đầu của tài liệu này nói `package` là tuỳ chọn, dựa trên `registryEntrySchema` (`package` không bắt buộc) và trên `validate-registry.ts` (cả khối npm nằm trong `if (entry.package)`). Đúng với hai chỗ đó, nhưng **thiếu một cổng thứ ba**: `scripts/plugin-security/targets.ts` dòng 99 ném lỗi với mọi hồ sơ mới không khai `package`, và job `Registry admission` đòi bước đó xanh.

Bằng chứng: PR [paseo-cafe/paseo-cafe#215](https://github.com/paseo-cafe/paseo-cafe/pull/215), run [35834044223](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35834044223) — `VALIDATE_OUTCOME: success` (phần §3 của tài liệu này đúng: manifest ở gốc repo được chấp nhận), nhưng `TARGETS_OUTCOME: failure` với

```
error: new registry entry "paseo-bm" must declare a public npm package
    at selectPullRequestTargets (scripts/plugin-security/targets.ts:100:17)
```

Hồ sơ cũ không khai `package` (ví dụ mục nào đó đã nằm sẵn trong registry) không bị đụng tới: điều kiện là `!previous && !baseIds.has(entry.id)`, tức chỉ áp cho mục mới.

Hệ quả lúc đó: muốn có listing thì **phải** khai `package`. Kết luận kế tiếp của bản này — "khai `paseo-bm` rồi thêm manifest vào `files` của gói trình cài" — **đã bị chính cổng 4 bác bỏ một giờ sau**: xem §10. Đường đi cuối cùng là publish payload thành gói riêng `paseo-bm-plugin` và khai gói ấy ([ADR-009](../adr/ADR-009-payload-as-npm-package.md)). Giữ lại mục này vì nó ghi một bài học còn đúng: đọc schema và một file validator là chưa đủ, một job CI có thể có nhiều cổng.

## 5. Thay đổi trong repo này

| File | Việc |
|---|---|
| ~~`paseo-plugin.json` (gốc repo)~~ | **Đã gỡ 2026-09-23** cùng phép kiểm của nó. Nó sinh ra cho phương án entry trỏ gốc repo; từ khi entry khai `path: "plugin"` thì cổng 1 đọc `plugin/paseo-plugin.json`, cổng 3 đọc gốc tarball gói payload, và một manifest ở gốc chỉ khiến `paseo plugin add` tìm thấy một plugin rồi chết vì thiếu runtime entry. Test nay khẳng định repo chỉ còn **một** manifest. |
| `test/plugin-structure.test.ts` | Thêm test giữ hai manifest không lệch nhau |
| `README.md` | Đổi tiêu đề mục `Quick start` thành `Install` và `Before you install` thành `Limitations and warnings`, để bộ đọc của paseo.cafe nhận ra mục cài đặt và mục giới hạn. Nội dung không đổi, nên REQ-015 không đổi. |
| `AGENTS.md` | **Trạng thái cuối:** mục "Two packages, one release" ghi quy tắc hai gói và năm thứ làm gãy hồ sơ; khối "Repository layout" khớp cây thư mục thật. Ba dòng mô tả manifest ở gốc đã bỏ cùng chính file đó (§10, WP-321a). |
| `plugin/images/` | Ba ảnh chụp màn hình thật, owner cung cấp (Q4a): `01-beads-screen.jpg` (màn Beads), `02-metric-request.jpg` (màn Metric), `03-installer-roles.png` (trình cài hỏi vai trò). Chép nguyên bản từ `paseo-bm-site/src/assets/media`. **Chuyển từ `images/` ở gốc repo vào `plugin/` ngày 2026-09-23** khi entry đổi sang `path: "plugin"`; không nằm trong `files` của gói payload và bị mẫu phủ định loại khỏi gói trình cài, nên không vào tarball nào. |

## 6. Trang listing sẽ hiện gì (`scripts/scan.ts`)

Mọi đường dẫn đều tính theo `path`, mà hồ sơ khai `path: "plugin"`, nên tất cả đọc trong `plugin/`:

- **Mô tả**: `plugin/package.json.description` — "Beads Management for Paseo — the plugin payload: the Metric, Beads and Setup screens plus the agent role instructions. Install with npx paseo-bm, which also registers the three agent roles."
- **Version**: `plugin/package.json.version`, luôn bằng gói trình cài (`0.3.0` lúc kiểm).
- **Ảnh**: bộ quét đọc thư mục `images` **ngay dưới `path`**, tức `plugin/images/` — ảnh đã chuyển vào đó, đánh số 01-03 để cố định thứ tự nên ảnh dẫn đầu là màn Beads. Không dùng URL tuyệt đối trong README: URL tuyệt đối chỉ được giữ nếu host nằm trong danh sách tin cậy mà ta chưa đọc được. Ảnh không nằm trong tarball nào và `smoke:packed` canh điều đó. Ba ảnh là ảnh thật của sản phẩm, đã soi từng tấm: không credential, không token, không đường dẫn riêng tư, không khối Exif.
- **Health, đạt 5/6 và cố ý**: `manifestValid`, `hasReadme` (`plugin/README.md`), `hasLicense` (`plugin/LICENSE`, và dù không có file thì license của repo cũng đủ), `hasTypecheckScript`, `updatedRecently` — đạt. `hasTests` **không đạt**: trong `plugin/` không có test nào, và bịa một script `test` để mục này xanh là làm cho kiểm tra trông xanh. Payload vẫn được kiểm thật bằng các test dưới `test/` ở gốc repo, chúng chỉ không nằm dưới `path`.
- Lịch quét: gói npm 15 phút một lần, nguồn Git 6 giờ một lần.

## 7. Rủi ro đã chấp nhận

Trang listing tự sinh lệnh cài thẳng: `paseo plugin add npm:paseo-bm-plugin@<version>` cho Paseo 0.9+, và `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin` cho 0.8. Từ khi có gói payload, **cả hai lệnh đều nạp được** — nhưng nạp ra một sản phẩm **thiếu ba vai trò** `bm-manager`, `bm-worker`, `bm-reviewer`, vì trình cài mới là bên đăng ký chúng (ADR-006). Beads Manager khi đó không tạo nổi Worker.

Đây là rủi ro đã chấp nhận có ý thức, và caveat số 1 cùng số 2 nói thẳng cả hai vế: `npx paseo-bm` là cách cài duy nhất được hỗ trợ, còn cài thẳng thì màn hình lên nhưng thiếu vai trò.

*(Bản trước của mục này mô tả một rủi ro khác — lệnh tự sinh **lỗi nạp**, vì hồ sơ khi ấy trỏ gốc repo nơi có manifest mà không có runtime entry. Owner từng chọn phương án đó ở Q1a, chính xác vì "một lỗi to và rõ" dễ hiểu hơn "một sản phẩm nửa vời". Cổng 4 của registry bác bỏ phương án ấy, nên nay ta đang ở đúng cái nửa vời đó — và trả giá bằng hai caveat nói rõ. Lối thoát thật sự vẫn thế: cho payload tự đăng ký vai trò lần đầu, một yêu cầu riêng owner đã chốt ở Q12 b.)*

## 8. Các bước owner làm

1. ~~Commit các thay đổi ở §5 và đưa lên nhánh mặc định `main`~~ — **xong 2026-09-23**, `main` ở `5c7daa5`, CI của repo xanh (run 35832961123).
2. ~~Fork `paseo-cafe/paseo-cafe`, thêm `registry/paseo-bm.json`, mở PR~~ — **xong**: [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) từ nhánh `hieunt286:add-paseo-bm`. Lúc đó **đỏ** vì §4 rồi §10; nay đã xanh, xem bước 3 và §13.
3. ~~Phát hành bản mới rồi cập nhật hồ sơ~~ — **xong 2026-09-23**: `0.3.0-alpha.6` publish hai gói, hồ sơ chuyển sang `path: "plugin"` + `package: "paseo-bm-plugin"`, và `Registry admission` xanh cả bốn cổng (§13). Ba lệnh cần OTP do owner chạy: bản giữ chỗ, `npm trust github`, và hai lần `npm dist-tag add`.
4. ~~Sửa caveat khi lên bản ổn định~~ — **xong 2026-09-25**: commit `d2213653` trên nhánh PR (+1/−1, caveat số 3), comment ở PR #215.
5. Sau khi PR được merge và tới lần quét kế tiếp, mở trang listing xem ba ảnh trong `plugin/images/` có hiện đúng không — đây là phép kiểm duy nhất phải chờ bên ngoài, nên nó nằm ở đây chứ không nằm trong tiêu chí của bead. Thêm hay đổi ảnh về sau chỉ cần push, không cần PR mới.

## 9. Mỗi lần phát hành sau phải giữ đúng những điều này

Không còn là danh sách việc phải làm — phase 2a-20 đã làm xong. Đây là những điều một bản phát hành **không được** làm sai, nếu không listing sẽ hỏng lặng lẽ. Bản rút gọn cho agent nằm ở mục "Two packages, one release" trong `AGENTS.md`.

1. **Hai gói, một phiên bản.** `release.yml` publish `paseo-bm` rồi `paseo-bm-plugin` trong cùng một lần chạy; bước "Assert both packages agree" chặn trước khi có gì lên npm.
2. **Ba nguồn phiên bản không được lệch**: `package.json`, `plugin/package.json`, `PLUGIN_VERSION`. Cổng 3 so phiên bản trên Git với phiên bản npm nó phân giải.
3. **`paseo-bm-plugin@latest` phải trỏ bản mới.** `resolveNpmPackage` đọc đúng tag đó. Từ `0.3.0`, `release.yml` tự đặt dist-tag theo loại phiên bản — prerelease vào `next`, bản ổn định vào `latest` — nên một bản ổn định không cần bước tay nào. Còn muốn `next` trỏ một bản ổn định, hay dời tag bằng tay, thì vẫn đòi OTP và vẫn là việc của owner.
4. **Đừng đổi tên `release.yml`**: cấu hình trusted publisher của **cả hai** gói trỏ theo tên file.
5. **Gốc tarball gói trình cài không được giống một plugin**, và gốc gói payload phải luôn là plugin nạp được — `smoke:packed` canh cả hai chiều.
6. Sửa hồ sơ registry thì nhớ **Biome giữ mảng ngắn trên một dòng**, nếu không job đỏ ngay trước cả bước validate.

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

## 12. Trusted publisher của gói payload — đã xác nhận

Bead `bm-phase-2a-20-x3g0.6` đóng lại khi phần này mới chỉ là lời owner: `npm trust list` đòi OTP, endpoint `/-/package/<gói>/trust` trả 401, và packument công khai không mang thông tin trust — đã thử cả ba đường. Owner chạy lệnh và dán kết quả ngay sau đó:

```
type: github
id: c392d9f4-e672-441c-a684-01331bc8cd81
file: release.yml
repository: hieunt286/paseo-bm
permissions: publish, stage publish
```

Đúng thứ cần: nguồn tin cậy là GitHub Actions, đúng file `release.yml`, đúng repo, có quyền publish. Nên nửa rủi ro "publish xong gói trình cài rồi chết ở gói payload" không còn là ẩn số trước khi phát hành.

**Ghi lại cho lần sau:** `npm trust list` và `npm trust github` đều cần OTP, nên chúng luôn là việc của owner, giống như bản giữ chỗ. Chỉ lần phát hành thật là chạy được không cần OTP, vì `release.yml` dùng OIDC.


## 13. Trạng thái cuối — cả bốn cổng đã xanh

Run [35854151581](https://github.com/paseo-cafe/paseo-cafe/actions/runs/35854151581) trên PR #215, đọc ở bước "Enforce admission result" chứ không nhìn danh sách bước:

```
FETCH_OUTCOME: success     VALIDATE_OUTCOME: success
TARGETS_OUTCOME: success   SCAN_OUTCOME: success      PUBLISH_OUTCOME: success
```

Hồ sơ đang nộp: `path: "plugin"`, `package: "paseo-bm-plugin"`, sáu caveat. PR `MERGEABLE`, đang chờ maintainer duyệt và merge — phần còn lại nằm ngoài tầm repo này.

Hai lỗi của Worker trên nhánh PR, ghi lại để lần sau tránh: một commit ghi đè file thành 0 byte, vì một bước trong lệnh hỏng mà chuỗi lệnh vẫn chạy tiếp (từ nay: kiểm file có nội dung **trước** khi gọi API ghi); và một commit sai định dạng, vì `json.dumps` bung mảng ngắn ra nhiều dòng trong khi Biome của họ giữ mảng ngắn trên một dòng.

**Bẫy còn lại ở một bản cũ.** `paseo-bm@0.3.0-alpha.6` publish từ `e7424cb`, trước commit `4b444b5` gỡ manifest ở gốc, nên tarball của nó **vẫn có `paseo-plugin.json` ở gốc**: trên Paseo 0.9+, `paseo plugin add npm:paseo-bm@0.3.0-alpha.6` tìm thấy một plugin rồi **lỗi nạp**; gỡ bằng `paseo plugin remove paseo-bm`. Từ `0.3.0-alpha.7` trở đi (gồm `latest` = `0.3.0`) thì hết, và `smoke:packed` canh sẵn. Bản đã publish thì không sửa được.

Việc còn lại sau khi merge, không thuộc phase này: mở trang listing xem mô tả, version và ba ảnh có lên đúng không; lịch quét là 15 phút cho nguồn npm và 6 giờ cho nguồn Git.

---

*Revision 2026-09-25: Status, quyết định còn hiệu lực, §2 (entry thật trên nhánh PR sau khi sửa caveat cho `0.3.0`), §6, §8 và bẫy ở §13 cập nhật theo trạng thái hiện tại. Các mục §4, §10 giữ lại vì ghi lý do của cấu hình đang dùng.*
