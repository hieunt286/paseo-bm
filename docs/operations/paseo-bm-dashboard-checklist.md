# Checklist nghiệm thu Dashboard điều phối (Phase 2a)

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-214-jvg.2` (WP-214) |
| Phạm vi | Chỉ số **D-1 → D-11** của [PRD Dashboard §2](../product/paseo-bm-dashboard-prd.md) |
| Phiên bản kiểm | payload `0.2.0-alpha.0` (chưa phát hành) |
| Mẫu | Theo [checklist nghiệm thu điều phối](./paseo-bm-orchestration-checklist.md) của WP-117 |
| Nguyên tắc ghi điểm | Chỉ số nào không đạt thì ghi **Không** kèm số đo. **Không bao giờ ghi PASS cho một chỉ số chưa đo.** |

## 1. Vì sao phải chạy thật

Mọi thứ đo được bằng unit test đã xanh (1556 test). Bốn thứ **chỉ** thấy được trên daemon thật:

1. Bộ thu thập có thực sự bắt được lượt của agent `bm-*` do Manager tạo, với `timeline.refetch` thật (A-1/A-2 đã xác nhận ở `bm-wp-205-nr1.2`, nhưng chưa từng chạy với một Manager thật).
2. Độ chính xác của việc nhóm trace và của bảng bước quy trình trên **hành vi agent thật** (D-2 → D-5) — không fixture nào thay được, vì đây là điểm sản phẩm hay sai nhất.
3. Trace sống sót qua reload plugin, khởi động lại daemon **và** việc người dùng lưu trữ rồi xoá agent (D-8).
4. Xoá và gán lại không chạm gì ngoài kho (D-9, D-11) trên một hệ thống file thật đang có dữ liệu khác.

## 2. Chuẩn bị, và đường lùi

> **Cảnh báo 1:** các bước dưới đây thay đổi môi trường Paseo đang chạy của người vận hành và tiêu hạn mức model thật. Chỉ chạy khi owner đồng ý.
>
> **Cảnh báo 2 (học được trong lượt 2026-09-16):** **không** chạy `install --apply` hay `paseo plugin reload` khi còn một agent `bm-*` đang chạy. Việc đó ngắt lượt của agent, và `worker.md` coi một lượt bị ngắt là người dùng bấm Stop — Worker sẽ đứng lại và gửi báo cáo `finished`. Kiểm `paseo ls` cho tới khi mọi agent trong workspace nháp ở trạng thái `idle` trước khi cài lại hoặc reload.

| # | Bước | Ghi lại |
|---|---|---|
| 1 | Ghi phiên bản đang cài: `node -e "console.log(require('os').homedir())"` rồi đọc `~/.paseo-bm/install.json` (`version`, `roles[]`) | phiên bản cũ, để khôi phục |
| 2 | Chụp `~/.paseo/config.json` và `ls -la ~/.paseo-bm` | ảnh trước |
| 3 | `npm run build` trong repo | bản dựng dùng để kiểm |
| 4 | Cài payload dev: `node dist/index.js install --home ~/.paseo-bm` (trả lời các câu hỏi như thường; đồng ý bật plugin đã có từ trước) | output, mã thoát |
| 5 | `paseo plugin reload paseo-bm --json` và chờ `status: running` | trạng thái plugin |
| 6 | Tạo một repo nháp dùng một lần, `br init`, `paseo` mở workspace cho nó | id workspace |

**Đường lùi:** cài lại phiên bản cũ bằng `npx paseo-bm@<phiên bản cũ>`, hoặc `node dist/index.js uninstall` rồi cài lại bản cũ. Kho `~/.paseo-bm/traces/` do lần chạy này tạo ra **không** bị hai lệnh đó xoá; xoá bằng tay sau khi thu bằng chứng.

## 3. Bộ fixture

Dùng lại hình dạng năm yêu cầu mẫu của WP-117 để so sánh được giữa hai đợt nghiệm thu.

| Fixture | Yêu cầu gửi Manager | Mức mong đợi | Vì sao có nó ở đây |
|---|---|---|---|
| F-1 | Một việc nhỏ, rõ ràng, nằm trong một file | Nhỏ | Bảng bước quy trình phải hiện `skipped` cho PRD/design/plan, **không** phải `unknown` |
| F-2 | Một việc vừa, cần sửa một tài liệu sẵn có | Vừa | Chỉ `polish_beads` được `skipped`; các bước tài liệu phải là `done` hoặc `unknown` |
| F-3 | Một việc lớn chạm lược đồ dữ liệu | Lớn | Không bước nào được `skipped`; phải có chuỗi tài liệu |
| F-4 | Một yêu cầu trùng với bead đang mở | Vừa | `beadsUpdated` phải có, `beadsCreated` không được phình |
| F-5 | Một yêu cầu bị dừng giữa chừng (người chạy bấm Stop) | bất kỳ | Trạng thái trace phải là `stopped` hoặc `waiting_user`, **không** phải `completed` |

## 4. Bảng đo

| ID | Ngưỡng | Cách đo | Bằng chứng |
|---|---|---|---|
| D-1 | Mở Dashboard đúng 1 lần bấm; danh sách hiện trong **≤ 3 giây** với ≤ 20 agent và ≤ 500 trace | Mở sidebar *Beads Manager* → bấm **Dashboard**. Bấm đồng hồ từ lúc bấm tới lúc danh sách hiện xong. Lặp 3 lần, lấy số lớn nhất | ảnh chụp màn hình, 3 số đo |
| D-2 | Số Worker và số agent Reviewer **khớp 5/5** với đếm tay trong giao diện Paseo; số **lượt** review hiện riêng | Với từng fixture: đếm agent trong panel *Beads agents*, so với dòng trace. Ghi cả `reviewCalls` và số Worker tự báo | bảng đối chiếu 5 dòng |
| D-3 | Lệch **≤ 1 giây** so với tính tay từ `timestamp` của timeline | Đọc `paseo logs <manager> --tail 200` lấy mốc đầu; lấy `at` của `BM-REPORT` `finished`; so với `durationMs` trên màn hình | 5 cặp số |
| D-4 | Bead created/updated/closed **khớp 5/5** với chênh lệch `.beads/issues.jsonl` trước–sau | `cp .beads/issues.jsonl before.jsonl` trước mỗi fixture; sau đó `diff` và so với khối Beads của trace | 5 diff |
| D-5 | **0** ô "đã làm" không có bằng chứng; **0** ô "không làm" khi Worker không báo mức | Với từng fixture, chụp bảng bước quy trình; kiểm từng ô `done` có evidence, từng ô `skipped` có mức tương ứng ở §3 | 5 ảnh chụp + ghi chú |
| D-6 | Khớp `br stats` và `br ready` trên **3** repo, một repo không có `.beads/` | Mở Dashboard cho 3 workspace, so với `br stats` chạy trong từng repo | 3 bảng |
| D-7 | **0** file ghi ngoài `~/.paseo-bm/traces`, **0** agent bị tạo/dừng/xoá bởi Dashboard, **0** lời gọi mạng, **0** lần ghi vào repo | Ảnh chụp hệ thống file trước–sau cả `$HOME` (`find ~ -newer <mốc>`), `git status` trong repo nháp, và `paseo ls` trước–sau | 2 ảnh chụp + diff |
| D-8 | Trace của **5/5** fixture đọc lại được nguyên vẹn sau: `paseo plugin reload` **và** sau khi lưu trữ rồi xoá Worker. ~~khởi động lại daemon~~ — **bỏ**: `AGENTS.md` cấm `paseo daemon restart`/`stop` vì có thể giết agent đang chạy, và ngưỡng này viết ra mà quên luật đó ([delta](../design/paseo-bm-delta-20260916-acceptance-fixes.md) §4) | Sau khi 5 fixture xong: đọc Dashboard (ảnh 1) → reload plugin → đọc lại (ảnh 2) → khởi động lại Paseo → đọc lại (ảnh 3) → xoá agent của F-1 → đọc lại (ảnh 4) | 4 ảnh + số trace mỗi lần |
| D-9 | Xoá 1 trace và xoá toàn bộ workspace: trace mất khỏi màn hình, dung lượng giảm, **0** file khác bị đổi | `find ~ -newermt <mốc> -not -path '*/traces/*'` trước–sau mỗi lần xoá; so số byte trên màn hình với `du -sb ~/.paseo-bm/traces` | 2 cặp ảnh chụp |
| D-10 | Chi phí: **mọi** dòng đều có nhãn "estimated" kèm ngày bảng giá; model không có trong bảng thì **chỉ** hiện token; và **0** dòng cộng `totalCostUsd`. ~~khớp tuyệt đối khi provider báo~~ — **bỏ**: provider báo tổng luỹ kế của phiên, không phải chi phí một request ([delta](../design/paseo-bm-delta-20260916-acceptance-fixes.md) vị trí 3) | So dòng chi phí với `paseo ls --json` (`lastUsage`) của từng agent; kiểm một agent Codex (`gpt-5.6-sol`, không có trong bảng giá) | bảng 5 dòng |
| D-11 | Gán lại: **100%** bản ghi tới đúng đích, **0** mất, **0** nhân đôi, **0** file ngoài kho bị đổi | Xoá workspace nháp khỏi Paseo → mở Dashboard, xác nhận nhóm "workspace không còn" → gán lại sang workspace khác → đếm trace trước/sau và `wc -l` các file `events-*.jsonl` | ảnh + 2 số đếm |

## 5. Phiếu ghi từng fixture

```
Fixture: F-_
Yêu cầu gửi lúc (UTC):
requestId hiện trên Dashboard:
Worker id / Reviewer id:
Số Worker / số agent Reviewer / số lượt review / số Worker tự báo:
durationMs trên màn hình / tính tay từ timeline / lệch:
Bead created / updated / closed trên màn hình:
Bead theo diff issues.jsonl:
Bảng bước quy trình: ô done không có evidence = _ ; ô skipped sai mức = _
Token in/cached/out; chi phí và nhãn:
Trạng thái trace:
Ghi chú:
```

## 6. Bảng kết quả

| ID | Ngưỡng | Đo được | Đạt | Bằng chứng |
|---|---|---|---|---|
| D-1 | ≤ 3 giây, 1 lần bấm | | | |
| D-2 | khớp 5/5 | | | |
| D-3 | lệch ≤ 1 giây | | | |
| D-4 | khớp 5/5 | | | |
| D-5 | 0 / 0 | | | |
| D-6 | khớp trên 3 repo | | | |
| D-7 | 0 / 0 / 0 / 0 | | | |
| D-8 | 5/5 sau 2 biến cố | | | |
| D-9 | 0 file khác bị đổi | | | |
| D-10 | có nhãn + ngày giá / chỉ token / 0 dòng cộng luỹ kế | | | |
| D-11 | 100% / 0 / 0 / 0 | | | |

## 7. Dọn dẹp

| # | Bước |
|---|---|
| 1 | Xoá repo nháp và workspace của nó |
| 2 | Cài lại phiên bản paseo-bm mà người vận hành đang dùng trước đợt này |
| 3 | So `~/.paseo/config.json` với ảnh trước; mọi khác biệt phải giải thích được |
| 4 | Xoá kho lưu vết do đợt này tạo, sau khi đã thu xong bằng chứng |
| 5 | Ghi biên bản vào `docs/operations/paseo-bm-dashboard-run-<ngày>.md` |

## 8. Trạng thái hiện tại

**Chưa chạy.** Checklist này là phần đầu của `bm-wp-214-jvg.2`; phần còn lại cần owner đồng ý vì nó thay môi trường Paseo đang chạy và tiêu hạn mức model thật (§2). Xem bình luận trên bead để biết chính xác còn thiếu gì.
