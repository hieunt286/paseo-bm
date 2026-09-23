# Delta plan — Payload thành gói npm `paseo-bm-plugin`, phát hành cùng `paseo-bm`

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260923-payload-npm-package` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ.** Delta này thêm WP-314 → WP-321 trong phase 2a-20 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-23 — hieu.nt10** (Beads Worker tự chấm sau review `b5` và re-review; hai chỗ sửa cuối của re-review không được Reviewer xem lại, owner chốt Q14 a — ghi như một ngoại lệ, không phải một lượt pass của Reviewer) |
| Routing decision | Large. Thay đổi **đóng gói và phát hành**, không đổi hành vi sản phẩm, nên đường đi là ADR mới + delta thiết kế + delta plan, **không** có delta PRD |
| Requirements | **N/A** — không thêm, sửa hay bỏ REQ nào. Hành vi mà người dùng thấy giữ nguyên (ADR-009 QĐ4: `npx paseo-bm` không đổi một bước nào), nên không có REQ/AC để phủ. Điều kiện ra của phase ở §1.3 đóng vai tiêu chí nghiệm thu |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Request | `req-20260923T063441Z` |
| Source design | [design-delta-20260923-payload-npm-package](../design/paseo-bm-delta-20260923-payload-npm-package.md) — nguồn duy nhất cho trường, lệnh, luật kiểm và kiểm thử |
| ADR | [ADR-009](../adr/ADR-009-payload-as-npm-package.md) |

## 1. MVP-Lock

### 1.1 Phạm vi

Phase 2a-20, tám work package: gói payload tồn tại, phát hành cùng một lần với gói trình cài, và hồ sơ trên paseo.cafe xanh cả bốn cổng.

### 1.2 Ngoài phạm vi

- **Payload tự đăng ký ba vai trò khi cài thẳng.** Owner chốt Q12 b: làm, nhưng là **yêu cầu riêng sau khi liệt kê xong**. Đợt này không đụng tới.
- Đổi đường cài được hỗ trợ. `npx paseo-bm` giữ nguyên mọi hành vi (ADR-009 QĐ4).
- Đổi mã payload. Không sửa một dòng `.ts`/`.tsx` nào trong `plugin/`; chỉ đặt thêm `package.json`, `README.md`, `LICENSE` và thư mục `images/` cạnh mã đó (thiết kế §3 và §6).
- Đưa ảnh vào tarball. `images/` **chuyển** vào `plugin/` để trang listing đọc được, nhưng không nằm trong `files` của gói payload và bị mẫu phủ định loại khỏi gói trình cài, nên không tarball nào phình thêm.

### 1.3 Điều kiện ra của phase

1. `npm run verify` và `npm run smoke:packed` xanh, trong đó smoke đóng gói **cả hai** gói và khẳng định gốc gói payload có manifest cùng hai runtime entry.
2. Một lần chạy `release.yml` thật cho ra hai gói cùng phiên bản, cùng provenance, cùng dist-tag.
3. Job `Registry admission` của [PR #215](https://github.com/paseo-cafe/paseo-cafe/pull/215) kết thúc **success** — phép kiểm ngoài tầm repo, và là điều kiện ra thật sự của cả yêu cầu.
4. Kết quả của cổng 4 **biết trước khi publish**: bảng đối chiếu từng luật blocking của `static-scan.ts` với bằng chứng của ta, không còn ô trống (WP-317).
5. `AGENTS.md` ghi quy tắc hai gói, để lần phát hành sau và agent sau không làm gãy hồ sơ. Owner yêu cầu thẳng điều này.
6. Không còn file nào trong repo tự nhận là "thứ paseo.cafe đọc" mà thực ra không ai đọc, và runbook không còn nói sai về ai chạy bước giữ chỗ (§3 WP-321).

### 1.4 Hành vi người dùng đang dựa vào sẽ đổi

| Trước | Sau |
|---|---|
| `paseo plugin add npm:paseo-bm@<v>` nạp lỗi (từ 0.3.0-alpha.5) | Không đổi. Gói trình cài vẫn không phải payload |
| Không có gói payload | Cài thẳng payload **nạp được** giao diện nhưng thiếu ba vai trò `bm-*`. Trên Paseo 0.8 lệnh là `paseo plugin add hieunt286/paseo-bm --ref <sha> --path plugin`; dạng `npm:` là của 0.9 trở lên (design S14) |
| Caveat số 2 của hồ sơ nói lệnh trang tự sinh "fails to load" | Phải sửa: từ nay nạp được nhưng thiếu vai trò. Nói sai kiểu nào cũng là nói sai |

### 1.5 Tư thế hoàn tác

Mặc định: mọi WP lùi được bằng `git revert`, và tới trước WP-318 thì chưa có gì rời khỏi repo.

Ngoại lệ, **không lùi được**: WP-318 (tên gói mới xuất hiện trên npm) và WP-319 (publish). npm chỉ cho gỡ trong 72 giờ và đường lùi của dự án là phát hành bản vá, không phải `npm unpublish` (runbook §1). Quyết định sở hữu điểm này là của owner: Q10 "other" (chấp nhận đổi đóng gói để được liệt kê), Q13 b (cho Worker dùng phiên npm), và [ADR-009](../adr/ADR-009-payload-as-npm-package.md) QĐ1. Vì vậy mọi phép kiểm phải chạy **trước** WP-318, đặc biệt WP-317.

### 1.6 Câu hỏi mở

Không còn. Q11, Q12, Q13 đã trả lời (design §10).

### 1.7 Hợp đồng công khai

| Hợp đồng | Đổi gì | Ai chịu ảnh hưởng |
|---|---|---|
| Gói npm `paseo-bm-plugin` | **Mới.** Gốc gói là payload nạp được; phiên bản luôn bằng `paseo-bm` | Chưa ai. Là nhà cung cấp mới, không có consumer cũ |
| Gói npm `paseo-bm` | Nội dung tarball đổi: bỏ `paseo-plugin.json` ở gốc (WP-321), loại `plugin/images/**` | Người dùng `npx paseo-bm`: **không ảnh hưởng**. `dist/` và `plugin/**` (trừ ảnh) giữ nguyên, `findPayloadRoot` đọc `plugin/paseo-plugin.json` chứ không đọc file ở gốc |
| Hồ sơ `registry/paseo-bm.json` | `path` và `package` đổi; caveat số 2 viết lại | Người đọc trang listing. Caveat cũ sẽ thành sai khi gói payload tồn tại, nên bắt buộc sửa cùng lúc (WP-320) |
| Lệnh, cờ, mã thoát, `--json` của CLI | **Không đổi** | — |

Chiến lược kiểm thử của phase nằm ở [design §9](../design/paseo-bm-delta-20260923-payload-npm-package.md): test đồng bộ ba phiên bản có đối chứng, test cấu trúc payload, `smoke:packed` đóng gói cả hai gói, bảng đối chiếu luật quét ở WP-317, và cuối cùng là `Registry admission` của PR #215 — phép kiểm duy nhất nằm ngoài tầm repo.

## 2. Thứ tự và vì sao

Gói phải **tồn tại và đúng** trước khi workflow được phép publish nó, và trusted publisher chỉ cấu hình được cho tên đã tồn tại — nên bước giữ chỗ (WP-318) phải xong trước lần phát hành thật (WP-319), còn WP-316 sửa workflow và WP-317 chạy bộ luật quét trên payload thì phải xong trước đó nữa để lần chạy thật dùng đúng workflow. Hồ sơ registry (WP-320) sửa **sau cùng**, vì cổng 3 và 4 đọc gói đã publish: đổi hồ sơ sớm chỉ tạo thêm một lần CI đỏ trên repo của người khác.

## 3. Work packages

### WP-314 — `plugin/package.json` và đồng bộ ba phiên bản

**Phụ thuộc:** không. Đây là WP gốc của phase.
**Design refs:** §3, §4.

- Tạo `plugin/package.json` đúng các trường ở design §3, không `dependencies`, không script `test` bịa.
- Mở rộng `scripts/generate-plugin-version.mjs` để ghi luôn `version` của file ấy, giữ nguyên thứ tự khoá, vẫn idempotent.
- Test: ba nguồn phiên bản khớp nhau; `plugin/package.json` vào danh sách file payload bắt buộc của `test/plugin-structure.test.ts`.
- Payload có thêm một file, nên **danh sách file payload mà test và snapshot đang chờ sẽ đổi** (`test/install-applier.test.ts`, `test/__snapshots__/uninstall.test.ts.snap`, `test/plugin-structure.test.ts`). Cập nhật chúng là đúng việc: payload thật sự có thêm file. Cấm nới lỏng phép kiểm để khỏi phải sửa.
- **Ra:** `npm run verify` xanh; làm lệch một nguồn phiên bản thì đúng test ấy đỏ; `smoke:packed` vẫn xanh (payload cài được có thêm một file, băm lại đúng).

### WP-315 — `plugin/README.md` cho trang listing

**Phụ thuộc:** WP-314 — README và `LICENSE` phải được `files` của `plugin/package.json` liệt kê, nên file ấy phải tồn tại trước.
**Design refs:** §3, §6.

- README ngắn cho gói payload: nó là gì, nạp được gì, và **nói thẳng** rằng cách cài đầy đủ là `npx paseo-bm` vì ba vai trò do trình cài đăng ký; link về `README.md` và `GUIDE.md` ở gốc; nhúng ảnh bằng đường dẫn tương đối tới `images/` **trong chính `plugin/`**.
- **Chuyển** `images/` từ gốc repo sang `plugin/images/` (chuyển, không chép: sau khi hồ sơ khai `path: "plugin"` thì thư mục ở gốc không còn ai đọc), và thêm mẫu phủ định `"!plugin/images/**"` vào `files` của gói trình cài để ảnh không vào tarball nào.
- **Chép `LICENSE`** vào `plugin/` và liệt kê trong `files` của gói payload: MIT đòi kèm giấy phép trong mọi bản sao, mà gói payload là một bản phân phối độc lập. Thêm test giữ hai file không lệch.
- **Ra:** file tồn tại, mọi link mở được (HTTP 200) và ảnh hiện đúng khi xem `plugin/README.md` trên GitHub; `smoke:packed` khẳng định **không** tarball nào chứa `images/`; nội dung không hứa điều gì payload không làm được, và nói đúng lệnh cài thẳng theo từng phiên bản Paseo (design S14).

### WP-316 — `release.yml` publish hai gói

**Phụ thuộc:** WP-314 — workflow kiểm `name` và `version` của `plugin/package.json` trước khi publish.
**Design refs:** §5, §9.

- Thêm ba bước theo design §5: kiểm tra hai gói khớp nhau và `--dry-run` cả hai **trước** khi publish bất cứ gì; publish payload sau gói trình cài; xác minh bản payload đã lên.
- `scripts/smoke-packed.mjs` đóng gói cả hai gói và khẳng định gốc gói payload có `paseo-plugin.json`, `index.client.tsx`, `index.server.ts` — chính luật `entrypoint/missing` của registry.
- **Gói payload không có `prepack`**, nên nó publish đúng những gì đang nằm trong checkout: `plugin/shared/version.ts` và `version` của `plugin/package.json` phải đã đúng **từ commit**, không phải sinh ra lúc publish. Test đồng bộ ba phiên bản ở WP-314 là thứ bảo đảm điều đó, và bước "Assert both packages agree" ở design §5.3 là lưới chắn cuối trước khi có gì lên npm.
- **Ra:** `smoke:packed` xanh và có đối chứng: bỏ một runtime entry khỏi `files` của gói payload thì đỏ; `release.yml` qua được lần chạy `workflow_dispatch` (không publish) trên tag hiện tại.

### WP-317 — Chạy bộ luật quét của registry trên payload, **trước** khi publish

**Phụ thuộc:** WP-315 — phải quét đúng thư mục payload ở trạng thái cuối, gồm cả `LICENSE`, `README.md` và `images/` vừa chuyển vào.
**Design refs:** §2 (S9–S11), §9.

Đây là lần đầu toàn bộ payload bị `static-scan.ts` soi, và mọi finding của nó đều blocking (design S9). Biết kết quả sau khi publish thì đã muộn: bản đã lên npm không gỡ được.

- Kiểm `plugin/` theo từng luật blocking ở S9: manifest hợp lệ và `id` khớp; có runtime entry, không phải `index.ts` kiểu cũ; mọi import nằm đúng `client/`, `server/`, `shared/`; không import Node builtin hay SDK server từ mã không thuộc `server/`, không import React hay SDK client từ mã không thuộc `client/`; không có symlink; không file nào quá 2 MB.
- Nhiều luật trong số này đã có test cấu trúc payload canh sẵn (`test/plugin-structure.test.ts` giữ ranh giới import 0.8). Việc của WP này là **đối chiếu từng luật của họ với từng phép kiểm của ta**, và bù phép kiểm cho luật nào chưa có ai canh.
- **Ra:** một bảng đối chiếu luật ↔ bằng chứng trong hồ sơ vận hành, không còn ô trống. Có ô nào không tự kiểm được thì ghi thẳng là chưa kiểm được và báo owner trước khi sang WP-319, chứ không đoán.

### WP-318 — Bước giữ chỗ và trusted publisher cho tên mới

**Phụ thuộc:** WP-317 — không đưa tên gói mới lên npm khi chưa biết payload có qua nổi bộ luật quét hay không.
**Design refs:** ADR-009 QĐ3; runbook §1.

- Theo runbook §1, nhưng cho `paseo-bm-plugin`: publish bản `0.0.0-placeholder.0` dưới dist-tag `placeholder`, rồi `npm trust github paseo-bm-plugin --file release.yml --repo hieunt286/paseo-bm --allow-publish`, rồi `npm trust list`.
- Owner chốt Q13 b: Worker chạy bằng phiên npm đã đăng nhập sẵn trên máy. **Đây là lần đầu một tên gói mới xuất hiện dưới tài khoản của owner** — đọc kỹ tên trước khi gõ.
- **Ra:** `npm view paseo-bm-plugin dist-tags` có `placeholder`; `npm trust list paseo-bm-plugin` hiện cấu hình trỏ `release.yml`.

### WP-319 — Phát hành 0.3.0-alpha.6, hai gói

**Phụ thuộc:** WP-316 (workflow đã biết publish hai gói) và WP-318 (trusted publisher cho tên mới). Đây là WP **không lùi được** (§1.5).
**Design refs:** §5.

- Bump, ghi chú phát hành, verify, push `main`, tag, GitHub Release `--prerelease`, theo dõi `release.yml`.
- **Điểm phê duyệt** như runbook: owner đã duyệt hướng ở Q10/Q13, nhưng trước khi tạo Release phải đọc danh sách file của cả hai `--dry-run`.
- **Dist-tag `latest`:** `release.yml` chỉ đặt `next`. Với hồ sơ registry, thứ duy nhất quan trọng là **`paseo-bm-plugin@latest`**, vì `resolveNpmPackage` phân giải `@latest` của chính gói được khai (S6) — Worker dời tag này, cùng thẩm quyền npm mà owner đã cho ở Q13 b. Còn `paseo-bm@latest` là việc phát hành thường lệ của owner, không liên quan tới bốn cổng.
- **Ra:** hai gói cùng `0.3.0-alpha.6` trên npm, cùng provenance; tải gói payload về và thấy gốc là plugin nạp được; `npm view paseo-bm-plugin dist-tags` cho `latest` bằng `next` bằng `0.3.0-alpha.6`.

### WP-320 — Hồ sơ registry và PR #215 xanh

**Phụ thuộc:** WP-319 — cổng 3 và cổng 4 đọc gói **đã publish**, nên sửa hồ sơ sớm hơn chỉ tạo thêm một lần CI đỏ trên repo của người khác.
**Design refs:** §7.

- Sửa `registry/paseo-bm.json`: thêm `path: "plugin"`, đổi `package` sang `paseo-bm-plugin`, viết lại caveat số 2 cho đúng sự thật mới.
- Cập nhật mô tả PR; theo dõi `Registry admission` gồm cả bước quét.
- **Ra:** job `Registry admission` success. Nếu vẫn đỏ: đọc log, ghi vào hồ sơ vận hành, báo owner — không sửa cho qua.

### WP-321 — Dọn manifest ở gốc repo và ghi quy tắc hai gói vào `AGENTS.md`

**Phụ thuộc:** WP-320 — chỉ khi hồ sơ đã khai `path: "plugin"` và xanh thì manifest ở gốc mới thật sự không còn ai đọc.
**Design refs:** §6; ADR-009.

Sau WP-320, hồ sơ khai `path: "plugin"` nên `paseo-plugin.json` ở **gốc repo** không còn ai đọc: cổng 1 đọc `plugin/paseo-plugin.json`, cổng 3 đọc gốc tarball của gói payload. Để nguyên thì `AGENTS.md` đang nói một câu sai — rằng đó là file paseo.cafe đọc — và gốc gói `paseo-bm` vẫn khiến một lệnh cài thẳng *tìm thấy* một plugin rồi nạp lỗi, thay vì đơn giản là không phải plugin — trên Paseo 0.9 trở lên là dạng `npm:`, còn trên 0.8 là khi ai đó trỏ `paseo plugin install` vào một checkout của repo (S14).

- Gỡ `paseo-plugin.json` ở gốc repo, mục `paseo-plugin.json` trong `files`, test soi gương và khẳng định tương ứng trong `smoke-packed.mjs`; thay bằng khẳng định rằng gốc gói trình cài **không** có manifest.
- `AGENTS.md`: ghi quy tắc hai gói — `plugin/` là gói `paseo-bm-plugin` và gốc gói ấy phải nạp được; mỗi lần phát hành ra hai gói cùng phiên bản; hồ sơ registry khai `path` cộng `package`; bốn cổng của paseo.cafe và chỗ tra cứu. Sửa khối "Repository layout" cho khớp.
- `docs/operations/paseo-bm-release-runbook.md` §1: ghi rằng quyết định Q13 b của owner thay luật "người chạy không đăng nhập npm" cho lần phát hành này, để runbook không mâu thuẫn với việc đã làm.
- Hồ sơ vận hành: §5 và §10 ghi trạng thái cuối.
- **Ra:** `npm run verify` và `smoke:packed` xanh; `Registry admission` của PR #215 vẫn success sau khi đổi (đổi repo không đụng gói đã publish, nhưng phải kiểm lại chứ không đoán); không còn câu nào trong repo nói sai về vai trò của từng file.
