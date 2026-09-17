# Delta-change — Tám luật đọc lại trace, sửa sau khi nghiệm thu trên daemon thật

| Trường | Giá trị |
|---|---|
| Mã | `design-delta-20260916-acceptance-fixes` |
| Tài liệu gốc | [Technical Design Dashboard](paseo-bm-dashboard.md) (Active) §6, §7.3, §8, §9 — **không sửa tại chỗ** |
| Status | **Accepted, Applied** |
| Accepted | 2026-09-16 — phát sinh từ chính đợt nghiệm thu mà owner đã duyệt ("Nghiệm thu đầy đủ D-1→D-11") |
| Applied | 2026-09-16 — áp dụng vào `plugin/server/{traces,collector,workflow-steps}.ts` kèm test hồi quy dùng dữ liệu thật |
| Owner | hieu.nt10 |
| Created | 2026-09-16 |
| Nguồn | [Biên bản nghiệm thu](../operations/paseo-bm-dashboard-run-20260916.md) · bead `bm-wp-214-jvg.2` |
| Quyết định của owner bị delta này chạm | **Q-035** (hiện token và chi phí tạm tính theo model) — phần "provider báo thì lấy số của provider" không thực hiện được, xem vị trí 3 |

Ghi chú quy ước: delta này **không thêm phạm vi**. Nó sửa các **luật suy luận** đã ghi trong design mà dữ liệu thật chứng minh là sai. Theo `PROCESS.md`, sửa một luật đã được ghi nhận là delta chứ không phải errata, vì nó đổi hành vi quan sát được của sản phẩm.

## 1. Vì sao có delta này

Đợt nghiệm thu WP-214 chạy trên daemon thật, với agent thật, trên hai workspace: repo nháp `/tmp/bm-acc-20260916/repo` và **workspace thật của chính owner**. Mười bốn lỗi bị phát hiện; năm lỗi đầu đã sửa và ghi trong biên bản §2–§3. Tám lỗi còn lại (số 6 → 12 và 14) chạm vào các luật của design, nên cần delta.

Điểm chung của cả tám: **không lỗi nào bị unit test bắt**, vì cả tám chỉ xuất hiện khi văn bản do agent thật viết, hoặc hình dạng dữ liệu daemon thật trả về, đi qua thuật toán đọc lại. Đây là lý do đợt nghiệm thu tồn tại.

## 2. Tám vị trí

Số dòng tính theo trạng thái làm việc ngày 2026-09-16.

| # | Design, vị trí | Hiện tại | Đổi thành | Bằng chứng thật |
|---|---|---|---|---|
| 1 | §6, mở một trace | Một trace mở ra từ lượt Manager **có tin nhắn người dùng** | Mở ra từ lượt Manager có tin nhắn người dùng **hoặc** có `requestId` đọc được. Không có text thì `requestText = null` và dòng đó **nói rõ là chưa ghi được** | Trên workspace của owner, 11 bản ghi chứa **hai** `requestId` rõ ràng nhưng ra **0 dòng**: plugin bắt đầu thu khi nó được nạp, nên mọi lượt Manager ở đó chỉ còn `BM-REPORT` của chính nó. Kho vẫn đếm 4 trace → màn hình tự mâu thuẫn |
| 2 | §6, một request một dòng | Mỗi lượt Manager thoả điều kiện mở một bucket | Bucket **khoá theo `requestId`**; N lượt của cùng một request gộp vào một dòng | Không sửa thì mỗi `BM-REPORT` của Manager mở thêm một dòng (F-1 có 8 lượt như vậy) |
| 3 | §9, chi phí | `totalCostUsd` của provider thắng; không có thì tạm tính theo bảng giá | **Chi phí một request luôn là số tạm tính từ token của từng lượt.** `lastUsage.totalCostUsd` **không được** ghi vào bản ghi lượt | Đo trên 12 lượt Manager thật: `totalCostUsd` **chỉ tăng** (0,3956 → 0,4492 → 0,6749 → 0,7948 → … → 2,2712) trong khi token bên cạnh lên xuống theo từng lượt. Đó là **tổng luỹ kế của phiên**, không phải chi phí một lượt. Cộng nó qua các lượt sẽ nhân chi phí lên nhiều lần |
| 4 | §6, id của bead | Id bead lấy từ mọi từ có gạch nối trong lệnh `br` | Id bead **chỉ** là tham số vị trí, trước cờ đầu tiên, sau khi làm trắng phần trong dấu nháy. `br create` **không** nêu id nào (br tự sinh) | `br create … -l "feature:format-date,component:invoice"` và `br close repo-37g -r "… a single-line docstring …"` làm một request tạo 1 bead, đóng 1 bead báo thành **2 tạo / 6 đóng**, trong đó có `single-line`, `non-empty`, `bm-reviewer`, `gpt-5.6-sol` |
| 5 | §7.3, trạng thái | `finished` + có lượt `canceled` bất kỳ → `stopped` | **Chỉ báo cáo cuối cùng quyết định.** `finished` mà `blockers` rỗng → `completed`, kể cả khi trước đó có lượt bị ngắt | F-1 bị ngắt **bốn** lần rồi làm xong: báo cáo cuối `finished`, `blockers` rỗng, nhưng 7 lượt trước đó là `canceled` → màn hình báo "Stopped" cho một request **đã giao xong**. Đúng là ảnh phản chiếu của lỗi thứ năm |
| 6 | §6, lượt Manager không nêu request | Không định nghĩa | Lượt Manager không nêu `requestId` thuộc về **request mà Manager nêu ở lượt kế tiếp**. Không có lượt kế tiếp nào nêu request thì mới mở một dòng tạm | Worker gửi cập nhật tiến độ cho Manager bằng `send_agent_prompt`, và chúng tới **y như** tin nhắn người dùng. Một dòng "Status update (not a milestone report)…" mở ra một request giả: không worker, không bead, 11 bước `unknown` |
| 7 | §8, bước `polish_beads` | Một vòng polish suy ra từ "≥2 lệnh `br update` trong một lượt" | (a) Một `guardrail` báo `polish 0` là **phủ định chính xác** và thắng mọi suy luận từ timeline; (b) vòng polish phải chạm **≥2 bead khác nhau** | F-1 là yêu cầu **Nhỏ**, nơi `worker.md` **cấm** polish, và chính Worker báo `polish 0/0`. Nhưng nó chạy `br update repo-37g` ba lần trong một lượt (description, description lại, rồi status) nên bảng báo "Beads polished: **Done** (inferred)" |

| 8 | §6, gắn bản ghi vào trace | Bản ghi được gắn qua **danh sách agent** của trace | Bản ghi có `requestId` khớp được gắn **kể cả khi agent không còn trên máy**, và agent đó vào `agentsMissing` | Người dùng xoá Worker → `agents.list` không còn gì để khớp → dòng trace mất phần việc của nó trong khi byte vẫn nằm trong kho. Chính là chân thứ ba của D-8 ("lưu trữ rồi xoá Worker") |

Kèm theo, **một luật phụ không đổi hành vi thiết kế nhưng phải ghi**: "báo cáo mới nhất" trong §6 và §7.3 nghĩa là **mới nhất theo thời gian**, không phải phần tử cuối mảng. Báo cáo tới một trace từ ba lượt duyệt khác nhau, nên thứ tự mảng là thứ tự tới, không phải thứ tự thời gian; F-1 đọc `state`, `tier` và `guardrail` từ một báo cáo lạc chỗ.

## 3. Vì sao không làm cách khác

| Cách khác | Vì sao không |
|---|---|
| Vị trí 1: bỏ luôn các bản ghi không có lượt mở đầu | Mất hai request có `requestId` **chính xác**, trong khi kho vẫn tính dung lượng của chúng. Màn hình sẽ nói "4 trace" cạnh một danh sách trống |
| Vị trí 3: vẫn lấy `totalCostUsd` nhưng chỉ của lượt cuối | Lượt cuối của một request không chứa chi phí của các lượt trước; và với nhiều agent thì không có "lượt cuối" chung. Số tạm tính theo token là số **duy nhất** cộng được |
| Vị trí 3: bỏ hẳn cột chi phí | Owner đã chốt Q-035 là **có** hiện chi phí tạm tính. Delta này giữ đúng phần đó và chỉ bỏ phần không làm được |
| Vị trí 4: kiểm id bead với kho `.beads` rồi loại id không có | Một bead vừa tạo có thể chưa kịp vào kho (REQ-044d đã tính tới), nên "không có trong kho" không đủ để loại. Luật vị trí phân biệt được ngay tại nguồn |
| Vị trí 6: đọc văn bản để đoán ai gửi | Không có dấu hiệu văn bản nào đáng tin: cập nhật của Worker viết bằng cùng thứ tiếng, cùng giọng, và câu "not a milestone report" làm bộ nhận diện báo cáo trượt. Lời của **chính Manager ở lượt sau** là bằng chứng, không phải phỏng đoán |
| Vị trí 6: gán theo thời gian tạo agent | Đã có và vẫn giữ cho **agent**; nhưng một lượt Manager không tạo agent nào nên không có mốc nào để so |

## 4. Ảnh hưởng tới các ngưỡng nghiệm thu

| Ngưỡng | Đổi |
|---|---|
| **D-10** | Bỏ phần "khớp tuyệt đối khi provider báo". Provider **không** báo chi phí theo lượt, nên ngưỡng đúng là: mọi dòng chi phí đều có nhãn *estimated* kèm ngày bảng giá; model không có trong bảng thì chỉ hiện token; và **không** dòng nào cộng `totalCostUsd` |
| **D-8** | Chân "khởi động lại daemon" **không chạy**. `AGENTS.md` cấm `paseo daemon restart`/`stop` vì có thể giết agent đang chạy; ngưỡng này viết ra mà quên luật đó. Ghi nhận là **Exception**, không phải PASS, và thay bằng `paseo plugin reload` cộng lưu trữ rồi xoá Worker |

## 5. Revision History

| Ngày | Người | Thay đổi |
|---|---|---|
| 2026-09-16 | hieu.nt10 (soạn cùng Claude) | Tạo delta sau khi nghiệm thu thật tìm ra tám lỗi luật; áp dụng ngay vào code kèm test hồi quy dùng đúng chuỗi quan sát được |
