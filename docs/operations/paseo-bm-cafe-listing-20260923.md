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
  **Hồ sơ này đi đường PR thủ công**, vì form bắt buộc điền npm package còn lần nộp này cố ý không khai (§4).

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

## 3. CI của họ kiểm gì (`scripts/validate-registry.ts`)

| Kiểm | Hồ sơ này |
|---|---|
| Tên file là plugin id kebab-case hợp lệ | `paseo-bm` — đạt |
| `<path>/paseo-plugin.json` tồn tại trên GitHub và `id` khớp tên file | không khai `path` nên nó đọc **gốc repo** — đạt nhờ file mới ở §5 |
| Khai `package` thì tải tarball npm, đòi `paseo-plugin.json` **ngay gốc tarball**, `name` khớp, `version` khớp npm và khớp `package.json` trên Git | bỏ qua vì không khai `package` |

CI đọc nhánh mặc định (`HEAD`) của repo, nên `paseo-plugin.json` ở gốc **phải có trên `main` trước khi mở PR**.

## 4. Vì sao lần này không khai `package`

Kiểm tra npm đọc `paseo-plugin.json` ở **gốc tarball** và không áp `path`. Gói `paseo-bm` là trình cài đặt: gốc tarball có `package.json` và `dist/`, còn payload nằm trong `plugin/`. Muốn khai `package` thì phải thêm `paseo-plugin.json` vào `files` rồi phát hành một bản mới, vì CI đọc gói **đã publish**. Owner chọn nộp ngay theo nguồn Git và để việc đó cho lần phát hành tới (§9). Cái mất: listing hiện số sao GitHub thay vì số lượt tải npm 30 ngày.

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

1. Xem `git diff`, commit các thay đổi ở §5 và **đưa lên nhánh mặc định `main`** (CI của họ đọc `HEAD`).
2. Fork `github.com/paseo-cafe/paseo-cafe`, thêm file `registry/paseo-bm.json` với đúng nội dung §2, mở PR.
3. Chờ CI xanh rồi chờ họ merge. Listing xuất hiện sau lần quét kế tiếp.
4. Sau khi PR được merge và tới lần quét kế tiếp, mở trang listing xem ba ảnh trong `images/` có hiện đúng không — đây là phép kiểm duy nhất phải chờ bên ngoài, nên nó nằm ở đây chứ không nằm trong tiêu chí của bead. Thêm hay đổi ảnh về sau chỉ cần push, không cần PR mới.

## 9. Lần phát hành tới

Muốn listing hiện số lượt tải npm:

1. Thêm `"paseo-plugin.json"` vào `files` trong `package.json`.
2. Phát hành bản mới theo `paseo-bm-release-runbook.md`, và bảo đảm dist-tag `latest` trỏ đúng bản đó (CI của paseo.cafe đọc bản npm đang phát hành).
3. Mở PR thứ hai vào registry, thêm `"package": "paseo-bm"` vào `registry/paseo-bm.json`.

Sau bước đó, lệnh `paseo plugin add npm:paseo-bm@<version>` mà trang tự sinh vẫn lỗi nạp vì gốc gói không phải payload — rủi ro §7 không đổi.
