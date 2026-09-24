# paseo-bm 0.3.0-alpha.7

Bản **tính năng**: Manager, Worker và Reviewer dựng khối `BM-*` bằng **tool có schema** do plugin phục vụ, thay cho việc tự viết khối rồi để plugin đoán lại bằng regex. Cùng lúc, Worker tự quyết nhiều hơn và hỏi ít hơn, và câu hỏi đã trả lời không bị hỏi lại. Dùng làm `--notes-file` theo [release runbook](./paseo-bm-release-runbook.md).

**Cài bản này:** `npx paseo-bm@next`, hoặc ghim cứng `npx paseo-bm@0.3.0-alpha.7`. Cách cài không đổi. Như mọi bản, hai gói `paseo-bm` và `paseo-bm-plugin` cùng phiên bản.

## Tool dựng khối (ADR-010)

- Mỗi agent `bm-*` tạo **sau khi cài** có đúng một tool của vai trò mình: Manager `bm_answers`, Worker `bm_report`, Reviewer `bm_review`. Tool kiểm đầu vào, trả lỗi từng trường ngay trong lượt, và trả về khối để agent gửi nguyên văn — không còn vòng `BM-FORMAT`.
- **Văn bản khối không đổi**: thẻ chat, màn Metric, trace và sổ hỏi–đáp đọc như cũ.
- Plugin phục vụ tool trên `127.0.0.1` từ chính tiến trình của nó; port giữ ở `~/.paseo-bm/ui/agent-tools.json`, nên agent đang sống giữ được tool qua các lần plugin nạp lại. Tool chỉ dựng văn bản: không đọc, ghi hay gửi gì.
- Tool chỉ được gắn cho agent chạy **Claude, Codex hoặc OpenCode** — những provider Paseo duyệt sẵn được tool. Trên provider khác (Pi, Copilot…), Paseo sẽ từ chối tạo agent nếu có tool, nên ở đó agent tự viết khối như trước.
- Đường viết tay giữ vĩnh viễn làm dự phòng, và vẫn được kiểm bằng `BM-FORMAT`.

## Worker tự quyết nhiều hơn, hỏi đúng chỗ

- Worker tự quyết mọi thứ hoàn tác được trong phạm vi yêu cầu và ghi vào trường `decided` để người dùng đảo lại; chỉ hỏi về phạm vi, việc không hoàn tác được, thứ chỉ người dùng có, hoặc khi bị kẹt.
- Mức Small/Medium/Large đo rủi ro của thay đổi Worker thiết kế, không đo điều người dùng đã nói rõ; một yêu cầu không cần thiết kế thì không có bead và không có Reviewer.
- Gợi ý chưa làm có trường riêng `suggestions`.

## Không hỏi lại câu đã trả lời

- Câu trả lời — qua thẻ hay qua Manager — được ghi thành trạng thái thật (sổ hỏi–đáp); Manager nhận `BM-ANSWERED` khi người dùng trả lời thẳng cho Worker và không chuyển lại.
- Thông báo của plugin (`BM-FORMAT`, `BM-ANSWERED`…) và câu trả lời gửi từ thẻ hiện thành thẻ nhỏ trong chat thay cho chữ thô.

## Sửa lỗi

- Bộ kiểm định dạng ghép các mảnh stream trước khi kiểm: 13/17 `BM-FORMAT` gửi Reviewer trước đây là báo nhầm vì đọc từng mảnh.
- `tier` có ghi chú sau dấu ngoặc không còn bị coi là sai mẫu.
- Trace không còn đọc thông báo của plugin thành review hay báo cáo; `parseReviews` chỉ đếm finding của chính khối đó.

## Kiểm chứng

Review độc lập hai lượt; 1100 đầu vào sinh theo seed được mọi bộ đọc của plugin đọc lại đúng; 7000 request vào endpoint ở 200 đồng thời, 0 lỗi; bốn Manager chạy song song trên bốn project, hai vòng, 0 `BM-FORMAT`; ma trận tình huống (Codex qua Paseo, Pi, OpenCode, reload, trả lời trên thẻ, request Large, câu trả lời tự do). Hồ sơ: [chạy thử diện rộng](./paseo-bm-agent-tools-scale-run-20260924.md).

## Cần biết khi nâng cấp

- **Manager đã mở trước khi cài bản này không có tool** (Paseo không cho plugin sửa agent đã tồn tại); nó vẫn chạy, bằng đường viết tay. Muốn Manager có tool thì archive Manager cũ và mở Manager mới. Worker và Reviewer được tạo mới cho mỗi request nên tự có tool.
- dist-tag `latest` của hai gói do owner dời tay; `release.yml` chỉ đặt `next`.

## Nguồn

[ADR-010](../adr/ADR-010-plugin-hosted-agent-tools.md); [design delta agent-tools](../design/paseo-bm-delta-20260924b-agent-tools.md), [qa-ledger](../design/paseo-bm-delta-20260924-qa-ledger.md), [worker-autonomy](../design/paseo-bm-delta-20260924-worker-autonomy.md), [instruction-quality](../design/paseo-bm-delta-20260924-instruction-quality.md); [PRD delta REQ-068](../product/paseo-bm-prd-delta-20260924b-agent-tools.md).
