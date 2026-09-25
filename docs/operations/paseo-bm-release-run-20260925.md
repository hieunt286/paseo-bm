# Bản ghi lần chạy — phát hành bản ổn định `0.3.0` (2026-09-25)

| Trường | Giá trị |
|---|---|
| Request | `req-20260925T033834Z` — "Tôi muốn tạo một bàn release 0.1.0 trên paseo.cafe và npm , hãy xem quy trình triển khai hiện tại và release phiên bản giúp tôi" |
| Plan | [delta 20260925b stable-release-030](../plans/paseo-bm-implementation-plan-delta-20260925b-stable-release-030.md) — Phase 2a-21, WP-322 → WP-327 |
| Design | [delta 20260925b stable-release](../design/paseo-bm-delta-20260925b-stable-release.md) |
| Ghi chú phát hành | [`paseo-bm-release-notes-0.3.0.md`](./paseo-bm-release-notes-0.3.0.md) — body của GitHub Release |
| Quy trình | [release runbook](./paseo-bm-release-runbook.md) **§4** (mục mới cho bản ổn định, viết trong chính phase này) |
| Kết quả | **Đã phát hành.** `paseo-bm@0.3.0` và `paseo-bm-plugin@0.3.0` trên dist-tag **`latest`**, có provenance SLSA v1 |
| Commit được tag | `e48e9ea23c0446d940c15f77314747ff7e91a749` (`e48e9ea`) |
| Các commit của lần phát hành | `6e8a9c0` bản vá trình cài đặt cho Paseo 0.9.2 (bead `bm-qh4c`) · `f6ef7fa` REQ-069 giao diện (bead `bm-ui-kanban-yen-tinh-4vm6`) · `1ac1dcf` bản viết lại quy trình trong `AGENTS.md` (việc có sẵn, owner chốt Q5 a) · `b64fd1f` đường phát hành nhận bản ổn định + errata + tài liệu phase · `6aa9345` `chore(release): 0.3.0` · `e48e9ea` sửa lỗi nháy đơn trong `release.yml` |
| Beads | `bm-release-030-hofc` (epic) và `.1`, `.3`, `.4`, `.5`, `.6`, `.7`, `.8`; `.2` đóng vì đã split thành `.7` + `.8` |
| Số hiệu | Owner chốt **`0.3.0`** thay cho "0.1.0" của yêu cầu: `0.1.0` thấp hơn mọi bản đã publish (`0.1.0-alpha.0` … `0.3.0-alpha.7`) nên sẽ là bước lùi, và ghim minor payload `0.3.` sẽ phải sửa |

## Bản này mang gì

Hai thứ, cộng một thay đổi đường phát hành:

1. **Trình cài đặt chạy được với Paseo 0.9.2** (bead `bm-qh4c`). 0.9.2 bỏ `cliVersion` khỏi `daemon status --json`, nên mọi lệnh của trình cài đặt dừng ở `E_PASEO_OUTPUT_UNEXPECTED` (exit 3). Đây là phần quan trọng nhất của bản này và **đã bị bỏ sót** ở bản nháp ghi chú phát hành đầu tiên — review lô `b1` tìm ra.
2. **REQ-069 giao diện**: kanban bốn cột có responsive, trạng thái nói bằng chữ và độ tương phản thay cho màu hue, Setup chia ba tab, thẻ "Errors" ở màn Metric.
3. **`release.yml` nhận bản ổn định** và đặt dist-tag theo loại phiên bản (`prerelease ? "next" : "latest"`), nên bản ổn định không còn cần `npm dist-tag add` cần OTP.

## Sáu điều kiện ra của phase

| # | Điều kiện | Bằng chứng |
|---|---|---|
| 1 | `npm run verify` mã 0 trên đúng cây được tag | Exit 0, **124 file test / 3052 test pass**, build success — chạy trong một **git worktree sạch tách rời** ở `e48e9ea` (xem bẫy số 2), không phải trong cây làm việc đang bẩn |
| 2 | `ci.yml` của commit phát hành trên `main` `success` | Run [`36095253325`](https://github.com/hieunt286/paseo-bm/actions/runs/36095253325) ở `e48e9ea` conclusion `success`; và run `36094885677` ở `6aa9345` cũng `success` |
| 3 | Dry-run `release.yml` `success`, đúng 2 job `verify`, dist-tag `latest`, các bước publish thật `skipped` | Run [`36095254508`](https://github.com/hieunt286/paseo-bm/actions/runs/36095254508) `success`. Đúng 2 job: `verify (ubuntu-latest, node 24)` và `verify (macos-latest, node 24)`, cả hai `success` kèm `Smoke test packed package` `success`. Log: `Dry-run publish of paseo-bm@0.3.0 with dist-tag latest` và `Dry-run publish of paseo-bm-plugin@0.3.0 with dist-tag latest`. Bốn bước `Publish to npm`, `Publish payload to npm`, `Verify published version`, `Verify published payload` đều `skipped`. **Lần dispatch đầu [`36094918617`](https://github.com/hieunt286/paseo-bm/actions/runs/36094918617) ĐỎ** — xem bẫy số 1 |
| 4 | Run của sự kiện `release` xanh ở bốn bước publish/verify | Run [`36095580331`](https://github.com/hieunt286/paseo-bm/actions/runs/36095580331), event `release`, conclusion `success`: `Resolve version, tag and dist-tag` success, hai bước dry-run success, **`Publish to npm` success**, **`Publish payload to npm` success**, **`Verify published version` success**, **`Verify published payload` success** |
| 5 | Hai gói `0.3.0`, `dist-tags.latest` là `0.3.0`, có provenance | `npm view paseo-bm version` → `0.3.0`; `npm view paseo-bm-plugin version` → `0.3.0`; dist-tags của cả hai: `latest 0.3.0`, `next 0.3.0-alpha.7`, `placeholder 0.0.0-placeholder.0`; `dist.attestations` của cả hai có `predicateType` `https://slsa.dev/provenance/v1`; `npx --yes paseo-bm@0.3.0 --version` trong một `mktemp -d` in `0.3.0` |
| 6 | Hồ sơ registry không còn gọi sản phẩm là prerelease, có một comment nhắc | Commit [`d2213653`](https://github.com/hieunt286/paseo-cafe/commit/d221365340703f311cef08c289514b0d90661e16) trên nhánh `hieunt286:add-paseo-bm`, **đúng một file, +1/−1**; đọc lại từ nhánh: 992 byte, 7 khoá cho phép, 6 caveat đều ≤ 140 ký tự, mảng ngắn vẫn một dòng, không còn chữ "prerelease". Comment: [#215 (comment)](https://github.com/paseo-cafe/paseo-cafe/pull/215#issuecomment-5826946145). PR **vẫn OPEN** — merge là việc của maintainer bên họ |

## dist-tag trước và sau

| Thời điểm | `placeholder` | `latest` | `next` |
|---|---|---|---|
| Trước lần phát hành | `0.0.0-placeholder.0` | `0.3.0-alpha.7` | `0.3.0-alpha.7` |
| Sau lần phát hành | `0.0.0-placeholder.0` | **`0.3.0`** (do `release.yml` đặt, không cần OTP) | `0.3.0-alpha.7` |

Đúng cho **cả hai** gói. `next` giữ nguyên có chủ ý: đẩy một bản ổn định vào `next` cần `npm dist-tag add`, một lệnh ghi khác `publish` mà cấu hình trusted publisher (`publish, stage publish`) chưa chứng minh là bao được — không đưa một lệnh ghi chưa kiểm chứng vào giữa một lượt phát hành không đảo ngược được. Muốn `next` trỏ `0.3.0` thì owner chạy tay, cần OTP.

## Đường lùi

Phát hành bản vá `0.3.1`; không `npm unpublish`. Hạ bản về `0.3.0-alpha.7` **chỉ dùng được trên Paseo 0.8**: trên 0.9.2 bản đó không cài được (đúng lỗi mà `bm-qh4c` sửa). Ghi chú phát hành nói rõ điều này ở mục "Hoàn tác".

## Bẫy gặp phải, ghi lại cho lần sau

1. **Một dấu nháy đơn trong `node -e '…'` của workflow làm chết bước đó.** Comment mới có chữ `owner's`; dấu nháy đơn đóng chuỗi shell, phần còn lại thành mã shell, và bước đỏ với `syntax error near unexpected token (`. Bằng chứng ban đầu của bead không bắt được vì nó **trích riêng phần JS ra chạy**, không đi qua lớp trích dẫn của shell. Cách kiểm đúng, nay đã chạy: `bash -n` cho **mọi** khối `run:` của workflow, cộng chạy thật khối `Resolve` bằng `bash -e` với đúng biến môi trường của runner (gồm cả đối chứng âm: bản ổn định mà Release đánh dấu prerelease phải exit 1). Diễn tập chính là thứ bắt được lỗi này trước khi có gì lên npm.
2. **Một phiên khác đang sửa cùng cây làm việc.** Giữa lúc phát hành, phiên `paseo-bm-2b` sửa `plugin/roles/*.md`, hai file `*-instructions.ts` sinh ra từ đó, `test/roles-content.test.ts` và 19 `docs/plans/*.md`. Owner chốt Q8 a: phát hành đúng phần đã commit. Cách đo cho sạch: `git worktree add --detach <mktemp -d> <commit>` rồi **symlink `node_modules`** của repo vào đó (không `npm ci`, không cần mạng) và chạy `npm run verify` trong worktree ấy — bằng chứng nói về đúng cây được tag, không lẫn việc đang dở của ai.
3. **`git commit <path>` commit cả file, nên một file mang nhiều đợt việc thì không tách được.** `AGENTS.md` mang cả dòng Verified facts của `bm-qh4c`, cả bản viết lại quy trình chưa có bead. Hệ quả: phải **commit việc đang treo trước**, rồi mới viết errata vào những file đó — review lô `b1` bắt đúng chỗ này và thứ tự bead đã đảo lại (`.7` trước `.1`).
4. **Cây làm việc có ba đợt việc, không phải hai.** Hai đợt có bead đã đóng (`bm-qh4c`, `bm-ui-kanban-yen-tinh-4vm6`), một đợt **không có bead nào**. Đếm bead trong `.beads/issues.jsonl` chưa commit là cách nhanh nhất để biết đợt nào thuộc về ai.
5. **`.beads/issues.jsonl` không tách được theo đường dẫn.** Nó mang trạng thái đóng của hai đợt kia **và** bead của phase này, nên nó đi cùng commit đường phát hành và commit ấy nói rõ vì sao.

## Còn lại

- **Owner**: muốn `npx paseo-bm@next` cũng lấy bản ổn định thì `npm dist-tag add paseo-bm@0.3.0 next` và `npm dist-tag add paseo-bm-plugin@0.3.0 next` (cần OTP).
- **Maintainer paseo.cafe**: merge PR #215. Sau khi merge, mở trang listing xem mô tả, version `0.3.0` và ba ảnh trong `plugin/images/` có lên đúng không (quét npm 15 phút/lần, nguồn Git 6 giờ/lần).
- **Bản viết lại `plugin/roles/*.md`** của phiên kia chưa được phát hành: nó đổi hành vi của mọi agent nên xứng đáng có review riêng và ghi chú phát hành riêng ở lần sau.
