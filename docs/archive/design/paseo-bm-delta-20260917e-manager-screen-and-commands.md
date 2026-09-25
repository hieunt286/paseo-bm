# Delta-change — Màn hình Beads Manager: thứ tự ghim, dấu hiệu đang chạy, tách luồng theo lượt hỏi, và hai slash command

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917e-manager-screen-and-commands` |
| Tài liệu gốc | [Technical Design](../../design/paseo-bm.md) (payload plugin, vai trò, dừng việc); [Technical Design Dashboard](../../design/paseo-bm-dashboard.md) §3.3, §4, §6 và RPC `workspaces.overview`; [PRD](../../product/paseo-bm-prd.md) REQ-026f; [PRD Dashboard](../../product/paseo-bm-dashboard-prd.md) REQ-041, REQ-057 |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Routing | Brownfield, mức **Vừa–Lớn**: bốn kết quả độc lập, đụng một hợp đồng RPC, một luật trình bày của Dashboard, một file vai trò, và một bề mặt UI mới. Cần plan trước khi chuyển bead vì có phụ thuộc thật giữa các kết quả |

## 1. Owner yêu cầu gì

> 1. Ở màn hình Beads Manager cho phép người dùng drag n drop vị trí thứ tự các Project để họ ưu tiên xem cái gì thì xem
> 2. Project nào đang có agent working thì cũng có icon động nhận diện nó đang làm việc
> 3. Mỗi lần user phản hồi vào luồng Chat cho Manager thì có thể sẽ hiển thị thành 1 flow mới chứ không gộp gom nhóm lại khó trace (mặc dù hoàn toàn có thể resuse worker, reviewer nhưng nó vẫn nên là 1 luồng mới
> 4. Tôi muốn thêm một số command khi người dùng gõ sau khi cài plugin như: `/bm-worker-new` => Nhận yêu cầu công việc mới và create agent ra một Worker mới để nhận và làm việc. `/bm-worker-stop-all` => Yêu cầu tất cả các worker và reviewer liên quan dừng việc của mình lại

## 2. Quyết định của owner (2026-09-17)

| # | Câu hỏi | Owner chốt |
|---|---|---|
| Q23 | Lượt hỏi mới thành luồng mới — đánh dấu bằng gì | **Chỉ Dashboard tách**, `requestId` giữ nguyên. Worker và Manager không đổi cách làm việc |
| Q24 | `/bm-worker-new` tạo Worker đường nào | **Qua Manager**. Lệnh chỉ là lối tắt gõ nhanh; Manager vẫn cấp `requestId`, đoán cỡ, tạo Worker và theo dõi |
| Q25 | "Đang làm việc" tính theo agent nào | **Bất kỳ agent bm nào đang chạy** — Manager, Worker hay Reviewer |
| Q26 | Thứ tự kéo-thả quan hệ thế nào với sắp theo hoạt động | **Ghim lên đầu**: project đã kéo nằm cố định ở trên theo thứ tự owner đặt; phần còn lại vẫn `activity_at desc` |
| Q27 | Biểu đồ "request mỗi ngày" đếm request hay đếm đoạn | **Đếm request.** Đếm đoạn thì một cuộc hỏi đáp mười lượt làm biểu đồ nhảy vọt và mất ý nghĩa so sánh giữa các ngày |
| Q28 | `/bm-worker-stop-all` phạm vi tới đâu | **Chỉ workspace hiện tại.** Toàn máy là một nút đỏ quá lớn cho một dòng gõ nhầm được |

## 3. Nền tảng — đã kiểm chứng những gì

Đọc trực tiếp từ gói đã cài và từ bundle của Paseo.app 0.8.0, không suy đoán.

- **P1. Paseo có slash command cho plugin.** `PluginClientContext.addSlashCommand(contribution)` với `contribution = { name, description, argumentHint, context: "workspace" | "agent", onSubmit }`. `onSubmit` nhận `args: string` cùng `paseo`, `rpc`, `openSurface`, `openSettings`, `openPanel`, và `workspace` (hoặc cả `agent` ở context `agent`). Nguồn: `@getpaseo/plugin/dist/client/contracts.d.ts`.
- **P2. Client gửi được tin nhắn cho agent.** `paseo.agents.ref(id).send(text, options)` (`@getpaseo/client`). Đây là cùng đường mà app dùng, nên tin nhắn mang `clientMessageId` và được ghi là **lời người dùng**.
- **P3. Renderer của Paseo là Expo + `react-native-web`.** Bundle `app-dist/_expo/static/js/web/index-*.js` có sẵn `PanResponder`, `AnimatedValue`, `LayoutAnimation`, `useNativeDriver`. Client của plugin vốn đã `import { Pressable, Text, View } from "react-native"` và chạy được, nên `Animated` và `PanResponder` cùng đường phân giải. **Kéo-thả và hoạt ảnh là làm được**, không cần thư viện ngoài.
- **P4. Paseo KHÔNG cho plugin huỷ agent.** Đã ghi từ WP-026f và vẫn đúng: cách ngắt gần nhất được hỗ trợ là `PaseoAgentHandle.send()` lên một agent **đang chạy**, nó thay lượt hiện tại bằng lượt mới mang thông báo dừng. Đây là ràng buộc quyết định hình dạng của `/bm-worker-stop-all`.
- **P5. `send()` bỏ lưu trữ một agent đã lưu trữ** (ADR-005). Mọi chỗ fan-out phải bỏ qua agent đã lưu trữ hoặc đã đóng.
- **P6. Dữ liệu cho dấu hiệu "đang chạy" đã có một nửa.** RPC `workspaces.overview` đã trả `runningWorkers` cho từng workspace; nó **chỉ đếm Worker**, nên Q25 đòi mở rộng.
- **P7. Phân biệt được lời người dùng thật.** Bản ghi vết đã có trường `origin` (`user` khi timeline item mang `clientMessageId`, `agent` khi do `send_agent_prompt`), và `isPluginNotice()` loại thông báo của chính plugin. Bản ghi cũ hơn trường này **không có** `origin` — theo AGENTS.md, không được đọc sự vắng mặt đó thành `user`.
- **P8. Màn hình "Beads Manager" là surface `launcher.tsx`**, liệt kê **workspace** (`paseo.workspaces.list` với `sort: [{ key: "activity_at", direction: "desc" }]`), mỗi dòng hiện `title` và `projectDisplayName`. "Project" trong lời owner chính là các dòng này.

## 4. Thiết kế

### 4.1 Thứ tự ghim bằng kéo-thả (mục 1)

> **Đã gỡ** (2026-09-18, hieu.nt10, soạn bởi Beads Worker): ghim, kéo-thả và RPC `launcher.order.*` bị gỡ bởi [delta 20260918f](./paseo-bm-delta-20260918f-ui-review.md) §4.5, owner chốt Q11 c và duyệt [prd-delta-20260918f-remove-pinning](../product/paseo-bm-prd-delta-20260918f-remove-pinning.md) (Q14 a). Danh sách Workspaces xếp theo hoạt động gần nhất. File `launcher-order.json` đã có trên máy không bị đọc hay xoá.

**Hành vi.** Nhấn giữ một dòng để nhấc lên, kéo tới chỗ muốn, thả. Dòng vừa thả trở thành **đã ghim** và nằm ở đúng vị trí đó. Danh sách chia hai khối: khối ghim ở trên theo thứ tự owner đặt, khối còn lại ở dưới theo `activity_at desc` như hiện nay. Mỗi dòng đã ghim có một nút bỏ ghim; bỏ ghim thì nó rơi về khối dưới.

**Lưu ở đâu.** Một file JSON trong install home: `<install home>/ui/launcher-order.json`, hình dạng `{ "schemaVersion": 1, "pinned": ["wks_…", "wks_…"] }`. Ghi qua đường đã có của kho vết (`install-home.ts` + bộ kiểm no-follow và mutex ở `trace-store.ts` §3.8), không mở đường ghi mới.

*Vì sao không dùng `useSettings`:* màn hình Settings hiện có đang lỗi — log daemon ngày 2026-09-17 có tám lần `Plugin paseo-bm does not contribute RPC settings.paseo-bm.read`. Chưa rõ nguyên nhân và nó **không thuộc delta này**, nhưng xây thứ tự ghim lên trên một cơ chế đang hỏng là tự chuốc lấy lỗi. Ghi nhận ở §9 để mở bead riêng.

**Workspace lạ.** Id trong `pinned` mà không còn trong danh sách thì bỏ qua khi hiển thị, và dọn khỏi file ở lần ghi kế tiếp. Không bao giờ xoá dòng của owner chỉ vì một lần đọc danh sách bị lỗi.

**Lệch so với bản thiết kế, ghi ngày 2026-09-17 khi làm WP-237.** Spike mà §7 rủi ro 1 yêu cầu **không chạy được**: nó đòi một người thật kéo chuột trên daemon thật, và tác nhân làm việc này không có tay. Cách xử lý là **đường lùi mà chính bead cho phép**: nút ★ (ghim / bỏ ghim) và ▲▼ trên mỗi hàng đã ghim. Đường này còn có một ưu điểm mà cử chỉ kéo không có — dùng được bằng bàn phím và bằng trình đọc màn hình, nên dù sau này có thêm kéo-thả thì nút vẫn nên ở lại.

Cử chỉ kéo **chưa làm**, giữ nguyên trong một bead riêng để không mất: owner thử nút trước, nếu vẫn muốn kéo thì spike chạy được vì lúc đó có người thao tác. Mô hình thứ tự (`plugin/client/pinned-order.ts`) là hàm thuần và đã có test, nên cử chỉ về sau chỉ cần gọi `pinAt`, không phải viết lại gì.

**Kỹ thuật (đã làm, 2026-09-17).** Tay cầm riêng (`⣿`) chỉ hiện trên hàng đã ghim, `onStartShouldSetPanResponder` trả `true` nên nó giành chạm trước `ScrollView`; `scrollEnabled={false}` suốt lúc kéo và trả lại ở **cả hai** lối kết thúc (`Release` và `Terminate`) — thiếu lối thứ hai thì một cử chỉ bị huỷ sẽ khoá cuộn vĩnh viễn. Thả đúng chỗ cũ thì không ghi file. `PanResponder` để bắt cử chỉ, `Animated.Value` cho độ dời của dòng đang kéo, `LayoutAnimation` cho các dòng nhường chỗ. Trên `react-native-web` **`useNativeDriver` phải là `false`**. Danh sách nằm trong `ScrollView`, nên trong lúc kéo phải khoá cuộn (`scrollEnabled={false}`) rồi mở lại khi thả.

### 4.2 Dấu hiệu "đang làm việc" (mục 2)

**Hợp đồng đổi.** `workspaces.overview` thêm một trường, **cộng thêm chứ không thay**:

```
runningWorkers: number        // giữ nguyên, đã có nơi dùng
runningAgents: {              // mới
  manager: number,
  worker: number,
  reviewer: number,
}
```

Máy chủ đếm từ cùng nguồn đang dùng cho `runningWorkers`, mở rộng sang cả ba vai theo nhãn `bm.role` và theo provider trong bản ghi.

**Hiển thị.** Một chấm tròn cạnh tên project, nhấp nháy bằng `Animated.loop` trên `opacity` khi tổng ba số lớn hơn 0; đứng yên và mờ khi bằng 0. Tooltip/nhãn phụ nói rõ đang chạy cái gì, ví dụ "1 Worker, 1 Reviewer".

**Giảm chuyển động.** Nếu hệ điều hành bật giảm chuyển động (`AccessibilityInfo.isReduceMotionEnabled`), hiện chấm **đặc, không nhấp nháy**. Dấu hiệu vẫn còn, chỉ bỏ hoạt ảnh.

### 4.3 Mỗi lượt hỏi là một luồng riêng trên Dashboard (mục 3)

Đây là mục rủi ro nhất vì nó đụng đúng luật vừa sửa sáng nay ở delta 20260917d.

**Luật mới.** Trong một bucket `requestId`, một **đoạn** (segment) mở ra ở mỗi lượt Manager có tin nhắn vào đầu tiên là **lời người dùng thật** — tức bản ghi có `origin === "user"`. Lượt đầu của request là đoạn 1. Danh sách Metric hiện **một dòng cho mỗi đoạn**, nhãn `req-…041929Z · lượt 2`, mỗi dòng có thời điểm, trích đoạn, token và thời lượng của riêng nó; mở ra thì vào cùng một request.

**Vì sao luật này không phá lại lỗi 9 của WP-214.** Báo cáo trạng thái của Worker gửi bằng `send_agent_prompt` có `origin === "agent"`, nên **không bao giờ** mở đoạn mới. Thông báo của chính plugin (`BM-BUDGET`, thông báo dừng) bị `isPluginNotice()` loại từ trước. Đó chính là thứ mà năm 2026-09-16 không phân biệt được bằng câu chữ.

**Bản ghi cũ.** Không có `origin` thì không tách: cả request là một đoạn, y như hiện nay. Không suy diễn sự vắng mặt thành `user`.

**Báo cáo, bead, review thuộc đoạn nào.** Theo thời gian: một `BM-REPORT` thuộc đoạn đang mở lúc nó tới. Số bead suy ra từ báo cáo nên đi theo. Ngân sách review vẫn tính **theo `requestId`**, không theo đoạn — nếu không, người dùng nhắn thêm vài câu là ngân sách được nhân lên, đúng thứ mà bộ đếm sinh ra để chặn.

**Điều delta này KHÔNG làm.** Không đổi `requestId`, không đổi cách Worker báo cáo, không đổi ba file vai trò cho mục này. Đó là lựa chọn của owner ở Q23.

### 4.4 Hai slash command (mục 4)

**`/bm-worker-new <yêu cầu>`** — context `workspace`.

1. Gọi RPC `manager.ensure` cho workspace hiện tại (mở Beads Manager nếu chưa có, đúng như nút trên màn hình).
2. Gửi `args` cho Manager bằng `paseo.agents.ref(managerId).send(args)` — tin nhắn của người dùng thật (P2).
3. Mở chat của Manager.

Manager từ đó làm đúng việc nó vẫn làm: cấp `requestId`, đoán cỡ, tạo Worker, báo cáo. Không có đường tạo Worker thứ hai nào được thêm vào sản phẩm — đúng Q24.

`args` rỗng thì **không gửi gì**: chỉ mở chat Manager và để con trỏ ở ô soạn. Gửi một tin nhắn rỗng cho Manager là ép nó đoán, và Manager thì bị cấm tự đặt yêu cầu.

**`/bm-worker-stop-all`** — context `workspace`.

Vì P4 (plugin không huỷ được agent), lệnh này là **hợp tác chứ không cưỡng chế**, và tài liệu lẫn thông báo cho người dùng phải nói đúng như vậy.

1. RPC máy chủ mới `agents.stop-all`, đầu vào `{ workspaceId }`.
2. Máy chủ liệt kê agent của workspace, lọc lấy **Worker và Reviewer** có `status === "running"`, bỏ qua agent đã lưu trữ hoặc đã đóng (P5).
3. Với mỗi agent đó, `send()` một thông báo dừng cố định, bắt đầu bằng **`BM-STOP`** và được đăng ký trong `notices.ts` để nó không bị ghi thành lời người dùng.
4. Trả về `{ workers: n, reviewers: m, skipped: k }` để client báo lại chính xác.

**Manager không bị đụng tới.** Nó là đầu mối của người dùng; tên lệnh cũng chỉ nói Worker.

**Vai trò phải biết trả lời thông báo này.**

*Bản Draft của delta này viết sai chỗ đó và đã sửa khi bắt tay làm (2026-09-17).* Bản cũ bắt `worker.md` thêm một thủ tục riêng cho `BM-STOP`: "không gọi thêm công cụ, gửi `BM-REPORT` với `phase: blocked`". Đọc lại `worker.md` thì thủ tục ấy **mâu thuẫn với luật dừng đã có** ở hai điểm:

- Luật dừng hiện tại **bắt buộc** bước (1) `cancel_agent` lên mọi Reviewer mà Worker đã tạo. "Không gọi thêm công cụ" xoá mất bước đó, và Reviewer sẽ chạy tiếp — đúng thứ mà `/bm-worker-stop-all` sinh ra để chặn.
- `phase: blocked` được `manager.md` xử lý bằng cách hiện **danh sách câu hỏi** cho người dùng rồi chờ. Một lượt bị dừng không có câu hỏi nào. Luật dừng hiện tại dùng `finished` kèm "dừng ở đâu", và đó mới là thứ Manager trình bày đúng.

**Cách làm đúng:** `BM-STOP` không cần thủ tục riêng, nó chỉ cần **được nhận ra là một lệnh dừng**. Thêm đúng một câu vào `## Stop` của `worker.md`: một tin nhắn bắt đầu bằng `BM-STOP` là của plugin và luôn luôn là lệnh dừng. Ba bước dừng đã có giữ nguyên. Đây là thay đổi **duy nhất** với file vai trò trong delta này, và nó đi đúng hướng owner đã yêu cầu ở delta 20260917b: thêm luật theo lớp, đừng thêm thủ tục theo từng ca.

**Reviewer dùng lại thông báo đã có.** `agents.stop-all` gửi `BM-STOP` cho Worker, và gửi `REVIEWER_STOP_NOTICE` đã tồn tại cho Reviewer — lối dừng đó đã chạy và đã có test, không việc gì phải viết lối thứ hai.

## 5. Hợp đồng đổi

| Hợp đồng | Đổi gì | Tương thích |
|---|---|---|
| `workspaces.overview` | thêm `runningAgents: { manager, worker, reviewer }` | Cộng thêm; `runningWorkers` giữ nguyên |
| `agents.stop-all` | RPC **mới**, `{ workspaceId }` → `{ workers, reviewers, skipped }` | Mới hoàn toàn |
| `launcher.order.get` / `launcher.order.set` | RPC **mới**, đọc/ghi `<install home>/ui/launcher-order.json` | Mới hoàn toàn |
| `ReconstructedTrace` | thêm `segments` và danh sách Metric hiện theo đoạn | Trường mới; bản ghi không có `origin` cho đúng một đoạn |
| `notices.ts` | thêm tiền tố `BM-STOP` | Cộng thêm |
| Lược đồ kho vết | **không đổi** | — |

## 6. Kiểm thử

| Kết quả | Test | Đối chứng âm |
|---|---|---|
| 4.1 | Ghim hai workspace → chúng lên đầu đúng thứ tự, phần còn lại vẫn theo hoạt động; id lạ trong file bị bỏ qua và dọn ở lần ghi sau; file hỏng thì danh sách vẫn hiện, không ghim | Bỏ khối ghim → test thứ tự đỏ |
| 4.2 | `runningAgents` đếm đủ ba vai; chấm nhấp nháy khi tổng > 0, đứng yên khi bằng 0; bật giảm chuyển động → không hoạt ảnh | Chỉ đếm Worker → ca "chỉ Reviewer đang chạy" đỏ |
| 4.3 | Một request, ba lượt Manager: lượt 1 lời người dùng, lượt 2 báo cáo Worker (`origin: agent`), lượt 3 lời người dùng → **hai** đoạn, báo cáo ở lượt 2 thuộc đoạn 1. Bản ghi không có `origin` → một đoạn. Ngân sách review vẫn tính theo request, không theo đoạn. Toàn bộ test của delta 20260917d vẫn xanh | Mở đoạn theo mọi `user_message` → ca báo cáo Worker đỏ (đúng lỗi 9 của WP-214) |
| 4.4 | `/bm-worker-new "x"` → `manager.ensure` được gọi đúng một lần, Manager nhận đúng chữ `x`; args rỗng → **không** gửi gì. `agents.stop-all` chỉ gửi cho Worker/Reviewer đang chạy, bỏ qua agent đã lưu trữ, không đụng Manager, và đếm đúng | Bỏ lọc `running` → ca agent đã lưu trữ đỏ (P5) |
| Vai trò | `worker.md` có lối trả lời `BM-STOP`, pin bằng test nội dung vai trò | Xoá câu đó → test đỏ |

## 7. Rủi ro

1. **Kéo-thả trong `ScrollView` trên web.** Cử chỉ và cuộn tranh nhau. Giảm thiểu bằng nhấn giữ mới nhấc và khoá cuộn lúc kéo; nếu vẫn xung đột thì lùi về nút "lên/xuống" trên mỗi dòng — vẫn đạt mục đích ưu tiên, chỉ kém đẹp. Đây là bead **đầu tiên** và là spike: làm nó trước, nếu hỏng thì các bead sau đổi hình dạng chứ không đổ vỡ.
2. **Tách đoạn làm Dashboard nhiều dòng hơn hẳn.** Một request hỏi đáp qua lại mười lần thành mười dòng. Đó đúng là điều owner muốn, nhưng biểu đồ "request mỗi ngày" sẽ nhảy vọt. Phải quyết: biểu đồ đếm **request** hay đếm **đoạn**. Đề xuất: đếm request, và nói rõ trên nhãn.
3. **Đếm request chứ không đếm đoạn (Q27) làm hai con số trên màn hình lệch nhau**: danh sách có nhiều dòng hơn số mà biểu đồ đếm. Nhãn của biểu đồ phải nói rõ "request", và dòng đoạn phải mang nhãn `· lượt N` để người đọc thấy chúng thuộc cùng một request.
4. **`BM-STOP` là hợp tác.** Một Worker đang kẹt trong một công cụ dài có thể không đọc thông báo ngay. Người dùng phải được nói thẳng điều này, đừng hứa "đã dừng" khi thực chất là "đã yêu cầu dừng".
5. **Màn hình Settings đang lỗi sẵn** (§4.1). Không chặn delta này, nhưng đừng xây thêm gì lên `useSettings` cho tới khi có kết luận.

## 8. Không đổi

Vai trò của Manager và Reviewer; cách Worker cấp và báo cáo `requestId`; ngân sách review và thông báo `BM-BUDGET`; lược đồ kho vết; ADR-005 (agent thuộc về người dùng — không lệnh nào trong delta này lưu trữ hay xoá agent).

## 9. Tài liệu phải cập nhật

- `docs/design/paseo-bm-dashboard.md`: RPC `workspaces.overview`, và §4 thêm luật tách đoạn.
- `docs/design/paseo-bm.md`: hai slash command và RPC `agents.stop-all`.
- `AGENTS.md`: sự thật đã kiểm P1, P2, P3 (renderer Expo + `react-native-web`, có `PanResponder`/`Animated`).
- Bead riêng, **không thuộc delta này**: điều tra lỗi `settings.paseo-bm.read`.

## 10. Câu hỏi đã đóng

Q27 và Q28 từng để ngỏ ở bản Draft; owner chốt cả hai ngày 2026-09-17 theo đề xuất, đã ghi vào bảng §2. Không còn câu hỏi mở nào chặn việc chuyển sang plan.

## 11. Lệch so với bản Accepted, và vì sao

Ghi lại khi đóng delta, để lần sau không ai coi đây là sót.

| # | Lệch | Vì sao |
|---|---|---|
| L1 | **Cử chỉ kéo-thả làm sau, trong bead `bm-wp-237-drag-bxrb`** (đã xong). WP-237 chỉ ship nút ★ và ▲▼ | Spike mà §7 rủi ro 1 yêu cầu cần một người thật kéo chuột; không kiểm được bằng máy. Cách giải quyết cuối cùng **không phải chờ spike mà là bỏ nguyên nhân xung đột**: tay cầm kéo là một vùng riêng chứ không phải cả hàng, nên hệ responder của React Native trao chạm cho tay cầm trước, và `ScrollView` chỉ cuộn từ những chạm không ai giành. Xung đột biến mất theo cấu trúc, không phải theo tinh chỉnh. Nút vẫn ở lại vì kéo không dùng được bằng bàn phím hay trình đọc màn hình |
| L2 | **`BM-STOP` không có thủ tục riêng**, chỉ thêm một câu vào `## Stop` của `worker.md` | Bản Draft bắt Worker "không gọi thêm công cụ" và báo `phase: blocked`. Cả hai mâu thuẫn với luật dừng đã có: câu đầu xoá mất bước bắt buộc `cancel_agent` lên Reviewer, câu sau khiến `manager.md` hiện danh sách câu hỏi cho một lượt dừng vốn không có câu hỏi nào. Chi tiết ở §4.4 |
| L3 | **Kết quả `/bm-worker-stop-all` không báo bằng cách ném lỗi** mà đẩy lên màn hình Beads Manager | Slash command của Paseo 0.8 chỉ hiện chữ khi `onSubmit` ném lỗi, và hiện dưới dạng toast **lỗi**. Báo một việc thành công như thế là tô màu thất bại lên việc đã chạy đúng |
| L4 | Nhãn lượt trên màn hình là **`turn N of M`**, không phải `lượt N` | Mọi chuỗi khác của màn hình đó đang là tiếng Anh (`size ?`, `from you`). §4.3 viết `lượt N` là văn mô tả tiếng Việt, không phải chuỗi giao diện |
| L5 | Errata của `workspaces.overview` nằm ở [delta 20260916-owner-feedback](paseo-bm-delta-20260916-owner-feedback.md), không ở design Dashboard | RPC đó được định nghĩa ở delta ấy; design Dashboard không hề nhắc tới nó. Bead WP-241 viết sai chỗ, đã sửa |

## 12. Ghi nhận, không thuộc delta này

- **Hàng workspace có hai dấu hiệu chồng nhau**: chấm động (ba vai) và con số "N Worker(s) running" cũ từ `workspaceStats` (chỉ Worker). Nên gộp, nhưng đó là quyết định giao diện của owner.
- **Lỗi `settings.paseo-bm.read`** vẫn còn nguyên; đã mở bead riêng.
