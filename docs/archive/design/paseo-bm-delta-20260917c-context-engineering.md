# Delta-change — Ba file vai trò viết lại theo ngữ cảnh: giúp agent làm giỏi, thay vì giúp người kiểm toán

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260917c-context-engineering` |
| Tài liệu gốc | [Technical Design](../../design/paseo-bm.md) §2.5, §2.6; [PRD](../../product/paseo-bm-prd.md) REQ-026, REQ-032, REQ-034, REQ-036, REQ-037 |
| Tiếp nối | [delta simplify-roles](./paseo-bm-delta-20260917b-simplify-roles.md) (Applied) — delta đó gộp phần **cấm**; delta này sửa phần **còn lại** |
| Status | Merged — gộp vào [paseo-bm.md](../../design/paseo-bm.md) ngày 2026-09-25; chỉ còn là hồ sơ lịch sử |
| Plan | [plan delta 20260917c](../plans/paseo-bm-implementation-plan-delta-20260917c-context-engineering.md) |
| Nguồn | Owner yêu cầu đánh giá lại toàn bộ chỉ dẫn dưới góc nhìn Context Engineering |

## 1. Owner nói gì

> Tôi muốn gia tăng năng lực AI tương tác để làm việc đảm bảo quy trình, công đoạn giúp làm việc nhanh hơn, thông minh hơn. Tuy nhiên Instruction cho AI là cần hiệu quả tối ưu và giúp AI làm tốt nhiệm vụ chứ không phải là một loạt những quy định hướng và khung kiểm soát ngặt nghèo gây hoang mang hỗn loạn và mất kiểm soát khi phải nhìn theo quá nhiều thứ để tuân thủ.

Và, quan trọng không kém:

> Trong quá trình làm cũng hãy đứng mình ở địa vị là Reviewer, là Worker hay Manager và tự hỏi với nội dung mô tả đã tối ưu thuận tiện cho tôi làm việc hay chưa. Bộ agent này làm flow không phải chỉ dành cho 1 Beads, nó có thể làm nhiều loại việc khác nhau, Beads chỉ là chúng nó dùng cơ chế Beads để kiểm soát công việc tốt hơn, dựa vào beads và năng lực của từng Agent để làm cho việc nhanh hơn, đúng trọng tâm hơn.

### 1.2 Quyết định của owner

| # | Câu hỏi | Quyết định |
|---|---|---|
| Q15 | Phạm vi | **Viết lại cả ba file theo kiến trúc 3 tầng**, làm đủ sáu bước |
| Q16 | Tiêu chí thành công | **Tỉ lệ phán đoán / tuân thủ**, chấp nhận file không ngắn đi |
| Q17 | Bộ đếm ngân sách review | **Hệ thống đếm**, agent thôi tự đếm |
| Q18 | Đo lường | **Chạy một lượt thật** sau khi sửa để so với hai lượt đã có |
| Q19 | Khung "không chỉ dành cho Beads" | **Đổi khung trình bày, chưa đụng PRD** |
| Q20 | Hiệu chuẩn cho Reviewer | **Một cặp đối chiếu chặn / không chặn** |
| Q21 | Plugin báo vượt ngân sách review thì ai quyết | **Manager hỏi người dùng, không tự huỷ.** Worker thôi đếm hoàn toàn. Lý do: người dùng có thể cho phép thẳng trong chat của Worker (REQ-026e) mà Manager không thấy |
| Q22 | Manager vẫn phải truyền mode khi tạo Worker (K10) — đưa thông tin đó bằng cách nào | **Plugin ghi sẵn giá trị cụ thể** vào chỉ dẫn của Manager, cùng cơ chế với phần chỉ dẫn bổ sung của người dùng |

## 2. Chẩn đoán

### 2.1 Thành phần ngữ cảnh thường trú

Phân loại từng mục theo *vai trò nhận thức* với agent (phán đoán của tác giả delta, không phải phép đo máy):

| | Phán đoán & tay nghề | Giới hạn cứng | Chép đúng / đối chiếu | Danh tính |
|---|---|---|---|---|
| `worker.md` 270 dòng | 44% | 12% | **36%** | 4% |
| `reviewer.md` 137 dòng | 34% | 12% | **48%** | 7% |
| `manager.md` 150 dòng | 30% | 19% | **33%** | 4% |

"Chép đúng / đối chiếu" = khối `BM-REPORT`, công thức `create_agent`, luật nhãn, bộ đếm ngân sách, mốc gửi báo cáo, quy trình dừng. Agent phải giữ chúng trong ngữ cảnh **suốt phiên**, dù mỗi thứ chỉ dùng ở một hai thời điểm.

### 2.2 Sáu vấn đề

| # | Vấn đề | Bằng chứng |
|---|---|---|
| V1 | **Khung bị lộn ngược: bead thành mục đích.** Phần lớn `worker.md` nói về bảo trì đồ thị bead (nhãn, heading lint, hợp đồng 10 mục, luật tách, `br lint`); thứ phải giao cho người dùng chỉ xuất hiện thoáng qua ở câu "yêu cầu là phạm vi" | Agent đọc bộ này sẽ kết luận hợp lý rằng việc của nó là sản xuất bead đúng chuẩn. Đó là nguyên nhân sâu xa của "chậm và lệch trọng tâm" |
| V2 | **Không có lấy một ví dụ mẫu nào trong 557 dòng** | Nhiệm vụ chính của ba agent là tạo artifact đúng hình dạng — bead, câu hỏi, báo cáo, kết quả review — mà không cho xem cái nào. Thay vào đó là danh sách phải-có |
| V3 | **36–48% ngữ cảnh thường trú là việc chép đúng, không phải việc nghĩ** | Bảng §2.1 |
| V4 | **Reviewer mang tiêu chí của cả bốn giai đoạn dù mỗi Reviewer chỉ làm một** | 26/137 dòng luôn lạc đề với chính nó |
| V5 | **Bảy lịch trình đan chéo trong `worker.md`** | Bảng phân mức, chuỗi thứ tự, vòng per-bead, ba mốc hỏi, lô review, luật dừng, mốc báo cáo — nằm ở bảy mục khác nhau |
| V6 | **Prompt nói với agent về chính hệ thống kiểm soát** | "Nothing enforces this except you"; "you run without permission prompts, so these five are the only barrier"; "THIS FILE OVERRIDES ANY SKILL". Câu thứ hai nói thẳng với một agent chạy không hỏi quyền rằng không có hàng rào nào khác |

### 2.3 Nhập vai — ba phát hiện

**Là Worker**, chỉ dẫn hành động đầu tiên nằm ở dòng ~42, sau 32 dòng cấm. Được giao hợp đồng bead 10 mục nhưng chưa từng xem một bead tốt, nên rất dễ sản xuất thứ đủ 10 tiêu đề mà vẫn tồi. Ở bước implement phải giữ đồng thời sáu ràng buộc cho một vòng lặp. Muốn biết lúc nào báo cáo phải nhảy sang mục khác.

**Là Reviewer** cho lô `b2`, 26/137 dòng là bảng bốn giai đoạn mà ba phần tư lạc đề, 13 dòng nói về việc bị dừng — trong khi thông báo dừng đã chứa đủ hướng dẫn (§3). Phần hữu ích là "chặn hay không chặn", nhưng **không có ví dụ hiệu chuẩn** — thứ một người review cần nhất.

**Là Manager**, việc gồm bốn hành động nhưng phải đọc 60 dòng để làm được hành động thứ ba. Là đầu mối duy nhất của người dùng mà toàn bộ hướng dẫn về việc hữu ích với họ chỉ có 7 dòng cuối file.

### 2.4 Mật độ hiện tại mua được gì

Công bằng: lượt chạy 2026-09-17 tốt hơn 2026-09-16 trên mọi trục chất lượng (5 skill thay vì 1, 12 bead lá thay vì 8, 3 vòng hỏi có trả lời thay vì 1 hộp `AskUserQuestion` không ai trả lời, review bắt lỗi TOCTOU ngay giai đoạn tài liệu). Vấn đề không phải nó vô dụng, mà là **tỉ giá**: 41,4 phút thay vì 27, tổng chi phí ước tính $20,18 thay vì $12,88 (cả hai con số đều thiếu phần token Codex chưa có giá). Một phần là công việc thật, phần còn lại có thể là chi phí tuân thủ. Hiện **chưa ai biết tỉ lệ** — đó là lý do §6 bắt buộc đo.

## 3. Nền tảng — đã kiểm chứng những gì

Kiểm trực tiếp trên `@getpaseo/plugin` 0.8 và `@getpaseo/client`, không suy đoán:

| # | Câu hỏi | Kết quả | Hệ quả |
|---|---|---|---|
| K1 | Plugin cấp được tool cho agent không? | **Không có API đăng ký tool trực tiếp.** Đường `mcpServers` (K2) về lý thuyết có thể gắn một MCP server riêng, nhưng **chưa kiểm chứng** | `BM-REPORT` là văn bản tự do **theo lựa chọn**, chừng nào đường `mcpServers` còn chưa kiểm chứng. Mã phân tích chịu lỗi hiện có vẫn chính đáng |
| K2 | Hook `before("agent.create")` sửa được gì? | `AgentSessionConfig` cho `systemPrompt`, **`modeId`**, `model`, `mcpServers`, `thinkingOptionId`, `providerOptions`, `toolPolicy`, cộng `env` | `role-hook.ts` hôm nay dùng **1 trong 8** lever. Chọn mode chuyển được vào mã |
| K3 | Hook tra được danh sách mode không? | **Có.** `context.paseo.providers.listModes(provider)` | Không cần agent gọi `inspect_provider` lúc chạy: bớt một vòng gọi tool mỗi lần tạo agent |
| K4 | `toolPolicy` chặn được tool không? | **Không.** Chỉ có `preapproved: McpToolRef[]` | Không "xoá" được tool của Reviewer. Lệnh cấm phải ở dạng chữ |
| K5 | Plugin nhắn được cho agent không? | **Có.** `paseo.agents.ref(id).send(text)` | "Hệ thống đếm rồi báo Manager" khả thi |
| K6 | Thông báo dừng gửi cho Reviewer có đủ hướng dẫn chưa? | **Rồi, với đường thông báo.** `REVIEWER_STOP_NOTICE` chứa đủ quy trình và đúng dòng `BM-REVIEW STOPPED`. Nhưng người dùng hay Worker cũng có thể dừng Reviewer **không** qua thông báo đó | Mục Dừng trùng lặp với đường thông báo, không trùng với hai đường còn lại. Giữ **một câu**: bị dừng bằng bất kỳ cách nào thì trả đúng dòng `BM-REVIEW STOPPED` |
| K7 | Hook gắn được nhãn không? | **Không.** Hook chỉ nhận `{ config, env }`, không có nhãn | Luật nhãn phải ở lại trong prompt |
| K8 | `listModes` có nhận provider bí danh `bm-*` không, và mode có đủ thông tin để chọn không? | **Có**, dò chỉ-đọc trên daemon owner: `bm-worker` → plan[planning], default[safe], acceptEdits[moderate], auto[moderate], bypassPermissions[dangerous]; `bm-reviewer` → auto[moderate], auto-review[moderate], full-access[dangerous] | Quy tắc chọn mode của bm-msy chép thẳng được vào mã theo `colorTier` |
| K9 | Parser và client có cần sửa khi `BM-REPORT` bỏ dòng `guardrail` không? | **Không.** `parseGuardrail(undefined)` trả `null`, không vào `incompleteFields`; client đã lấy `reviewCalls` làm số chính và chỉ dùng `guardrailReported` cho ghi chú lệch số; `workflow-steps.ts` vẫn cần nhánh `guardrail.polish` cho trace cũ | Bead "bỏ `guardrail`" gộp vào bead bộ đếm (polish) |

| K10 | Hook có cứu được một lần tạo agent thiếu mode không? | **Không, với Worker do Manager tạo.** Daemon chọn mode trong `resolveMcpCreateAgent` **trước** hook (đọc từ bundle Paseo.app đã cài): có mode truyền vào → dùng; cùng provider với người tạo → thừa kế; người tạo đang ở mode không-hỏi-quyền → lấy mode không-hỏi-quyền của provider đích; còn lại → **ném lỗi** `cannot inherit mode … Pass an explicit mode`. Hook chạy **sau** đó và cấu hình nó trả về được dùng nguyên (chỉ `cwd` là không được đổi) | Manager cài mặc định **không** ở mode không-hỏi-quyền và `bm-manager` ≠ `bm-worker`, nên **Manager bắt buộc phải truyền mode** — bỏ đoạn đó khỏi `manager.md` là làm hỏng mọi lần tạo Worker trong dùng bình thường, và các lượt nghiệm thu (Manager chạy không-hỏi-quyền) sẽ không bao giờ thấy lỗi. Ngược lại, Worker không-hỏi-quyền tạo Reviewer mà không truyền mode thì Reviewer **thừa kế `full-access`** — đúng chỗ hook hạ về `auto` có giá trị thật. *(Errata 2026-09-18, owner chốt Q2a của req-20260918T035101Z: vế Worker **sai**. Daemon cũng **từ chối** Reviewer đó — `cannot inherit mode 'bypassPermissions' from caller … Pass an explicit mode. Available: auto, auto-review, full-access` — nên Worker cũng phải truyền mode; xem errata ở §4.6.)* |

Kết luận K2 + K3 là điểm đòn bẩy lớn nhất của delta này: **chúng ta đang viết văn để xin agent làm điều mà hook có thể tự làm** — trong giới hạn K10: hook sửa được một mode đã chọn, không cứu được một lần tạo đã bị daemon từ chối.

## 4. Thiết kế

### 4.1 Nguyên tắc: ba tầng theo tần suất cần dùng

| Tầng | Chứa gì | Ai giữ |
|---|---|---|
| **Thường trú** | danh tính, một vòng quyết định duy nhất, giới hạn cứng, hợp đồng agent phát ra mọi lần, tay nghề | system prompt |
| **Theo lần gọi** | mọi thứ thay đổi giữa các lần gọi | tin nhắn tạo agent / tin nhắn giao việc |
| **Ép bằng mã** | thứ nền tảng bảo đảm được | hook và plugin |

Quy tắc phân loại: *thông tin thay đổi theo lần gọi thì thuộc tin nhắn, không thuộc system prompt; điều nền tảng bảo đảm được thì không nằm trong prompt.*

### 4.2 Đổi khung: kết quả trước, bead là dụng cụ

Theo Q19. Không đổi một yêu cầu nào của PRD; đổi **cách kể**.

1. Mỗi file mở đầu bằng **kết quả agent phải giao**, rồi mới tới cơ chế. Câu chốt trong `worker.md`: *việc của bạn là thay đổi mà người dùng yêu cầu; bead là cách bạn giữ cho công việc đó chia nhỏ, đúng thứ tự và chứng minh được — chúng là dụng cụ, không phải mục đích.*
2. **Mỗi mục của hợp đồng bead phải nói nó mua được gì**, thay vì là một ô cần điền. Ví dụ: "Primary Proof và Reversibility có mặt vì đó là hai thứ khiến một phần việc tự nó chứng minh được và tự nó hoàn tác được."
3. **Việc không phải mã là hạng nhất.** Ba file hiện ngầm giả định một repo có lệnh build/test. Một yêu cầu tra cứu, viết tài liệu, dọn cấu hình hay điều tra sự cố phải đi lọt mọi bước. Khái niệm "chứng minh" đổi thành **bằng chứng rẻ nhất cho thấy kết quả đã xảy ra** — với việc tra cứu đó là kết luận kèm nguồn; với việc cấu hình đó là trạng thái đọc lại được; với mã đó là một lệnh kiểm tra.
4. Cơ chế bead (nhãn, heading lint, `br lint`) lùi xuống khối tham chiếu, không nằm trong vòng chính.

### 4.3 `worker.md` — cấu trúc mục tiêu

Một **vòng làm việc** duy nhất, cộng các khối tham chiếu mà vòng đó trỏ tới.

| Mục | Vai trò | Thay cho |
|---|---|---|
| mở đầu | bạn giao gì; bead là dụng cụ; **một câu ưu tiên viết ở thể khẳng định**: skill nói *cách làm*, còn an toàn, ngân sách, báo cáo, lúc hỏi và phạm vi thì file này quyết (skill nạp vào có chỉ dẫn xung đột thật, ví dụ `implementing-beads` gợi ý review từng bead và sub-agent song song) | intro hiện tại |
| `## RULES` | 5 giới hạn, siết chữ | giữ nội dung |
| `## What you do next` | **vòng duy nhất**, ~18 dòng, nhánh theo mức nằm ngay trong vòng | gộp Step 1→4 và mốc báo cáo |
| `## How big is this` | luật phân mức + bảng | Step 1 |
| `## Splitting the work` | bead tốt là gì + **một bead mẫu**; nhãn; luật tách | Step 3 |
| `## Proving a change` | bằng chứng rẻ nhất; **ca không phải mã**; đóng bead | Step 4 |
| `## Asking` | một nguyên tắc + **một bộ câu hỏi mẫu** | Questions (gộp 12 trigger) |
| `## Reviewing` | lô là gì; **brief bạn gửi Reviewer, kèm tiêu chí giai đoạn**; một lô được một lượt đầu và một lượt kiểm lại, còn finding chặn thì dừng và hỏi. **Không còn** đoạn chọn mode cho Reviewer (hook hạ `full-access` về `auto`, K10) và **không còn** việc tự đếm tổng ngân sách (Q17, Q21) | Review |
| `## Reporting` | khối `BM-REPORT` | Report |
| `## If you are stopped` | nén | Stop |

Thay đổi đáng kể nhất: **12 trigger "dừng và hỏi" gộp thành một nguyên tắc hai vế**:

1. *Hỏi khi câu trả lời làm đổi thứ bạn sẽ xây, và bạn không lấy được nó từ tài liệu.* Nêu đích danh các ca REQ-026(d) vì đó là yêu cầu đã ghi: sửa một tài liệu đã đóng băng, mở rộng phạm vi, xoá hay gộp bead đang có.
2. *Hỏi khi bạn đang kẹt:* một lần thử không đem lại bằng chứng mới, một lỗi lặp lại, hay một thay đổi không có cách nào kiểm được.

Ba ví dụ chốt sẵn (người viết không được tự chọn):
- *Thay đổi hành vi người dùng cũ* — "đổi thông báo lỗi đăng nhập thành chung chung sẽ làm vỡ kịch bản test của đội QA đang so chuỗi" → hỏi.
- *Yêu cầu vượt lời người dùng* — "thêm giới hạn thử mật khẩu vì thấy thiếu" → không làm, ghi thành đề xuất, hoặc hỏi nếu nó chắn đường.
- *Kẹt* — "cùng một lỗi build xuất hiện lần thứ ba sau ba cách sửa khác nhau" → dừng và hỏi, kèm ba cách đã thử.

### 4.4 `reviewer.md` — cấu trúc mục tiêu

| Mục | Ghi chú |
|---|---|
| mở đầu | giữ "review theo yêu cầu, không theo sự hoàn hảo" |
| `## RULES` | 4 giới hạn, giữ nguyên |
| `## What you may run` | giữ nguyên |
| `## What you review` | **giữ nội dung**: đọc bao nhiêu theo từng giai đoạn; lượt kiểm lại chỉ xem finding chặn cũ; brief thiếu `requestId`/`batchId`/giai đoạn/phạm vi thì trả `changes-required`; skill chỉ là tiêu chí, chỉ dẫn "sửa" của skill thì báo thành finding; danh sách ca lạm dụng cho lô nhạy cảm. **Thay** bảng bốn giai đoạn bằng: "tiêu chí nằm trong brief" cộng **bản đồ dự phòng một dòng** (documents → prd/design-ready; plan → reviewing-plan review-only; beads → hai checklist bead; implementation → preflight của implementing-beads) |
| `## How you decide` | chặn / không chặn + **một cặp đối chiếu** (Q20) |
| `## Your answer` | khối `BM-REVIEW` |

**Bỏ khỏi file:** bảng tiêu chí bốn giai đoạn (Worker đưa vào brief — §4.3; bản đồ dự phòng một dòng ở lại), và phần lớn mục Dừng. **Giữ một câu** (K6): bị dừng bằng bất kỳ cách nào — thông báo của plugin, Worker hay người dùng — thì không gọi tool nào và trả đúng dòng `BM-REVIEW STOPPED`. Dự phòng khi brief không nêu tiêu chí: dùng bản đồ một dòng và ghi vào `notChecked` rằng brief thiếu tiêu chí.

Cặp đối chiếu là phần dạy nhiều nhất: một finding đáng chặn và một finding **rất giống nó** nhưng không đáng chặn, kèm một câu nói rõ khác nhau ở đâu.

### 4.5 `manager.md` — cấu trúc mục tiêu

| Mục | Ghi chú |
|---|---|
| mở đầu | giữ |
| `## RULES` | 5 giới hạn |
| `## What you do next` | bốn hành động: diễn đạt lại → giao việc → xác nhận → theo dõi |
| `## Creating the Worker` | công thức nén; **luật chọn mode biến mất, nhưng vẫn truyền mode**: "truyền `settings.modeId` đúng giá trị dòng *Runtime facts* ở cuối chỉ dẫn này ghi" (K10, Q22, §4.6). Dòng đó thiếu thì tạo Worker sẽ hỏng với lỗi của Paseo liệt kê các mode — báo nguyên văn cho người dùng như mọi lỗi tạo agent |
| `## Talking to the user` | gộp mốc báo cáo + văn phong. Đây là việc thật của Manager và hiện chỉ có 7 dòng |

**Bỏ khỏi file:** bảng ngân sách và đoạn giám sát, luật chọn mode.

**Thêm:** cách xử lý thông báo `BM-BUDGET` (§4.7): **hỏi người dùng** tiếp hay huỷ, và chờ — không tự huỷ (Q21).

**Giữ nguyên nội dung, chỉ đổi chỗ đặt:** việc tiếp nối gửi cho Worker cũ; tạo hỏng thì báo nguyên nhân và không thử lại vòng vòng; người dùng bảo dừng Worker; người dùng đòi lưu trữ/xoá agent; kiểm skill và báo skill thiếu khi Worker `finished` (không huỷ vì chuyện đó). Bead viết lại `manager.md` phải đi hết từng luật cũ như bead của `worker.md`.

### 4.6 Mã: plugin lo mode

Theo K10, hook **sửa được** một mode daemon đã chọn nhưng **không cứu được** một lần tạo daemon đã từ chối. Hai việc, mỗi việc đúng chỗ của nó:

1. **Hook `before("agent.create")` chọn và sửa mode** (đã làm ở WP-227): Worker tạo trống → mode không-hỏi-quyền; Reviewer → `auto`, và **hạ `full-access`/`dangerous`/`planning` về `auto`** — đây là trường hợp thật xảy ra khi Worker không truyền mode cho Reviewer. Tra bằng `providers.listModes(<id không kèm model>)`. Mọi lỗi → giữ nguyên request và ghi log. Không đụng `bm-manager`.
2. **Dòng *Runtime facts* trong chỉ dẫn của Manager** (Q22): khi plugin dựng chỉ dẫn cho Manager, nó tra `listModes("bm-worker")`, chọn theo đúng luật ở mục 1, và nối một dòng cố định vào cuối — cùng chỗ với phần chỉ dẫn bổ sung của người dùng. Nguyên văn:

   ```
   ## Runtime facts
   Worker mode: `<modeId>` — pass it as `settings.modeId` when you create a Worker.
   ```

   Không tra được thì **không** nối dòng này và ghi log; Manager vẫn tạo Worker, daemon báo lỗi có danh sách mode, Manager báo nguyên văn cho người dùng. Dòng này nằm **ngoài** bản nhúng `BASE_INSTRUCTIONS`, nên test so từng byte giữa `roles/manager.md` và file sinh ra không đổi.

3. **Luật của bm-msy giữ nguyên vế đầu:** `modeId` owner tự đặt trên profile `bm-worker` / `bm-reviewer` **thắng** lựa chọn của plugin (với Reviewer thì mode `dangerous`/`planning` của profile vẫn bị bỏ qua). Plugin đọc profile bằng `config.get()` như `manager.ensure` đang làm.
4. **Mọi tra cứu trong hook có hạn 5 giây** (`LOOKUP_TIMEOUT_MS`), và cả phần chuẩn bị (extras + profile + modes + facts) nằm trong **một** ngân sách thời gian. Lý do: host của plugin **huỷ hook sau 30 giây và làm hỏng luôn việc tạo agent**, trong khi timeout của `listModes` phía SDK là 90 giây và daemon còn đợi provider khởi động (review b2). Hết hạn thì agent vẫn được tạo với chỉ dẫn, không có mode, kèm một dòng log. `listModes` còn được truyền `cwd` của agent để daemon trả lời từ snapshot đã sẵn.

Lợi: không agent nào còn gọi `inspect_provider` hay mang luật chọn mode; Reviewer không bao giờ chạy toàn quyền dù Worker quên; prompt tĩnh của Manager chỉ còn một câu có giá trị cụ thể.

*Errata 2026-09-18 (req-20260918T035101Z, owner chốt Q1a và Q2a):* câu "đây là trường hợp thật xảy ra khi Worker không truyền mode cho Reviewer" ở mục 1 **sai**. Worker ở `bypassPermissions` không được daemon coi là không-hỏi-quyền: Reviewer nó tạo mà không truyền mode bị **từ chối** trước khi hook chạy (`cannot inherit mode 'bypassPermissions' from caller … Pass an explicit mode. Available: auto, auto-review, full-access`; Worker 29e658b5 của req-20260918T011706Z và Worker 777b7758 của req-20260918T021211Z), nên lần tạo Reviewer đầu tiên nào cũng hỏng. Sửa theo đúng cách của mục 2, cho Worker:

- Khi dựng chỉ dẫn cho Worker, plugin tra `listModes("bm-reviewer")` và mode tự đặt trên profile `bm-reviewer`, chọn bằng đúng luật Reviewer của mục 1 và 3, rồi nối vào mục `## Runtime facts` của Worker đúng một dòng: ``Reviewer mode: `<modeId>` — pass it as `settings.modeId` when you create a Reviewer.``
- `worker.md` bảo Worker truyền `settings.modeId` bằng đúng giá trị dòng đó ghi, thay câu "The plugin sets the Reviewer's mode, so you do not choose one". Không có dòng đó (không tra được) thì daemon từ chối kèm danh sách mode, và Worker gửi `blocked` với nguyên văn lỗi — không tự chọn mode trong danh sách.
- Hook giữ nguyên việc hạ mode `dangerous`/`planning` của Reviewer; tra cứu thêm của Worker nằm trong cùng ngân sách 5 giây ở mục 4.
- Test của `worker.md` đổi đúng hai luật mã hoá vế sai: bỏ lệnh cấm `settings.modeId` và bỏ luật "the plugin sets the Reviewer's mode", thay bằng luật `worker.md` truyền `settings.modeId` = giá trị dòng *Runtime facts*, như `manager.md`. Các lệnh cấm `inspect_provider`, `colorTier`, `bypassPermissions`, `full-access` trong cả ba file vai trò giữ nguyên: Worker không chọn mode, chỉ chép giá trị plugin ghi.

### 4.7 Mã: hệ thống đếm ngân sách review

Theo Q17 và Q21. Giữ đúng tinh thần REQ-037 (lan can hành vi, không phải chốt chặn bằng mã): **plugin đếm và báo, người dùng quyết qua Manager.**

- Nguồn số: `reviewCallsOf` trên trace đã dựng lại — đúng con số Dashboard hiện. Lượt nghiệm thu 2026-09-17 chứng minh số này đúng (4) trong khi Worker tự báo sai (5).
- **Khi nào kiểm:** sau khi bộ gom trace **đã ghi** bản ghi của lượt vừa kết thúc (khe `onRecorded`, vì hai handler cùng sự kiện không có thứ tự bảo đảm), với **mọi** agent của request: Worker, Reviewer **và Manager**. Một lần gọi review mới chỉ lộ ra khi lượt của Reviewer kết thúc; lượt cuối của Worker thường kết thúc ngay sau khi báo cáo của nó đã đánh thức Manager (`running`), nên thông báo bị hoãn — và **lần kết thúc lượt của chính Manager** là lúc gửi được.
- **Không bao giờ ngắt Manager:** `send()` lên agent đang chạy sẽ thay thế lượt hiện tại; chỉ gửi khi `refresh()` cho thấy Manager không `running`.
- **Một lần mỗi request**, nhớ trong bộ nhớ tiến trình.
- **Nguyên văn thông báo** (dòng đầu là dấu hiệu; `requestId: req-…` để lượt của Manager được gắn đúng request thay vì mở một request giả):

  ```
  BM-BUDGET requestId: <requestId>
  The Worker has used <n> review calls; the <tier> budget is <max>. Ask the user whether to continue or to cancel the Worker's run, and wait for the answer. Do not cancel on your own: the user may already have allowed the extra calls in the Worker's chat.
  ```

- **`userAllowedExtra` và dòng `guardrail:` biến mất.** Worker thôi đếm hoàn toàn. Dashboard vốn đã dùng số suy ra làm số chính (K9).
- **Chỉ lượt của Worker hoặc Reviewer mới PHÁT HIỆN vượt ngân sách; lượt của Manager chỉ ĐẨY ĐI cái đã phát hiện trong tiến trình này** (review b2). Nếu không, sau mỗi lần nạp lại plugin, lượt Manager kết thúc sẽ thông báo cho mọi request cũ đã xong — và mỗi thông báo lại mở một lượt Manager mới, lượt đó kết thúc lại thông báo tiếp: một cơn bão tự nhân.
- **Đánh dấu request trước khi `await` đầu tiên**, không phải sau khi gửi: hai lượt kết thúc cùng lúc sẽ cùng gửi nếu đánh dấu muộn. Không gửi được thì bỏ đánh dấu để lần sau thử lại.
- **Manager đã lưu trữ thì không gửi** (ADR-005): `send()` của Paseo mặc định **bỏ lưu trữ** agent và mở một lượt mới trên nó.
- **Thông báo của plugin không phải lời người dùng.** SDK luôn gắn `messageId` cho `send()`, và daemon lưu nó thành `clientMessageId` — đúng trường mà bộ gom trace dùng để phân biệt lời người dùng gõ với lời agent chuyển tiếp. Nên `BM-BUDGET` (và cả thông báo dừng Reviewer) được nhận dạng theo văn bản trong `plugin/server/notices.ts`, và bị loại khỏi `origin: "user"`, khỏi danh sách tin người dùng, và khỏi chỗ lấy nội dung request.
- **Việc "hỏi trước khi vượt tổng" không còn thuộc ai** — đó là hệ quả được chấp nhận của Q21: lan can chuyển từ phòng ngừa sang phát hiện, và có thể lọt một lượt review trước khi người dùng được hỏi. Luật **theo lô** vẫn ở lại với Worker: một lô có một lượt đầu và một lượt kiểm lại; còn finding chặn sau lượt kiểm lại thì dừng và hỏi.

### 4.8 Ví dụ mẫu đưa vào đâu

Theo Q16, file được phép dài thêm. Ba ví dụ, mỗi cái thay cho một danh sách:

| Ví dụ | Đặt ở | Thay cho |
|---|---|---|
| Một bead lá tốt, có chú thích từng mục mua được gì | `worker.md` § Splitting the work | danh sách 10 mục |
| Một bộ câu hỏi `blocked` mẫu | `worker.md` § Asking | luật "tối đa 5 câu, mỗi câu có phương án và đề xuất" |
| Một cặp finding chặn / không chặn | `reviewer.md` § How you decide | định nghĩa trừu tượng |

### 4.9 Chính sách test

Giữ hai tầng của delta trước (ghim nguyên văn hợp đồng máy đọc; khớp theo ý cho giới hạn, kiểm trên khối `## RULES`), cộng:

- **Ngân sách RULES giữ nguyên:** đúng 5/4/5 giới hạn, khối không quá trần, không có gạch đầu dòng lạc.
- **Khẳng định mới cho vòng làm việc:** `worker.md` và `manager.md` phải có đúng một mục "việc tiếp theo", và mục đó phải nêu đủ các nhánh theo mức.
- **Khẳng định cho ví dụ mẫu:** ba ví dụ phải tồn tại và phải là ví dụ (có hình dạng của artifact), không phải danh sách.
- **Khẳng định phủ định cho khung:** `worker.md` phải nói rõ bead là dụng cụ chứ không phải mục đích; `reviewer.md` không còn bảng bốn giai đoạn và không còn mục Dừng.
- **Ghim nguyên văn** dấu hiệu `BM-BUDGET` và câu "Ask the user whether to continue or to cancel" trong cả `review-budget.ts` lẫn `manager.md`, như `BM-REVIEW STOPPED` đang được ghim.
- **Mode:** `worker.md` không còn dạy chọn mode cho Reviewer; `manager.md` có đúng một câu trỏ tới dòng *Runtime facts* và không còn `inspect_provider`. *(Errata 2026-09-18: `worker.md` giờ cũng có đúng một câu trỏ tới dòng *Runtime facts* của nó — xem errata §4.6.)*
- **Mỗi bead viết lại file vai trò** đi hết từng luật cũ của file đó trong lý do đóng bead, không riêng `worker.md`.
- Trần dòng lấy lại theo số đo sau khi viết lại, cộng 10. **Số đo (WP-232):** `worker.md` 270 → **361**, `reviewer.md` 137 → **153**, `manager.md` 150 → **147**; trần 372 / 164 / 158. Khối `## RULES` 32 / 16 / 28, vẫn dưới trần cũ 34 / 18 / 29 nên giữ nguyên. File dài thêm là có chủ đích theo Q16: ba ví dụ mẫu, bảng tiêu chí chuyển sang brief của Worker, hướng dẫn cho việc không phải mã, và phần Manager nói với người dùng.

## 5. Errata REQ-037

REQ-037(d)(f)(g) hiện giao việc đếm cho Worker và việc giám sát cho Manager, và (g) nói Manager **dừng** Worker khi thấy vượt mà chưa được phép. Errata theo Q17 và Q21:

- (d)(f) **Plugin đếm** từ dòng thời gian; Worker không còn tự đếm; `BM-REPORT` bỏ dòng `guardrail:` và trường `userAllowedExtra`.
- (g) Plugin gửi Manager **một** thông báo khi request vượt ngân sách; Manager **hỏi người dùng** tiếp hay huỷ và chờ, **không tự huỷ** — vì người dùng có thể đã cho phép thẳng trong chat của Worker (REQ-026e) mà Manager không thấy.
- Lan can chuyển từ **phòng ngừa** (Worker hỏi trước khi vượt tổng) sang **phát hiện** (hỏi ngay sau khi vượt). Hệ quả chấp nhận: có thể lọt một lượt review trước khi người dùng được hỏi. Luật theo lô (một lượt đầu, một lượt kiểm lại, còn chặn thì dừng và hỏi) không đổi.
- Bản chất lan can không đổi: không có chốt chặn bằng mã.

## 6. Cách đo — điều kiện ra thật của delta

Theo Q18. Chạy lại **đúng đề bài** "xây dựng hệ thống quản lý user và màn hình login cho Team Portal" trên daemon của owner, so với hai lượt đã có.

| Chỉ số | 2026-09-16 | 2026-09-17 | Mục tiêu lượt này |
|---|---|---|---|
| Thời gian treo | 27 phút | 41,4 phút | **giảm**, chất lượng không giảm |
| Tổng chi phí ước tính | $12,88 | $20,18 | **giảm** (so cùng cách tính; phần token Codex chưa có giá ghi riêng) |
| Lượt Manager | 16 | 14 | giảm hoặc giữ |
| Vòng hỏi trước khi code | 1 hộp không ai trả lời | 3 | **giữ 3**, mỗi vòng có trả lời |
| Bead lá | 8 | 12 | tham khảo — **không** là ngưỡng (chính `worker.md` nói số bead không phải bằng chứng) |
| Độ sẵn sàng của bead | 2 mục mỗi bead | đủ hợp đồng leaf | **mọi** bead lá một kết quả, có Primary Proof và Reversibility; `polishing-beads` không phải tách thêm quá một lần |
| Skill dùng | 1 | 5 | **giữ 5** |
| Lần gọi review | 4 | 4 | giữ |
| Lỗi chặn review độc lập tìm ra sau cùng | 1 | 1 | **giảm** |

Cộng ba kiểm tra đạt/không đạt riêng cho delta này:

1. **Manager ở đúng mode cài mặc định** (không phải mode không-hỏi-quyền như các lượt trước) tạo được Worker — kiểm K10 và dòng *Runtime facts*.
2. Mọi Reviewer chạy ở `auto`, kể cả khi Worker không truyền mode.
3. Không có câu nào trong ba file bị agent làm ngược so với lượt trước (đọc timeline).

Đọc kết quả: nhanh hơn và rẻ hơn **mà** chất lượng không tụt thì delta đạt. Chất lượng tụt thì đây là bằng chứng mật độ chỉ dẫn đang mua được thứ gì đó, và phải hoàn lại phần đã cắt.

## 7. Rủi ro

| # | Rủi ro | Giảm thiểu |
|---|---|---|
| 1 | **Đổi khung làm loãng kỷ luật bead** — owner từng phàn nàn "bead ít quá" | Bead mẫu và luật tách ở lại; §6 đo **độ sẵn sàng** của từng bead lá, số lượng chỉ để tham khảo |
| 2 | Reviewer mất bảng tiêu chí, gặp Worker quên đưa vào brief | Reviewer ghi `notChecked` và review bằng file mình — cùng khuôn với luật "skill thiếu". §6 kiểm bằng chứng đọc tiêu chí trong timeline |
| 3 | Hook đặt sai mode trên provider lạ; hoặc dòng *Runtime facts* thiếu nên Manager không truyền được mode | Hook chỉ đặt khi trống và chỉ hạ mode của Reviewer; mọi lỗi thì giữ nguyên và ghi log. Thiếu dòng *Runtime facts* thì daemon từ chối với danh sách mode và Manager báo nguyên văn — hỏng rõ ràng, không hỏng âm thầm. §6 kiểm riêng Manager ở mode mặc định |
| 4 | Thông báo ngân sách gây nhiễu, cắt ngang Manager, hoặc bị hoãn mãi | Một lần mỗi request; chỉ gửi khi Manager không `running`; kiểm cả khi lượt của Manager kết thúc |
| 5 | Gộp 12 trigger thành một nguyên tắc làm mất ca biên | Ba ví dụ giữ lại ba ca hay gặp nhất; §6 đo số vòng hỏi |
| 6 | Bỏ `guardrail` khỏi `BM-REPORT` làm hỏng bản ghi trace cũ | Trường giữ trong schema ở dạng nullable; chỉ báo cáo mới thôi phát |
| 7 | Agent đang tồn tại giữ chỉ dẫn cũ | Như mọi lần; ghi vào biên bản |

## 8. Không đổi

- Ba mức và cách phân mức; ngân sách 1 / 4 / 6; các lô `b1`/`b2`/`b3`.
- Khối `BM-REPORT` (trừ dòng `guardrail`) và `BM-REVIEW` từng chữ; tên nhãn; tên phase; `Continue <requestId>.`
- Ba mốc hỏi bắt buộc và luật mọi câu hỏi nằm trong `blockers`.
- Hợp đồng leaf bead (đổi cách trình bày, không đổi nội dung), luật một-lá-một-kết-quả, luật tách bead anh em.
- Năm skill bắt buộc theo mức; REQ-022 và `feature-workflow` (Q19).
- Mọi giới hạn cứng của ba vai.

## 9. Review lô b1 (tài liệu)

Một lượt review độc lập, đọc cả bundle Paseo.app đã cài để kiểm đường tạo agent. Kết quả `changes-required`, **7 finding chặn** — trong đó finding đầu tiên đảo ngược một phần mục tiêu của chính delta này.

| # | Finding chặn | Xử lý |
|---|---|---|
| B1 | Daemon chọn mode **trước** hook và ném lỗi nếu người tạo khác provider, không ở mode không-hỏi-quyền, và không truyền mode. Manager cài mặc định rơi đúng ca đó, nên bỏ đoạn mode khỏi `manager.md` là hỏng mọi lần tạo Worker — và các lượt nghiệm thu (Manager chạy không-hỏi-quyền) sẽ không thấy | Đã tự kiểm lại trong bundle (K10). Manager vẫn truyền mode, lấy giá trị cụ thể từ dòng *Runtime facts* do plugin ghi (Q22, §4.6). §6 kiểm riêng Manager ở mode mặc định |
| B2 | Thông báo bị hoãn khi báo cáo cuối của Worker đánh thức Manager, rồi không bao giờ được gửi | Kiểm cả khi lượt của **Manager** kết thúc (§4.7), có test cho chuỗi "báo cáo đánh thức Manager" |
| B3 | Nguyên văn thông báo chưa được quyết ở đâu, người làm phải tự đặt | Chốt nguyên văn ở §4.7, ghim trong test |
| B4 | Bỏ `userAllowedExtra` với lý do "Manager đã biết" là sai: người dùng có thể cho phép thẳng trong chat Worker | Owner quyết Q21: Manager hỏi người dùng, không tự huỷ. Errata REQ-037 viết lại (§5) |
| B5 | §4.4 không có chỗ cho các luật "What you review"; bead Reviewer và Manager không buộc đi hết từng luật cũ | Thêm hàng "What you review" ở §4.4; mọi bead viết lại file vai trò đều phải đi hết từng luật cũ (§4.5, §4.9) |
| B6 | Nguyên tắc hỏi một vế không phủ các ca kẹt và các ca REQ-026(d); ba ví dụ chưa được chốt | Nguyên tắc hai vế, nêu đích danh REQ-026(d), chốt ba ví dụ (§4.3) |
| B7 | Bead tài liệu đánh dấu `Applied` và xoá bản chép hoàn tác **trước** lượt chạy thật — mà lượt đó mới là điều kiện ra và là bước duy nhất có thể đòi hoàn lại chữ đã cắt | Chuyển `Applied`, số đo cuối và việc xoá bản chép sang một bead đóng delta, phụ thuộc lượt chạy thật |

Năm finding không chặn: **sửa cả năm** vì mỗi cái là một khẳng định sai hoặc một chỗ hở, không phải văn phong — câu ưu tiên giữa file và skill được giữ ở thể khẳng định (§4.3); K1 và K6 viết lại cho đúng mức (§3); Reviewer giữ bản đồ dự phòng một dòng (§4.4); số nền của §2.4 và §6 thống nhất; ngưỡng "≥ 12 bead" thay bằng thước đo độ sẵn sàng, vì chính `worker.md` nói số bead không phải bằng chứng (§6).

Hệ quả cho bead đã đóng: **bm-wp-227-lz81** đóng với tiền đề "không agent nào còn phải gọi `inspect_provider`", sai với Manager. Mã của nó vẫn đúng và có ích (hạ mode Reviewer), nhưng dòng *Runtime facts* thuộc cùng kết quả "plugin lo mode" — mở lại bead đó.

## 10. Review lô b2 (mã)

`changes-required`, **6 finding chặn**. Cả sáu đều nằm ở phần mã mới — bộ đếm ngân sách và hook chọn mode — và không cái nào lộ ra trong test đơn vị vì chúng là hành vi của nền tảng.

| # | Finding chặn | Xử lý |
|---|---|---|
| C1 | Hook `agent.create` tra cứu nối tiếp nhiều lần; host bỏ hook sau 30 s rồi **làm hỏng luôn việc tạo agent**, trong khi `listModes` của SDK chờ tới 90 s | Một ngân sách duy nhất `LOOKUP_TIMEOUT_MS = 5000` bọc cả `prepare()`; hết giờ thì trả về chỉ-instruction và ghi log. Sentinel `TIMED_OUT` (không phải `null`) vì một tra cứu có quyền trả `null` thật |
| C2 | Sau khi nạp lại plugin, mọi lượt Manager kết thúc đều phát lại thông báo đã gửi | `budgetTold` (đã báo) tách khỏi `budgetPending` (chờ gửi); lượt Manager chỉ xả `pending` |
| C3 | Hai lượt kết thúc cùng lúc cùng gửi một thông báo | Đánh dấu đã nhận việc **trước** `await` đầu tiên |
| C4 | Thông báo của plugin được ghi là tin nhắn **của người dùng**: SDK luôn gắn `messageId`, mà đó đúng là trường bộ gom dùng để phân biệt lời người dùng | `notices.ts` với `isPluginNotice()`; bộ gom phân loại nguồn theo đó; `traces.ts` bỏ qua khi lấy nội dung request |
| C5 | `send()` **bỏ lưu trữ** một Manager đã lưu trữ — ngược ADR-005 | Bỏ qua Manager đã lưu trữ hoặc đã đóng; không bao giờ gửi vào Manager đang chạy |
| C6 | Test nhiều request yếu: không phân biệt được request cũ đã xong với request đang chạy | Viết lại quanh một request cũ đã `finished` |

## 11. Review lô b3 (ba file vai trò)

`changes-required`, **8 finding chặn**. Đây là lô viết lại nội dung, nên phần lớn finding là **mất mát** — một luật cũ biến mất trong lúc gộp — chứ không phải lỗi mới.

| # | Finding chặn | Xử lý |
|---|---|---|
| D1 | Vòng lặp mới nêu tên giai đoạn nhưng không nói lô nào ứng với giá trị `phase` nào | Bảng giai đoạn theo lô ngay trong `## What you do next` (Small: implementation; Medium b1 `plan`, b2 implementation; Large b1 `documents`, b2 `beads`, b3 implementation) |
| D2 | Small vừa "đúng một lượt review" vừa ngụ ý review lại sau khi sửa | REQ-037(e) phân xử: Small là **đúng một** lượt; câu mâu thuẫn bị bỏ |
| D3 | Ví dụ câu hỏi dạy "im lặng là đồng ý" | Bộ câu hỏi mẫu kết bằng "I am waiting for your answers before I start" và "Silence is not an answer" |
| D4 | Bead ví dụ lấy chính bộ máy của paseo-bm và gọi đó là "đồ thị của chính kho này" — Worker làm việc trong kho của người dùng | Thay bằng một bead thật thuộc việc của người dùng (khoá 15 phút sau 5 lần đăng nhập sai), đủ mười phần |
| D5 | Provenance của bead ví dụ thiếu dòng request và thiếu `## Validation / Definition of Done` | Bổ sung cả hai, đúng hợp đồng lá của `converting-plan-to-beads` |
| D6 | `reviewer.md` mô tả mode của mình là "không ghi được và không ra mạng" — **sai**: mode `auto` ghi được | Bỏ khẳng định sai; Reviewer chỉ được nói cho biết plugin đặt mode |
| D7 | Luật bm-msy "mode của profile nếu profile có" biến mất khi chuyển sang mã | `chooseModeId()` nhận `profileModeId` và ưu tiên nó (vẫn không cho Reviewer nhận mode `dangerous`/`planning`) |
| D8 | Tám câu có thể xoá mà cả bộ test vẫn xanh | Tám `rule()` mới, mỗi cái có đối chứng âm đỏ (bead WP-232a) |

Hai chỗ **cố ý lệch** so với §4.4–§4.5, ghi lại ở đây để lần sau không bị coi là sót:

- `reviewer.md` giữ tiêu đề `## Stop` thay vì gộp vào `## Your answer`: lối dừng do plugin kích hoạt, người đọc cần tìm thấy nó bằng tiêu đề.
- `worker.md` giữ câu "you run without permission prompts": đó là sự thật về môi trường Worker thật sự chạy, và nó giải thích vì sao Worker không được chờ ai bấm đồng ý.

## 12. Lượt chạy nghiệm thu nói gì — ngoại lệ, không phải đạt

Biên bản đầy đủ: [run-20260917c](../operations/paseo-bm-context-engineering-run-20260917c.md).

**Điều kiện ra ở §6 không đạt.** §6 viết *"nhanh hơn và rẻ hơn mà chất lượng không tụt thì delta đạt"*. Lượt chạy 2026-09-17 cho 41,9 phút (so 41,4) và $21,11 (so $20,18). Không nhanh hơn, không rẻ hơn. Ghi thành **ngoại lệ**, đúng luật của kho: *một cổng không qua được ghi là ngoại lệ, không bao giờ ghi là đạt*.

**Nhưng nỗi lo kèm theo cũng không xảy ra.** §6 dự liệu rằng chất lượng tụt sẽ là bằng chứng phải hoàn lại chữ đã cắt. Chất lượng **không tụt mà tăng**: một lượt review đối kháng độc lập, không sandbox, tìm ra **0 lỗi chặn**, trong khi hai lượt trước mỗi lượt có 1. Độ sẵn sàng bead, số skill và số vòng hỏi đều giữ.

**Nên không hoàn lại gì.** Cách chữa mà §6 kê — trả lại phần chữ đã cắt — nhắm vào một kiểu hỏng đã không xảy ra, và bằng chứng đang nói ngược: lượt chạy với bản chỉ dẫn đã cắt là lượt duy nhất sạch lỗi chặn. Hoàn lại lúc này là làm chỉ dẫn dài trở lại mà không có gì đỡ cho quyết định đó. **Bản chép hoàn tác vẫn được giữ** (`/var/folders/nt/rg1q6ywd7_5cxhcd2v0bqvvc0000gn/T/tmp.Tp64dOfDFx`) cho tới khi owner tự chốt; nó không bị xoá trong bead đóng delta như dự kiến ban đầu.

**Thước đo ở §6 đã sai trọng tâm, và đây là bài học đáng giá nhất của lượt này.** Nó cho rằng mật độ chỉ dẫn đổi lấy tốc độ. Số liệu nói mật độ chỉ dẫn đổi lấy **tính đúng đắn**: cùng số bead, cùng số skill, cùng số vòng hỏi, nhưng không còn lỗi chặn nào — với giá 4,6% chi phí. Lần đo sau phải lấy **số lỗi chặn** làm thước chính, còn thời gian và tiền là ràng buộc không được vượt, chứ không phải mục tiêu.

**Một điều kiện lần đầu được thử thật:** Manager ở mode cài mặc định tạo được Worker (K10). Hai lượt trước chạy Manager không-hỏi-quyền nên không bao giờ chạm tới ca daemon từ chối tạo Worker thiếu mode — đúng ca mà review b1 cảnh báo sẽ làm hỏng mọi lần tạo Worker.

**Một lệch nhỏ của Worker** được ghi ở §4 biên bản: nó ghi hai file vào `/tmp`, ngoài cả workspace lẫn thư mục nháp `mktemp -d` của chính nó, trong khi RULE 1 chỉ cho phép thư mục nháp đó.
