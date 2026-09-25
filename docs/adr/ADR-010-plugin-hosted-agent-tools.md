# ADR-010 — Plugin phục vụ tool có schema cho agent của mình qua MCP HTTP

| Trường | Giá trị |
|---|---|
| Status | Accepted |
| Date | 2026-09-24 |
| Owner | hieu.nt10 |
| Liên quan | [design-delta-20260924b-agent-tools](../archive/design/paseo-bm-delta-20260924b-agent-tools.md); [ADR-004](ADR-004-paseo-config-mutation.md) (plugin không sửa config Paseo); [ADR-006](ADR-006-role-registration.md) (vai trò đăng ký qua provider alias) |
| Quyết định của chủ repo | 2026-09-24: Q1 (a), Q2 (a), Q3 (a) của delta trên |

## Context

Agent viết khối `BM-*` bằng tay, plugin đọc lại bằng regex. Chỉ dẫn và bộ kiểm là hai bản mô tả một mẫu, lệch nhau, và mỗi lần lệch tốn một lượt `BM-FORMAT`. Chủ repo muốn sửa tận gốc, và muốn cách sửa **có sẵn khi người dùng cài plugin**, không cần bước cài thêm.

Paseo 0.8 cho plugin gắn MCP server vào agent sắp tạo (`before("agent.create")` → `config.mcpServers`) và duyệt sẵn tool (`config.toolPolicy.preapproved`). Paseo tự đưa tool của nó tới agent bằng MCP `http`.

## Decision

1. **Tiến trình server của paseo-bm phục vụ một MCP endpoint HTTP** trên `127.0.0.1`. Port được chọn một lần và lưu trong install home, để agent đang sống giữ được tool qua các lần plugin nạp lại.
2. `before("agent.create")` gắn endpoint ấy **chỉ cho agent `bm-*`** và duyệt sẵn đúng các tool của vai trò đó. Không đụng config Paseo (ADR-004 giữ nguyên), không đụng agent khác trên máy.
3. **Tool không có tác dụng phụ:** kiểm đầu vào bằng schema Zod trong `shared/`, trả về khối `BM-*` dựng từ schema, hoặc lỗi từng trường. Agent tự gửi khối như trước. Vì vậy endpoint không cần biết ai gọi và không cần xác thực.
4. **Schema là nguồn duy nhất của mẫu.** Văn bản khối không đổi, nên mọi bên đang đọc văn bản (thẻ chat, Dashboard, trace, qa-ledger) không đổi.
5. **Đường viết tay giữ vĩnh viễn** làm dự phòng; bộ kiểm và `BM-FORMAT` giữ nguyên cho nó.

## Consequences

- Agent tạo trước bản này không có tool (hook `agent.session_open` chỉ đổi được `env`); chúng tiếp tục viết tay.
- Plugin mở một cổng lắng nghe trên loopback. Tool không đọc, ghi hay gửi gì, nên một tiến trình khác trên máy gọi vào cũng không lấy được gì ngoài văn bản nó tự đưa vào.
- Không giữ được port cũ (bị chiếm) thì plugin chọn port mới; agent cũ mất tool và quay về viết tay.
- Paseo **từ chối tạo agent** khi request có `toolPolicy` mà provider không duyệt sẵn được tool MCP (chỉ claude, codex, opencode làm được). Vì vậy tool chỉ được gắn khi provider gốc của alias nằm trong danh sách đó; Pi, Copilot hay provider không đọc được thì không gắn gì, và agent viết khối bằng tay như hôm nay.

## Alternatives considered

- **Tool tự gửi khối** (Q1 b): bớt một bước nhưng phải nhận diện agent gọi, giữ luật "không gửi vào lượt đang chạy", và đổi cách thẻ chat nhận biết người gửi. Có thể làm sau, trên nền quyết định này.
- **Script `stdio` trong payload** (Q2 b): không phụ thuộc port, nhưng cần đường dẫn `node` chạy được; Paseo Desktop không bảo đảm có `node` trên `PATH`.
- **Bỏ đường viết tay sau chuyển đổi** (Q3 b): một provider không hỗ trợ MCP sẽ không báo cáo được.
