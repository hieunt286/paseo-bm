# Delta-change — Metric gắn sai request và làm rơi lượt khi Manager đổi hoặc turn id lặp lại

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917d-request-attribution` |
| Tài liệu gốc | [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) §3.3 (chống trùng), §4 bước 2 (lượt Manager không nêu request); [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-041, REQ-057 |
| Status | Merged — gộp vào [paseo-bm-dashboard.md](../../design/paseo-bm-dashboard.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Routing | Brownfield, mức **Vừa**: sửa đường đọc của Dashboard, một thành phần, không đổi hợp đồng RPC hay lược đồ kho. Không cần plan: hai kết quả độc lập, viết bead bằng tay |

## 1. Owner báo gì

> tôi đã chat trong beads manager "UI/UX - Deal Detail" tôi vừa mới hỏi một câu về check mr, nhưng không nhìn thấy trong metric. Vấn đề ở đây là gì vậy

## 2. Bằng chứng

Một sub-agent chẩn đoán (chỉ đọc), rồi tác giả delta tự kiểm lại trong kho vết của owner.

- Workspace `wks_a217b1fc9568ab78`. Manager mới `d6fc9b1c…` tạo lúc 04:19 hôm nay, một phút sau khi Manager cũ `a508fb27…` bị lưu trữ. Manager mới giao `req-20260917T041929Z` cho Worker `9ddf32c5…`.
- Bộ gom trace chạy đúng: kho có đủ các lượt của Manager mới, kể cả lượt mở đầu 04:19 chứa câu hỏi về MR.
- `traces.list` trả dòng `req:req-20260917T041929Z` nhưng `requestedAt` là **2026-09-16T10:28:40Z** và nội dung là **"Hãy thực hiện commit, push toàn bộ những thay đổi"** — lượt cuối của Manager **cũ**, 18 giờ trước. Trên màn hình, dòng đó trông như yêu cầu của hôm qua.
- **Turn id bị dùng lại** (tác giả delta tự kiểm): Manager mới có `foreground-turn-1`, `-2`, `-3` mỗi cái **hai lần**, lần đầu lúc 04:19–04:22 và lần sau lúc 04:27–04:31, với thời điểm tin nhắn đầu khác nhau; Worker có `foreground-turn-1` hai lần (04:19 và 04:27). Đó là các lượt khác nhau thật.

## 3. Hai lỗi

| # | Lỗi | Vị trí | Bản chất |
|---|---|---|---|
| A | Lượt Manager không nêu request được gộp vào request **nêu kế tiếp trong cả workspace**, xuyên qua Manager khác và khoảng cách 18 giờ; `fold` rồi lấy tin nhắn **sớm nhất** làm nội dung request | `plugin/server/traces.ts` `openBuckets`, lượt 2 (`nextNamed`, `openedAfter`) | **Mã lệch thiết kế.** §4 bước 2 viết "request mà **Manager** nêu ở lượt kế tiếp" — một Manager. Lý do của luật (WP-214 lỗi 9: báo cáo trạng thái của Worker đến như lời người dùng) chỉ đúng trong hội thoại của chính Manager đó |
| B | Chống trùng theo `(agentId, turnId)` giữ bản ghi có `at` muộn nhất, nên khi Paseo đánh số lại turn id thì các lượt **cũ hơn nhưng khác nhau** bị vứt: lượt mở đầu của Manager (câu hỏi MR), hai lượt kế, và lượt đầu của Worker (12.476 token đầu ra) | `plugin/server/trace-store.ts` `dedupeRecords` | **Giả định của thiết kế sai.** §3.3 giả định turn id không lặp trong một agent. Thực tế Paseo đánh số lại |

Hệ quả phụ trên màn hình: biểu đồ "request mỗi ngày" ghi 0 cho 17/09; thời lượng tính từ hôm qua; token của Manager cũ bị cộng vào request hôm nay; yêu cầu commit/push hôm qua mất dòng riêng.

## 4. Sửa

**A — gộp trong phạm vi một Manager.** `nextNamed` và `openedAfter` chỉ xét lượt **của cùng agent Manager**. Một lượt không nêu request chỉ gộp vào request mà **chính Manager đó** nêu về sau; không có thì mở dòng tạm như hiện nay. Vì phạm vi đã là một Manager, `fold` không còn cách nào lấy nội dung hay thời điểm từ Manager khác. Không thêm ngưỡng thời gian: lỗi quan sát được giải quyết hết bằng phạm vi agent, và một ngưỡng tự đặt sẽ là một quy tắc mới không có bằng chứng.

**B — khoá chống trùng thêm vân tay nội dung lượt.** Khoá thành `(agentId, turnId, vân tay các tin nhắn)`: một digest của chữ trong `sent` rồi `received`, theo thứ tự. Một lượt được ghi lại sau khi nạp lại plugin có cùng các tin nhắn nên cùng vân tay và vẫn trùng khoá; một turn id bị dùng lại cho lượt khác có nội dung khác nên được giữ. Bản ghi không có tin nhắn nào thì giữ khoá cũ `(agentId, turnId)`.

**Sửa lần đầu viết là "thời điểm tin nhắn đầu" — đã kiểm và bỏ.** Delta này ban đầu kê khoá `(agentId, turnId, thời điểm tin nhắn đầu)` kèm một rủi ro phải kiểm trước: cách đó chỉ đúng nếu thời điểm tin nhắn **lấy từ dòng thời gian**. Bead B đã đọc `collector.ts` và **giả định đó sai**:

```
line 350  const endedAt = now().toISOString();          // giờ lúc ghi
line 367  at: typeof entry.timestamp === "string" ? entry.timestamp : endedAt
line 369  : sliceLastTurn(items).map((item) => ({ item, at: endedAt }))
```

Tin nhắn chỉ mang giờ của dòng thời gian khi `timestampsForTurn` gọi `refetch` thành công; lỗi bị nuốt ở dòng 246–248 (agent đã lưu trữ là ca hiển nhiên) và khi đó cả bản ghi đóng dấu giờ lúc ghi. Ghi lại cùng một lượt sau khi nạp lại plugin sẽ ra khoá khác, và Dashboard **đếm đôi** cả lượt lẫn token — đúng hỏng hóc mà mục rủi ro bắt dừng lại. Trong bản ghi không có mốc thời gian nào ổn định: `at` và `endedAt` đều là `now()`, `startedAt` lấy từ mark trong bộ nhớ (dòng 420) mà nạp lại là mất.

Cái **ổn định** qua một lần ghi lại là **chữ của tin nhắn**: cả đường `refetch` lẫn đường dự phòng đều đọc cùng các timeline item. `messageId` (protocol `agent-types.d.ts`: `user_message` có `messageId?`) còn đúng bản chất hơn, nhưng `traceMessageSchema` không lưu nó — thêm vào là đổi lược đồ kho đã ghi, nên để dành. Owner chốt vân tay nội dung ngày 2026-09-17.

Rủi ro còn lại, chấp nhận: nếu lần ghi lại rơi vào đường dự phòng và cắt ra một tập tin nhắn hơi khác, vân tay đổi và ra **hai dòng** — thừa một dòng, không mất dữ liệu. Đổi lại, hỏng hóc đang có là **mất hẳn** lượt.

## 5. Sự thật mới

Bộ gom trace **có thể đóng dấu giờ lúc ghi** cho tin nhắn: khi `refetch` của `timestampsForTurn` lỗi hoặc không trả timestamp, `buildRecord` dùng `endedAt = now()`. Không mã nào được coi thời điểm tin nhắn trong một bản ghi là thời điểm thật trên dòng thời gian (kiểm 2026-09-17, `plugin/server/collector.ts` dòng 350/367/369).

Paseo có thể **dùng lại turn id trong cùng một agent** (quan sát 2026-09-17 trên kho vết của owner: `foreground-turn-1…3` xuất hiện hai lần với tin nhắn đầu cách nhau 8 phút, ở cả Manager lẫn Worker). Không có mã nào được giả định turn id là duy nhất theo agent.

## 6. Ghi nhận, không sửa ở đây

Manager mới **không có nhãn** `bm.role` (có vẻ được tạo ngoài launcher của plugin), nên `bmAgentsOf` không thấy nó. Dashboard vẫn dựng được trace vì vai trò lấy từ provider trong bản ghi, nhưng thông tin agent (tiêu đề, trạng thái) của Manager đó thiếu. Đề xuất cho owner, không thuộc delta này.

## 7. Kiểm thử

| Kết quả | Test | Đối chứng âm |
|---|---|---|
| A | Manager A có lượt cuối mang lời người dùng và không nêu request; một ngày sau Manager B mở `req-X` → **hai** dòng: dòng tạm của A với nội dung của A, và `req-X` với nội dung và thời điểm của B. Các test lượt 2 hiện có (báo cáo trạng thái của Worker, lời nối tiếp của người dùng, WP-214 F-4) vẫn xanh | Bỏ phạm vi agent → test mới đỏ |
| B | Cùng agent, cùng turn id, nội dung lượt khác nhau (04:19 và 04:27) → giữ **cả hai**; cùng nội dung, `at` ghi khác → giữ **một** (bản muộn hơn); bản ghi không có tin nhắn → khoá cũ. Thêm một ca cho đúng rủi ro đã chốt: cùng nội dung nhưng **mọi thời điểm tin nhắn khác nhau** (đường dự phòng đóng dấu giờ ghi) vẫn phải giữ **một**. Test hiện có ở `test/plugin-trace-store.test.ts` vẫn xanh, kể cả đường gộp của `reassignWorkspace` dùng chung `dedupeRecords` | Bỏ vân tay khỏi khoá → ca turn id lặp đỏ |
| Hai kết quả cùng nhau | Dựng lại từ các bản ghi có hình dạng như kho của owner (Manager cũ lưu trữ, Manager mới, turn id lặp) → dòng `req-X` có nội dung câu hỏi MR và `requestedAt` 04:19 hôm nay | — |

## 8. Tài liệu phải cập nhật

- `docs/design/paseo-bm-dashboard.md` §3.3 (khoá chống trùng) và §4 bước 2 ("cùng Manager") — errata trỏ về delta này.
- `AGENTS.md` mục sự thật đã kiểm chứng: turn id có thể lặp trong một agent; và thời điểm tin nhắn trong bản ghi vết có thể là giờ lúc ghi.
