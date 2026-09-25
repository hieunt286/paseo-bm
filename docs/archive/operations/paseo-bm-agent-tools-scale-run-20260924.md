# Chạy thử diện rộng — tool có schema (ADR-010)

| Trường | Giá trị |
|---|---|
| Ngày | 2026-09-24, 13:07Z–13:39Z |
| Bản cài | working tree sau design delta 20260924b-agent-tools §3.6–§3.7 |
| Yêu cầu | Chủ repo: "Đã test full lại những gì xử lý chưa? Tôi cần sự ổn định khi sử dụng diện rộng và spawn rất nhiều manager trên nhiều project" |
| Thiết kế | [design-delta-20260924b-agent-tools](../design/paseo-bm-delta-20260924b-agent-tools.md) |

## 1. Endpoint dưới tải

Bắn thẳng vào endpoint đang chạy trong daemon, trộn ba vai trò, `tools/list` và `tools/call`:

| Request | Đồng thời | Lỗi | p50 | p99 |
|---|---|---|---|---|
| 2000 | 50 | 0 | 5,8 ms | 26,5 ms |
| 5000 | 200 | 0 | 20,2 ms | 39,0 ms |

Plugin vẫn `running` sau đó.

## 2. Tạo agent đồng thời

Test tự động: 60 lần tạo agent cùng lúc qua hook, `config.get()` trả lời trễ và lệch thứ tự. Mỗi agent nhận đúng tool của vai trò mình; agent trên Pi không nhận gì (`test/plugin-agent-tools.test.ts`).

## 3. Bốn project, bốn Manager cùng lúc

Bốn repo Node nhỏ, mỗi repo một workspace. Bốn Manager mở bằng `manager.ensure` **song song** (205 ms, không lỗi), đặt `bypassPermissions` theo luật của người chạy thử, rồi nhận yêu cầu gửi như app.

**Vòng 1** — thêm `median`, sửa `slugify` với dấu tiếng Việt, thêm `--json`, "thêm cache cho fetchUser": cả bốn `finished`, Reviewer `pass`, test repo xanh, không commit.

- Phát hiện: ở lần gọi đầu, 3/4 Worker viết `"skillsUsed": none` — chữ `none` trần, không phải JSON — nên Claude không gửi được cuộc gọi và phải gọi lại; Worker thứ tư ghi `"implementing-beads (planned)"`, bị từ chối với câu lỗi của bộ kiểm ("must be none or …") không chỉ đúng trường đầu vào.
- Sửa: mô tả mọi trường danh sách "leave it out or [] … never the word none", mô tả tool "Arguments are JSON: leave out a field you have nothing for"; id bead và tên skill kiểm bằng `pattern` trong schema, nên lỗi nêu `input.beadsCreated[0]` / `input.skillsUsed[0]`.

**Vòng 2** (sau khi cài bản sửa), bốn yêu cầu mới qua `BM-NEW-REQUEST`, cùng lúc — xoá `mean`, đổi tên `slugify`, thêm `--help`, thời hạn cho cache:

- 0 lần gọi hỏng, 0 lần bị từ chối: mọi `bm_report` / `bm_review` dựng được khối ngay lần đầu.
- p1 hỏi (xoá code có sẵn) → người chạy thử trả lời `A1 a` với Manager → Manager gọi **`bm_answers`** → Worker làm tiếp → Reviewer → `finished`.
- p2 tự quyết không giữ alias, ghi ở `decided`, đưa alias vào `suggestions`.

## 4. Tổng

| Chỉ số | Kết quả |
|---|---|
| Agent tạo ra | 20 (4 Manager, 8 Worker, 8 Reviewer), 0 lỗi tạo, 0 trạng thái `error` |
| Chờ duyệt quyền | 0 |
| `BM-FORMAT` | 0 trên 8 request (mốc trước: 25/17 và 6/8, §3.7 của design delta) |
| Test các repo | xanh cả bốn |
| Commit của agent | 0 |
| Lỗi trong log plugin | 0 |

## 5. Ma trận tình huống (vòng 3, 14:00Z–14:40Z)

Chủ repo: "Hãy thực hiện test làm thêm cho đủ các case tình huống". Agent trên provider khác Claude được tạo qua **fallback** của paseo-bm (`roles.save-fallback`, alias `bm-<role>-fallback-1`), để ba vai trò đang dùng không bị đụng; cấu hình được trả về đúng bản sao lưu sau đó.

| # | Tình huống | Kết quả |
|---|---|---|
| S1 | Reviewer trên **Codex** tạo qua Paseo | **Đạt**: gọi `paseo-bm.bm_review` (tên Codex hiển thị), không bị hỏi duyệt, khối đúng mẫu |
| S2 | Worker trên **Pi** | **Đạt ở điều cần kiểm**: agent được tạo (hook không gắn `toolPolicy`, nên Paseo không từ chối). Endpoint model Pi riêng của máy báo lỗi kết nối — môi trường, không phải plugin |
| S3 | Manager trên **OpenCode** | **Tạo agent có tool: đạt** (Paseo nhận `toolPolicy`). Gọi tool: chưa kiểm được — OpenCode trên máy không tìm thấy model Anthropic, một agent OpenCode chạy thẳng cũng lỗi như vậy |
| S4 | Agent tạo trước một lần `paseo plugin reload` | **Đạt**: cùng port 57829, Worker cũ gọi `bm_report` thành công sau reload |
| S5 | Người dùng trả lời **thẳng trên thẻ** của Worker | **Đạt**: Worker làm tiếp; Manager nhận `BM-ANSWERED`, nói một dòng, **không** chuyển lại |
| S6 | Request **Large** | **Đạt**: `received` → review `b1` (tài liệu + beads) `pass` → `beads-done` → làm → review `b2` `pass` → `finished`; test 10/10 |
| S7 | Câu trả lời `other` (lời của người dùng) | **Đạt**: Worker theo đúng lời ("không xoá, đổi tên"), test 4/4 |

Vòng 3: 7 `bm_report` + 2 `bm_review` dựng được khối, 0 bị từ chối, 0 lần gọi hỏng.

## 6. Test tự động thêm

- `test/bm-tools-property.test.ts`: 500 báo cáo, 300 review, 300 câu trả lời sinh theo seed, đọc lại bằng mọi bộ đọc của plugin (bộ kiểm, parser báo cáo và review, đọc câu hỏi, đọc câu trả lời, thẻ chat, quy tắc "còn chờ" của trace, cách Manager đếm gợi ý). Tìm ra và đã sửa năm trường hợp: dấu `Suggestion (not done):` trong trường khác làm sai số gợi ý (gợi ý viết trong `blockers` nay được chuyển sang `suggestions`); một mục `decided` mở đầu bằng "none" bị đọc thành rỗng; id bead trùng; `tier` có ngoặc lẻ; lỗi của bộ kiểm không nêu tên trường đầu vào.
- `test/plugin-agent-tools.test.ts`: 60 lần tạo agent đồng thời.

**Giới hạn còn lại:** repo và yêu cầu nhỏ; OpenCode chưa gọi được tool trên máy này vì cấu hình model của OpenCode.

Các agent và workspace thử (`scale-p1` … `scale-p4`, `at3-work`) để lại cho chủ repo tự archive.
