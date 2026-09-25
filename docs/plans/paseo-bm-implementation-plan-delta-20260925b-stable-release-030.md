# Delta plan — Phát hành bản ổn định `0.3.0` lên npm và cập nhật hồ sơ paseo.cafe

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260925b-stable-release-030` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS) và [delta 20260925 kanban-quiet-colours](paseo-bm-implementation-plan-delta-20260925-kanban-quiet-colours.md) (Active) — **không sửa tại chỗ**. Delta này thêm WP-322 → WP-327 |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-25 — hieu.nt10** (Beads Worker tự chấm theo `plan-ready-for-beads`; xem §6) |
| Owner | hieu.nt10 |
| Created | 2026-09-25 |
| Request | `req-20260925T033834Z` — "Tôi muốn tạo một bàn release 0.1.0 trên paseo.cafe và npm, hãy xem quy trình triển khai hiện tại và release phiên bản giúp tôi" |
| Routing decision | [design-delta-20260925b-stable-release](../design/paseo-bm-delta-20260925b-stable-release.md) §0 |
| Source design | [design-delta-20260925b-stable-release](../design/paseo-bm-delta-20260925b-stable-release.md) — nguồn duy nhất cho mã workflow, luật dist-tag và danh sách errata |
| Source PRD | **N/A có lý do** — delta không thêm hay đổi REQ nào. Nội dung bản phát hành (REQ-069 và errata REQ-060) đã có [PRD delta 20260925](../product/paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) riêng, đã Accepted và đã implement; delta này chỉ quyết **cách đưa chúng lên npm dưới một số hiệu ổn định** |
| ADR | N/A — không thực thi quyết định ADR mới; chạy trong khuôn [ADR-009](../adr/ADR-009-payload-as-npm-package.md) |
| Runbook | [release runbook](../operations/paseo-bm-release-runbook.md) §2, cộng §4 mới cho luồng bản ổn định (WP-322) |
| Ghi chú phát hành | [`paseo-bm-release-notes-0.3.0.md`](../operations/paseo-bm-release-notes-0.3.0.md) — dùng làm `--notes-file` của GitHub Release |
| Phase | **Phase 2a-21 — Phát hành bản ổn định `0.3.0`** (nhãn bead `phase:2a-21`) |

## 0. Routing Decision

Lấy nguyên từ design delta §0: public contract đổi (bản mà `npx paseo-bm` lấy về) + rollback yếu R3 (publish không lùi được sau 72 giờ) → design delta + delta plan + beads, không PRD delta.

## 1. MVP-Lock

### 1.1 Phạm vi

**Trong phase:**

1. `release.yml` nhận bản không phải prerelease và đặt dist-tag theo loại phiên bản (design delta §2.1, §2.2).
2. Errata **bảy** chỗ tài liệu nói "prerelease" hoặc "chỉ `next`" (design delta §4).
3. Commit **hai** đợt việc đang nằm trong working tree, mỗi đợt một commit — owner chốt Q2 a:
   - `bm-qh4c` (đã đóng): trình cài đặt đọc `paseo --version` khi `daemon status --json` của Paseo 0.9.2 không có `cliVersion` — `src/paseo/adapter.ts`, `test/paseo-adapter.test.ts`, errata `docs/adr/ADR-004-paseo-config-mutation.md`, một dòng Verified facts trong `AGENTS.md`. Không có nó, **mọi** lệnh của trình cài đặt dừng ở `E_PASEO_OUTPUT_UNEXPECTED` (exit 3) trên Paseo 0.9.2.
   - REQ-069 (đã đóng): kanban bốn cột, chữ yên tĩnh, Setup chia tab, thẻ Errors ở Metric — mã plugin, test và ba tài liệu delta của nó.
4. Bump `0.3.0-alpha.7` → **`0.3.0`** ở ba nguồn phiên bản (`package.json`, `plugin/package.json`, `PLUGIN_VERSION`), hai cái sau do `npm run build` sinh.
5. Ghi chú phát hành `0.3.0`.
6. Phát hành: tag `v0.3.0`, GitHub Release **không** đánh dấu prerelease, hai gói lên npm kèm provenance, `latest` trỏ bản mới.
7. Cập nhật `registry/paseo-bm.json` trên nhánh PR `hieunt286:add-paseo-bm` cho khớp bản ổn định, và một comment nhắc maintainer ở PR #215 — owner chốt Q4 a.
8. Bản ghi lần chạy.

**Ngoài phase:**

- **Dời `next` sang `0.3.0`**: cần `npm dist-tag add`, cần OTP, là việc tay của owner (design delta §2.3).
- **Merge PR #215**: thuộc maintainer của `paseo-cafe/paseo-cafe`. Không phải điều kiện ra của phase.
- **Mở trang listing kiểm ba ảnh**: chỉ làm được sau khi họ merge và quét lại.
- Mọi thay đổi mã sản phẩm ngoài REQ-069 đã implement. Delta này **không** viết thêm tính năng.
- `npm unpublish`, đổi tên gói, đổi tên `release.yml`.

### 1.2 Điều kiện ra của phase

| # | Điều kiện | Cách đo |
|---|---|---|
| 1 | `npm run verify` mã 0 trên đúng cây được tag | Chạy tại máy sau khi bump; ghi số file test / số test |
| 2 | `ci.yml` của commit phát hành trên `main` `success` | `gh run list --workflow ci.yml`, đúng sha, conclusion `success` |
| 3 | Dry-run `release.yml` `success`, đúng 2 job `verify`, `Publish (dry-run)` chạy với dist-tag `latest`, các bước publish thật `skipped` | `gh run view --json` của lần `workflow_dispatch` |
| 4 | Lần chạy `release.yml` của sự kiện `release` xanh ở `Publish to npm`, `Publish payload to npm`, `Verify published version`, `Verify published payload` | `gh run view` của lần chạy đó |
| 5 | `npm view paseo-bm version` và `npm view paseo-bm-plugin version` trả `0.3.0`; `dist-tags.latest` của cả hai là `0.3.0`; cả hai có `dist.attestations` provenance SLSA v1 | Bốn lệnh `npm view`, đọc lại kết quả |
| 6 | Hồ sơ registry trên nhánh PR không còn gọi sản phẩm là prerelease; có một comment nhắc ở PR #215 | `gh api` đọc lại file trên nhánh đó; link comment |

### 1.3 Checkpoint / đường lùi mặc định

Lùi được bằng `git revert` cho tới **trước** khi tạo GitHub Release. Sau khi publish thì đường lùi là **phát hành bản vá `0.3.1`**, không `npm unpublish` (design delta §5). Điểm không đảo ngược: bước tạo GitHub Release ở WP-325 — chủ rủi ro là owner, diễn tập bắt buộc ở WP-324, và §2 nói rõ diễn tập chứng minh được gì.

## 2. Thứ tự và vì sao

```
WP-323a (commit hai đợt việc đang treo)
   └─> WP-322 (workflow + errata)
          └─> WP-323b (bump 0.3.0, build, verify, commit chore(release))
                 └─> WP-324 (main, ci.yml, dry-run release.yml)
                        └─> WP-325 (tag + GitHub Release + publish + xác minh)
                               └─> WP-326 (hồ sơ paseo.cafe trên nhánh PR + comment)
                                      └─> WP-327 (bản ghi lần chạy, đóng phase)
```

Một chuỗi thẳng, và mỗi cạnh là một cạnh thật:

- **WP-323a → WP-322**: errata của WP-322 sửa `AGENTS.md` và `GUIDE.md`, mà hai file đó **đang mang thay đổi chưa commit** của `bm-qh4c` và REQ-069. `git commit <path>` commit cả file, nên viết errata trước thì không tách được hai đợt ra hai commit, và cây này thì không được `reset`. Commit việc đang treo trước là cách duy nhất giữ lịch sử sạch mà không đụng tới thay đổi của người khác.
- **WP-322 → WP-323b**: commit được tag phải **đã chứa** `release.yml` mới, vì lần chạy của sự kiện `release` đọc workflow ở đúng ref được phát hành. Sửa workflow sau khi tag là phát hành bằng workflow cũ — và workflow cũ từ chối `0.3.0`.
- **WP-323b → WP-324**: chưa có commit `chore(release)` thì không có gì để đẩy lên `main` và không có sha để kiểm.
- **WP-324 → WP-325**: diễn tập là điều kiện phê duyệt của bước không đảo ngược được. Nó chứng minh **ma trận kiểm tra xanh, `smoke:packed` xanh, và workflow tính ra `dist-tag=latest`** — chứ **không** chứng minh registry nhận tag đó, vì `npm publish --dry-run` không hỏi registry publish (design delta §5).
- **WP-325 → WP-326**: caveat mới nói "bản ổn định `0.3.0` đang có trên npm"; viết nó trước khi publish là viết một câu chưa đúng vào repo của người khác.
- **WP-327** đi cuối vì bản ghi lần chạy chép lại bằng chứng của năm bước trên.

## 3. Chiến lược kiểm thử của phase

| Mức | Cách làm |
|---|---|
| Unit / integration | Bộ test sẵn có: `npm run verify` (`typecheck`, `typecheck:plugin`, `lint`, `vitest run`, `build`). Không thêm test mới: delta không đổi một dòng mã sản phẩm nào. Số test **phải lớn hơn hoặc bằng** con số của cây hiện tại (REQ-069 đã thêm test) và không được giảm |
| Phủ | Không đặt mục tiêu phủ mới |
| Thứ tự bắt buộc | **bump → `npm run build` → `npm run verify`**. `verify` chạy `test` trước `build`, nên `verify` ngay sau khi bump mà chưa build luôn đỏ hai test phiên bản (`test/plugin-structure.test.ts`, `test/plugin-role-labels.test.ts`) — bẫy đã ghi ở [run 20260923](../operations/paseo-bm-release-run-20260923.md) |
| Ghim minor payload | `test/plugin-role-labels.test.ts` ghim `PLUGIN_VERSION.startsWith("0.3.")`. `0.3.0` **qua được ghim này**; ghim **không** được sửa hay xoá trong phase này |
| Mã workflow | Logic `Resolve version, tag and dist-tag` được chạy tại máy trên hai đầu vào (`0.3.0` → `latest`, `0.3.0-alpha.7` → `next`) trước khi đẩy; bằng chứng thật là lần dry-run trên GitHub |
| Bằng chứng nền tảng | `ci.yml` (Node 22, ubuntu) ở WP-324; `release.yml` (Node 24 × {ubuntu, macOS}) kèm `smoke:packed` ở WP-324 (dry-run) và WP-325 (thật) |
| Bằng chứng gói | `smoke:packed` đóng gói tarball thật, cài ngoại tuyến, chạy bin đã cài; nó cũng canh hai chiều của ADR-009 (gốc gói trình cài không được giống plugin, gốc gói payload phải là plugin nạp được) |

## 4. Work packages

### WP-322 — `release.yml` nhận bản ổn định, và errata tài liệu

- **Outcome**: workflow publish được một phiên bản không phải prerelease, vào dist-tag `latest`; bảy chỗ tài liệu không còn câu sai.
- **Design refs**: design delta §2.1, §2.2, §2.4 (mã), §4 (bảng bảy chỗ).
- **REQ/AC**: N/A — không REQ nào đổi; phục vụ điều kiện ra số 3 và 4 của §1.2.
- **Prerequisites**: WP-323a — `AGENTS.md` và `GUIDE.md` phải sạch trước khi viết errata vào chúng (§2).
- **Exit**: `release.yml` không còn nhánh chặn `!prerelease`; `distTag` là `prerelease ? "next" : "latest"`; comment của bước `Publish to npm` khớp hành vi mới; bảy chỗ errata trong năm file đã sửa; logic resolve chạy tại máy cho ra `latest` với `0.3.0` và `next` với `0.3.0-alpha.7`; `npm run verify` mã 0; **và output của chính WP này đã vào một commit riêng**: `release.yml`, năm file errata, cùng ba tài liệu mới của phase (design delta, delta plan, ghi chú phát hành — `git add` theo đường dẫn trước vì chúng là file untracked). Không có commit này thì tag sẽ rơi vào một cây còn `release.yml` cũ, và workflow cũ từ chối `0.3.0`.

### WP-323a — Commit hai đợt việc đang treo

- **Outcome**: hai commit trên nhánh làm việc, một cho `bm-qh4c` (bản vá trình cài đặt cho Paseo 0.9.2), một cho REQ-069 — không commit nào lẫn việc của đợt kia.
- **Design refs**: bead `bm-qh4c` (Scope liệt kê đúng bốn đường dẫn của nó); [delta plan kanban-quiet-colours](paseo-bm-implementation-plan-delta-20260925-kanban-quiet-colours.md) cho REQ-069.
- **REQ/AC**: REQ-069 (a)–(h), errata REQ-060 (g)(h)(j)(k)(n), và bead `bm-qh4c` — tất cả **đã implement và đã đóng bead**; WP này chỉ commit, không sửa một dòng mã nào của chúng.
- **Prerequisites**: không.
- **Exit**: `npm run verify` mã 0 **trước** commit đầu tiên; hai commit tồn tại và commit `bm-qh4c` đi trước; `AGENTS.md` cùng `GUIDE.md` đã vào lịch sử nên hết bẩn; không `git add -A`; không hoàn tác hay định dạng lại thay đổi của ai.

### WP-323b — Bump `0.3.0` và commit `chore(release)`

- **Outcome**: ba nguồn phiên bản đều `0.3.0`, và một commit `chore(release): 0.3.0` ở đỉnh — đúng commit sẽ được tag.
- **Design refs**: design delta §2 (số hiệu); `scripts/generate-plugin-version.mjs` (generator ghi `plugin/package.json` và `plugin/shared/version.ts`).
- **REQ/AC**: N/A — bước phát hành.
- **Prerequisites**: WP-322 (commit được tag phải đã chứa `release.yml` mới).
- **Exit**: ba nguồn phiên bản đều `0.3.0`; `npm run verify` mã 0 sau **bump → build**; commit `chore(release): 0.3.0` ở đỉnh; ghi chú phát hành có dòng kiểm chứng với số đo thật; `git status` sạch phần của phase này.

### WP-324 — Đưa lên `main`, `ci.yml` xanh, diễn tập `release.yml`

- **Outcome**: commit phát hành nằm trên `main` của remote, CI mỗi commit xanh, và một lần chạy dry-run của `release.yml` xanh với dist-tag `latest`.
- **Design refs**: design delta §5 (diễn tập chứng minh được gì, và không chứng minh được gì); run 20260923 bẫy số 4 (đẩy `feat/worker-fallback:main` thay vì `git checkout main` khi `.beads/issues.jsonl` bẩn).
- **REQ/AC**: điều kiện ra số 2 và 3 của §1.2.
- **Prerequisites**: WP-323b.
- **Exit**: `gh run` của `ci.yml` ở đúng sha conclusion `success`; `gh run` của `workflow_dispatch` trên `release.yml` conclusion `success`, đúng 2 job `verify`, `Publish (dry-run)` và `Publish payload (dry-run)` success với dòng log ghi dist-tag `latest`, bốn bước publish/verify thật `skipped`.

### WP-325 — Phát hành `0.3.0` lên npm

- **Outcome**: `paseo-bm@0.3.0` và `paseo-bm-plugin@0.3.0` trên npm, dist-tag `latest`, kèm provenance.
- **Design refs**: design delta §2.1 (Release **không** đánh dấu prerelease), §2.3 (`next` giữ nguyên); runbook §2 + §4.
- **REQ/AC**: điều kiện ra số 4 và 5 của §1.2.
- **Prerequisites**: WP-324.
- **Exit**: tag `v0.3.0` đẩy lên; GitHub Release `v0.3.0` tạo bằng `--notes-file` ghi chú phát hành, **không** `--prerelease`; lần chạy `release` xanh ở bốn bước publish/verify; bốn lệnh `npm view` trả `0.3.0` và provenance; `npx --yes paseo-bm@0.3.0 --version` trong một thư mục tạm in `0.3.0`.

### WP-326 — Hồ sơ paseo.cafe trên nhánh PR #215

- **Outcome**: `registry/paseo-bm.json` trên nhánh `hieunt286:add-paseo-bm` mô tả đúng bản ổn định; maintainer được nhắc một lần.
- **Design refs**: design delta §3; [listing record](../operations/paseo-bm-cafe-listing-20260923.md) §2 (schema `.strict()`, caveat ≤ 6 câu, ≤ 140 ký tự), §13 (hai lỗi phải tránh: file 0 byte, Biome giữ mảng ngắn một dòng).
- **REQ/AC**: điều kiện ra số 6 của §1.2.
- **Prerequisites**: WP-325 (câu caveat nói về bản đã có trên npm).
- **Exit**: file trên nhánh đó parse được, đúng schema, sáu caveat mỗi câu ≤ 140 ký tự, mảng ngắn trên một dòng, nội dung khác rỗng đã kiểm **trước** khi ghi; một comment ở PR #215 có link; không đụng tới bất kỳ file nào khác trong repo của họ.

### WP-327 — Đóng phase

- **Outcome**: bản ghi lần chạy `docs/operations/paseo-bm-release-run-20260925.md`; đồ thị bead sạch.
- **Design refs**: mẫu [run 20260923](../operations/paseo-bm-release-run-20260923.md) — cùng bố cục (bản này mang gì, sáu điều kiện ra kèm bằng chứng, bảng dist-tag, đường lùi, bẫy gặp phải).
- **REQ/AC**: N/A — đóng phase.
- **Prerequisites**: WP-326.
- **Exit**: bản ghi có bằng chứng của cả sáu điều kiện ra; `br lint -s all` không cảnh báo trên bead của phase này; `br dep cycles` không cycle; epic và mọi leaf `closed`.

## 5. Rollback yếu (R3)

| Trường | Giá trị |
|---|---|
| Chủ rủi ro | **hieu.nt10** (owner). Worker không chạy `npm publish` bằng tay, không chạy `npm trust`, `npm dist-tag`, không chạm thông tin đăng nhập; publish đi qua OIDC trong workflow |
| Diễn tập | **Có, bắt buộc** — WP-324, `workflow_dispatch`, đi qua đúng ma trận, `smoke:packed`, `npm publish --dry-run --tag latest` cho cả hai gói |
| Điểm phê duyệt | Việc tạo GitHub Release ở WP-325. Trước đó còn lùi được bằng cách xoá tag |
| Đường lùi sau khi publish | Phát hành `0.3.1`. Hạ bản: `npx paseo-bm@0.3.0-alpha.7` còn dùng được và chỉ thiếu REQ-069 (giao diện), không thiếu tính năng cốt lõi nào — rẻ hơn hẳn đường lùi của lần phát hành trước |
| Diễn tập chứng minh được gì | Ma trận kiểm tra xanh, `smoke:packed` xanh, hai gói đóng gói được, và workflow tính ra `dist-tag=latest`. **Không** chứng minh registry nhận tag đó: `npm publish --dry-run` không hỏi registry publish. Nếu sau khi publish `latest` không dời, owner chạy `npm dist-tag add paseo-bm@0.3.0 latest` và lệnh tương tự cho gói payload — đúng bước tay vẫn dùng tới hôm nay |

## 6. Gate plan-ready-for-beads — tự chấm

```
Gate: plan-ready-for-beads

Required:
  ✓ Header: Status Active, Owner, Routing Decision, Source design, Source PRD (N/A có lý do), Phase "Phase 2a-21"
  ✓ MVP-lock: 8 mục trong phase, 5 mục ngoài phase, 6 điều kiện ra đo được
  ✓ Checkpoint posture: §1.3 — revert được tới trước GitHub Release, sau đó là bản vá
  ✓ Work packages: 7 WP (WP-322, WP-323a, WP-323b, WP-324..WP-327), mỗi WP có outcome, design refs, prerequisites, exit
  ✓ Dependencies: 6 cạnh, một chuỗi thẳng, không cycle, mỗi cạnh nêu sản phẩm mà WP sau cần
  ✓ Test strategy: §3, gồm thứ tự bump → build → verify và ghim minor payload
  ✓ R3: §5 — chủ rủi ro, diễn tập bắt buộc, điểm phê duyệt, hai đường lùi
  ✓ Open questions: không còn — Q1..Q4 của request đã có trả lời (a, a, a, a)

Decomposition-readiness:
  ✓ Không phải đoán gì: mã workflow ở design delta §2, bảy chỗ errata trong năm file ở §4, số hiệu phiên bản đã chốt
  ✓ Seam đã nêu: WP-325 là điểm không đảo ngược; WP-326 ghi vào repo của người khác
  ✓ Sequencing tường minh, kèm lý do từng cạnh ở §2

Warnings:
  - 7 WP trong một phase: ổn
  - Chuỗi thẳng không nhánh: đúng bản chất của một lần phát hành, không phải thiếu cạnh

Verdict: PASS.
```

## 7. Câu hỏi mở

| Mã | Nội dung | Trả lời |
|---|---|---|
| Q1 | Số hiệu bản phát hành | **a** — bản ổn định `0.3.0` |
| Q2 | Nội dung bản phát hành | **a** — commit phần việc REQ-069 đang treo rồi phát hành |
| Q3 | `release.yml` cho bản ổn định | **a** — workflow nhận bản ổn định và đặt dist-tag `latest` |
| Q4 | paseo.cafe | **a** — cập nhật hồ sơ trên nhánh PR #215 và nhắc maintainer |

## Revision history

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta plan, kích hoạt phase 2a-21 với WP-322 → WP-327; phạm vi đóng băng theo §1.1 |
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo review lô `b1`: thêm `bm-qh4c` vào phạm vi commit; tách WP-323 thành WP-323a (commit việc đang treo, **đi trước** WP-322 vì `AGENTS.md`/`GUIDE.md` đang bẩn) và WP-323b (bump); nói đúng diễn tập chứng minh được gì; REQ-069 (a)–(h); errata bảy chỗ |
| 2026-09-25 | hieu.nt10 (soạn bởi Beads Worker) | Sửa theo re-review lô `b1`: WP-322 nay commit chính output của nó (`release.yml`, năm file errata, ba tài liệu mới của phase) — sau khi tách WP-323 thì không WP nào commit chúng, và tag sẽ rơi vào cây còn `release.yml` cũ; đồng bộ "bảy chỗ trong năm file" ở mọi chỗ |
