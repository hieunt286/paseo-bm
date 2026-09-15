# Runbook nghiệm thu điều phối — paseo-bm (lượt 2026-09-15)

| Trường | Giá trị |
|---|---|
| Status | Ready to run |
| Date | 2026-09-15 |
| Owner | hieu.nt10 (người chạy) · Claude (chuẩn bị và chấm) |
| Checklist gốc | [paseo-bm-orchestration-checklist.md](paseo-bm-orchestration-checklist.md) — tài liệu này chỉ là trình tự thao tác, **luật chấm nằm ở checklist** |
| Bead | `bm-wp-117-9vy.2` |
| Bộ công cụ | `~/bm-acceptance/20260915/kit/` (ngoài repo, dùng một lần) |

Owner chọn cách chạy: **owner tự thao tác trong Paseo, Claude chuẩn bị bộ công cụ và chấm điểm từ bằng chứng**. Lượt chạy tạo agent thật bằng provider thật và tốn hạn mức.

## 0. Trước khi bắt đầu — đọc kỹ

- Bước cài ở mục 1 **sửa `~/.paseo/config.json` thật** (có backup), đăng ký plugin `paseo-bm`, và nếu bạn đồng ý thì bật `pluginsEnabled` cùng `daemon.mcp.injectIntoAgents`. Bật công tắc này nghĩa là **mọi agent trên máy** có quyền tạo, nhắc và dừng agent khác, không riêng ba vai trò của paseo-bm.
- Ghi lại giá trị hiện tại của hai công tắc trước khi cài để so sau khi gỡ.
- Không chạy trên repo thật của bạn. Mọi repo dùng trong lượt này nằm dưới `~/bm-acceptance/20260915/repos/`.

## 1. Cài paseo-bm từ commit đang nghiệm thu

```bash
cd /Users/Shared/work/self/paseo-plugins/paseo-bm
git rev-parse --short HEAD                     # ghi vào biên bản
npm ci && npm run build
npm pack --pack-destination ~/bm-acceptance/20260915
npx --yes --package ~/bm-acceptance/20260915/paseo-bm-0.1.0-alpha.0.tgz paseo-bm install
```

- Cài **tương tác**. Đếm số lần được hỏi **xác nhận** (áp dụng; bật plugin kèm quyền công cụ; cài skills) — mong đợi đúng 3 (M-1). Câu hỏi cấu hình vai trò không tính là xác nhận.
- Chọn provider/model cho Manager, Worker, Reviewer; ghi lại vào mục 7 của checklist.
- Sau đó chạy `npx --yes --package ~/bm-acceptance/20260915/paseo-bm-0.1.0-alpha.0.tgz paseo-bm doctor` — mong đợi mã 0.
- Kiểm nhanh trong Paseo: plugin `paseo-bm` ở `status: running`; ba profile `bm-*` có trong bộ chọn.

## 2. Dựng repo mốc (một lần)

```bash
~/bm-acceptance/20260915/kit/make-baseline.sh
```

Repo mốc là một ứng dụng Node nhỏ không phụ thuộc gì: `npm run build`, `npm test` chạy được; có component hiển thị ngày hoá đơn đang ra `MM/DD/YYYY`, màn hình danh sách đơn hàng có bộ lọc theo khách hàng, API `GET /api/invoices/:id` kèm client trong cùng repo và test hợp đồng, tài liệu trong `docs/`, kho beads rỗng.

## 3. Mỗi fixture F-1 → F-5

Làm tuần tự từng fixture, mỗi fixture một Manager chat mới.

1. **Chuẩn bị:** `~/bm-acceptance/20260915/kit/prepare-fixture.sh F-n`
2. **Mở workspace** `~/bm-acceptance/20260915/repos/F-n` trong Paseo, rồi mở **Beads Manager** từ sidebar hoặc Command Center.
3. **Chụp trước:** `~/bm-acceptance/20260915/kit/snapshot.sh before F-n`
4. **Gửi đúng câu yêu cầu** ở cột "Yêu cầu nguyên văn" trong mục 3 của checklist. Ghi thời điểm gửi (UTC, tới giây) vào `evidence/F-n/request-sent-at.txt`.
5. **Trả lời** các câu agent hỏi đúng theo bảng "Trả lời chuẩn" của checklist. Riêng F-3: không trả lời câu xin xác nhận trong 10 phút.
6. **Khi Worker báo `finished` hoặc đang dừng chờ bạn** (F-3, F-5): nhắn cho Claude "xong F-n". Claude sẽ dùng công cụ **chỉ đọc** của Paseo để lấy dòng hoạt động của Manager, Worker và mọi Reviewer vào `evidence/F-n/timeline-*.txt`, rồi chạy `scan-timeline.sh F-n`.
   - Nếu muốn tự lấy: sao chép toàn bộ timeline của từng agent trong Paseo vào các file đó.
7. **Chụp sau:** `~/bm-acceptance/20260915/kit/snapshot.sh after F-n` — xem `evidence/F-n/auto-checks.txt`.
8. **Chạy lại build/test do chính bạn** (F-1, F-2): `cd ~/bm-acceptance/20260915/repos/F-n && npm run build && npm test > ~/bm-acceptance/20260915/evidence/F-n/runner-tests.txt 2>&1`.
9. Ghi chi phí quan sát được (mục 7 checklist). **Không** lưu trữ hay xoá agent cho tới khi Claude đã lấy xong timeline.

## 4. Kiểm bằng mắt (một lần, trong lúc chạy F-1)

Mang sang từ hai bead giao diện đã đóng kèm ngoại lệ:

- Surface Beads Manager, mục sidebar, mục Command Center và panel "Beads agents" hiển thị đúng trên cửa sổ desktop rộng và ở bố cục hẹp.
- Đổi theme sáng/tối: chữ vẫn đọc được; icon `Bot` và `ListTree` hiện đúng.
- Mở Beads Manager lần hai: mở lại đúng Manager cũ, không tạo thêm.
- Chọn mục Command Center "Open Beads Manager": thật sự mở Manager.
- Reviewer có nhận được công cụ tạo agent hay không (ADR-006 quyết định 9) — Claude kiểm từ timeline.

## 5. Sau khi xong cả năm fixture

- Nhắn Claude "chấm điểm". Claude đối chiếu bằng chứng theo mục 4–8 của checklist và viết biên bản `docs/operations/paseo-bm-orchestration-run-20260915.md` (M-10 → M-18, lệch fixture, chi phí, hạn chế).
- Gỡ (tuỳ chọn, **tương tác** để có thể bỏ backup và tắt lại công tắc — M-5 chỉ đạt được khi chạy tương tác):
  `npx --yes --package ~/bm-acceptance/20260915/paseo-bm-0.1.0-alpha.0.tgz paseo-bm uninstall --apply`
- So hai công tắc với giá trị đã ghi ở mục 0.
- Chỉ xoá `~/bm-acceptance/20260915/` sau khi biên bản đã được commit.
