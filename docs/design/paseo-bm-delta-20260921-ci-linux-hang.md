# Delta-change — CI trên Linux treo trọn 6 tiếng vì `mkdirSync` đệ quy dưới `/proc`, và rút ma trận node của `release.yml`

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260921-ci-linux-hang` |
| Tài liệu gốc | [Technical Design](./paseo-bm.md) §10 (khung kiểm thử và CI) cùng **errata 2026-09-18** của §10 — delta này đảo một phần errata đó, phần ma trận node |
| PRD | **Không có PRD delta, và không cần.** PRD §7 M-6 chỉ ràng buộc *ma trận hỗ trợ (macOS, Linux)*; nó không nói gì tới phiên bản Node. Quyết định Q6 giữ nguyên cả hai hệ điều hành nên không yêu cầu sản phẩm nào đổi. Routing Decision vì vậy nằm ở §0 của chính tài liệu này |
| Plan | [plan-delta-20260921-ci-linux-hang](../plans/paseo-bm-implementation-plan-delta-20260921-ci-linux-hang.md) |
| Status | **Active** — cổng `design-ready` PASS 2026-09-21, review batch `b1` pass ở lần re-review |
| Owner | hieu.nt10 |
| ADR | N/A — không ADR nào quản chuyện này. Không thêm công nghệ, không thêm phụ thuộc, không đảo quyết định kiến trúc nào |
| Request | `req-20260920T111140Z` — "có tạo đi" (trả lời đề nghị sửa lỗi test treo trên Linux CI rồi release) |

**Thiết kế này sở hữu:**

- cách test `test/plugin-collector.test.ts` dựng một đường dẫn *không ghi được* để kiểm tra nhánh nuốt lỗi của collector;
- ma trận `os` × `node` của job `verify` trong `.github/workflows/release.yml`.

**Không sở hữu:**

- `ci.yml` (giữ nguyên ubuntu + Node 22, không đổi một dòng nào);
- `plugin/server/trace-store.ts` và mọi mã sản phẩm khác — xem §6;
- bước publish, quyền OIDC, tên file `release.yml`;
- 15 file đang sửa dở trong working tree của người khác (quyết định Q2: a).

## 0. Routing Decision

| Trường | Giá trị |
|---|---|
| Variant | brownfield |
| Tier | **Large** |
| Trigger | **Rollback yếu**: request kết thúc bằng một lần publish lên npm, mà npm không cho gỡ sau 72 giờ. Đường lùi duy nhất là phát hành bản vá |
| Trigger phụ | Đổi một quyết định đã ghi (Design §10 errata 2026-09-18) và một tiêu chí nghiệm thu của plan v2 đang `Active` |
| Cổng áp dụng | `design-ready`, `plan-ready-for-beads`, `feature-done` |
| Cổng bỏ qua | `prd-ready` — không có PRD delta, vì không yêu cầu sản phẩm nào đổi (xem bảng trên). Đây là **không áp dụng**, không phải ngoại lệ |
| Quyết định của owner | Q1: a, Q2: a, Q3: b, Q5: b, Q6: a (`req-20260920T111140Z`). Q4 còn mở, sẽ hỏi ngay trước khi phát hành |

## 1. Hai kết quả

1. **`npm test` chạy xong trên Linux.** Hôm nay nó không bao giờ kết thúc; job CI bị runner huỷ ở mốc 6 tiếng.
2. **`release.yml` chạy 2 job thay vì 4**: `node 24 × {ubuntu, macOS}`.

Hai kết quả độc lập: không cái nào cần mã của cái kia. Nhưng kết quả 2 **không được làm trước** kết quả 1, vì nếu ma trận đổi trước thì vòng chạy tiếp theo vẫn treo, chỉ là treo ở ít job hơn.

## 2. Chẩn đoán — đã đo được gì

Không suy đoán; toàn bộ mục này là quan sát trực tiếp.

### 2.1 Trên CI

- Run `35336520890` (push `65ca95f`), job `105572509981` "verify (ubuntu, node 22)".
- Dòng test cuối cùng in ra lúc `2026-09-18T10:50:02.3606356Z`. Job bị huỷ lúc `16:49:09` với chú thích *"The job has exceeded the maximum execution time of 6h0m0s"*. **Gần 6 tiếng không in thêm một dòng nào.**
- Vitest **chưa bao giờ** in dòng tổng kết `Test Files …`. Nó dừng giữa chừng, không phải chạy xong rồi không thoát.
- Lúc dọn dẹp, runner giết các tiến trình mồ côi: `npm test`, `sh`, `node (vitest)`, `esbuild`, `node (vitest 1)`, `node (vitest 2)`, `node (vitest 3)`.
- Đếm trong log: **101 trên 102 file test đã commit báo kết quả**. Đúng một file không bao giờ báo: `test/plugin-collector.test.ts`.
- Các run "cancelled" trước đó (`35304463987` 3h08, `35299411872` 1h19) không phải lỗi khác: chúng bị `concurrency.cancel-in-progress` cắt khi có push mới. Chỉ run cuối cùng chạy tới trần 6 tiếng.

### 2.2 Tái hiện tại chỗ trên Linux

Container `node:22-slim` (Node `v22.23.2`), cây mã lấy đúng bằng `git archive HEAD` nên không dính 15 file đang sửa dở, `npm ci` theo lockfile:

- `npx vitest run test/plugin-collector.test.ts` in ra `RUN v2.1.9 /app` rồi **đứng im**, bị giết ở 150 giây.
- Chia theo `describe` → treo ở `collection end to end`.
- Chia theo từng test → treo ở đúng một test: **`swallows a store failure and logs it`** (`test/plugin-collector.test.ts:530`).
- Trên macOS chính test đó chạy xong dưới một giây; toàn bộ 103 file / 2352 test xanh trong 56,5 giây.

### 2.3 Thu hẹp tới một lời gọi

Test đó truyền `tracesDir: "/proc/definitely-not-writable/traces"`. Đường đó chạy vào `ensureStoreDir` (`plugin/server/trace-store.ts:159`): `mkdirSync(directory, { recursive: true, mode: 0o700 })`.

Đo trần trụi trên Linux, không qua vitest:

| Lời gọi | Kết quả |
|---|---|
| `fs.lstatSync("/proc")` | OK, 0 ms — `/proc` **có thật** trên Linux |
| `fs.lstatSync("/proc/definitely-not-writable")` | `ENOENT`, 0 ms |
| `fs.mkdirSync("/proc/nope")` (không đệ quy) | `ENOENT` ngay lập tức |
| `fs.mkdirSync("/proc/nope/a", { recursive: true })` | **không bao giờ trả về** (phải `SIGKILL`, mã thoát 137) |
| `fs.mkdirSync("/tmp/ro/a/b", { recursive: true })` với `/tmp/ro` mode 555 | trả về ngay — thư mục không ghi được *thông thường* không gây treo |

Tiến trình kẹt tiêu thụ **0 tick user và 0 tick system trong 2 giây**: nó không quay vòng ngốn CPU mà bị chặn hẳn. Đó là lý do runner không thấy dấu hiệu bất thường nào suốt 6 tiếng.

## 3. Nguyên nhân gốc

Ba điều kiện cộng lại:

1. **`/proc` chỉ tồn tại trên Linux.** Trên macOS không có, nên `mkdirSync` đệ quy hỏng ngay ở thành phần đầu tiên và test đi tiếp bình thường. Đây là toàn bộ lý do lỗi chỉ có trên một hệ điều hành.
2. **`mkdirSync(..., { recursive: true })` dưới `/proc` không trả về trên Linux.** Bản không đệ quy trả `ENOENT` ngay; chỉ bản đệ quy mới kẹt.
3. **`mkdirSync` là lời gọi đồng bộ.** `testTimeout: 30_000` trong `vitest.config.ts` không thể cắt nó: timeout của Vitest cần vòng lặp sự kiện quay lại, mà vòng lặp đang bị chặn trong một lời gọi đồng bộ. Vì vậy test không *fail sau 30 giây* — nó treo vô hạn, kéo theo cả file, cả tiến trình vitest, cả job.

Điểm thứ 3 là lý do sự cố đắt như vậy: một test sai ở đây không báo đỏ sau nửa phút mà đốt trọn trần 6 tiếng của runner, và làm mọi vòng CI sau đó vô dụng.

## 4. Thay đổi

### 4.1 Test dùng đường dẫn hỏng theo cách xác định được (kết quả 1)

Ý đồ của test — *"nuốt lỗi của store và ghi log, không ném vào lượt của agent"* — vẫn giữ nguyên. Chỉ đổi cách dựng một đường dẫn không tạo được.

Thay `/proc/definitely-not-writable/traces` bằng **một file thường đứng ở vị trí thư mục**, nằm trong thư mục tạm của chính test:

```ts
const blocker = join(home, "not-a-directory");
writeFileSync(blocker, "");
const broken = { tracesDir: join(blocker, "traces") };
```

Vì sao cách này đúng đắn hơn:

- `mkdir -p` qua một file thường hỏng với **`ENOTDIR` ngay lập tức**, trên mọi hệ điều hành;
- **không phụ thuộc quyền**: chạy bằng `root` (như trong container) hay bằng `runner` (như trên CI) đều hỏng như nhau. Cách dựa vào `chmod 555` thì không: bảng ở §2.3 cho thấy `root` đi xuyên qua nó;
- nằm trong `home` mà `beforeEach` tạo và `afterEach` xoá, nên không để lại rác và không đụng gì ngoài thư mục tạm;
- không có thành phần nào của đường dẫn nằm ngoài quyền kiểm soát của test.

Các phép khẳng định của test **không đổi**: vẫn `collectTurnEnded(...) === false`, vẫn `log` được gọi đúng một lần, vẫn chứa `[paseo-bm]`. Đường đi trong mã sản phẩm cũng vẫn là đường cũ: `assertNoSymlinkOnPath` thoát sớm ở thành phần chưa tồn tại, rồi `ensureStoreDir` ném `E_TRACE_STORE_UNWRITABLE`, rồi collector nuốt và ghi log.

### 4.2 Ma trận node của `release.yml` (kết quả 2)

Theo quyết định Q6: a.

| | Trước | Sau |
|---|---|---|
| `ci.yml` (mỗi commit) | ubuntu, Node 22 | **không đổi** |
| `release.yml` job `verify` | `{ubuntu, macOS} × {22, 24}` = 4 job | `{ubuntu, macOS} × {24}` = **2 job** |

Lý do chọn Node 24 chứ không phải 22 cho `release.yml`: `ci.yml` đã chạy Node 22 ở mọi commit. Để `release.yml` ở 24 thì **cả hai mức vẫn được kiểm tra**, chỉ nằm ở hai workflow khác nhau; nếu để 22 thì Node 24 không còn được kiểm tra ở đâu nữa, trong khi `engines` khai `>=22` và phần lớn người dùng đang ở 24.

Chiều hệ điều hành **giữ nguyên cả hai**. Chính chiều đó bắt được sự cố này; bỏ nó đi là bỏ đúng cái lưới đã bắt được cá.

Không đổi: bước publish, `if: github.event_name == 'release'`, quyền `id-token: write`, tên file, `concurrency`, các bước `smoke:packed` và kiểm tra script vòng đời.

## 5. Bằng chứng bắt buộc

Không có bằng chứng nào dưới đây thì không được đóng bead tương ứng.

1. **Trên Linux, trước khi vá:** `test/plugin-collector.test.ts` treo — đã có, §2.2.
2. **Trên Linux, sau khi vá:** `npm test` chạy **toàn bộ** suite tới dòng tổng kết `Test Files …`, trong cùng một container. Đây là bằng chứng chính: nó chứng minh không còn chỗ treo nào khác.
3. **Trên macOS, sau khi vá:** `npm run verify` mã 0.
4. **Trên CI:** vòng chạy `ci.yml` của commit vá trên `main` kết thúc `success` trong vài phút, thay vì bị huỷ sau 6 tiếng.
5. **Ma trận:** run `release.yml` liệt kê đúng 2 job `verify`, cả hai `success`.

## 6. Cố ý không làm

- **Không sửa `ensureStoreDir`.** `mkdirSync(recursive)` trong mã sản phẩm vẫn có thể kẹt y như vậy nếu `tracesDir` trỏ vào `/proc`. Thực tế `tracesDir` do resolver của WP-202 dựng dưới thư mục cài đặt, người dùng không trỏ nó vào `/proc` được, nên đây không phải lỗi đang xảy ra. Ghi lại thành **đề xuất**, không làm trong request này (đúng phạm vi người dùng yêu cầu).
- **Không thêm `timeout-minutes`** cho job CI — quyết định Q5: b. Ghi lại thành **đề xuất**: hôm nay không có lưới nào chặn, nên một lần treo tương tự vẫn sẽ đốt trọn 6 tiếng.
- **Không đụng 15 file đang sửa dở** trong working tree — quyết định Q2: a. Chúng không nằm trong HEAD nên cũng không nằm trong bản phát hành.
- **Không sửa `ci.yml`.**

## 7. Hoàn tác

| Thay đổi | Cách lùi |
|---|---|
| §4.1 test | revert đúng `test/plugin-collector.test.ts` |
| §4.2 ma trận | revert đúng `.github/workflows/release.yml` |
| Bản publish lên npm | **không lùi được sau 72 giờ.** Đường lùi là phát hành bản vá. Đây là điểm không đảo ngược duy nhất của request, và nó có bước người dùng xác nhận riêng (Q4) |

## 8. Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| Còn chỗ treo thứ hai chưa lộ ra, vì file treo đầu tiên che mất | Vừa | Bằng chứng §5.2 chạy **toàn bộ** suite trên Linux chứ không chỉ file đã vá |
| Bản vá đúng trên container nhưng khác trên ubuntu của GitHub | Thấp | Container chỉ để thu hẹp; bằng chứng §5.4 vẫn là vòng CI thật |
| Rút ma trận làm lọt lỗi chỉ có ở Node 22 | Thấp | `ci.yml` chạy Node 22 ở mọi commit, kể cả commit phát hành |
| `65ca95f` còn lỗi khác chưa biết, phát hành ra npm | Vừa | Bước phát hành chỉ chạy sau khi `main` xanh thật, và có bước người dùng xác nhận (Q4) |

## 9. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Tạo delta. Chẩn đoán treo CI trên Linux (§2, §3), cách vá test (§4.1), rút ma trận node của `release.yml` theo quyết định Q6: a (§4.2). Status `Draft`, chờ review batch `b1` |
| 2026-09-21 | hieu.nt10 (soạn bởi Beads Worker) | Review `b1` pass. Thêm §9 Revision History theo phát hiện chặn của Reviewer; Status `Draft` → `Active` |
