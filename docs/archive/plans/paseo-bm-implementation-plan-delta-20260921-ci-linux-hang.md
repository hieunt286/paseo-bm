# Delta plan — Sửa treo CI trên Linux, rút ma trận node, rồi phát hành 0.2.0-alpha.0

| Trường | Giá trị |
|---|---|
| Mã | `plan-delta-20260921-ci-linux-hang` |
| Plan gốc | [Implementation Plan v2](paseo-bm-implementation-plan-v2.md) (Active, Plan-ready PASS). **Không sửa tại chỗ.** Delta này thêm WP-283 → WP-286 và **đảo một phần tiêu chí nghiệm thu số 2** của plan gốc (xem §1.1) |
| Status | **Completed** (2026-09-25) — mọi bead của plan đã đóng; từ nay tài liệu sống thay cho chuỗi delta (xem `AGENTS.md`, mục Process). Trạng thái trước: **Active** |
| Plan-ready | **PASS — 2026-09-21 — hieu.nt10** (tự chấm bởi Beads Worker sau khi review batch `b1` pass ở lần re-review, không còn phát hiện nào). Q4 và Q7 còn mở và chặn đúng WP của chúng, không chặn việc chuyển thành bead |
| Owner | hieu.nt10 |
| Created | 2026-09-21 |
| Request | `req-20260920T111140Z` |
| Source design | [design-delta-20260921-ci-linux-hang](../design/paseo-bm-delta-20260921-ci-linux-hang.md) — nguồn duy nhất cho chẩn đoán, cách vá và ma trận |
| Source PRD | **N/A có lý do** — PRD §7 M-6 chỉ ràng buộc ma trận *hệ điều hành*, không nói gì tới phiên bản Node; quyết định Q6 giữ nguyên cả hai hệ điều hành. Không yêu cầu sản phẩm nào đổi |
| ADR | N/A — delta không thực thi quyết định ADR nào |
| Routing decision | [Design delta §0](../design/paseo-bm-delta-20260921-ci-linux-hang.md#0-routing-decision) — brownfield, **Large**, trigger là rollback yếu của `npm publish` |
| Phase | **Phase 2a-12 — Sửa treo CI trên Linux và phát hành 0.2.0-alpha.0** (nhãn bead `phase:2a-12`) |

## 1. MVP-Lock

### 1.1 Tiêu chí nghiệm thu của plan gốc bị đảo

Plan v2 tiêu chí số 2 viết: *"CI xanh trên macOS và Linux, Node 22 và 24, gồm smoke trên gói npm đã đóng gói."*

Delta này thay phần **"Node 22 và 24"** bằng: `ci.yml` chạy Node 22 ở mọi commit, `release.yml` chạy Node 24 trên cả macOS và Linux. Phần **"macOS và Linux"** và phần **smoke trên gói đã đóng gói** giữ nguyên. Đây là quyết định của owner (Q6: a, `req-20260920T111140Z`), ghi ở đây chứ không sửa đè lên plan gốc đang đóng băng.

### 1.2 Phạm vi

- **Trong phạm vi:** §4.1 và §4.2 của delta thiết kế; đưa bản vá lên `main`; phát hành `0.2.0-alpha.0`.
- **Ngoài phạm vi (dễ tưởng là trong):**
  - `plugin/server/trace-store.ts` — `mkdirSync(recursive)` của mã sản phẩm **không** được làm cứng trong request này (delta thiết kế §6);
  - `timeout-minutes` cho job CI — owner đã từ chối (Q5: b), dù hôm nay không có lưới nào chặn một lần treo tương tự;
  - `ci.yml` — không đổi một dòng nào;
  - 15 file đang sửa dở trong working tree (Q2: a) — không commit, không revert, không đụng. Chúng **sẽ không** có trong bản phát hành. `.beads/issues.jsonl` là một trong 15 file đó và là ca đặc biệt: xem Q7 ở §6;
  - `npm trust`, `npm dist-tag` (kể cả `latest`) — việc của owner;
  - nâng số phiên bản: `package.json` đã là `0.2.0-alpha.0`.
- **Điều kiện ra của phase:**
  1. Trên Linux, `npm test` chạy hết suite tới dòng tổng kết `Test Files …`.
  2. Trên macOS, `npm run verify` mã 0.
  3. Vòng `ci.yml` của commit vá trên `main` kết thúc `success`.
  4. Dry-run `release.yml` liệt kê đúng 2 job `verify`, cả hai `success`.
  5. `npm view paseo-bm@next version` trả `0.2.0-alpha.0`.
- **Hợp đồng đang được tiêu thụ:** không có hợp đồng nào đổi. Không RPC, không dữ liệu lưu bền, không giao diện dòng lệnh nào đổi. Thay đổi duy nhất người ngoài thấy được là có một phiên bản mới trên npm. Vì vậy không cần chính sách tương thích ngược nào.
- **Tư thế hoàn tác mặc định:** revert đúng các file trong phạm vi của từng WP. WP-285 lùi bằng một commit revert trên `main`. **Ngoại lệ duy nhất là WP-286**: sau khi publish thì không lùi được sau 72 giờ — xem §5.

## 2. Thứ tự và vì sao

```
WP-283 ──> WP-284 ──> WP-285 ──> WP-286
 (vá)      (ma trận)   (lên main)  (phát hành)
```

Cả bốn nối tiếp, mỗi cạnh là một phụ thuộc thật, và mỗi cạnh nêu rõ **kết quả nào của WP trước mà WP sau cần**:

- **WP-283 → WP-284.** WP-284 cần *"suite đã chạy xong được trên Linux"*. Hai WP sửa hai file khác nhau nên không xung đột, nhưng rút ma trận trước khi vá thì vòng chạy kế tiếp vẫn treo, chỉ là treo ở ít job hơn — mất đúng tín hiệu đang cần.
- **WP-284 → WP-285.** WP-285 cần *"ma trận đã ở dạng cuối"*, để chỉ đẩy lên `main` một lần mang cả hai thay đổi. Q3: b là push thẳng vào `main`, nên mỗi lần đẩy là một vòng CI thật trên nhánh chính.
- **WP-285 → WP-286.** WP-286 cần *"`main` xanh thật và dry-run xanh"*. Không được tag khi chưa có hai thứ đó — điều kiện tiên quyết cứng, đã ghi trong `bm-release-howto-stkl`.

## 3. Chiến lược kiểm thử của phase

Theo Design §10 (khung **Vitest**) — delta này không thêm khung hay kiểu test mới.

| Mức | Cách làm |
|---|---|
| Unit / integration | Bộ test sẵn có, chạy bằng `npm test` (`vitest run`). Không thêm test mới: WP-283 **sửa** một test đang sai, không thêm phủ |
| Phủ | Không đặt mục tiêu phủ mới. Số test phải **giữ nguyên 2352** trước và sau khi vá — vá này không được làm mất hay thêm test nào |
| Bằng chứng nền tảng | Bắt buộc chạy trên **cả hai** nền tảng: Linux trong container `node:22-slim`, và macOS tại chỗ. Lỗi đang sửa chỉ lộ ra trên Linux, nên bằng chứng chỉ-macOS là vô giá trị ở WP-283 |
| Bằng chứng thật | Container chỉ để thu hẹp và thử nhanh. Bằng chứng sau cùng luôn là vòng CI thật trên GitHub (WP-285) |

**Bẫy đã biết:** container hiện có được dựng từ `git archive HEAD`, tức là **chưa có bản vá**. WP-283 phải chép file đã vá vào container rồi mới chạy; chạy lại container cũ sẽ ra kết quả cũ và là bằng chứng giả.

## 4. Work packages

### WP-283 — Vá test treo trên Linux

- **Kết quả:** `test/plugin-collector.test.ts` chạy xong trên Linux, và toàn bộ suite chạy xong trên Linux.
- **REQ/AC:** N/A có lý do — không yêu cầu sản phẩm nào đổi; đây là lỗi của chính bộ test.
- **Design refs:** delta thiết kế §4.1 (cách dựng đường dẫn hỏng), §2.3 (vì sao cách dựa vào quyền không dùng được), §3 (nguyên nhân gốc).
- **Phạm vi:** đúng một file, `test/plugin-collector.test.ts` — test `swallows a store failure and logs it`, cộng `writeFileSync` vào danh sách import từ `node:fs`.
- **Prerequisite:** không.
- **Điều kiện ra:** trong container Linux dựng lại **từ cây đã vá**, `npm test` chạy hết tới dòng `Test Files …` với 2352 test xanh; trên macOS `npm run verify` mã 0. Chỉ chạy riêng file đã vá là **không đủ**.
- **Hoàn tác:** revert đúng file đó.

### WP-284 — Rút ma trận node của `release.yml`

- **Kết quả:** job `verify` của `release.yml` chạy `node 24 × {ubuntu, macOS}` = 2 job.
- **REQ/AC:** N/A có lý do — quyết định vận hành của owner (Q6: a), không phải yêu cầu sản phẩm. Ràng buộc bị đảo ghi ở §1.1.
- **Design refs:** delta thiết kế §4.2 (bảng trước/sau và lý do chọn Node 24).
- **Phạm vi:** đúng một file, `.github/workflows/release.yml`, khối `strategy.matrix` và **phần bình luận phía trên job** — bình luận đó đang mô tả ma trận cũ nên phải sửa theo, nếu không tài liệu tại chỗ sẽ nói sai.
- **Không đụng:** bước publish, `if: github.event_name == 'release'`, `id-token: write`, tên file, `concurrency`, `smoke:packed`, bước kiểm tra script vòng đời.
- **Prerequisite:** WP-283 (cần "suite chạy xong được trên Linux").
- **Điều kiện ra:** đọc lại file thấy đúng 2 tổ hợp; bằng chứng lúc chạy thật thuộc WP-285.
- **Hoàn tác:** revert đúng file đó.

### WP-285 — Đưa bản vá lên `main`, CI xanh, và diễn tập phát hành

- **Kết quả:** `main` có commit mang WP-283 + WP-284; vòng `ci.yml` của commit đó `success`; dry-run `release.yml` `success` với đúng 2 job `verify`.
- **REQ/AC:** N/A có lý do — bước vận hành.
- **Design refs:** delta thiết kế §5 (bằng chứng bắt buộc 4 và 5).
- **Phạm vi:** commit hai file mã (WP-283, WP-284) và hai file tài liệu của delta này, rồi push thẳng vào `main` (Q3: b). Số phận của `.beads/issues.jsonl` **chưa quyết** — xem Q7 ở §6, câu hỏi đó chặn WP này.
- **Ràng buộc cứng:** `git commit <đường dẫn cụ thể>`, **không bao giờ** `git add -A` / `git add .`. 15 file đang sửa dở phải còn nguyên trong `git status` sau khi commit.
- **Vấn đề `.beads/issues.jsonl`:** AGENTS.md coi file này là nguồn sự thật **phải commit**, nhưng nó đang bẩn sẵn từ trước khi request này bắt đầu, và trộn hai nhóm: beads của request phát hành trước (`bm-release-howto-stkl`, `bm-release-v020-alpha0-31ru` — liên quan trực tiếp tới WP-286) lẫn beads đang làm dở của Worker khác (`bm-wp-266-beads-header-*`, `bm-wp-249-*`). Một file thì `git commit <path>` không tách được, và AGENTS.md cấm sửa tay JSONL nên cũng không được stage từng dòng. Vì vậy: commit nó là vi phạm Q2: a, còn không commit nó là để đồ thị bead của request này nằm ngoài lịch sử git. Worker **không tự chọn** — Q7.
- **Lưu ý về kích hoạt CI:** `ci.yml` có `paths-ignore` cho `docs/**`. Commit này **có** đụng `test/**` và `.github/workflows/release.yml` nên CI chắc chắn chạy. Nếu vì lý do nào đó commit chỉ còn file tài liệu thì sẽ **không có** vòng CI nào để làm bằng chứng — khi đó phải dừng, không được coi là xanh.
- **Diễn tập (rehearsal):** chạy `release.yml` bằng `workflow_dispatch`. Lượt chạy tay **không publish** (bước publish có `if: github.event_name == 'release'`); nó vừa là diễn tập cho WP-286 vừa là bằng chứng ma trận của WP-284.
- **Prerequisite:** WP-284.
- **Điều kiện ra:** `gh run view` cho thấy `ci.yml` `success` tính bằng phút; `gh run view` của dry-run cho thấy đúng 2 job `verify`, cả hai `success`.
- **Hoàn tác:** một commit revert trên `main`.
- **Nếu CI vẫn đỏ:** dừng, không đi tiếp WP-286, báo `blocked`.

### WP-286 — Phát hành `0.2.0-alpha.0`

- **Bead đã tồn tại: `bm-release-v020-alpha0-31ru`.** Cập nhật bead đó, **không tạo bead mới** — nó mô tả đúng công việc này và đang `blocked` vì `main` đỏ.
- **Kết quả:** `npm view paseo-bm@next version` trả `0.2.0-alpha.0`, có provenance.
- **REQ/AC:** PRD §11 Phase 1 MVP — *"một phiên bản prerelease có trên npm kèm provenance"*.
- **Design refs:** `docs/operations/paseo-bm-release-runbook.md` §2; bead `bm-release-howto-stkl`.
- **Prerequisite:** WP-285; owner xác nhận `npm trust list paseo-bm` còn đúng; **Q4 đã có trả lời**.
- **Điều kiện ra:** run `release.yml` của sự kiện `release` xanh ở bước `Publish to npm` và `Verify published version`.
- **Điểm không đảo ngược:** tạo GitHub Release chính là nút bấm publish. Sau 72 giờ không gỡ được.
- **Hoàn tác:** trước khi publish, xoá release và tag là lùi được (phải hỏi owner). Sau khi publish, đường lùi là phát hành bản vá.

## 5. Rollback yếu (R3) — chủ rủi ro và diễn tập

WP-286 là công việc **R3**: `npm publish` không gỡ được sau 72 giờ.

| Trường | Giá trị |
|---|---|
| Chủ rủi ro | **hieu.nt10** (owner). Worker không chạy `npm trust`, không chạm thông tin đăng nhập |
| Diễn tập | **Có, và bắt buộc** — dry-run `release.yml` bằng `workflow_dispatch` ở WP-285, đi qua đúng ma trận, `smoke:packed` và `npm publish --dry-run`, chỉ bỏ đúng bước publish thật |
| Điểm phê duyệt | Việc tạo GitHub Release. Trước đó còn lùi được bằng cách xoá tag và release |
| Đường lùi sau khi publish | Phát hành bản vá. **Không** dùng `npm unpublish` — dự án đã chốt như vậy trong runbook |

## 6. Câu hỏi mở

| Mã | Nội dung | Chủ | Trạng thái | Chặn WP nào |
|---|---|---|---|---|
| Q4 | Chia việc ở bước phát hành: Worker chạy git/gh còn owner chạy `npm trust`/`dist-tag`, hay owner làm trọn phần phát hành | hieu.nt10 | **Mở** — cố ý giữ lại để hỏi ngay trước khi phát hành, đúng bước xác nhận bắt buộc của request Large | **WP-286** |

| Q7 | Có commit `.beads/issues.jsonl` không, khi nó đang trộn beads của request trước với beads đang làm dở của Worker khác: (a) không commit, đồ thị bead của request này nằm ngoài git — giữ đúng hiện trạng và đúng Q2: a; (b) commit cả file, kéo theo beads của người khác — trái Q2: a | hieu.nt10 | **Mở** — hỏi ở bước xác nhận bắt buộc trước khi implement, cùng Q4 | **WP-285** |

Q1, Q2, Q3, Q5, Q6 đã có trả lời và đã nằm trong phạm vi ở §1.2.

## 7. Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Còn chỗ treo thứ hai bị file đầu che mất | Vừa | WP-283 bắt buộc chạy **cả suite** trên Linux, không chỉ file đã vá |
| Chạy lại container cũ (chưa có bản vá) rồi tưởng là đã xanh | Vừa | §3 ghi rõ bẫy này; WP-283 yêu cầu dựng lại từ cây đã vá |
| Push thẳng vào `main` mà bản vá sai | Vừa | Đã có bằng chứng Linux thật trước khi push; nếu đỏ thì dừng ở WP-285 |
| Vô tình commit 15 file của người khác | Cao | WP-285 ràng buộc cứng: commit theo đường dẫn cụ thể, kiểm `git status` sau commit |
| Phát hành một `main` còn lỗi khác | Vừa | `main` phải xanh thật, cộng dry-run xanh, cộng owner xác nhận (Q4) |
| Bản vá đúng trong container, khác trên ubuntu của GitHub | Thấp | Bằng chứng cuối vẫn là vòng CI thật (WP-285) |

## 8. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta: WP-283 → WP-286, chiến lược kiểm thử §3, rollback yếu R3 §5. Status `Draft`, Plan-ready `Pending` |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1`: thêm Q7 (`.beads/issues.jsonl` trộn beads của hai request, không tách được bằng `git commit <path>`) và ghi rõ nó chặn WP-285; thêm mục Revision History |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1` pass ở lần re-review. Cổng `plan-ready-for-beads` tự chấm **PASS**; Status `Draft` → `Active`. Phạm vi đóng băng: WP-283 → WP-286, Phase 2a-12 |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Chuyển thành bead. WP-285 được bộ chuyển tách thành hai bead anh em (`…la9k.4` đưa lên main + ci.yml xanh, `…la9k.5` diễn tập `release.yml`): hai kết quả soát được độc lập, bằng chứng và đường lùi khác nhau. Tách là chuyện phân rã, không đổi phạm vi — plan giữ nguyên WP-285 |
