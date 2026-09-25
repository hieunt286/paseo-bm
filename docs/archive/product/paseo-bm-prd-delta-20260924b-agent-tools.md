# PRD delta — Agent báo cáo qua tool có schema

| Trường | Giá trị |
|---|---|
| Mã | `prd-delta-20260924b-agent-tools` |
| PRD gốc | [paseo-bm PRD](../../product/paseo-bm-prd.md), [Dashboard PRD](../../product/paseo-bm-dashboard-prd.md) (hợp đồng `BM-REPORT` công khai) |
| Status | Merged — gộp vào [paseo-bm-prd.md](../../product/paseo-bm-prd.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Owner | hieu.nt10 |
| Created | 2026-09-24 |
| Thiết kế | [design-delta-20260924b-agent-tools](../design/paseo-bm-delta-20260924b-agent-tools.md), [ADR-010](../../adr/ADR-010-plugin-hosted-agent-tools.md) |

## REQ-068 — Khối `BM-*` được dựng bởi tool có schema

- (a) Khi người dùng cài paseo-bm, mọi Worker, Reviewer và Manager tạo sau đó có sẵn tool `bm_report`, `bm_review`, `bm_answers` — không bước cài thêm, không hỏi quyền khi gọi.
- (b) Tool trả lỗi từng trường ngay trong lượt khi đầu vào sai mẫu; khi đúng, trả về khối đúng mẫu để agent gửi nguyên văn.
- (c) Văn bản khối không đổi: thẻ chat, Dashboard, trace và qa-ledger đọc như trước (tương thích hai chiều của Dashboard PRD giữ nguyên).
- (d) Khi tool không có (agent cũ, provider không nạp MCP), agent viết khối bằng tay như hôm nay và vẫn được kiểm bằng `BM-FORMAT`.

**Tiêu chí đo:** số `BM-FORMAT` trên mỗi request tạo sau khi cài giảm so với mốc 2026-09-22..24 (`npm run measure`).
