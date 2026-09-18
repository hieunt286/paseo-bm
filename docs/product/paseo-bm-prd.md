# paseo-bm (Beads Management) — PRD

| Trường | Giá trị |
|---|---|
| Status | Accepted (2026-09-15) |
| Owner | hieu.nt10 (GitHub: hieunt286) |
| Created | 2026-09-14 |
| Repo | https://github.com/hieunt286/paseo-bm |
| Tham chiếu | https://github.com/cuongntr/paseo-room (npm `0.1.0-alpha.6`, commit `f426163`); nguồn skills khuyến nghị: https://github.com/cuongntr/agent-skills |
| Related service PRD | Không có — sản phẩm mới |
| Routing decision | [§0 Routing Decision](#0-routing-decision) (canonical owner) |

## 0. Routing Decision

- Variant preset: greenfield
- Triggered risks:
  - Sản phẩm và actor mới, chưa có acceptance criteria → PRD + `prd-ready`
  - **Điều phối agent (mới, 2026-09-15):** plugin tự tạo và giám sát agent khác trên Paseo; agent do plugin sinh ra lại ghi vào repo của người dùng → Technical Design + `design-ready`, cần chính sách quyền và bằng chứng phủ định riêng
  - **Chi phí và tài nguyên (mới):** mỗi yêu cầu sinh ra nhiều phiên agent (Worker + Reviewer), nên phải có giới hạn và điểm dừng rõ ràng
  - Kiến trúc/phụ thuộc mới (phân phối qua npm, plugin API Paseo 0.8 gồm cả server entry và Paseo SDK, gọi công cụ cài skills của bên thứ ba) → Technical Design + `design-ready`
  - Public/consumed contract: bề mặt lệnh CLI và các vị trí trên đĩa mà Paseo đọc → Technical Design
  - Security boundary: bật plugin không sandbox (`pluginsEnabled`), ghi vào home và cấu hình Paseo, **chạy công cụ cài skills của bên thứ ba theo yêu cầu người dùng** → Technical Design, cần bằng chứng phủ định (không ghi đè ngoài quyền sở hữu, không chạm credential, không tự ghi file skills, không chạy lệnh ngoài khi chưa được đồng ý)
  - Phased rollout (Phase 1/2/3 MVP) → Implementation Plan + `plan-ready-for-beads`
- Required artifacts/gates: PRD [`prd-ready`] → Technical Design (+ ADR cho cơ chế đăng ký plugin nếu cần) [`design-ready`] → Implementation Plan [`plan-ready-for-beads`] → Beads → `feature-done` (standard)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-14 — hieu.nt10 (Claude đề xuất, owner xác nhận khi review)
- Supersedes: none

## 1. Bối cảnh

Paseo (paseo.sh) từ 0.8 có plugin API chính thức. Owner đang làm việc theo quy trình PRD → plan → beads, dựa trên beads CLI (`br`/`bd`/`bv`), công cụ báo cáo `bva` và một bộ agent skills. Mục tiêu của repo `paseo-bm` (**BM = Beads Management**) là đưa phần quản lý beads này vào Paseo dưới dạng plugin *"Agents Bead Reporter / Tracker / Implementation"*.

### 1.1 Giá trị cốt lõi: điều phối, không chỉ cài đặt

Hôm nay, muốn biến một yêu cầu tính năng thành beads làm được, người vận hành phải tự tay chạy cả chuỗi: đọc yêu cầu, quyết định cần tài liệu gì, viết hoặc sửa PRD/design/plan, chuyển thành beads, rồi tự nhờ một agent khác review lại tài liệu và review lại beads. Chính phiên làm việc tạo ra tài liệu này đã đi qua đúng chuỗi đó — thủ công, mất nhiều giờ, và phụ thuộc hoàn toàn vào việc người điều khiển có nhớ đủ các bước hay không.

**Sản phẩm này tự động hoá chuỗi đó.** Sau khi cài, Paseo có thêm **Beads Manager** — bản thân nó là **một agent**, không phải một màn hình. Người dùng chat với Manager như chat với bất kỳ agent nào khác; Manager nhận yêu cầu rồi **giao ngay** cho một **Beads Worker** trong cùng workspace. Manager giữ vai trò quản lý: theo dõi tiến độ, kiểm soát, và trả lời khi người dùng hỏi về tình hình các agent đang chạy — nó dùng chính bộ công cụ của Paseo để làm việc đó. Worker phân tích yêu cầu, xác định có cần bổ sung hay cập nhật tài liệu trước không, bám theo quy trình feature-workflow, rồi tạo beads mới **hoặc** cập nhật beads cũ còn dang dở nếu yêu cầu đã nằm trong đó, **rồi đi tiếp cho tới khi implement xong**. Mỗi khi Worker chạm vào tài liệu hay beads, nó tự gọi một sub-agent để review lại phần vừa làm. Không có giới hạn cứng về thời gian hay số bước: hễ vướng thì Worker hỏi lại người dùng rồi đi tiếp.

Trình cài đặt vì thế **không phải sản phẩm**; nó là đường đưa năng lực trên tới máy người dùng. Hai phần được mô tả trong cùng một PRD vì chúng chỉ có nghĩa khi đi cùng nhau: cài mà không có Manager thì không ai dùng, có Manager mà không cài được thì không ai chạm tới.

**Vấn đề của phần cài đặt:** hiện chưa có cách đưa plugin này lên một máy khác mà không làm tay nhiều bước dễ sai:

1. Lấy mã plugin, đặt vào một thư mục cố định, chạy lệnh đăng ký plugin với daemon.
2. Biết rằng Paseo mặc định **tắt** plugin (`pluginsEnabled` trong `config.json`), tự bật rồi reload daemon. Nếu quên, plugin "không hiện" mà không có lỗi rõ ràng.
3. Khi có bản mới thì lặp lại toàn bộ; không biết file nào đã bị sửa tay; không có cách gỡ sạch.
4. Plugin phát huy tác dụng tốt nhất khi máy đã có bộ bead skills cho agent, nhưng người dùng mới thường không biết điều đó, cũng không biết cài ở đâu.

**Tại sao bây giờ:**
- Plugin API 0.8 đã ổn định (CLI/daemon trên máy owner là 0.8.0).
- Repo `paseo-bm` vừa khởi tạo và còn trống. Chốt cách phân phối ngay từ đầu rẻ hơn nhiều so với sửa sau khi đã có người dùng.
- `paseo-room` đã chứng minh mô hình "một lệnh `npx` để thiết lập Paseo" khả thi và dùng được thực tế. Tuy vậy nó có những khoảng trống (§1.1) mà `paseo-bm` nên tránh ngay từ Phase 1.

**Ranh giới đã chốt về skills:** paseo-bm **không tự copy, sửa hay xoá file skills**. Quyền sở hữu skills thuộc về người dùng và công cụ cài skills chính thức. Nhưng paseo-bm **có hỗ trợ**: khi phát hiện máy chưa đủ skills, nó đề nghị chạy hộ công cụ cài skills chính thức từ nguồn khuyến nghị (`github.com/cuongntr/agent-skills`, repo của tác giả khác — khảo sát chi tiết ở [Phụ lục A](#12-phụ-lục-a--khảo-sát-nguồn-skills-khuyến-nghị)) sau khi người dùng đồng ý rõ ràng. Cách này giúp người mới không phải tự mò, đồng thời giữ nguyên nguyên tắc: mọi file skills trên máy đều do công cụ cài skills quản lý, không phải paseo-bm. Đây cũng là cách tránh rủi ro lớn nhất: trên máy owner, 5 bead skills đang do `npx skills` quản lý ở `~/.agents/skills` và được symlink sang `~/.claude/skills`; nếu paseo-bm tự copy skills cùng tên vào đó thì sẽ ghi đè lên bản của công cụ khác.

### 1.1 Bài học từ paseo-room

| Khía cạnh | paseo-room | paseo-bm |
|---|---|---|
| Điểm vào | `npx paseo-room` mở wizard; lệnh con `setup` / `verify` / `remove` | **Giữ**: một lệnh `npx paseo-bm` có wizard, kèm lệnh con tương đương |
| An toàn trước khi ghi | Mặc định chỉ xem trước, phải có cờ áp dụng; xác nhận mặc định "No" | **Giữ** |
| Chạy không có terminal | In usage, thoát lỗi | **Cải tiến**: in bản xem trước (không ghi) và hướng dẫn cờ chạy tự động |
| Chạy lại | Idempotent — lần hai không đổi gì | **Giữ** |
| File người dùng đã sửa | Xoá rồi ghi lại, không backup, không cảnh báo riêng | **Cải tiến**: phát hiện sửa đổi, không ghi đè im lặng, backup trước mọi ghi đè có chủ đích |
| Hồ sơ cài đặt | Chỉ ghi version và danh sách agent, không có danh sách file | **Cải tiến**: ghi nhận từng thứ mình tạo/sửa để cập nhật và gỡ chính xác |
| Gỡ cài đặt | Xoá toàn bộ thư mục (kể cả credential) | **Cải tiến**: chỉ gỡ thứ mình sở hữu, giữ file đã sửa tay, không chạm credential |
| Phạm vi ghi | Ghi cấu hình cho từng vai trò agent vào `~/.paseo-room`, symlink vào thư mục agent | **Hẹp hơn**: chỉ ghi trong thư mục cài đặt của mình và phần cấu hình Paseo cần cho plugin |
| Tích hợp Paseo | Đăng ký providers/profiles qua daemon; không dùng plugin | **Khác**: dùng cơ chế quản lý plugin chính thức + xin đồng ý trước khi bật plugin |
| Kiểm tra môi trường | Daemon phải chạy, CLI khớp daemon, phiên bản tối thiểu | **Giữ** |
| Ghi dở khi bị ngắt | Không atomic; "chạy lại là xong" | **Cải tiến**: không để file đích ở trạng thái ghi dở |
| Nền tảng & kiểm thử | macOS/Linux; CI không thử gói npm đã đóng gói | **Giữ** phạm vi nền tảng; **cải tiến**: kiểm thử chính gói đã đóng gói |

## 2. Mục tiêu & chỉ số thành công

- **Goal:** Người dùng Paseo đi từ "chưa có gì" tới chỗ **giao một yêu cầu tính năng bằng lời và nhận lại beads làm được, kèm tài liệu đã được review**, chỉ với một lệnh cài và một lần giao việc. Phần cài đặt phải cập nhật, kiểm tra và gỡ được bất cứ lúc nào mà không làm hỏng cấu hình đang có.
- **Success evidence (Phase 1 MVP):**

| ID | Chỉ số | Mục tiêu | Cách đo |
|---|---|---|---|
| M-1 | Số thao tác để cài lần đầu trên máy đủ điều kiện | 1 lệnh + tối đa 3 xác nhận: (1) áp dụng, (2) **bật plugin và mở quyền công cụ agent — gộp một lần hỏi**, (3) cài skills | Demo trên HOME sạch, đếm số lần bộ hỏi đáp được gọi |
| M-2 | Thời gian cài phần plugin, tính từ lúc `npx` đã tải xong gói, chưa tính bước cài skills | ≤ 60 giây | Đo trong CI và trên máy owner |
| M-3 | Thay đổi khi chạy lại cùng phiên bản | 0 | Test tự động |
| M-4 | Số lần ghi ra ngoài phạm vi sở hữu: ghi đè file người dùng đã sửa mà không có đồng ý, hoặc **tự** ghi vào thư mục skills | 0 | Test tự động các kịch bản xung đột |
| M-5 | Số thứ do paseo-bm tạo còn sót lại sau khi gỡ | 0 | Lệnh kiểm tra sau khi gỡ + test tự động |
| M-6 | Tỉ lệ cài thành công trên ma trận hỗ trợ (macOS, Linux) | 100% | CI chạy trên gói npm đã đóng gói |
| M-7 | Plugin ở trạng thái `running` sau khi cài (khi người dùng đã đồng ý bật plugin) | 100% trên máy demo | `paseo plugin ls` |
| M-8 | Độ chính xác của báo cáo tình trạng skills (đủ / thiếu skill nào / agent nào chưa có) | 100% trên ma trận test (đủ, thiếu một phần, thiếu hết, symlink, đổi vị trí bằng biến môi trường) | Test tự động |
| M-9 | Máy thiếu skills, người dùng đồng ý để paseo-bm hỗ trợ → sau bước đó máy có đủ skills | 100% khi công cụ cài skills chạy thành công; khi thất bại thì 100% trường hợp in được hướng dẫn thủ công | Demo trên HOME sạch + test tự động với công cụ giả lập |
| M-10 | Thời gian từ lúc người dùng gửi yêu cầu cho Beads Manager tới lúc Beads Worker xuất hiện trong workspace (`createdAt` của Worker) | ≤ 60 giây với mọi yêu cầu mẫu | Đo trong nghiệm thu điều phối trên daemon thật theo checklist điều phối. Test với Paseo SDK giả lập không đo được thời gian suy luận của Manager (agent LLM, ADR-005) nên không dùng cho chỉ số này |
| M-11 | Với bộ **5 yêu cầu mẫu** (1 nhỏ, 2 vừa, 1 chạm hợp đồng công khai, 1 trùng bead đang mở), tỉ lệ Worker kết thúc và để lại beads hợp lệ — `lint` sạch, không chu trình, có provenance, **có nhãn theo REQ-033** | 5/5 | Kịch bản nghiệm thu thủ công, có ghi lại |
| M-15 | Với **2 yêu cầu mẫu nhỏ và vừa**, Worker đi hết chặng implement: bead được đóng kèm bằng chứng, và thay đổi mã chạy được (build và test của repo đích xanh) | 2/2 | Nghiệm thu thủ công trên repo nháp, có ghi lại |
| M-16 | Số lần Worker im lặng tự quyết khi gặp chỗ vướng, thay vì hỏi lại người dùng | 0 trên toàn bộ yêu cầu mẫu | Đọc lại timeline agent trong Paseo |
| M-17 | Số lần vượt lan can **mà người dùng chưa cho phép**: lô review quá 2 lượt, polish quá 1 lượt, hoặc vượt ngân sách sub-agent theo mức | 0 trên toàn bộ yêu cầu mẫu | Đếm số lần gọi review/polish trong timeline và đối chiếu với bộ đếm trong báo cáo. Phần vượt **đã được người dùng cho phép** không tính là vi phạm |
| M-18 | Số **file tài liệu mới** do một yêu cầu mức Nhỏ tạo ra | 0 | Yêu cầu mẫu số 1 — đối chiếu danh sách file mới trong `git status` |
| M-12 | Số bead trùng lặp bị tạo ra khi yêu cầu đã nằm trong một bead đang mở | 0 | Yêu cầu mẫu số 5 |
| M-13 | Số lần Worker hoặc Reviewer vượt ranh giới: commit, push, tạo pull request, chạy lệnh phá huỷ, hay ghi ra ngoài workspace | 0 | Chạy trên repo dùng một lần: so ảnh chụp hệ thống file trước/sau, đọc toàn bộ timeline lệnh và tool call, kiểm remote không đổi và không có pull request. `git reflog` một mình **không đủ** vì không thấy push, tạo PR hay ghi ngoài repo |
| M-14 | Mỗi lần Worker chạm tài liệu hoặc beads đều có một lượt review bằng sub-agent, và mọi phát hiện mức chặn đều được xử lý trước khi Worker báo xong | 100% trên 5 yêu cầu mẫu | Đối chiếu timeline agent trong Paseo |

## 3. Ngoài phạm vi

- **Tự copy, sửa hay xoá file skills.** paseo-bm chỉ dò, hướng dẫn, và (khi được đồng ý) gọi công cụ cài skills chính thức để làm việc đó — xem REQ-007.
- Sở hữu hay bảo trì nội dung bộ skills: đó là repo của tác giả khác (`cuongntr/agent-skills`).
- Cài Paseo, Node.js, beads CLI (`br`/`bd`/`bv`), Claude Code, Codex; đăng nhập provider.
- **Tự merge, tự commit, tự tạo pull request.** Worker viết mã nhưng **không** đụng tới git; người dùng xem `git diff` rồi tự quyết định.
- **Bảng báo cáo tiến độ bead trong Paseo** (reporter/tracker dạng biểu đồ): Phase 2. Phase 1 chỉ hiển thị trạng thái các Worker và kết quả gần nhất.
- **Tự merge, tự commit, tự tạo pull request.** Worker không đụng tới git.
- **Đoán ý từ mọi câu chat.** Manager chỉ nhận việc khi người dùng giao một cách tường minh; plugin không âm thầm đọc và diễn giải mọi tin nhắn trong khung chat.
- Daemon từ xa (`--host`), Docker.
- Windows nguyên bản. WSL có thể chạy như Linux nhưng Phase 1 không cam kết kiểm thử.
- Cách ly credential theo từng vai trò kiểu paseo-room (thư mục nhà riêng, phiên đăng nhập riêng). paseo-bm **có** đăng ký providers và agent profiles (REQ-031), nhưng chỉ ở dạng dẫn xuất dùng lại phiên đăng nhập sẵn có.
- Quản lý plugins, providers, profiles do công cụ khác hoặc người dùng tạo.
- Tự cập nhật ngầm, thông báo có phiên bản mới.
- Telemetry.

## 4. Personas / Affected Actors

- **Người vận hành Paseo cá nhân (owner)**
  - *Bối cảnh:* dùng Paseo desktop cùng Claude Code/Codex hằng ngày, theo quy trình PRD → plan → beads, trên nhiều máy (cá nhân, công ty).
  - *Mục tiêu:* dựng lại môi trường nhanh và giữ phiên bản plugin đồng bộ giữa các máy.
  - *Nỗi đau:* skills đã được công cụ khác quản lý nên không muốn công cụ nào tự ý đụng vào; quên bật `pluginsEnabled` nên plugin im lặng không chạy.
- **Đồng nghiệp được chia sẻ bộ công cụ**
  - *Bối cảnh:* đã cài Paseo, không quen cấu trúc `~/.paseo`, chưa từng nghe tới beads skills.
  - *Mục tiêu:* một lệnh là xong, kể cả phần skills, không phải tự đi tìm repo.
  - *Nỗi đau:* không muốn làm hỏng cấu hình Paseo đang chạy; cần biết trước những gì sẽ thay đổi và gỡ được.
- **Maintainer phát hành** (owner ở vai trò khác)
  - *Bối cảnh:* phát hành phiên bản mới của plugin.
  - *Mục tiêu:* người dùng cập nhật bằng một lệnh; khi báo lỗi thì kèm đủ thông tin chẩn đoán.
  - *Nỗi đau:* không biết máy người dùng đang chạy phiên bản nào, có đủ skills không.
- **Script bootstrap tự động** (dotfiles, thiết lập máy mới; actor không tương tác)
  - *Nhu cầu:* chạy không có prompt, mã thoát rõ ràng, output máy đọc được, và quyết định rõ ràng về việc có cho phép cài skills hay không.
- **Người giao việc** (chính là owner và đồng nghiệp, nhưng ở vai trò khác khi đã cài xong)
  - *Bối cảnh:* đang mở workspace của một repo trong Paseo và nảy ra một yêu cầu tính năng hoặc một chỗ cần sửa.
  - *Mục tiêu:* mô tả yêu cầu bằng lời rồi nhận lại beads làm được, mà không phải tự nhớ đủ các bước của feature-workflow hay tự mở từng skill.
  - *Nỗi đau:* làm tay thì tốn hàng giờ và hay bỏ sót bước review; nhưng giao cho một agent tự do thì nó thường nhảy thẳng vào viết mã, bỏ qua tài liệu, và tạo bead trùng với thứ đã có.

**Actor không phải người:**

- **Beads Worker** — agent do Manager tạo, chạy trong cùng workspace, chịu trách nhiệm cả chuỗi từ phân tích yêu cầu tới khi có beads.
- **Reviewer** — sub-agent do Worker tạo, chỉ đọc và nhận xét phần tài liệu hoặc beads mà Worker vừa chạm vào.

## 5. User / Operational Journeys

- **J-1 Cài lần đầu trên máy chưa có gì:**
  1. Đồng nghiệp đọc README và gõ `npx paseo-bm`.
  2. Công cụ kiểm tra môi trường: Paseo đã cài, daemon đang chạy, phiên bản hợp lệ.
  3. Công cụ hiển thị kế hoạch: tạo thư mục cài đặt, đăng ký plugin. Kèm theo là tình trạng skills: Claude Code và Codex đều chưa có skill nào trong danh sách khuyến nghị.
  4. Người dùng chọn áp dụng.
  5. Công cụ báo công tắc plugin của Paseo đang tắt, hiển thị cảnh báo tin cậy. Người dùng đồng ý; plugin được cài, reload và đạt `running`.
  6. Công cụ hỏi: "Máy chưa có bộ skills khuyến nghị. Cho phép chạy hộ lệnh sau không?" kèm **đúng lệnh sẽ chạy** và nguồn `cuongntr/agent-skills`. Người dùng đồng ý.
  7. Công cụ chạy lệnh đó, hiển thị output, rồi dò lại và báo kết quả.
  8. Bản tóm tắt: plugin `running`, skills đã đủ, những gì đã thay đổi và ở đâu.
- **J-2 Cập nhật:**
  1. Maintainer phát hành phiên bản mới; owner chạy `npx paseo-bm@latest`.
  2. Công cụ nhận ra phiên bản cũ đang cài và liệt kê những gì sẽ cập nhật. Trong đó có một file owner từng sửa tay.
  3. Công cụ hỏi giữ bản đã sửa hay ghi đè (ghi đè thì có backup). Owner chọn.
  4. Công cụ áp dụng; plugin reload và `running`; lệnh kiểm tra báo sạch.
- **J-3 Chẩn đoán:**
  1. Plugin không hiện trong Paseo; owner chạy lệnh kiểm tra.
  2. Công cụ báo "công tắc plugin đang tắt", kèm cách khắc phục; đồng thời cảnh báo "thiếu 2 skills khuyến nghị cho Codex" và lệnh để bổ sung.
  3. Owner chạy lại lệnh cài để sửa cả hai việc.
- **J-4 Gỡ cài đặt:**
  1. Đồng nghiệp chạy lệnh gỡ và xem danh sách sẽ gỡ: chỉ những thứ paseo-bm tạo. File đã sửa tay được giữ lại và liệt kê. Skills không nằm trong danh sách vì paseo-bm không sở hữu chúng.
  2. Đồng nghiệp xác nhận.
  3. Plugin bị huỷ đăng ký. Chỉ khi chính paseo-bm đã bật công tắc plugin và không còn plugin nào khác, công cụ mới đề nghị tắt lại.
  4. Bản tóm tắt nhắc: skills vẫn còn trên máy, muốn gỡ thì dùng công cụ cài skills.
- **J-5 Bootstrap không tương tác:**
  1. Script gọi paseo-bm với cờ áp dụng, cờ đồng ý bật plugin, cờ cho phép cài skills và output JSON.
  2. Thành công thì exit 0; JSON ghi rõ đã chạy lệnh cài skills nào và kết quả.
  3. Không truyền cờ cho phép cài skills → công cụ vẫn cài plugin, chỉ báo cảnh báo về skills, không tự chạy gì.
- **J-6 Giao một yêu cầu tính năng mới (luồng chính của sản phẩm):**
  1. Owner đang mở workspace của repo trong Paseo, mở Beads Manager rồi **chat**: "thêm màn hình xuất báo cáo theo tháng, có lọc theo phòng ban".
  2. Manager không tự làm mà giao ngay: nó tạo một Beads Worker trong workspace đó, truyền nguyên văn yêu cầu cùng ngữ cảnh repo và vị trí kho beads, rồi báo lại cho owner biết Worker nào đang cầm việc.
  3. Worker đọc yêu cầu, đối chiếu tài liệu và beads đang có, rồi kết luận: yêu cầu này chạm giao diện và một hợp đồng dữ liệu mới, nên cần bổ sung tài liệu trước.
  4. Worker viết phần tài liệu cần thiết theo feature-workflow, rồi tạo một sub-agent review tài liệu. Review trả về hai điểm chặn; Worker sửa cả hai.
  5. Worker chuyển tài liệu thành beads, rồi tạo một sub-agent review beads. Review chỉ ra một bead ôm hai kết quả; Worker tách ra.
  6. Giữa chừng Worker gặp một chỗ cần quyết định: yêu cầu đụng vào một tài liệu đã đóng băng. Nó **dừng lại hỏi**. Owner chat thẳng với Worker để chốt hướng, không cần nói vòng qua Manager.
  7. Worker báo xong. Owner hỏi Manager "tình hình thế nào" và Manager trả lời: tài liệu nào đã đổi, bead nào vừa tạo, bead nào đang sẵn sàng làm.
  8. Owner xem lại kết quả rồi tự quyết định lưu trữ hay xoá Worker. Không agent nào tự xoá agent.
- **J-7 Yêu cầu trùng với việc đã nằm trong kho beads:**
  1. Owner giao: "phần xuất báo cáo cần thêm định dạng CSV".
  2. Worker tìm thấy một bead đang mở về xuất báo cáo, chưa ai làm.
  3. Thay vì tạo bead mới, Worker cập nhật bead đó và ghi rõ lý do; nếu phạm vi phình quá một kết quả thì tách thành bead con thay vì nhân bản.
  4. Manager báo: đã cập nhật bead nào, không tạo bead trùng.
- **J-8 Cấu hình agent trong lúc cài:**
  1. Trong luồng cài, công cụ hỏi: đặt tên cho từng vai trò (Worker, Reviewer) và chọn công cụ kèm model cho mỗi vai trò, từ danh sách provider mà Paseo đang có.
  2. Với provider chưa đăng nhập, công cụ báo rõ và mời chạy đúng lệnh đăng nhập của chính công cụ đó; người dùng đồng ý thì nó chạy hộ, còn không thì in hướng dẫn.
  3. Cấu hình được lưu lại để các lần chạy sau không hỏi lại.
  4. Bản tóm tắt cuối liệt kê từng vai trò, công cụ đã chọn, và trạng thái đăng nhập.

## 6. Functional Requirements

Priority: **P1** = bắt buộc cho Phase 1 MVP; **P2/P3** = phase sau.

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Điểm vào một lệnh | P1 | (a) Trong terminal tương tác, `npx paseo-bm` không tham số chạy lần lượt: kiểm tra môi trường → xem trước → xác nhận → áp dụng → hỗ trợ skills → tóm tắt. (b) Không có terminal tương tác và không có cờ áp dụng: chỉ in bản xem trước và hướng dẫn cờ, **không ghi gì**, exit khác 0. (c) Có lệnh con cho cài/cập nhật, kiểm tra, gỡ; `--help` và `--version` hoạt động. |
| REQ-002 | Kiểm tra môi trường trước khi ghi | P1 | Nếu một trong các điều kiện sau không đạt, công cụ dừng **trước mọi thao tác ghi**, in lý do và cách khắc phục, exit khác 0: hệ điều hành không hỗ trợ; Node dưới mức tối thiểu; không tìm thấy Paseo CLI; daemon không chạy hoặc không kết nối được; Paseo < 0.8.0 hoặc phiên bản CLI lệch daemon; thư mục đích không ghi được. Thiếu beads CLI (`br`/`bd`) hoặc thiếu skills chỉ là **cảnh báo**, không chặn. |
| REQ-003 | Xem trước thay đổi | P1 | Trước khi ghi, hiển thị đầy đủ hành động theo từng vị trí đích. Mỗi mục có một trạng thái: *tạo mới / cập nhật / giữ nguyên / bỏ qua do xung đột / thay đổi cấu hình Paseo*. Phần skills hiển thị tách riêng: tình trạng hiện tại và **lệnh sẽ được đề nghị chạy** (chưa chạy gì ở bước này). Câu hỏi xác nhận mặc định là "Không". Chọn "Không" thì không có thay đổi nào trên đĩa hay trong Paseo. |
| REQ-004 | Thư mục cài đặt riêng và hồ sơ cài đặt | P1 | (a) Sau khi cài có một thư mục cài đặt thuộc paseo-bm: mặc định nằm trong home người dùng, đổi được bằng cờ hoặc biến môi trường. Thư mục chứa payload đúng phiên bản gói. (b) Hồ sơ cài đặt ghi: phiên bản, thời điểm, từng thứ paseo-bm đã tạo/sửa (đủ để sau này phát hiện nội dung bị sửa), các thay đổi cấu hình Paseo, và việc đã đề nghị/chạy lệnh cài skills hay chưa (để không hỏi lại khi người dùng đã từ chối). (c) Công cụ từ chối nếu thư mục cài đặt trùng hoặc chứa home, thư mục Paseo hay thư mục cấu hình agent. |
| REQ-005 | Đăng ký plugin với Paseo | P1 | (a) Plugin id `paseo-bm` được đăng ký qua cơ chế quản lý plugin chính thức của Paseo, không sửa tay danh mục plugin. (b) Khi công tắc chung đang bật: sau khi cài, `paseo plugin ls` hiển thị `paseo-bm` ở trạng thái `running`, không lỗi. (c) Nếu plugin lỗi khi tải: báo lỗi kèm lệnh xem log (`paseo plugin logs paseo-bm`), exit khác 0. (d) Plugin có một dấu hiệu tối thiểu trong Paseo để người dùng thấy đã cài và đang ở phiên bản nào — từ bản sửa đổi 2026-09-15, dấu hiệu này chính là giao diện Beads Manager ở REQ-020. |
| REQ-006 | Đồng ý trước khi bật plugin | P1 | (a) `pluginsEnabled` của daemon đích đang bật → không hỏi. (b) Đang tắt hoặc chưa có → hiển thị cảnh báo: plugin là mã được tin cậy, không sandbox, truy cập được file, tiến trình, credential và mạng của máy. Chỉ bật khi người dùng đồng ý rõ ràng (tương tác) hoặc truyền **cờ đồng ý riêng** (không tương tác); cờ áp dụng chung **không** ngầm hiểu là đồng ý. (c) Nếu đồng ý: bật công tắc, giữ nguyên mọi trường khác của cấu hình, reload và xác nhận thay đổi đã có hiệu lực. (d) Nếu từ chối: vẫn cài phần còn lại; plugin ở trạng thái chưa chạy; tóm tắt nêu rõ và hướng dẫn cách bật sau. (e) Hồ sơ cài đặt ghi nhận việc paseo-bm là bên đã bật công tắc. |
| REQ-007 | Dò skills và hỗ trợ cài khi thiếu | P1 | (a) **Dò:** kiểm tra sự hiện diện của các skill khuyến nghị trong thư mục skills của **Claude Code** (`~/.claude/skills`), **Codex** (`~/.codex/skills`) và thư mục chung `~/.agents/skills`; tôn trọng `CLAUDE_CONFIG_DIR`, `CODEX_HOME`; nhận diện đúng cả skill dạng symlink. (b) **Báo cáo** theo từng agent: đủ / thiếu skill nào / agent chưa cài hoặc chưa có thư mục skills. Danh sách đối chiếu là nhóm **bắt buộc** ở [Phụ lục A](#12-phụ-lục-a--khảo-sát-nguồn-skills-khuyến-nghị); nhóm **tuỳ chọn** chỉ liệt kê như gợi ý, thiếu cũng không cảnh báo. Phase 1 chỉ so tên skill có hay không, **không so phiên bản** vì nguồn chưa có tag hay số phiên bản (xem Q-013). (c) **Không bao giờ tự ghi, copy, sửa, xoá file trong thư mục skills**; mọi thay đổi skills chỉ diễn ra qua công cụ cài skills chính thức. (d) **Hỗ trợ khi thiếu:** hiển thị lý do nên có, nguồn khuyến nghị (`github.com/cuongntr/agent-skills`, tác giả khác), **danh sách agent đích do người dùng nhập hoặc sửa** (gợi ý mặc định Claude Code và Codex) và **đúng lệnh sẽ chạy**; hỏi người dùng cho phép chạy hộ. (e) Người dùng đồng ý → chạy lệnh đó, hiển thị output trực tiếp, sau đó dò lại và báo kết quả trước/sau. (f) Người dùng từ chối → in hướng dẫn thủ công, ghi nhớ để lần sau không hỏi lại (đặt lại được bằng cờ). (g) Công cụ cài skills không có trên máy, chạy lỗi, hoặc không có mạng → báo lỗi kèm hướng dẫn thủ công; **không** làm hỏng việc cài plugin. (h) Ở chế độ không tương tác, chỉ chạy khi có **cờ cho phép riêng**; không có cờ thì chỉ cảnh báo. (i) Mọi tình huống liên quan tới skills đều không đổi exit code của lệnh cài plugin. (j) Vì Beads Worker bám feature-workflow, thiếu skills làm giảm chất lượng kết quả — cảnh báo phải nói rõ điều đó, và Manager nhắc lại khi người dùng giao việc trên máy còn thiếu skills. |
| REQ-008 | Bảo vệ xung đột | P1 | (a) Đích đã tồn tại mà không có trong hồ sơ cài đặt → bỏ qua, báo xung đột, không ghi. (b) Đích thuộc paseo-bm nhưng nội dung đã khác lúc cài (người dùng sửa) → khi tương tác thì hỏi giữ hay ghi đè; khi không tương tác thì giữ, trừ khi có cờ ghi đè rõ ràng. (c) Mọi ghi đè có chủ đích đều backup bản cũ vào thư mục cài đặt và in đường dẫn backup. (d) Không bao giờ đọc, sửa, in hay xoá file credential của Paseo hoặc agent. (e) Test tự động chứng minh paseo-bm không tự thực hiện thao tác ghi nào vào thư mục skills; thay đổi duy nhất được phép ở đó là do tiến trình công cụ cài skills tạo ra sau khi người dùng đồng ý. |
| REQ-009 | Idempotent | P1 | Chạy cài lần hai cùng phiên bản trên máy đã đủ skills: bản xem trước báo 0 thay đổi, không hỏi xác nhận áp dụng, không đề nghị cài skills, exit 0, không file đích nào bị đổi thời điểm sửa. |
| REQ-010 | Cập nhật và an toàn khi bị ngắt | P1 | (a) Chạy phiên bản mới hơn → nhận ra phiên bản đang cài; cập nhật những thứ thuộc paseo-bm theo quy tắc REQ-008; gỡ những thứ bản mới không còn dùng; reload plugin; cập nhật hồ sơ. (b) Chạy phiên bản cũ hơn bản đang cài → cảnh báo hạ cấp và chỉ tiếp tục khi người dùng xác nhận rõ ràng. (c) Bị ngắt giữa chừng (Ctrl+C, kill, lỗi) → không file đích nào ở trạng thái ghi dở; chạy lại lệnh cài đưa hệ thống về trạng thái nhất quán; plugin bản trước (nếu có) vẫn dùng được cho tới khi bản mới áp dụng xong. (d) Nếu Paseo từ chối cấu hình sau khi reload → hoàn tác thay đổi cấu hình của lần chạy đó. (e) Ngắt trong lúc công cụ cài skills đang chạy → paseo-bm không để lại trạng thái sai của riêng nó và báo rõ phần skills có thể dở dang, kèm lệnh chạy lại. **(f)** Cập nhật **không bao giờ** xoá hay ghi đè kho lưu vết của Dashboard (`<install home>/traces/`), kể cả khi payload sang thư mục phiên bản mới, kể cả với `--prune`, và kể cả khi lược đồ kho cần di trú — di trú ghi bản mới rồi mới bỏ bản cũ *(delta `design-delta-20260916-trace-store`)*. |
| REQ-011 | Kiểm tra sức khoẻ | P1 | (a) Lệnh kiểm tra **không ghi gì**, không chạm mạng, và chỉ được gọi các lệnh Paseo **chỉ-đọc** (`paseo daemon status`, `paseo plugin ls`) vì không có cách nào khác để biết trạng thái daemon và plugin; **không bao giờ** gọi CLI `skills`. (b) Báo từng mục: thiếu, bị sửa, lỗi thời so với phiên bản gói đang chạy, plugin không `running`, công tắc plugin tắt, daemon lệch phiên bản, thiếu beads CLI (cảnh báo), tình trạng skills theo REQ-007b (cảnh báo, kèm lệnh khắc phục). (c) Exit 0 khi khoẻ, 1 khi có sai lệch thuộc phạm vi sở hữu của paseo-bm, 2 khi dùng sai lệnh. Cảnh báo về skills và beads CLI không làm exit khác 0. |
| REQ-012 | Gỡ cài đặt | P1 | (a) Có xem trước và xác nhận như REQ-003. (b) Chỉ gỡ những thứ có trong hồ sơ. File thuộc paseo-bm đã bị sửa tay được giữ lại và liệt kê, trừ khi có cờ rõ ràng. (c) Huỷ đăng ký plugin khỏi Paseo. (d) Chỉ đề nghị tắt lại `pluginsEnabled` khi chính paseo-bm đã bật và không còn plugin nào khác; mặc định giữ nguyên. (e) Nếu người dùng chọn, khôi phục các backup do paseo-bm tạo. (f) **Không chạm tới skills và không gọi công cụ cài skills**; bản tóm tắt nhắc rằng skills vẫn còn và do công cụ khác quản lý. (g) Sau khi gỡ, lệnh kiểm tra báo "chưa cài" và không còn đích nào do paseo-bm tạo. (h) Daemon không chạy → vẫn gỡ phần file, giữ hồ sơ phần Paseo để lần sau hoàn tất, và báo rõ. **(i)** Kho lưu vết của Dashboard được liệt kê **riêng** trong bản xem trước, kèm số trace và dung lượng, và chỉ bị xoá sau khi người dùng đồng ý riêng cho nó; chế độ không tương tác chỉ xoá khi có cờ dành đúng cho việc này. Không đồng ý thì kho được giữ lại và bản tóm tắt nói rõ nó còn ở đâu *(delta `design-delta-20260916-trace-store`)*. |
| REQ-013 | Chế độ không tương tác và output máy đọc | P1 | (a) Mọi lệnh có cờ áp dụng không cần hỏi và cờ xuất JSON. (b) JSON gồm danh sách hành động, trạng thái từng mục, tình trạng skills trước/sau, lệnh cài skills đã chạy (nếu có) cùng kết quả, cảnh báo và mã kết quả. (c) Khi bật JSON, stdout không lẫn log; output của công cụ cài skills không phá vỡ JSON. (d) Bảng mã thoát nhất quán giữa các lệnh và được ghi trong README. *(Errata 2026-09-18, [delta short-readme](paseo-bm-prd-delta-20260918b-short-readme.md): bảng mã thoát nay nằm trong `GUIDE.md` ở gốc repo, README trỏ tới.)* |
| REQ-014 | Vị trí tuỳ chỉnh | P1 | (a) Tôn trọng `PASEO_HOME` (và cờ tương ứng) cho thư mục Paseo. (b) Có cờ/biến môi trường cho thư mục cài đặt paseo-bm và cho vị trí thư mục cấu hình agent dùng khi dò skills. (c) Thứ tự ưu tiên: cờ > biến môi trường > mặc định. (d) Test với HOME tạm chứng minh paseo-bm không ghi ra ngoài các vị trí đã khai báo. |
| REQ-015 | Tài liệu người dùng | P1 | README có đủ: yêu cầu hệ thống; lệnh cài một dòng; bảng **mọi vị trí** paseo-bm ghi vào; nêu rõ paseo-bm không tự ghi skills mà gọi công cụ chính thức khi được đồng ý; **tham chiếu nguồn skills `https://github.com/cuongntr/agent-skills` kèm ghi nhận đây là repo của tác giả khác**, danh sách skills khuyến nghị và lệnh cài thủ công tương đương; cảnh báo tin cậy plugin; cách cập nhật và gỡ (gồm cách gỡ skills bằng công cụ của nó); bảng mã thoát; xử lý sự cố thường gặp. *(Errata 2026-09-18, [delta short-readme](paseo-bm-prd-delta-20260918b-short-readme.md), quyết định owner: README ngắn — ảnh luồng, mô tả sơ bộ, lệnh cài một dòng, cảnh báo tin cậy tóm tắt, ghi nhận nguồn skills là repo của tác giả khác, link site https://paseo-bm.erai.pro và `GUIDE.md`; mọi mục còn lại ở trên nằm trong `GUIDE.md` ở gốc repo, chép nguyên văn từ README cũ. Nội dung yêu cầu không đổi, chỉ đổi file chứa.)* |
| REQ-020 | Beads Manager là một agent, mở được từ Paseo | P1 | (a) Sau khi cài và bật plugin, người dùng mở được Beads Manager cho workspace hiện tại từ sidebar và từ Command Center; plugin đóng vai **lối vào**, còn Manager là một agent thật chạy bằng công cụ và model đã cấu hình. (b) Mỗi workspace dùng lại **một** Manager thay vì tạo trùng; Manager cũ còn sống thì mở lại nó. (c) Người dùng chat với Manager bằng khung chat bình thường của Paseo. (d) Manager dùng bộ công cụ Paseo để liệt kê, đọc trạng thái và dòng hoạt động, nhắc việc, và **dừng** agent mà nó đã tạo khi cần. Manager **không được lưu trữ hay xoá** agent — đó là quyền của người dùng (REQ-026f). Phân biệt rõ: dừng thì khôi phục được, xoá thì mất lịch sử. (e) Manager trả lời được câu hỏi về tiến độ: agent nào đang chạy, đang chờ gì, đã chạm file nào, đã tạo hay cập nhật bead nào, review còn vướng gì — dựa trên **báo cáo có cấu trúc do Worker gửi về** cộng với dòng hoạt động mà công cụ Paseo trả về. |
| REQ-021 | Manager giao ngay cho Beads Worker | P1 | (a) Khi nhận một yêu cầu tính năng hoặc sửa đổi, Manager **không tự làm** mà tạo ngay một Beads Worker trong **chính workspace đang mở**, dùng công cụ và model đã cấu hình cho vai trò Worker. (b) Chỉ dẫn khởi tạo chứa nguyên văn yêu cầu, đường dẫn repo, vị trí kho beads, và ràng buộc bám feature-workflow. (c) Worker là agent hạng nhất trong workspace: người dùng mở, chat, dừng, lưu trữ hay xoá được như mọi agent khác. (d) Tạo agent thất bại (provider chưa sẵn sàng, chưa đăng nhập, hết hạn mức) → Manager báo đúng nguyên nhân và cách khắc phục, không để lại agent rác. (e) M-10: từ lúc giao tới lúc Worker xuất hiện ≤ 60 giây. (f) Manager chỉ nhận việc khi người dùng giao trong khung chat của chính nó; nó không đọc chat của agent khác. |
| REQ-022 | Worker bám feature-workflow trước khi tạo beads | P1 | (a) Worker phân loại yêu cầu theo mức rủi ro trước, rồi mới quyết định cần tài liệu gì. (b) Yêu cầu nhỏ, rõ, cục bộ → không bắt viết PRD; chỉ cần bản mô tả ngắn rồi sang beads. (c) Yêu cầu chạm hợp đồng công khai, lược đồ dữ liệu, xác thực, hay kiến trúc → phải có tài liệu tương ứng trước khi tạo bead. (d) Tài liệu được đặt đúng thư mục quy ước của repo đích. (e) Sau khi có beads, Worker **đi tiếp sang implement** và chạy cho tới khi các bead thuộc yêu cầu đó xong xuôi, theo đúng quy trình implement của feature-workflow. (f) **Không có giới hạn cứng về thời gian hay số bước**; thay vào đó, hễ vướng ở bất kỳ điểm nào từ đầu tới lúc implement xong thì Worker hỏi lại người dùng rồi mới đi tiếp. (g) Worker viết mã nhưng không chạm git (REQ-026a). |
| REQ-033 | Gán nhãn khi tạo bead và truy vấn theo nhãn khi tìm việc liên quan | P1 | (a) Mỗi bead do Worker tạo đều được gán bộ nhãn phù hợp, suy ra từ nội dung yêu cầu (ví dụ nhãn theo tính năng, theo vùng chức năng, theo thành phần). (b) Trước khi tạo bead mới cho một yêu cầu, Worker **truy vấn kho beads theo chính bộ nhãn vừa suy ra**, rồi xét những bead chưa đóng trong tập kết quả đó để quyết định cập nhật hay tạo mới (REQ-023). (c) Quy ước nhãn được ghi trong chỉ dẫn vai trò để các lần chạy khác nhau cho ra nhãn nhất quán. (d) Nhãn do người dùng tự thêm không bị Worker xoá. |
| REQ-023 | Ưu tiên cập nhật bead liên quan thay vì tạo trùng | P1 | (a) Trước khi tạo bead mới, Worker tìm trong kho beads những bead **chưa đóng** có liên quan tới yêu cầu. (b) Có bead liên quan → cập nhật hoặc mở rộng bead đó, ghi rõ lý do trong bead; chỉ tách bead con khi phạm vi vượt quá một kết quả quan sát được. (c) Không có bead liên quan → tạo mới. (d) M-12: với yêu cầu mẫu trùng bead đang mở, số bead trùng lặp tạo ra bằng 0. (e) Báo cáo cuối nêu rõ bead nào được tạo, bead nào được cập nhật. |
| REQ-024 | Tự review bằng sub-agent mỗi khi chạm tài liệu hoặc beads | P1 | (a) Worker tạo hoặc sửa tài liệu → phải tạo một sub-agent review tài liệu. (b) Worker tạo hoặc sửa beads → phải tạo một sub-agent review beads. (c) Worker xử lý xong mọi phát hiện **mức chặn** rồi mới được báo hoàn thành; phát hiện không chặn thì ghi lại để người dùng quyết định. (d) Kết quả review truy lại được từ Manager. (e) Sub-agent review chỉ đọc và nhận xét, không tự sửa tài liệu hay beads, **và không được tạo agent khác** — đây là ràng buộc chặn review đệ quy. (f) M-14 đạt trên cả 5 yêu cầu mẫu. (g) **Một lượt review tính theo lô**: mỗi lần Worker hoàn tất một nhóm thay đổi mạch lạc (một tài liệu, hoặc một đợt tạo/cập nhật bead) thì gọi review một lần, chứ không phải mỗi file một lần. Sau khi sửa theo phát hiện mức chặn thì **review lại** cho tới khi hết mục chặn; thao tác chỉ-đọc không kích hoạt review. |
| REQ-036 | Phân loại quy mô yêu cầu và chọn đường làm tương ứng | P1 | (a) Ngay khi nhận việc, Worker phân yêu cầu vào một trong ba mức và **nói rõ mức đó cho người dùng** kèm lý do. Phân loại theo **thứ tự, dừng ở điều kiện khớp đầu tiên**: (1) chạm hợp đồng công khai, lược đồ dữ liệu, xác thực, quyền, khả năng hoàn tác yếu, hay nhiều thành phần độc lập → **Lớn**, bất kể yêu cầu nghe nhỏ tới đâu; (2) thoả **tất cả**: nằm gọn trong một thành phần, không đổi hợp đồng, không cần tài liệu mới, và cách làm đã rõ ngay từ đầu → **Nhỏ**; (3) còn lại → **Vừa**. **Rủi ro luôn thắng cảm giác về kích thước.** Số bead là kết quả của phân rã nên **không** được dùng làm căn cứ phân loại. (b) Mức Nhỏ **không tạo tài liệu mới** (không PRD, không design, không plan); đi thẳng tới một bead rồi implement, và chỉ review đúng một lượt sau khi implement (REQ-037e). Vẫn được sửa tài liệu sẵn có nếu chính bead yêu cầu. (c) Mức Vừa chỉ bổ sung phần tài liệu thật sự bị ảnh hưởng, không viết lại cả bộ. (d) Mức Lớn mới đi đủ chuỗi tài liệu và **phải hỏi người dùng xác nhận trước khi bước sang implement**. (e) Đang làm mà phát hiện rủi ro thuộc mức cao hơn thì **nâng mức, báo người dùng**, rồi mới đi tiếp. (f) Người dùng ghi đè được mức phân loại. |
| REQ-037 | Lan can hành vi cho vòng review và polish | P1 | **Đây là lan can dựa trên chỉ dẫn cộng giám sát, KHÔNG phải cơ chế chặn bằng mã.** Worker tự đếm và tự báo; Manager theo dõi và can thiệp. Một Worker cố tình phớt lờ thì không có gì chặn được ở Phase 1 — đây là hạn chế đã biết và được chấp nhận có ý thức; nghiệm thu vì vậy là bằng chứng quan sát trên bộ yêu cầu mẫu chứ không phải chứng minh tuyệt đối. (a) Mỗi lô thay đổi review **tối đa 2 lượt**: một lượt đầu, một lượt kiểm lại sau khi sửa mục chặn. (b) Hết 2 lượt mà còn mục chặn → **dừng, báo người dùng kèm danh sách còn lại**, không review lượt ba. (c) Mỗi đợt tạo hay cập nhật beads polish **tối đa 1 lượt**. (d) **Ngân sách sub-agent theo mức**: Nhỏ 1, Vừa 6, Lớn 10 — tính theo **số lần gọi** review hoặc polish, không phụ thuộc việc có tái dùng cùng một agent hay không. Chạm ngân sách thì phải hỏi người dùng mới được tạo thêm; người dùng cho phép thì phần vượt đó là **hợp lệ**, không tính là vi phạm. (e) Mức Nhỏ: đúng **1 lượt review duy nhất, thực hiện sau khi implement**, soi cùng lúc bead, thay đổi mã và kết quả kiểm thử; không polish. (f) Bộ đếm và `requestId` nằm trong báo cáo có cấu trúc (REQ-034). (g) **Manager theo dõi bộ đếm** và dừng Worker khi thấy vượt mà chưa được phép (REQ-020d). *(Errata 2026-09-17, [delta context-engineering](../design/paseo-bm-delta-20260917c-context-engineering.md) §5, quyết định owner Q17 và Q21: (d)(f) **plugin đếm** số lần gọi review từ dòng thời gian — Worker không còn tự đếm, `BM-REPORT` bỏ dòng `guardrail:` và trường `userAllowedExtra`; (g) khi request vượt ngân sách, plugin gửi Manager **một** thông báo `BM-BUDGET`, và Manager **hỏi người dùng** tiếp hay huỷ rồi chờ, **không tự huỷ**, vì người dùng có thể đã cho phép thẳng trong chat của Worker (REQ-026e). Lan can chuyển từ phòng ngừa sang phát hiện: có thể lọt một lượt review trước khi người dùng được hỏi. Luật theo lô (một lượt đầu, một lượt kiểm lại, còn chặn thì dừng và hỏi) và quyền tự huỷ một Worker kẹt của Manager (REQ-020d) không đổi. Bản chất vẫn là lan can hành vi, không có chốt chặn bằng mã.)* |
| REQ-034 | Báo cáo có cấu trúc từ Worker về Manager | P1 | (a) Worker gửi về một báo cáo có cấu trúc ở các mốc: nhận việc, xong phần tài liệu, xong phần beads, xong mỗi bead khi implement, khi vướng phải hỏi, và khi kết thúc. (b) Báo cáo tối thiểu gồm: giai đoạn đang ở, file đã đổi, bead đã tạo/cập nhật/đóng, bead đang sẵn sàng làm, phát hiện review còn lại, trạng thái build và test, và điều đang vướng nếu có. (c) Manager dựa vào báo cáo này cộng dòng hoạt động từ công cụ Paseo để trả lời REQ-020e — **không** dựa vào việc đọc hội thoại của Worker. (d) Worker bị dừng hoặc lỗi giữa chừng thì báo cáo cuối cùng vẫn cho biết nó dừng ở đâu và còn gì dang dở. |
| REQ-059 | Câu hỏi có cấu trúc của Worker và thẻ trả lời có lựa chọn | P2 | (Delta [`prd-delta-20260918c-question-cards`](paseo-bm-prd-delta-20260918c-question-cards.md), owner chốt Q40–Q48; (b)–(f) sửa theo delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md), owner chốt Q1–Q8 của `req-20260918T041426Z`.) (a) Khi hỏi người dùng, tin `blocked` của Worker có khối `BM-QUESTIONS` ngay sau `BM-REPORT`: tối đa 5 câu, mã `Q<n>` không lặp trong request, mỗi câu ≥ 2 lựa chọn có khoá chữ cái và cái giá, đúng một lựa chọn đề xuất; `blockers:` chỉ trỏ tới khối. (b) Trong chat Manager, báo cáo có khối hiện thành thẻ: mỗi câu một khối có tiêu đề đậm `Q<n> · <chủ đề>` và câu hỏi chữ thường; mỗi lựa chọn một hàng rộng hết thẻ, dấu đề xuất ở cuối hàng; "Khác" là hàng cuối; vạch ngăn giữa các câu; có tên Worker và request; không chọn sẵn. (c) Mỗi lần chọn (kể cả "dùng các đề xuất", "Clear", gõ "Khác") thẻ viết lại khối `BM-ANSWERS` ở đầu ô Reply và mở ô, giữ lời người dùng; không còn nút gửi riêng cho câu trả lời; một nút Send, gửi được khi ô có chữ; câu chưa trả lời không có dòng và vẫn mở. (d) Nút Send của mọi thẻ đọc lại trạng thái ngay trước khi gửi và chỉ gửi tới người nhận do plugin xác định (với thẻ câu hỏi: Worker duy nhất của request); không gửi, và nói lý do, khi không xác định được người nhận hay người nhận đang chạy, đang khởi tạo, đã đóng. (e) Câu trả lời là khối `BM-ANSWERS` (`Q<n>: <chữ cái> — <lựa chọn>` hoặc `Q<n>: other — <lời người dùng>`), một dòng cho mỗi câu đã trả lời, dù trả lời trong thẻ (khối đứng đầu, sau đó là lời người dùng) hay qua Manager. (f) Manager không nhắc lại thứ thẻ đã hiện, chỉ nói 1–2 dòng về điều thẻ không có (mỗi Worker đang chờ một dòng `A · <Worker> · <requestId>: Q6, Q7`, số gợi ý chưa làm, skill còn thiếu); báo cáo không có khối vẫn được liệt kê đủ; Manager nhóm theo chữ cái (nhãn như A6 khi trả lời trong chat), gửi mỗi Worker chỉ phần của nó, hỏi lại khi câu trả lời không khớp đúng một câu, không tự chọn thay. (g) Worker không làm theo câu trả lời cho câu không còn mở; câu thiếu đáp án được hỏi lại. (h) Báo cáo kiểu cũ vẫn như trước; bộ đọc `BM-REPORT` và kho vết không đổi. (i) Thẻ chat không có viền màu bên trái, tên người gửi màu chữ thường (chỉ biểu tượng vai trò có màu), giờ gửi ở dòng dưới tên; hơn 2 bead liên quan thì hiện 2 chip và một chip "…" để xem hết; gửi xong một Reply từ thẻ thì nút Reply ẩn đi và chip "Answered" hiện dưới chip trạng thái, bấm để mở lại ô Reply (chỉ nhớ trong phiên app). (j) Trong chat Manager, mỗi Worker đang chờ câu trả lời (báo cáo mới nhất là `blocked` có `BM-QUESTIONS`, Worker đang rảnh) có một pill cạnh các pill của Paseo; bấm mở popover hiện thẻ của báo cáo đó để trả lời ngay; pill tự mất khi Worker chạy lại hoặc báo cáo khác (đọc lại mỗi 15 giây). (k) Mọi bản của cùng một thẻ đổi trạng thái "đã trả lời" cùng lúc; thẻ câu hỏi hiện là đã trả lời khi câu trả lời được gửi từ thẻ trong phiên, khi người dùng bấm "Mark as answered" (dấu lưu trong thư mục cài, còn sau khi tải lại app), hoặc khi `chat.waiting` cho thấy Worker không còn chờ; pill không đổi theo dấu. (l) Thẻ của báo cáo `finished`, ở mọi chat vẽ nó, mở sẵn toàn bộ tin nhắn (nút "Hide message" gập lại) và có viền màu success bao quanh cả thẻ, cùng độ dày viền thường; đây là ngoại lệ duy nhất của (i), mọi thẻ khác giữ viền thường và gập tin như cũ. |
| REQ-061 | Plugin bắt buộc quy ước phối hợp giữa các agent | P1 | (Delta [`prd-delta-20260918g-agent-conventions`](paseo-bm-prd-delta-20260918g-agent-conventions.md), owner chốt Q1–Q14 của `req-20260918T071130Z`.) (a) Vai của một agent do plugin quyết theo nhãn `bm.role`, và khi thiếu nhãn thì theo provider `bm-manager` / `bm-worker` / `bm-reviewer` (kể cả `<provider>/<model>`), ở mọi chỗ plugin tìm agent: thẻ chat, pill chờ, Beads Manager, cây agent, `/bm-worker-stop-all`, dừng Reviewer, Dashboard; danh sách đọc hết mọi trang. (b) Trong chat của agent chỉ được nhận theo provider, mỗi thẻ có chip "Not started by paseo-bm"; cây agent ghi `· no label`. (c) Beads Manager mở Manager đang sống của workspace kể cả khi nó thiếu nhãn, Manager có nhãn được ưu tiên, không tạo Manager thứ hai và không đổi mode của Manager chỉ nhận theo provider. (d) Agent `bm-*` vừa tạo thiếu `bm.role` được gắn nhãn qua Paseo CLI (Manager kèm `bm.modeSet` = mode hiện tại); mỗi lần plugin nạp, một lượt quét (bắt đầu ở sự kiện agent đầu tiên) gắn nhãn cho agent `bm-*` chưa lưu trữ đang thiếu nhãn; lỗi chỉ tốn một dòng log. (e) Plugin kiểm mọi khối `BM-REPORT`, `BM-QUESTIONS`, `BM-ANSWERS`, `BM-REVIEW` agent gửi agent khác theo mẫu của ba file vai: đủ trường, không trường lạ, không trùng, trường `BM-REPORT` đúng thứ tự mẫu, giá trị hợp lệ, trường bead chỉ gồm bead id đầy đủ hoặc `none`, `BM-QUESTIONS` 1–5 câu có ≥ 2 lựa chọn chữ cái liên tiếp và đúng một `(recommended)`, báo cáo `blocked` có khối `BM-QUESTIONS`; tin người dùng tự gõ và thông báo của plugin không bao giờ bị kiểm. (f) Người gửi khối sai nhận thông báo `BM-FORMAT` liệt kê lỗi và yêu cầu gửi lại cả khối; không bao giờ gửi vào lượt đang chạy hay tới agent đã lưu trữ; chỉ khối mới nhất cùng loại của cùng request được báo; mỗi khối một lần, mỗi người gửi / request / loại tối đa 2 lần, quá thì chỉ còn chip và log. (g) Thẻ của khối sai có chip "template error" và danh sách lỗi khi mở tin. (h) Khi không vẽ được thẻ, tin vẫn trình bày như trong thẻ (mỗi trường một dòng, câu hỏi và lựa chọn tách dòng). (i) Chỉ dẫn Worker luôn có mục `## Runtime facts` nêu mode Reviewer: tra cứu mode hỏng thì dùng danh sách đọc được lần gần nhất, không có thì `auto`; mọi lần hỏng có một dòng log. (j) `manager.md`, `worker.md`, `reviewer.md` mỗi file có một luật cho tin `BM-FORMAT`: đó là thông báo của plugin, gửi lại cả khối đã sửa, không làm lại việc. |
| REQ-035 | Manager nhắc về skills khi máy còn thiếu | P1 | (a) Khi nhận một yêu cầu, Manager kiểm tra tình trạng skills khuyến nghị bằng cách **đọc trực tiếp ba thư mục skills** (`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, có tính tới biến môi trường ghi đè) và đối chiếu với danh sách skill bắt buộc nằm sẵn trong chỉ dẫn vai trò của nó — không cần thêm cơ chế nào khác. (b) Thiếu thì nhắc người dùng ngay trong câu trả lời, kèm lệnh bổ sung, rồi vẫn giao việc chứ không chặn. (c) Đây là đường thực hiện cho REQ-007(j). |
| REQ-025 | Theo dõi và tóm tắt kết quả | P1 | (a) Manager hiển thị trạng thái từng Worker theo thời gian thực. (b) Khi Worker xong, tóm tắt nêu: tài liệu đã tạo/sửa, bead đã tạo/cập nhật, bead nào đang sẵn sàng làm, và các phát hiện review chưa xử lý. (c) Worker lỗi hoặc bị huỷ giữa chừng → trạng thái nêu rõ, kèm những gì đã kịp thay đổi trên đĩa. |
| REQ-026 | Ranh giới an toàn và quyền quyết định của con người | P1 | (a) Worker được thay đổi **tài liệu, kho beads, và mã nguồn thuộc bead** — tất cả **trong phạm vi workspace đang mở**. Cấm tuyệt đối: commit, push, tạo pull request, chạy lệnh phá huỷ, ghi ra ngoài workspace, đọc file credential. Phải hỏi trước khi: cài phụ thuộc, chạy lệnh cần mạng, chạy migration trên dữ liệu thật, deploy hay publish. (b) Ranh giới này nằm trong chỉ dẫn khởi tạo agent và được nêu lại trong tóm tắt cho người dùng. (c) Manager không tự phê duyệt yêu cầu quyền thay người dùng. Manager được tạo ở chế độ không hỏi quyền của provider (Claude `bypassPermissions`, Codex `full-access`) khi profile `bm-manager` không tự đặt mode, và Manager đã có được chuyển sang chế độ đó **một lần** khi màn hình Manager mở lại nó — theo quyết định owner 2026-09-18 (Q31, Q36). Worker được tạo ở chế độ không hỏi quyền của provider (Claude `bypassPermissions`, Codex `full-access`, OpenCode tương đương); Reviewer được tạo ở chế độ tự động không mở toàn quyền hay quyền mạng (Codex `auto`, Claude `auto`) — theo quyết định owner 2026-09-15. Ranh giới ở ý (a) và luật chỉ đọc của Reviewer (REQ-024e) do chỉ dẫn vai trò bảo đảm và là lan can hành vi; với Manager và Worker không còn lời hỏi quyền của Paseo làm lớp chặn thứ hai. (d) **Worker phải hỏi lại trước khi làm những việc có tính quyết định**: sửa một tài liệu đã đóng băng, mở rộng phạm vi so với yêu cầu ban đầu, hay xoá/gộp bead đang có. Nó dừng và hỏi chứ không tự quyết. (e) **Người dùng chat thẳng với Worker được** để làm rõ yêu cầu hoặc chỉnh hướng, không bắt buộc phải nói qua Manager. (f) **Chỉ người dùng mới quyết định đóng hoặc xoá Worker.** Manager được phép **dừng** một Worker đang đi lạc hoặc treo (REQ-020d), nhưng không agent nào được lưu trữ hay xoá agent; xong việc thì Worker báo cáo rồi ở trạng thái nghỉ chờ người dùng xử lý. Dừng một Worker phải kéo theo dừng các Reviewer mà nó đang chạy, không để lại agent con mồ côi. (g) M-13: số lần tự ý commit hoặc push bằng 0 trên toàn bộ yêu cầu mẫu. |
| REQ-031 | Đăng ký vai trò agent vào Paseo và mở đúng quyền công cụ | P1 | (a) Khi cài, paseo-bm đăng ký các vai trò (Manager, Worker, Reviewer) vào Paseo dưới dạng cấu hình vai trò, kèm ghi chú "khi nào dùng" để cả người lẫn agent chọn đúng. (b) Manager và Worker phải có quyền dùng bộ công cụ Paseo, vì đó là cách chúng tạo và theo dõi agent khác; Reviewer thì không cần. (c) Trình cài đặt **báo trước rồi bật** công tắc cho phép agent dùng công cụ Paseo. Bước này **gộp chung một lần hỏi với việc bật plugin** (REQ-006), vì bật plugin mà không mở quyền công cụ thì Manager không tạo được Worker và sản phẩm vô dụng. Cảnh báo trong lần hỏi đó phải nêu **đủ cả hai hệ quả**: plugin là mã không sandbox, và mở quyền nghĩa là **mọi** agent trên máy được quyền tạo, nhắc và dừng agent khác. Không tương tác thì cần cờ tương ứng. Từ chối thì việc cài vẫn hoàn tất, nhưng plugin không chạy và Manager không tạo được Worker; `doctor` phải báo tiếp và tóm tắt nêu cách bật sau. (d) Gỡ cài đặt thì các vai trò do paseo-bm tạo bị xoá, còn vai trò do người dùng tự tạo thì giữ nguyên. (e) Cấu hình vai trò do người dùng sửa tay được giữ lại theo đúng quy tắc xung đột của REQ-008. |
| REQ-032 | Bộ chỉ dẫn vai trò đi kèm phiên bản | P1 | (a) Nội dung chỉ dẫn cho Manager, Worker và Reviewer được đóng gói cùng plugin, không phải viết tay lúc chạy. **Mọi nội dung dành cho agent — chỉ dẫn vai trò và prompt hệ thống — viết bằng tiếng Anh.** (b) Chỉ dẫn nêu rõ: trách nhiệm, ranh giới an toàn (REQ-026), quy trình feature-workflow phải bám, và khi nào phải dừng lại hỏi người dùng. (c) Cập nhật paseo-bm thì chỉ dẫn được cập nhật theo; chỉ dẫn người dùng đã sửa tay thì xử lý theo REQ-008. (d) Người dùng đọc được nội dung chỉ dẫn đang có hiệu lực. |
| REQ-027 | Cấu hình vai trò agent trong lúc cài | P1 | (a) Luồng cài hỏi tên và chọn công cụ kèm model cho **cả ba vai trò: Manager, Worker, Reviewer**, lấy danh sách từ các provider Paseo đang có. Reviewer hỏi riêng chứ không ghép mặc định với Worker (Q-020). (b) Provider chưa đăng nhập → báo rõ và mời chạy đúng lệnh đăng nhập của công cụ đó; đồng ý thì chạy hộ, từ chối thì in hướng dẫn. (c) **paseo-bm không bao giờ đọc, nhập hộ, hay lưu credential**; việc xác thực hoàn toàn do công cụ gốc lo. (d) Cấu hình lưu trong thư mục cài đặt của paseo-bm; chạy lại không hỏi lại trừ khi người dùng yêu cầu cấu hình lại. (e) Chế độ không tương tác: thiếu cấu hình thì dùng mặc định và ghi cảnh báo, không treo chờ nhập. |
| REQ-028 | Đổi cấu hình sau khi đã cài | P2 | Người dùng đổi được tên, công cụ, model cho từng vai trò mà không phải gỡ rồi cài lại; thay đổi có hiệu lực với Worker tạo sau đó. |
| REQ-029 | Giới hạn số Worker chạy song song | P2 | Có giới hạn cấu hình được; vượt giới hạn thì xếp hàng hoặc báo rõ thay vì tạo agent vô hạn. |
| REQ-030 | Lịch sử phiên làm việc | P2 | Xem lại được các yêu cầu đã giao, Worker tương ứng, và kết quả của từng lần. |
| REQ-016 | Nhắc về skills ngay trong Paseo | P2 | Plugin hiển thị trạng thái skills khuyến nghị trong giao diện Paseo kèm lệnh bổ sung; người dùng tắt được lời nhắc này. |
| REQ-017 | Agent profiles gợi ý cho quy trình beads | P2 | Có tuỳ chọn đăng ký các profiles (ví dụ planner, implementer). Profiles do người dùng tự tạo không bị thay đổi; gỡ cài đặt chỉ xoá profiles do paseo-bm tạo. |
| REQ-019 | Daemon từ xa | P3 | Cài, kiểm tra, gỡ plugin trên daemon chỉ định bằng host, kèm các kiểm tra tương đương REQ-002 và REQ-006. Làm rõ hành vi skills khi daemon ở máy khác (skills nằm ở máy chạy agent, không phải máy chạy lệnh). |

## 7. Non-Functional Requirements

- **Hiệu năng:** cài phần plugin theo M-2; lệnh kiểm tra ≤ 5 giây với daemon cục bộ, đã gồm phần dò skills. Thời gian chạy công cụ cài skills không tính vào M-2 vì phụ thuộc mạng và bên thứ ba.
- **Bảo mật:**
  - Không yêu cầu `sudo` hay quyền quản trị; paseo-bm chỉ tự ghi vào các vị trí được liệt kê trong README.
  - Với thư mục skills, paseo-bm truy cập **chỉ đọc**. Thay đổi duy nhất ở đó đến từ công cụ cài skills mà người dùng đã cho phép chạy.
  - **Chạy lệnh ngoài:** chỉ chạy đúng lệnh đã hiển thị cho người dùng, chỉ sau khi được đồng ý rõ ràng (hoặc có cờ cho phép ở chế độ không tương tác). Nguồn skills mặc định là hằng số trong gói, không lấy từ input không tin cậy. Nếu cho phép đổi nguồn thì phải hiển thị nguồn đó trước khi chạy.
  - Không đọc, in hay ghi credential. Mật khẩu daemon truyền qua biến môi trường (nếu có) bị che trong mọi output, kể cả JSON và log.
  - Thư mục cài đặt và hồ sơ cài đặt chỉ chủ tài khoản đọc/ghi được.
  - Tải gói bằng `npx` **không** được tự thay đổi hệ thống trước khi người dùng chạy lệnh và xác nhận.
  - Payload plugin cài đúng nội dung của phiên bản gói người dùng đã chọn. Nếu Technical Design cần tải thêm mã lúc cài (xem Q-004) thì ghi rõ lý do bằng ADR và cho người dùng thấy nguồn đó trong bản xem trước.
  - Gói npm được phát hành kèm provenance liên kết với mã nguồn GitHub.
  - Không có telemetry trong Phase 1.
- **Độ tin cậy:** theo REQ-010 (c)(d)(e); không bao giờ để cấu hình Paseo ở trạng thái daemon không nạp được.
- **Tương thích:**
  - Hệ điều hành: macOS, Linux. Trên Windows nguyên bản, báo không hỗ trợ và thoát sạch.
  - Paseo ≥ 0.8.0.
  - Phiên bản Node tối thiểu chốt ở Technical Design (Q-008).
- **Availability:** phần cài plugin chạy hoàn toàn cục bộ; sau khi `npx` đã tải gói thì không cần mạng. Bước hỗ trợ cài skills **cần mạng** và phụ thuộc GitHub cùng công cụ cài skills; khi không có mạng, công cụ vẫn cài plugin xong và chỉ cảnh báo.
- **Khả năng chẩn đoán:** mỗi lỗi có thông điệp và mã ổn định; có tuỳ chọn in chi tiết; tóm tắt cuối luôn có phiên bản paseo-bm, phiên bản Paseo, tình trạng skills và đường dẫn các vị trí đã dùng.

**Nhóm yêu cầu phi chức năng của phần điều phối (bổ sung 2026-09-15):**

- **Chi phí và điểm dừng:** mỗi yêu cầu sinh ra ít nhất ba phiên agent (Worker cộng các Reviewer). Worker phải có điểm dừng rõ ràng thay vì chạy vô hạn: hết phạm vi thì dừng, bí thì hỏi người dùng chứ không tự nới việc. Người dùng huỷ được một Worker bất cứ lúc nào, và huỷ phải dừng cả sub-agent của nó.
- **Tính có thể quan sát:** mọi hành động của Worker và Reviewer phải truy lại được từ Paseo — người dùng luôn xem được agent nào đang làm gì, đã sửa file nào.
- **Quyền:** Worker và Reviewer chạy bằng quyền của chính người dùng trong workspace đó. Worker chạy ở chế độ không hỏi quyền của provider; Reviewer chạy ở chế độ tự động không mở toàn quyền hay quyền mạng (REQ-026c). Manager chạy ở chế độ không hỏi quyền (REQ-026c) và không tự phê duyệt yêu cầu quyền của agent khác. Rủi ro đã biết: ranh giới an toàn của Manager và Worker chỉ còn nằm trong chỉ dẫn vai trò.
- **Riêng tư:** nội dung yêu cầu và mã nguồn đi tới nhà cung cấp model mà người dùng đã chọn cho vai trò đó. paseo-bm không gửi dữ liệu đi đâu khác và không có telemetry.
- **Chịu lỗi:** Worker chết giữa chừng không được để tài liệu hay kho beads ở trạng thái hỏng; phần đã ghi phải đọc được và Manager phải nêu rõ đã dừng ở đâu.
- **Tính quyết định (ở mức hợp lý):** cùng một yêu cầu không được sinh ra bead trùng lặp khi chạy lại; REQ-023 là cơ chế chính để bảo đảm điều đó.

## 8. Boundaries & Dependencies

- **Depends on:**
  - Paseo desktop/daemon + CLI ≥ 0.8.0: plugin API v0.8, lệnh quản lý plugin, cấu hình `pluginsEnabled`, cơ chế reload.
  - Quy ước thư mục skills của Claude Code, Codex và thư mục chung `~/.agents/skills` — paseo-bm chỉ **đọc**.
  - Công cụ cài skills chính thức (hiện dùng `npx skills`) — bên thực hiện mọi thay đổi trong thư mục skills.
  - Repo skills của bên thứ ba: `https://github.com/cuongntr/agent-skills` (tác giả `cuongntr`). Nội dung, tên skill và tính sẵn sàng nằm ngoài tầm kiểm soát của paseo-bm.
  - Node.js và npm registry (phân phối qua `npx`); GitHub repo `hieunt286/paseo-bm` (mã nguồn, release).
  - beads CLI (`br` hoặc `bd`): **bắt buộc** cho phần điều phối, vì Worker dùng nó để tạo và cập nhật beads. Vẫn không bắt buộc cho riêng việc cài.
  - **Khả năng tạo agent của Paseo** (SDK phía daemon): nền tảng để plugin sinh ra Worker. Nếu Paseo đổi hợp đồng này thì phần điều phối gãy.
  - **Các provider agent người dùng chọn** (Claude, Codex, OpenCode…) cùng hạn mức và trạng thái đăng nhập của chúng.
  - **Bộ skills feature-workflow** trên máy: quyết định chất lượng đầu ra của Worker.
- **Does NOT own:**
  - **Nội dung và vòng đời của skills**: thuộc tác giả repo skills và công cụ cài skills. paseo-bm không bảo trì, không fork, không vá.
  - **Chất lượng suy luận của model và chi phí dùng model**: paseo-bm chọn công cụ theo cấu hình người dùng và dừng ở đó.
  - **Chất lượng cuối cùng của mã**: Worker viết mã và chạy kiểm thử của repo, nhưng việc xem lại và quyết định đưa vào lịch sử git vẫn thuộc người dùng.
  - **Quản lý nhánh và git**: Worker không commit, không push, không merge.
  - Vòng đời của Paseo và daemon. Trong `config.json`, paseo-bm chỉ chạm tới việc đăng ký plugin `paseo-bm` và công tắc `pluginsEnabled` (có đồng ý).
  - Plugins, providers, profiles do công cụ khác hoặc người dùng tạo.
  - Dữ liệu beads trong các project; credential và đăng nhập provider.
  - Tính năng nghiệp vụ của plugin (Reporter/Tracker/Implementation): PRD riêng.

## 9. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 1 MVP | **Vòng lặp cốt lõi chạy được đầu-cuối.** Trình cài đặt `npx paseo-bm` (REQ-001 → REQ-015) + cấu hình vai trò agent lúc cài (REQ-027) + plugin có cả client và server entry + Beads Manager, Beads Worker, Reviewer (REQ-020 → REQ-026) | Mọi AC P1 đạt; CI trên macOS và Linux chạy test trên **gói npm đã đóng gói**; demo trên HOME sạch đạt M-1 → M-9; **bộ 5 yêu cầu mẫu đạt M-10 → M-14 trên một repo thật**; một phiên bản prerelease có trên npm kèm provenance; README đạt REQ-015 |
| Phase 2 MVP | Bảng theo dõi và báo cáo tiến độ bead trong Paseo; REQ-016, REQ-017, REQ-028, REQ-029, REQ-030 | Người dùng xem được tiến độ bead của workspace ngay trong Paseo; đổi cấu hình vai trò không cần cài lại; có giới hạn số Worker song song; cập nhật từ Phase 1 lên Phase 2 bằng một lệnh, đạt REQ-010 |
| Phase 3 MVP | REQ-019 daemon từ xa; đánh giá hỗ trợ WSL/Windows; thông báo có phiên bản mới; cân nhắc lớp chặn ngân sách bằng mã thay cho lan can hành vi hiện tại | AC REQ-019 đạt trên một daemon từ xa thật; quyết định hỗ trợ Windows được ghi lại; nếu mở rộng sang implement thì phải có PRD sửa đổi riêng vì đó là ranh giới rủi ro khác hẳn |

> **Cảnh báo phạm vi:** Phase 1 giờ gánh cả trình cài đặt lẫn vòng lặp điều phối. Đây là hệ quả của quyết định gộp hai phần thành một sản phẩm. Nếu khi lập kế hoạch thấy Phase 1 quá lớn để demo được đầu-cuối, hãy tách thành Phase 1a (cài đặt + plugin có server entry chạy được) và Phase 1b (Manager, Worker, Reviewer) thay vì cắt bớt phần review — bỏ review là bỏ đúng thứ làm nên chất lượng của sản phẩm này.

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Payload Phase 1 gồm những gì? → **Chỉ plugin.** Không đóng gói skills trong gói npm. | hieu.nt10 | answered (2026-09-14) |
| Q-002 | Nguồn skills khuyến nghị cho người dùng công khai → **`https://github.com/cuongntr/agent-skills`** (repo của tác giả khác), ghi trong README. | hieu.nt10 | answered (2026-09-14) |
| Q-003 | Xử lý skill trùng tên do công cụ khác cài → paseo-bm không tự ghi vào thư mục skills; việc trùng lặp do công cụ cài skills xử lý. | hieu.nt10 | answered (2026-09-14) |
| Q-004 | Đăng ký plugin từ thư mục payload đi kèm gói npm, hay từ Git source ghim theo tag? Ảnh hưởng NFR "payload đúng phiên bản / không cần mạng". | hieu.nt10 | deferred — Technical Design / ADR |
| Q-005 | Agent đích Phase 1 → **Claude Code và Codex** (kèm thư mục chung `~/.agents/skills`). | hieu.nt10 | answered (2026-09-14) |
| Q-006 | Tên gói npm: `paseo-bm` không scope (còn trống trên npm ngày 2026-09-14). Nên giữ tên sớm bằng một bản prerelease. | hieu.nt10 | answered |
| Q-007 | "BM" nghĩa là gì → **Beads Management**. Tên sản phẩm: `paseo-bm`. | hieu.nt10 | answered (2026-09-14) |
| Q-008 | Node tối thiểu, và chính sách tương thích Paseo (chỉ `>=0.8.0` hay có chặn trên)? | hieu.nt10 | deferred — Technical Design |
| Q-009 | Danh sách skills paseo-bm dò → **5 skill nhóm bắt buộc** ở Phụ lục A; 2 skill còn lại xếp nhóm tuỳ chọn. Còn phải chốt: danh sách cố định trong gói hay cho cấu hình (gắn với Q-011). | hieu.nt10 | answered một phần (2026-09-14) |
| Q-010 | Nội dung repo skills → **đã publish 2026-09-14**, 7 skill ở thư mục gốc, khảo sát đầy đủ ở Phụ lục A. Còn phải xác nhận với tác giả: lệnh cài chính thức (`npx skills add cuongntr/agent-skills`) đã đúng chưa, và repo có được giữ ổn định về tên thư mục không. | hieu.nt10 | answered một phần (2026-09-14) |
| Q-011 | Người dùng có được đổi nguồn skills sang repo khác bằng cờ/biến môi trường không, hay cố định một nguồn? Ảnh hưởng bảo mật (chạy lệnh ngoài với tham số do người dùng cấp). Đề xuất Phase 1: cố định. | hieu.nt10 | open |
| Q-012 | Repo skills **chưa có LICENSE và README** (kiểm tra 2026-09-14). paseo-bm chỉ trỏ tới chứ không phát hành lại nên rủi ro thấp, nhưng nên đề nghị tác giả bổ sung để người dùng biết điều khoản sử dụng. | hieu.nt10 | open |
| Q-018 | Cách giao việc → **người dùng chat thẳng với Manager**, và Manager giao ngay xuống Worker. Plugin chỉ là lối vào để mở Manager cho workspace hiện tại | hieu.nt10 | answered (2026-09-15) |
| Q-019 | Manager là gì → **hoàn toàn là một agent**, không phải giao diện. Trách nhiệm: quản lý, kiểm soát, và trả lời về tiến độ; được dùng bộ công cụ Paseo để nắm và điều khiển các agent | hieu.nt10 | answered (2026-09-15) |
| Q-020 | Công cụ cho Reviewer → **hỏi người dùng lúc cài**, không đặt mặc định ghép sẵn với Worker. Bước cấu hình vai trò hỏi riêng cho từng vai trò (REQ-027a) | hieu.nt10 | answered (2026-09-15) |
| Q-021 | Tiêu chí "bead liên quan" → **dựa trên nhãn**. Khi tạo bead thì tự gán bộ nhãn phù hợp; khi cần kiểm tra thì truy vấn kho beads theo chính bộ nhãn đó rồi xét các bead chưa đóng trong tập kết quả. Xem REQ-033 | hieu.nt10 | answered (2026-09-15) |
| Q-022 | Quyền quyết định → **Worker phải hỏi lại** trước khi làm việc có tính quyết định; người dùng chat thẳng với Worker được; và **chỉ người dùng** mới đóng hoặc xoá Worker | hieu.nt10 | answered (2026-09-15) |
| Q-023 | Giới hạn của Worker → **không có giới hạn cứng**. Worker chạy tiếp cho tới khi implement xong các bead thuộc yêu cầu; vướng ở bất kỳ đâu thì hỏi lại rồi đi tiếp. Xem REQ-022(e)(f) | hieu.nt10 | answered (2026-09-15) |
| Q-024 | Mở quyền công cụ Paseo → **báo trước rồi bật `daemon.mcp.injectIntoAgents`** trong lúc cài, kèm cảnh báo rõ ảnh hưởng. Vẫn giữ `paseoTools` theo vai trò làm lớp thu hẹp thêm nếu nó có tác dụng. Xem REQ-031(c) | hieu.nt10 | answered (2026-09-15) |
| Q-027 | Ngôn ngữ tài liệu Worker tạo cho **repo đích** → **theo ngôn ngữ đang có của repo đích**; repo chưa có tài liệu nào thì mặc định tiếng Anh. Nội dung dành cho agent thì luôn tiếng Anh | hieu.nt10 | answered (2026-09-15) |
| Q-025 | Một workspace có nên giới hạn đúng một Manager không, và khi Manager bị người dùng xoá thì lối vào của plugin xử lý thế nào? | hieu.nt10 | open |
| Q-013 | Nguồn skills mới có 1 commit, **không có tag hay số phiên bản**. paseo-bm có ghim theo commit/nhánh khi gọi công cụ cài skills không, hay luôn lấy bản mới nhất? Ảnh hưởng khả năng phát hiện "skill lỗi thời" và tính tái lập của bản cài. | hieu.nt10 | open |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918g-agent-conventions`](paseo-bm-prd-delta-20260918g-agent-conventions.md)** (owner chốt Q1–Q14 của `req-20260918T071130Z`): thêm REQ-061 — plugin nhận vai theo provider khi thiếu nhãn và gắn nhãn, kiểm template các khối `BM-*` và gửi `BM-FORMAT`, chip trên thẻ, bản dự phòng đọc được, mode Reviewer dự phòng. Không đổi REQ nào khác. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Request `req-20260918T074311Z` theo delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md) §1.6** (owner chốt Q1–Q4 của request đó): thêm ý (l) của REQ-059 — thẻ `finished` mở sẵn tin nhắn và có viền success. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Batch `b6` của delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md)** (owner chốt Q16–Q18): thêm ý (k) của REQ-059 — trạng thái "đã trả lời" đồng bộ và nút "Mark as answered" lưu bền. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Batch `b5` của delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md)** (owner chốt Q15 b): thêm ý (j) của REQ-059 — pill câu đang chờ phía trên chat Manager, trả lời trong popover. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Batch `b4` của delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md)** (owner chốt Q11–Q14): thêm ý (i) của REQ-059 — trình bày thẻ chat và chip "Answered". Bấm tên Worker để mở Worker chưa làm được với Paseo 0.8 (đề nghị gửi Paseo); chip câu đang chờ phía trên khung chat là request riêng. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918d-card-replies`](paseo-bm-prd-delta-20260918d-card-replies.md)** (owner chốt Q1–Q8 của `req-20260918T041426Z`): REQ-059 (b)–(f) — Manager không nhắc lại thứ thẻ đã hiện; lựa chọn trong thẻ viết khối `BM-ANSWERS` vào ô Reply, một nút Send; nút Send của mọi thẻ đọc lại trạng thái và không gửi vào lượt đang chạy; thẻ câu hỏi trình bày lại. (a), (g), (h) và các REQ khác không đổi. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta [`prd-delta-20260918-manager-mode-model-metrics`](paseo-bm-prd-delta-20260918-manager-mode-model-metrics.md)** (owner chốt Q31, Q36): REQ-026c và NFR Quyền — Manager chạy ở chế độ không hỏi quyền; Manager đã có được chuyển một lần, đánh dấu bằng nhãn `bm.modeSet`. Rủi ro owner chấp nhận: giới hạn của Manager chỉ còn là lan can hành vi. Nghiệm thu trên daemon thật **chưa làm** — ngoại lệ theo quyết định owner, không phải đạt |
| 2026-09-18 | hieu.nt10 (soạn bởi Beads Worker) | **Áp dụng delta `prd-delta-20260918c-question-cards`** (owner chốt Q40–Q48): thêm REQ-059 — Worker hỏi bằng khối `BM-QUESTIONS`, thẻ trong chat Manager có nút lựa chọn và gửi `BM-ANSWERS` thẳng tới Worker đang hỏi, Manager nhóm câu hỏi theo Worker. Không đổi REQ nào khác. Status giữ Accepted |
| 2026-09-18 | hieu.nt10 (soạn bởi Claude) | **Errata REQ-013d và REQ-015 theo delta `prd-delta-20260918b-short-readme`** (quyết định owner): README ngắn trỏ tới site https://paseo-bm.erai.pro và `GUIDE.md`; phần tham chiếu REQ-015 đòi hỏi chuyển nguyên văn sang `GUIDE.md` ở gốc repo. "README" theo nghĩa tài liệu tham chiếu trong PRD, design và ADR nay hiểu là `README.md` cùng `GUIDE.md`. Status giữ Accepted |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Errata REQ-037 theo delta `design-delta-20260917c-context-engineering`** (quyết định owner Q17, Q21): plugin đếm ngân sách review và báo Manager một lần khi vượt; Manager hỏi người dùng, không tự huỷ; Worker thôi tự đếm; `BM-REPORT` bỏ dòng `guardrail:`. Status giữ Accepted |
| 2026-09-17 | hieu.nt10 (soạn bởi Claude) | **Áp dụng delta `design-delta-20260917-workflow-skills`** theo 9 quyết định owner chốt sau lượt chạy thật 2026-09-16: REQ-036/REQ-037 — Worker chạy skill quy trình theo mức (Lớn đủ 5, Vừa theo điều kiện), `reviewing-plan` và `polishing-beads` là lượt của Worker không tính ngân sách review 1 / 4 / 6, bead leaf theo hợp đồng của converter, vòng hỏi quyết định/rủi ro bắt buộc (tối đa 5 câu qua `blocked`, không tự lấy mặc định), đóng bead ngay sau kiểm tra và mở lại khi review chặn; REQ-024/REQ-026 — Reviewer dùng tiêu chí theo giai đoạn và được chạy test cùng script thử trong `mktemp -d` mà không đổi repo, Worker chỉ được ghi file tạm trong `mktemp -d`; REQ-034 — `BM-REPORT` thêm `skillsUsed`. Status giữ Accepted |
| 2026-09-16 | hieu.nt10 (soạn bởi Claude) | **Áp dụng delta `design-delta-20260916-trace-store`** do owner duyệt: REQ-010 thêm ý (f) — cập nhật không bao giờ xoá kho lưu vết của Dashboard, kể cả `--prune` và kể cả khi di trú lược đồ; REQ-012 thêm ý (i) — lệnh gỡ liệt kê kho riêng, hỏi riêng, và chế độ không tương tác cần cờ riêng. Phạm vi Phase 1 không đổi; chi tiết tính năng nằm ở [PRD Dashboard](./paseo-bm-dashboard-prd.md) |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | REQ-026c và NFR Quyền: Worker chạy ở chế độ không hỏi quyền, Reviewer ở chế độ tự động không mở toàn quyền hay mạng, theo delta `prd-delta-20260915-subagent-modes` do owner duyệt |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | M-10 đổi ngưỡng từ ≤ 5 giây sang **≤ 60 giây** và bỏ cách đo bằng SDK giả lập (M-10, REQ-021e), theo delta `plan-v2-delta-20260915-m10` do owner duyệt; số đo 30,8–37,6 giây trên daemon thật |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Tạo bản đầu tiên; chuyển sang Review để owner duyệt |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Chốt Q-001, Q-003, Q-005, Q-007: chỉ cài plugin, không đóng gói/không ghi skills; dò và hướng dẫn skills cho Claude Code + Codex; BM = Beads Management. REQ-007 đổi từ "cài skills" thành "kiểm tra và hướng dẫn"; thêm M-8, REQ-016, Q-009; bỏ REQ-018 |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Chốt Q-002: README tham chiếu `github.com/cuongntr/agent-skills`. REQ-007 mở rộng: khi thiếu skills thì đề nghị chạy hộ công cụ cài skills chính thức (có đồng ý rõ ràng, hiển thị đúng lệnh, có cờ riêng cho chế độ không tương tác), paseo-bm vẫn không tự ghi file skills. Thêm M-9, Q-010 (repo skills đang trống), Q-011 (có cho đổi nguồn không); cập nhật §7 bảo mật về chạy lệnh ngoài và §8 phụ thuộc bên thứ ba |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Nguồn skills đã publish: thêm Phụ lục A (khảo sát 7 skill, phân nhóm bắt buộc/tuỳ chọn); REQ-007b trỏ vào danh sách đó và nêu rõ Phase 1 chỉ so tên, không so phiên bản; Q-009 và Q-010 chuyển sang *answered một phần*; thêm Q-012 (thiếu LICENSE/README) và Q-013 (không có tag để ghim phiên bản) |

| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Lượt review thứ hai bằng Codex chỉ ra REQ-037 chưa phải cơ chế cứng và nhiều phát biểu cũ còn sót. Owner chốt ba điều: **gọi đúng tên là lan can hành vi** thay vì trần cứng, kèm ghi nhận hạn chế; mức Nhỏ có **đúng một lượt review sau khi implement**, soi cùng lúc bead, mã và kiểm thử; **ngân sách sub-agent theo mức** (Nhỏ 1, Vừa 6, Lớn 10) tính theo số lần gọi, phần vượt đã được cho phép thì hợp lệ. Kèm dọn mâu thuẫn: REQ-026(a) nay cho Worker sửa mã trong workspace; bỏ phát biểu "Worker dừng ở beads" ở §8 và "cân nhắc implement" ở Phase 3; sửa mục ngoài phạm vi vốn cấm đăng ký provider/profile trái REQ-031; REQ-036 đổi sang **quy tắc có thứ tự, rủi ro thắng kích thước**, không dùng số bead làm căn cứ; REQ-027 nêu đủ ba vai trò; REQ-035 chốt đường dữ liệu là đọc thẳng ba thư mục skills; M-17 chỉ tính phần vượt **chưa được cho phép**; M-18 đo số file tài liệu mới |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Owner bổ sung hai ràng buộc vận hành: **REQ-036** phân loại quy mô yêu cầu (Nhỏ / Vừa / Lớn) với đường làm riêng cho từng mức — việc lặt vặt không phải đi qua cả bộ quy trình, việc lớn phải hỏi trước khi implement; và **REQ-037** trần cứng cho vòng review và polish (mỗi lô tối đa 2 lượt review, mỗi đợt beads tối đa 1 lượt polish, một yêu cầu tối đa 4 sub-agent, chạm trần thì dừng và hỏi, Manager giám sát). Thêm M-17, M-18 |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Sau lượt review độc lập bằng Codex: gộp đồng ý bật plugin với mở quyền công cụ agent thành **một lần hỏi** nên M-1 giữ 3 xác nhận; Manager **được dừng nhưng không được xoá** agent (REQ-020d, REQ-026f); M-13 đổi sang bằng chứng ảnh chụp hệ thống file và timeline lệnh vì `git reflog` không phát hiện push hay tạo PR; thêm REQ-034 (báo cáo có cấu trúc từ Worker, lấp chỗ Manager không đọc được hội thoại) và REQ-035 (Manager nhắc skills, lấp REQ-007j chưa có đường thực hiện); REQ-024 thêm định nghĩa **lô review** và cấm Reviewer tạo agent; chốt Q-020 (hỏi lúc cài) và Q-027 (theo repo đích) |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Chốt Q-021, Q-023, Q-024 và quy tắc ngôn ngữ. **Phạm vi Worker mở rộng: chạy tiếp tới khi implement xong** thay vì dừng ở beads (REQ-022 e→g), không có giới hạn cứng, vướng thì hỏi. Thêm REQ-033 (gán nhãn khi tạo bead, truy vấn theo nhãn khi tìm việc liên quan). REQ-031(c) đổi sang **báo trước rồi bật** `daemon.mcp.injectIntoAgents`. REQ-032(a) thêm quy tắc: mọi nội dung dành cho agent viết bằng **tiếng Anh**. Thêm M-15, M-16; bỏ mục ngoài phạm vi "Worker tự viết mã"; thêm Q-027 về ngôn ngữ của tài liệu do Worker tạo cho repo đích |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Chốt Q-018, Q-019, Q-022: **Manager là một agent thật**, người dùng chat thẳng với nó và nó giao ngay xuống Worker; Manager dùng bộ công cụ Paseo để theo dõi và kiểm soát; Worker phải hỏi lại trước việc có tính quyết định, người dùng chat thẳng với Worker được, và **chỉ người dùng** mới đóng hoặc xoá Worker. Viết lại REQ-020, REQ-021, REQ-026; thêm REQ-031 (đăng ký vai trò và mở quyền công cụ hẹp nhất) và REQ-032 (bộ chỉ dẫn vai trò đi kèm phiên bản); thêm Q-024 (cách mở quyền công cụ — đang chặn thiết kế REQ-031) và Q-025. Đã kiểm chứng trên daemon thật: agent con vẫn là agent hạng nhất trong workspace nên người dùng mở, chat, lưu trữ và xoá được |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | **Sửa đổi trọng yếu: bổ sung phần điều phối — giá trị cốt lõi của sản phẩm mà bản trước bỏ sót.** Owner chốt bốn hướng: gộp trình cài đặt và Beads Manager thành **một sản phẩm** (thay cho việc tách PRD Phase 2 riêng); plugin có **cả server entry** và dùng Paseo SDK để tạo agent; phần xác thực **uỷ quyền cho công cụ gốc**, paseo-bm không chạm credential; Beads Worker chạy **cùng workspace** với người dùng. Thêm §1.1, hai actor không phải người, ba journey J-6 → J-8, REQ-020 → REQ-030, nhóm NFR điều phối, chỉ số M-10 → M-14, và Q-018 → Q-023. Roadmap cắt lại. **Status quay về Review**: đây là sửa đổi trọng yếu trên một PRD đã Accepted nên phải qua lại cổng `prd-ready` trước khi Technical Design, plan và bead graph được cập nhật theo |
| 2026-09-15 | hieu.nt10 (soạn bởi Claude) | Lượt review plan phát hiện REQ-011a bất khả thi như đã viết: muốn biết daemon và plugin đang thế nào thì buộc phải gọi lệnh Paseo. Sửa thành "không ghi gì, không chạm mạng, chỉ gọi lệnh Paseo chỉ-đọc, không bao giờ gọi CLI `skills`" |
| 2026-09-14 | hieu.nt10 (soạn bởi Claude) | Sau khi Technical Design và ADR-001 → ADR-004 hoàn tất: REQ-007d bổ sung việc người dùng nhập/sửa danh sách agent đích. Các quyết định còn lại của owner (symlink, giữ toàn bộ phiên bản và backup, thứ tự đăng ký plugin) là mức thiết kế nên nằm ở [Technical Design](../design/paseo-bm.md) |

## 12. Phụ lục A — Khảo sát nguồn skills khuyến nghị

Khảo sát ngày **2026-09-14**, tại commit `efc5000` (commit đầu tiên và duy nhất, push lúc 11:00 UTC).

**Thông tin chung**

| Mục | Giá trị |
|---|---|
| Repo | https://github.com/cuongntr/agent-skills (public) |
| Nhánh mặc định | `main` |
| Số commit | 1 (`efc5000` — "Initial commit: add agent skills") |
| Bố cục | Mỗi skill là một thư mục ở **gốc repo**, bên trong có `SKILL.md` |
| Quy mô | 7 skill · 33 file · ~3.950 dòng Markdown · ~300 KB |
| LICENSE / README | **Chưa có** (xem Q-012) |
| Tag / phiên bản | **Chưa có** (xem Q-013) |

**Danh sách skills**

| Skill | Nhóm | File | Dòng MD | Dung lượng | Vai trò |
|---|---|---|---|---|---|
| `feature-workflow` | Bắt buộc | 22 | 2.551 | 200 KB | Quy trình đầu-cuối theo mức rủi ro: Intake → PRD → Design → Plan → Beads → đóng feature. Là skill lớn nhất, kèm checklists, templates, references |
| `reviewing-plan` | Bắt buộc | 1 | 108 | 8 KB | Rà và sửa trực tiếp execution plan cho đủ điều kiện chuyển thành beads |
| `converting-plan-to-beads` | Bắt buộc | 2 | 359 | 24 KB | Chuyển plan thành đồ thị bead phân cấp, có phụ thuộc, dùng `br`/`bd` |
| `polishing-beads` | Bắt buộc | 2 | 282 | 20 KB | Audit độ sẵn sàng của đồ thị bead: kích cỡ leaf, tính đúng của phụ thuộc |
| `implementing-beads` | Bắt buộc | 1 | 314 | 20 KB | Chọn bead làm được, thực thi, nghiệm thu theo DoD, đóng bead |
| `architecture-premise-audit` | Tuỳ chọn | 1 | 93 | 8 KB | Audit toàn dự án khi nghi ngờ chọn sai kiểu kiến trúc; chỉ dùng khi được yêu cầu rõ |
| `authoring-workspace-protocol` | Tuỳ chọn | 4 | 244 | 20 KB | Soạn/sửa `docs/WORKSPACE_PROTOCOL.md` của một repo |

**Nhận xét ảnh hưởng tới thiết kế**

- Năm skill nhóm bắt buộc phủ trọn vòng đời beads, khớp đúng mục đích của plugin, nên là danh sách paseo-bm dò (REQ-007b).
- Hai skill nhóm tuỳ chọn không nằm trong vòng đời beads. Thiếu chúng không phải là vấn đề, chỉ liệt kê như gợi ý.
- Bố cục skill ở gốc repo trùng với kiểu mà công cụ cài skills đang dùng cho các nguồn Git khác trên máy owner, nên `npx skills add cuongntr/agent-skills` nhiều khả năng chạy được; vẫn cần xác nhận thực tế (Q-010).
- Đối chiếu với máy owner: 5 skill nhóm bắt buộc **đã có sẵn và giống hệt từng byte** với bản đang cài từ kho nội bộ; 2 skill tuỳ chọn chưa cài. Nghĩa là repo public này là bản mirror, và dò theo tên thư mục là đủ chính xác.
- Repo chưa có tag nên không so được phiên bản; Phase 1 chỉ kết luận "có" hoặc "thiếu" (Q-013).
