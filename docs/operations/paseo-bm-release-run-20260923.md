# Bản ghi lần chạy — phát hành `0.3.0-alpha.4` (2026-09-23)

| Trường | Giá trị |
|---|---|
| Request | `req-20260923T040415Z` — "Tôi muốn public bản mới bao gồm những gì đã sửa này lên npmjs" |
| Plan | [delta 20260923 release 0.3.0-alpha.4](../plans/paseo-bm-implementation-plan-delta-20260923-release-030-alpha4.md) — Phase 2a-19, WP-310 → WP-314 |
| Ghi chú phát hành | [`paseo-bm-release-notes-0.3.0-alpha.4.md`](./paseo-bm-release-notes-0.3.0-alpha.4.md) — dùng làm body của GitHub Release |
| Quy trình | [release runbook](./paseo-bm-release-runbook.md) §2 |
| Kết quả | **Đã phát hành.** `paseo-bm@0.3.0-alpha.4` trên dist-tag `next`, có provenance SLSA v1 |
| Commit được tag | `e309e452dcb5c4c9df11b68820d53d62e993c790` (`e309e45`) |
| Các commit của lần phát hành | `55403a0` bản vá nút Beads + tài liệu phát hành · `e309e45` `chore(release): 0.3.0-alpha.4` (được tag) · `7d62a16` bản ghi này + bốn dòng revision · `721f446` và `9f75bfb` đồ thị bead · cộng một commit sửa theo review `b3` |
| Beads | `bm-release-030-alpha4-shof` (epic) và `.1` → `.8` |

## Bản này mang gì

Một bản prerelease **gộp**: phase 2a-13 → 2a-18 của delta 20260921 (REQ-062 → REQ-067) cộng bản vá nút Beads trên di động (`bm-n99t`). Sáu số phiên bản theo phase (`0.2.0-alpha.2`, `0.3.0-alpha.0` → `.3`) **chưa từng lên npm** và sẽ không bao giờ lên; owner chốt gộp làm một bản (Q1: a).

## Năm điều kiện ra của phase

| # | Điều kiện | Bằng chứng |
|---|---|---|
| 1 | `npm run verify` mã 0 trên cây được tag | Exit 0, **119 file test / 2880 test pass**, build success (chạy tại máy trên đúng cây `e309e45`) |
| 2 | Vòng `ci.yml` của commit phát hành trên `main` `success` | Run [`35820755035`](https://github.com/hieunt286/paseo-bm/actions/runs/35820755035), sha `e309e452`, conclusion `success`, job `verify (ubuntu, node 22)` success |
| 3 | Dry-run `release.yml` `success`, đúng 2 job `verify` | Run [`35820891937`](https://github.com/hieunt286/paseo-bm/actions/runs/35820891937), event `workflow_dispatch`, conclusion `success`. Đúng 2 job: `verify (macos-latest, node 24)` và `verify (ubuntu-latest, node 24)`, cả hai success với `Smoke test packed package` success. Job `release (dry-run)`: `Publish (dry-run)` success; `Publish to npm` và `Verify published version` **skipped** |
| 4 | Run `release.yml` của sự kiện `release` xanh ở `Publish to npm` và `Verify published version` | Run [`35821253485`](https://github.com/hieunt286/paseo-bm/actions/runs/35821253485), event `release`, sha `e309e452`, conclusion `success`. `Resolve version, tag and dist-tag` success, `Publish (dry-run)` success, **`Publish to npm` success**, **`Verify published version` success** |
| 5 | `npm view paseo-bm@next version` trả `0.3.0-alpha.4`, có provenance | `npm view paseo-bm@next version` → `0.3.0-alpha.4`; `npm view paseo-bm@next dist.attestations` → `{ url: …/attestations/paseo-bm@0.3.0-alpha.4, provenance: { predicateType: "https://slsa.dev/provenance/v1" } }` |

## Điều kiện phát hành REQ-067 (c) — mục 18.1

**Đạt**, đo ngày 2026-09-23. `~/.paseo-bm/role-fallback-state.json` (chỉ đọc) có đúng một sự cố: `fb-d3c9430912b2`, `role` `worker`, `signal` `completed`, `message` `"Failed to authenticate. API Error: 401 API key is invalid."` — do Anthropic thật từ chối một lượt Claude Code sinh ra — `class` `L4`, `status` `switched`.

Không chấm bằng mắt: `~/.paseo-bm/role-fallback.json` không tồn tại nên bộ mẫu áp dụng là `DEFAULT_PATTERNS`, và chính `classifyText` của `plugin/shared/fallback-patterns.ts` (bundle bằng esbuild trong một thư mục `mktemp -d`, đã xoá) được chạy trên `message` đó: trả `L4`, mẫu khớp `/\b401\b/i`, `isFallbackClass` true — **trùng** `class` đã ghi trong file.

Các mục 18.2 → 18.6 vẫn **Chưa đo**; owner chốt Q4: a, phát hành không chờ chúng. "Auto switch" mặc định tắt.

## dist-tag — phần còn lại của owner

`release.yml` chỉ đẩy vào `next`. `latest` — thứ mà `npx paseo-bm` trong README dùng — **không** tự đổi.

| Thời điểm | `placeholder` | `latest` | `next` |
|---|---|---|---|
| Trước lần phát hành | `0.0.0-placeholder.0` | `0.2.0-alpha.1` | `0.2.0-alpha.1` |
| Sau lần phát hành | `0.0.0-placeholder.0` | `0.2.0-alpha.1` | **`0.3.0-alpha.4`** |

Muốn `npx paseo-bm` lấy bản mới, **owner** chạy (cần OTP, Worker không chạy lệnh npm ghi nào):

```bash
npm dist-tag add paseo-bm@0.3.0-alpha.4 latest
```

## Đường lùi

`npm unpublish` **không** dùng — dự án đã chốt đường lùi là phát hành bản vá. Người dùng hạ bản được về `0.2.0-alpha.1`, nhưng đó là bước lùi đắt: bản đó không chứa một dòng mã dự phòng hay Roles & models nào, nên bỏ toàn bộ REQ-062 → REQ-067. Chi tiết ở mục "Hoàn tác" của ghi chú phát hành.

## Bẫy gặp phải, ghi lại cho lần sau

1. **`npm run verify` chạy `test` TRƯỚC `build`.** `build` mới là bước sinh lại `plugin/shared/version.ts` từ `package.json`, nên lần `verify` đầu tiên ngay sau khi bump **luôn** đỏ hai test phiên bản (`test/plugin-structure.test.ts`, `test/plugin-role-labels.test.ts`). Thứ tự đúng là **bump → `npm run build` → `npm run verify`**. §3 của delta plan có mô tả cái bẫy này nhưng ghi sai thứ tự; đã sửa errata.
2. **`test/plugin-role-labels.test.ts` ghim minor của payload.** Dòng `expect(PLUGIN_VERSION.startsWith("0.2."))` viết từ đợt phase 2a chặn mọi bước sang `0.3.x`. Ghim được **đổi sang `"0.3."`**, không xoá và không làm yếu — đây là lưới duy nhất bắt việc phiên bản payload đi lệch khỏi minor đã định (owner chốt Q8: a).
3. **`git commit <path>` từ chối file untracked** và không commit gì cả. File delta plan phải `git add` theo đúng đường dẫn trước — vẫn không dùng `git add -A` / `git add .`.
4. **Không `git checkout main` được** khi `.beads/issues.jsonl` đang bẩn và khác nhau giữa hai nhánh. Đẩy thẳng ref `feat/worker-fallback:main` cho cùng kết quả, không đụng working tree, vẫn là fast-forward thuần.
5. **`test/skills-assist.test.ts` chập chờn** dưới tải: đỏ một lần rồi xanh ở hai lần chạy sau, không liên quan bump.

## Còn lại

- Owner chạy `npm dist-tag` ở trên nếu muốn chuyển `latest`.
- Các mục nghiệm thu 18.2 → 18.6 của "Auto switch" vẫn chờ một chuỗi dự phòng thật để đo.
