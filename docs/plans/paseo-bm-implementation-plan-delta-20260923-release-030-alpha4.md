# Delta plan — Phát hành gộp `0.3.0-alpha.4` lên npm

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260923-release-030-alpha4` |
| Plan gốc | [delta 20260921 worker-fallback-and-role-settings](paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md) (Active, Applied). **Không sửa tại chỗ.** Delta này thêm WP-310 → WP-314 và **đảo điều kiện ra số 4** của plan đó (xem §1.1) |
| Status | **Active** |
| Plan-ready | **PASS — 2026-09-23 — hieu.nt10** (tự chấm bởi Beads Worker sau khi review batch `b1` pass ở lần re-review, không còn phát hiện nào) |
| Owner | hieu.nt10 |
| Created | 2026-09-23 |
| Request | `req-20260923T040415Z` — "Tôi muốn public bản mới bao gồm những gì đã sửa này lên npmjs" |
| Source design | **N/A có lý do** — delta này không đổi một dòng mã sản phẩm nào. Mã của 2a-13…2a-18 đã viết, đã review và đã Applied theo [design delta 20260921](../design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md) và ADR-008; bản vá nút Beads đã đóng ở bead `bm-n99t`. Delta này chỉ quyết **cách đưa chúng lên npm** |
| Source PRD | [PRD delta 20260921](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md) REQ-067 (c) — điều kiện phát hành bản mang "Auto switch"; PRD gốc §11 Phase 1 MVP — *"một phiên bản prerelease có trên npm kèm provenance"* |
| ADR | N/A — delta không thực thi quyết định ADR nào |
| Runbook | [release runbook](../operations/paseo-bm-release-runbook.md) §2 — quy trình phát hành không đổi |
| Phase | **Phase 2a-19 — Phát hành gộp `0.3.0-alpha.4`** (nhãn bead `phase:2a-19`) |

## 0. Routing Decision

- Variant preset: brownfield
- Triggered risks: **rollback yếu** (`npm publish` không gỡ được sau 72 giờ) → Large
- Required artifacts/gates: delta plan này + `plan-ready-for-beads`; `feature-done` hồ sơ chuẩn khi đóng. **Không** cần PRD mới hay Technical Design mới — xem hai dòng *Source* ở bảng trên
- Execution path: plan → converter → beads
- Exceptions: none
- Decided: 2026-09-23 — hieu.nt10 (soạn bởi Beads Worker), theo năm câu trả lời Q1–Q5 của `req-20260923T040415Z`
- Supersedes: none

## 1. MVP-Lock

### 1.1 Điều kiện ra của plan gốc bị đảo

Plan gốc (delta 20260921) §1.3 *"Điều kiện ra của mỗi phase"* mục 4 viết: *"Owner phát hành bản của phase theo runbook."* §2 nói rõ lý do: *"mỗi phase là một bản phát hành riêng, cắt từ một cây chỉ có thay đổi của phase đó và các phase trước"*, để mỗi bước rút lại được bằng cách cài bản trước.

**Thực tế:** không phase nào được phát hành. Sáu ghi chú phát hành (`0.2.0-alpha.2`, `0.3.0-alpha.0` → `0.3.0-alpha.4`) đã viết, nhưng `package.json` chưa bao giờ rời `0.2.0-alpha.1` và tag mới nhất cũng là `v0.2.0-alpha.1`. Tính chất "rút lại bằng cách cài bản trước" của từng phase **đã mất từ trước request này**: không có bản trung gian nào trên npm để lùi về.

Delta này thay mục 4 bằng: **một bản prerelease gộp duy nhất, `0.3.0-alpha.4`**, mang cả phase 2a-13 → 2a-18 và bản vá nút Beads (`bm-n99t`). Đây là quyết định của owner (Q1: a, `req-20260923T040415Z`), ghi ở đây chứ không sửa đè lên plan gốc.

Chọn đúng số `0.3.0-alpha.4` vì đó là số mà mọi tài liệu đã đóng băng đang gọi tên cho bản mang "Auto switch" (plan gốc §1.2 bảng phase, checklist nghiệm thu mục 18, PRD delta REQ-067). Hệ quả: các số `0.2.0-alpha.2`, `0.3.0-alpha.0` → `.3` sẽ **không bao giờ tồn tại trên npm**; ghi chú của chúng ở lại `docs/operations/` như lịch sử theo phase, và ghi chú của `0.3.0-alpha.4` phải nói rõ điều đó cùng đường lùi thật.

Tiền lệ: `0.2.0-alpha.1` cũng là một bản gộp (commit `5e69a7e` mang nút Beads trên header cộng kết quả delta 20260918), nên gộp không trái thông lệ của kho.

### 1.2 Phạm vi

- **Trong phạm vi:**
  - errata cho `docs/operations/paseo-bm-release-notes-0.3.0-alpha.4.md` (đường lùi, bản vá nút Beads, nói rõ bản này gộp);
  - ghi kết quả mục **18.1** vào `docs/operations/paseo-bm-worker-fallback-checklist.md`;
  - dòng `Status: prerelease (0.2.0-alpha.*)` của `README.md`;
  - commit ba file đang sửa dở trong working tree (`plugin/client/beads-header-button.ts`, `test/plugin-beads-header-button.test.ts`, `.beads/issues.jsonl`);
  - nâng phiên bản lên `0.3.0-alpha.4` (`package.json`, `package-lock.json`, `plugin/shared/version.ts`);
  - fast-forward `main`, push, chờ `ci.yml` xanh, diễn tập `release.yml`, tạo tag và GitHub prerelease;
  - một bản ghi lần chạy trong `docs/operations/`.
- **Ngoài phạm vi (dễ tưởng là trong):**
  - **mọi thay đổi mã sản phẩm** — delta này không sửa một dòng nào trong `src/` hay `plugin/`, trừ `plugin/shared/version.ts` do bộ sinh của build ghi;
  - **sửa năm ghi chú phát hành theo phase** đã có (`0.2.0-alpha.2`, `0.3.0-alpha.0` → `.3`) — giữ nguyên làm lịch sử; ghi chú của `0.3.0-alpha.4` sẽ trỏ tới chúng;
  - **các mục nghiệm thu 18.2 → 18.6** — owner chốt Q4: a, phát hành không chờ chúng; chúng vẫn "Chưa đo" trong checklist;
  - **mọi lệnh npm ghi** — `npm publish`, `npm trust`, `npm dist-tag` — việc của owner, cần OTP. Worker chỉ được chạy lệnh npm **đọc**, đúng ba lệnh, và cả ba đều là bằng chứng của một WP: `npm view paseo-bm dist-tags` (WP-314), `npm view paseo-bm@next version` và `npm view paseo-bm@next dist.attestations` (WP-313). Đây là ranh giới owner đã chốt ở Q5: a;
  - **chuyển `latest`** sang bản mới — owner tự chạy sau khi publish (Q5: a);
  - **`docs/plans/paseo-bm-implementation-plan-v2.md`** và ba tài liệu delta 20260921 — không sửa nội dung, chỉ thêm một dòng revision trỏ tới delta này khi Applied.
- **Điều kiện ra của phase:**
  1. `npm run verify` mã 0 trên cây sẽ được tag.
  2. Vòng `ci.yml` của commit phát hành trên `main` kết thúc `success`.
  3. Dry-run `release.yml` (`workflow_dispatch`) `success`, đúng 2 job `verify`.
  4. Run `release.yml` của sự kiện `release` xanh ở bước `Publish to npm` và `Verify published version`.
  5. `npm view paseo-bm@next version` trả `0.3.0-alpha.4`, có provenance.
- **Hợp đồng đang được tiêu thụ:** delta này **không** đổi hợp đồng nào. Các hợp đồng mà bản phát hành mang theo (RPC `roles.save-fallback` nhận `policy: "auto"`, `install.json`, `role-fallback.json`) đã chốt và đã review trong phase 2a-13…2a-18; tương thích của chúng ghi ở phần "Tương thích" của từng ghi chú phát hành. Thứ duy nhất người ngoài thấy mới là có một phiên bản mới trên dist-tag `next`.
- **Tư thế hoàn tác mặc định:** revert đúng các file trong phạm vi của từng WP. **Ngoại lệ duy nhất là WP-313**: sau khi publish thì không lùi được sau 72 giờ — xem §5.

## 2. Thứ tự và vì sao

```
WP-310 ──> WP-311 ──> WP-312 ──> WP-313 ──> WP-314
(tài liệu) (commit +  (main +    (phát      (đóng)
           bump)      diễn tập)  hành)
```

Năm WP nối tiếp, mỗi cạnh là một phụ thuộc thật:

- **WP-310 → WP-311.** WP-311 cần *"tài liệu phát hành đã đúng"*: commit phát hành phải mang theo ghi chú và checklist đã sửa, nếu không tag sẽ trỏ vào một cây mà ghi chú còn nói sai đường lùi.
- **WP-311 → WP-312.** WP-312 cần *"cây đã mang đúng số phiên bản"*: `release.yml` so `package.json` với tên tag và dừng nếu lệch, nên bump phải xong trước khi đẩy lên `main`.
- **WP-312 → WP-313.** WP-313 cần *"`main` xanh thật và dry-run xanh"* — điều kiện tiên quyết cứng của runbook, đã áp dụng ở lần phát hành trước (`bm-release-howto-stkl`).
- **WP-313 → WP-314.** WP-314 chỉ ghi lại được khi đã có bằng chứng publish thật.

## 3. Chiến lược kiểm thử của phase

Delta này **không thêm một test nào** — nó không đổi mã sản phẩm.

| Mức | Cách làm |
|---|---|
| Unit / integration | Bộ test sẵn có, `npm run verify` (`typecheck`, `typecheck:plugin`, `lint`, `vitest run`, `build`). Số test phải **giữ nguyên 2880 / 119 file** trước và sau khi bump; bump chỉ đổi một hằng chuỗi |
| Phủ | Không đặt mục tiêu phủ mới |
| Bằng chứng nền tảng | Vòng CI thật trên GitHub: `ci.yml` (Node 22) ở WP-312, rồi `release.yml` (Node 24 × {ubuntu, macOS}) kèm `smoke:packed` ở WP-312 (dry-run) và WP-313 (thật) |
| Bằng chứng gói | `smoke:packed` đóng gói tarball thật, cài ngoại tuyến vào một dự án tạm và chạy bin đã cài — đây là thứ bắt được file thiếu trong `files` của `package.json`, mà chạy trên cây nguồn không thấy |

**Bẫy đã biết (sửa errata 2026-09-23 sau khi gặp thật):** `build` là bước sinh lại `plugin/shared/version.ts` từ `package.json`, nhưng `npm run verify` chạy `test` **trước** `build`. Vì vậy lần `verify` đầu tiên ngay sau khi bump **luôn** đỏ hai test phiên bản (`test/plugin-structure.test.ts`, `test/plugin-role-labels.test.ts`): lúc test chạy, `version.ts` còn số cũ. Thứ tự đúng là **bump → `npm run build` → `npm run verify` → commit**. Bỏ bước `build` riêng thì `version.ts` trong commit còn số cũ và plugin tự báo sai phiên bản.

## 4. Work packages

### WP-310 — Tài liệu phát hành

- **Kết quả:** ghi chú `0.3.0-alpha.4` mô tả đúng một bản gộp; mục 18.1 của checklist có kết quả thật; README không còn nói bản hiện hành là `0.2.0-alpha.*`.
- **REQ/AC:** REQ-067 (c) — điều kiện phát hành phải được kiểm và ghi lại trước bước phát hành.
- **Design refs:** [checklist nghiệm thu](../operations/paseo-bm-worker-fallback-checklist.md) mục 18.1; [release runbook](../operations/paseo-bm-release-runbook.md) §2.
- **Phạm vi:** đúng ba file — `docs/operations/paseo-bm-release-notes-0.3.0-alpha.4.md`, `docs/operations/paseo-bm-worker-fallback-checklist.md`, `README.md`.
- **Nội dung bắt buộc của ghi chú:** (a) bỏ khối trích dẫn "Chưa phát hành" và nói bản này **gộp** phase 2a-13 → 2a-18, có liên kết tới năm ghi chú theo phase; (b) thêm bản vá nút Beads (`bm-n99t`); (c) mục **"Hoàn tác"** sửa đường lùi từ `0.3.0-alpha.3` thành **`0.2.0-alpha.1`** — số trung gian không tồn tại trên npm — và nói rõ hạ bản là bỏ toàn bộ delta 20260921, theo đúng §5; (d) mục **"Tương thích"** sửa theo: câu "cài lại một bản trước … coi cả file là không dùng được" được viết cho `0.3.0-alpha.3`, không đúng cho `0.2.0-alpha.1` (bản đó không đọc `role-fallback.json`), nên phải nói đúng bản nào áp dụng.
- **Nội dung bắt buộc của checklist 18.1:** cột "Kết quả" ghi **Đạt** kèm bằng chứng đọc được: id sự cố, `signal`, `message`, `class`, mẫu nào khớp, ngày đọc.
- **Không đụng:** năm ghi chú phát hành theo phase; các mục 18.2 → 18.6 (vẫn "Chưa đo"); nội dung PRD, thiết kế, plan gốc.
- **Prerequisite:** không.
- **Điều kiện ra:** đọc lại ba file thấy đúng bốn điểm (a) → (d) và mục 18.1 ở trên; `git status` không có file nào ngoài phạm vi WP này, ngoài những file đã bẩn từ trước khi request bắt đầu (ba file working tree) và chính tài liệu delta này, đang untracked cho tới WP-311.
- **Hoàn tác:** revert đúng ba file đó.

### WP-311 — Commit bản vá nút Beads và bump `0.3.0-alpha.4`

- **Kết quả:** trên nhánh `feat/worker-fallback` có hai commit mới: một mang bản vá nút Beads cùng đồ thị bead, một là `chore(release): 0.3.0-alpha.4`.
- **REQ/AC:** N/A có lý do — bước vận hành.
- **Design refs:** commit `5e69a7e` là mẫu của commit phát hành trong kho này (`package.json`, `package-lock.json`, `plugin/shared/version.ts`).
- **Phạm vi:** commit 1 — `plugin/client/beads-header-button.ts`, `test/plugin-beads-header-button.test.ts`, `.beads/issues.jsonl`, ba file tài liệu của WP-310, **và tài liệu delta này** (đang untracked; đưa vào đây để không có file nào lơ lửng qua WP-312 và WP-313). Commit 2 — `package.json`, `package-lock.json`, `plugin/shared/version.ts`.
- **Ràng buộc cứng:** `git commit <đường dẫn cụ thể>`, **không bao giờ** `git add -A` / `git add .`. Sau hai commit, `git status` phải **sạch hoàn toàn**: mọi file bẩn lúc request bắt đầu đều nằm trong phạm vi hai commit này.
- **Thứ tự bắt buộc:** sửa `package.json` → chạy `npm run verify` (nó ghi lại `version.ts`) → mới commit. Xem bẫy ở §3.
- **Ranh giới phân rã:** hai commit là **hai miền bằng chứng và hoàn tác khác nhau** — commit 1 được chứng minh bằng test của bản vá và `br lint`, commit 2 bằng hằng số `PLUGIN_VERSION` và `verify` chạy lại sau bump. Tách thành hai bead anh em là hợp lệ; không tách thì commit 2 phải nằm sau commit 1 trong cùng một bead.
- **Prerequisite:** WP-310.
- **Điều kiện ra:** `npm run verify` mã 0 sau bump, vẫn 119 file / 2880 test; `git show --stat` của commit 2 đúng ba file; `grep PLUGIN_VERSION plugin/shared/version.ts` trả `0.3.0-alpha.4`.
- **Hoàn tác:** commit revert trên nhánh (chưa push nên chưa ai thấy).

### WP-312 — Đưa lên `main`, `ci.yml` xanh, và diễn tập `release.yml`

- **Kết quả:** `main` mang hai commit của WP-311; vòng `ci.yml` của commit đó `success`; dry-run `release.yml` `success` với đúng 2 job `verify`.
- **REQ/AC:** N/A có lý do — bước vận hành.
- **Design refs:** [release runbook](../operations/paseo-bm-release-runbook.md) §2 mục 1; plan delta 20260921 ci-linux-hang §2 (điều kiện tiên quyết cứng "main xanh thật và dry-run xanh").
- **Phạm vi:** `git merge --ff-only` từ `feat/worker-fallback` vào `main` (đã kiểm: `main` là tổ tiên của nhánh, fast-forward được), `git push origin main`, rồi `gh workflow run release.yml`.
- **Lưu ý về kích hoạt CI:** `ci.yml` có `paths-ignore` cho `docs/**`. Commit của WP-311 **có** đụng `plugin/`, `test/` và `package.json` nên CI chắc chắn chạy. Nếu không có vòng CI nào để làm bằng chứng thì phải dừng, không được coi là xanh.
- **Diễn tập:** lượt chạy tay **không publish** (bước publish có `if: github.event_name == 'release'`); nó vừa là diễn tập cho WP-313 vừa là bằng chứng `smoke:packed` trên cả hai hệ điều hành.
- **Ranh giới phân rã:** "đưa lên `main` + `ci.yml` xanh" và "diễn tập `release.yml`" là **hai kết quả soát được độc lập**, bằng chứng khác nhau (vòng `ci.yml` với vòng `release.yml`) và đường lùi khác nhau (commit revert với không có gì để lùi). Bộ chuyển đã tách đúng chỗ này ở lần phát hành trước (`…la9k.4` và `…la9k.5` của plan delta 20260921 ci-linux-hang) — tách lại như vậy là đúng, không phải mở rộng phạm vi.
- **Prerequisite:** WP-311.
- **Điều kiện ra:** `gh run view` cho thấy `ci.yml` `success`; `gh run view` của dry-run cho thấy đúng 2 job `verify` `success` và bước `Publish (dry-run)` đã chạy.
- **Hoàn tác:** một commit revert trên `main`.
- **Nếu CI đỏ:** dừng, không đi tiếp WP-313, gửi `blocked`.

### WP-313 — Phát hành `0.3.0-alpha.4` lên npm

- **Kết quả:** `npm view paseo-bm@next version` trả `0.3.0-alpha.4`, có provenance.
- **REQ/AC:** PRD gốc §11 Phase 1 MVP — *"một phiên bản prerelease có trên npm kèm provenance"*; REQ-067 (c) đã đạt ở WP-310.
- **Design refs:** [release runbook](../operations/paseo-bm-release-runbook.md) §2 mục 2 → 4.
- **Phạm vi:** `git tag v0.3.0-alpha.4`, `git push origin v0.3.0-alpha.4`, `gh release create v0.3.0-alpha.4 --prerelease --notes-file docs/operations/paseo-bm-release-notes-0.3.0-alpha.4.md`, theo dõi workflow tới hết `Verify published version`.
- **Không đụng:** không lệnh `npm publish` / `npm trust` / `npm dist-tag` nào từ Worker. Chỉ được chạy `npm view paseo-bm dist-tags`, `npm view paseo-bm@next version` và `npm view paseo-bm@next dist.attestations` — đọc.
- **Kiểm trước khi tạo tag:** `git ls-remote --tags origin v0.3.0-alpha.4` phải rỗng. Có rồi thì dừng và hỏi, **không** ép đẩy đè.
- **Prerequisite:** WP-312; **owner đã xác nhận** ở bước xác nhận bắt buộc trước khi implement.
- **Trusted publishing là thứ duy nhất chưa được diễn tập:** dry-run không xác thực với registry, nên cấu hình trusted publisher (`hieunt286/paseo-bm` + `release.yml`) chỉ được chứng minh ở lần publish thật. Nếu bước `Publish to npm` đỏ vì xác thực, **không** thử cách publish khác: xoá GitHub Release và tag, gửi `blocked`, để owner kiểm `npm trust list paseo-bm`.
- **Điều kiện ra:** run `release.yml` của sự kiện `release` xanh ở bước `Publish to npm` và `Verify published version`; `npm view paseo-bm@next version` trả `0.3.0-alpha.4`; `npm view paseo-bm@next dist.attestations` có provenance (điều kiện ra số 5 của §1.2).
- **Điểm không đảo ngược:** việc tạo GitHub Release chính là nút bấm publish. Sau 72 giờ không gỡ được.
- **Hoàn tác:** trước khi tạo Release, xoá tag là lùi được. Sau khi publish, đường lùi là phát hành bản vá — **không** dùng `npm unpublish` (runbook đã chốt).

### WP-314 — Đóng delta

- **Kết quả:** một bản ghi lần chạy trong `docs/operations/`; ba tài liệu delta 20260921 và delta này có dòng revision trỏ tới lần phát hành; đồ thị bead cuối cùng nằm trong git; owner biết chính xác lệnh `npm dist-tag` cần chạy.
- **REQ/AC:** N/A có lý do — bước đóng, theo `feature-done` hồ sơ chuẩn.
- **Phạm vi:** `docs/operations/paseo-bm-release-run-20260923.md` (mới); một dòng revision ở delta này (file đã được WP-311 đưa vào git) **và ở mỗi tài liệu trong ba tài liệu delta 20260921** (PRD delta, design delta, plan delta) — đúng như dòng "Kết quả" ở trên và §1.2 đã nêu, chỉ thêm dòng vào bảng `## Revision History`, không chạm thân tài liệu; `.beads/issues.jsonl` ở trạng thái cuối.
- **Bàn giao cho owner (Q5: a):** in ra `npm view paseo-bm dist-tags` trước và sau, cùng lệnh chính xác `npm dist-tag add paseo-bm@0.3.0-alpha.4 latest` để owner tự chạy với OTP.
- **Prerequisite:** WP-313.
- **Điều kiện ra:** bản ghi có đủ năm điều kiện ra của §1.2 kèm bằng chứng; `br lint -s all` và `br dep cycles` sạch.
- **Hoàn tác:** revert các file tài liệu.

## 5. Rollback yếu (R3) — chủ rủi ro và diễn tập

WP-313 là công việc **R3**: `npm publish` không gỡ được sau 72 giờ.

| Trường | Giá trị |
|---|---|
| Chủ rủi ro | **hieu.nt10** (owner). Worker không chạy `npm publish`, `npm trust`, `npm dist-tag`, và không chạm thông tin đăng nhập |
| Diễn tập | **Có, và bắt buộc** — dry-run `release.yml` bằng `workflow_dispatch` ở WP-312, đi qua đúng ma trận, `smoke:packed` và `npm publish --dry-run`, chỉ bỏ đúng bước publish thật |
| Điểm phê duyệt | Việc tạo GitHub Release. Trước đó còn lùi được bằng cách xoá tag |
| Đường lùi sau khi publish | Phát hành bản vá. Hạ bản là đường lùi **đắt**: `0.2.0-alpha.1` không chứa một file `fallback-*.ts` hay `config-writer.ts` nào (kiểm `git ls-tree -r 5e69a7e`), nên `npx paseo-bm@0.2.0-alpha.1` bỏ **toàn bộ** delta 20260921 — REQ-062 tôn trọng profile, REQ-063 mọi provider cho mọi vai trò, REQ-064 màn Roles & models, REQ-065/066/067 dự phòng cho cả ba vai trò. `role-fallback.json` khi đó chỉ nằm im không ai đọc. **Cảnh báo "bản trước coi cả file là không dùng được" trong ghi chú `0.3.0-alpha.4` chỉ đúng giữa các bản `0.3.0-alpha.*`, không đúng cho `0.2.0-alpha.1`** — nhưng vẫn nên đặt policy về "Ask me" hay "Off" **trước khi** hạ bản, vì bản cũ không có màn hình nào để đặt lại |

## 6. Câu hỏi mở

Không còn câu nào mở. Năm câu của `req-20260923T040415Z` đã có trả lời và đã nằm trong phạm vi ở §1.2:

| Mã | Nội dung | Trả lời |
|---|---|---|
| Q1 | Số hiệu bản phát hành | **a** — một bản gộp `0.3.0-alpha.4` |
| Q2 | Ai chạy commit / push / tag / Release | **a** — Worker làm tới hết, không lệnh npm ghi nào |
| Q3 | Điều kiện phát hành 18.1 | **a** — Đạt, ghi vào checklist |
| Q4 | 18.2 → 18.6 chưa đo | **a** — vẫn phát hành |
| Q5 | dist-tag `latest` | **a** — owner tự chạy sau khi publish; Worker được đọc `npm view … dist-tags` |

## 7. Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Publish một `main` còn lỗi, không gỡ được sau 72 giờ | Cao | `main` phải xanh thật, cộng dry-run xanh (WP-312), cộng owner xác nhận trước khi implement |
| `version.ts` trong commit còn số cũ vì quên chạy build sau bump | Vừa | §3 ghi rõ bẫy; WP-311 ràng buộc thứ tự bump → verify → commit, và điều kiện ra kiểm lại hằng số |
| Vô tình commit file của người khác | Vừa | WP-311 ràng buộc cứng: commit theo đường dẫn cụ thể, kiểm `git status` sau commit. Hiện working tree chỉ có đúng ba file, tất cả đều thuộc phạm vi |
| Ghi chú phát hành chỉ tay sang bản không tồn tại trên npm | Vừa | WP-310 sửa đường lùi về `0.2.0-alpha.1` và nói rõ các số trung gian chưa từng phát hành |
| "Auto switch" lên npm khi 18.2 → 18.6 chưa đo | Vừa | Owner chấp nhận (Q4: a); tính năng mặc định tắt, bật riêng từng vai trò, có cảnh báo chi phí; 18.1 Đạt là điều kiện phát hành duy nhất mà REQ-067 (c) đặt ra |
| `npx paseo-bm` vẫn cài bản cũ vì `latest` không đổi | Vừa | Đọc thật ngày 2026-09-23 (`npm view paseo-bm dist-tags`): `latest` và `next` **đều ở `0.2.0-alpha.1`**. Sau lần này `next` sang `0.3.0-alpha.4` còn `latest` đứng yên cho tới khi owner chạy `npm dist-tag`. WP-314 bàn giao lệnh đó kèm trạng thái đọc được trước và sau |
| Trusted publisher hỏng, bước `Publish to npm` đỏ sau khi Release đã tồn tại | Vừa | Chưa diễn tập được (dry-run không xác thực). Đường xử lý đã ghi ở WP-313: xoá Release và tag, `blocked`, owner kiểm `npm trust list`. Lúc đó **chưa có gì lên npm**, nên vẫn lùi được hoàn toàn |
| Tag đã có trên remote nên push bị từ chối | Thấp | `v0.3.0-alpha.4` chưa tồn tại tại máy; WP-313 kiểm remote trước khi tạo, gặp trùng thì dừng và hỏi |

## 8. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: WP-310 → WP-314, Routing Decision §0, điều kiện ra bị đảo §1.1, rollback yếu R3 §5. Status `Draft`, Plan-ready `Pending` |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | `reviewing-plan`: thêm ranh giới phân rã cho WP-311 và WP-312; WP-313 thêm kiểm tag trên remote, đường xử lý khi trusted publishing hỏng, và provenance vào điều kiện ra; §7 thêm rủi ro trusted publisher |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | Review `b2` (beads): errata cho WP-314 — dòng "Phạm vi" bỏ sót ba tài liệu delta 20260921, mâu thuẫn với chính dòng "Kết quả" của nó và với §1.2. Sửa dòng "Phạm vi" theo hai chỗ đã ghi quyết định; không thêm phạm vi mới |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1` pass ở lần re-review. Cổng `plan-ready-for-beads` tự chấm **PASS**; Status `Draft` → `Active`. Phạm vi đóng băng: WP-310 → WP-314, Phase 2a-19 |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1`, hai phát hiện chặn: (1) lý do đường lùi chép từ `0.3.0-alpha.3` là sai cho `0.2.0-alpha.1` — bản đó không có mã dự phòng nào, nên §5 và WP-310 (c)(d) viết lại theo đúng cái giá thật của việc hạ bản; (2) ranh giới npm ở §1.2 mâu thuẫn với điều kiện ra số 5 và WP-313 — viết lại thành "không lệnh npm ghi", liệt kê đúng ba lệnh đọc. Cùng lúc: sửa số `latest` trong §7 theo `npm view` đọc thật, và đưa tài liệu delta này vào commit 1 của WP-311 để điều kiện ra của WP-310/WP-311 thoả được |
| 2026-09-23 | hieu.nt10 (soạn bởi Beads Worker) | **Applied.** Phát hành xong: `paseo-bm@0.3.0-alpha.4` trên dist-tag `next` kèm provenance, commit `e309e45`, run `35821253485`. Cả năm điều kiện ra của §1.2 có bằng chứng trong [bản ghi lần chạy](../operations/paseo-bm-release-run-20260923.md). Errata §3: bẫy `version.ts` ghi sai thứ tự — `verify` chạy `test` trước `build`, nên phải `npm run build` trước rồi mới `verify`. Ngoài phạm vi đã lường: commit `chore(release)` mang thêm `test/plugin-role-labels.test.ts` vì nó ghim minor `0.2.` (owner chốt Q8 a; ghim đổi sang `0.3.`, không xoá). Còn lại của owner: `npm dist-tag add paseo-bm@0.3.0-alpha.4 latest` |
