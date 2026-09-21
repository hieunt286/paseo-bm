# Checklist nghiệm thu — delta 20260921 (worker-fallback-and-role-settings)

| Trường | Giá trị |
|---|---|
| Nguồn | [PRD delta §5](../product/paseo-bm-prd-delta-20260921-worker-fallback-and-role-settings.md#5-bằng-chứng-thành-công), [design delta §8](../design/paseo-bm-delta-20260921-worker-fallback-and-role-settings.md#8-testing-strategy), [plan delta §1.3](../plans/paseo-bm-implementation-plan-delta-20260921-worker-fallback-and-role-settings.md#13-điều-kiện-ra) |
| Người chạy | owner (hieu.nt10), trên daemon thật, sau `finished` của mỗi phase |
| Nguyên tắc ghi điểm | Mục nào chưa đo thì ghi **Chưa đo**, không bao giờ ghi Đạt. Mục không đạt thì ghi **Không** kèm số đo |

Mỗi phase có một phần riêng, thêm vào khi bead đóng phase đó chạy.

## Chuẩn bị chung, và đường lùi

> **Cảnh báo:** **không** cài bản mới hay `paseo plugin reload` khi còn một agent `bm-*` đang chạy — việc đó ngắt lượt của agent (bài học lượt 2026-09-16).

| # | Bước | Ghi lại |
|---|---|---|
| 1 | Đọc `~/.paseo-bm/install.json` (`version`, `roles[]`) | phiên bản cũ, để khôi phục |
| 2 | Chụp `~/.paseo/config.json` (mục `agents.providers.bm-*` và `daemon.agentProfiles`) | ảnh trước |
| 3 | `npm run build` trong repo, trên commit của phase cần kiểm | bản dựng dùng để kiểm |
| 4 | `node dist/index.js install --home ~/.paseo-bm` | output, mã thoát |

**Đường lùi:** `npx paseo-bm@<phiên bản cũ>` cài lại bản trước. Các giá trị bạn đặt trên mục `bm-*` không bị bản mới xoá; bản cũ sẽ thay nguyên mục đó ở lần ghi kế tiếp của nó.

## Phase 2a-13 — `0.2.0-alpha.2` (REQ-062)

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 13.1 | Thinking của profile tới Worker | Settings → Agent profiles → profile **Worker** (`bm-worker`) → Thinking = `max` → lưu. Giao Manager một yêu cầu Nhỏ | Worker mới chạy thinking `max`: Dashboard → request → nút Worker ghi `thinking: max` (`runtimeInfo.thinkingOptionId`) cho **100%** Worker tạo sau đó | Chưa đo |
| 13.2 | Thinking của profile tới Reviewer | Như 13.1 với profile **Reviewer** (`bm-reviewer`), ví dụ `high` | Reviewer mới chạy `high` | Chưa đo |
| 13.3 | Cài lại không xoá | Sau 13.1, chạy lại `node dist/index.js install --home ~/.paseo-bm` | Bản xem trước báo 0 thay đổi cấu hình; `thinkingOptionId: "max"` vẫn nằm trên profile `bm-worker` trong `~/.paseo/config.json` | Chưa đo |
| 13.4 | `--role` chỉ đổi đúng vai trò | `node dist/index.js install --home ~/.paseo-bm --role worker=<provider>/<model khác>` | Profile `bm-worker` đổi `model`, **mất** `thinkingOptionId`, giữ `modeId` nếu có; profile `bm-manager` và `bm-reviewer` không đổi byte nào | Chưa đo |
| 13.5 | `doctor` báo đổi trong app | Trong Settings, đổi model của Worker; chạy `node dist/index.js doctor` | Có dòng `bm-worker: base provider or model differs from what the installer wrote (changed in the app).`; mã thoát không đổi so với trước khi đổi | Chưa đo |

## Phase 2a-14 — `0.3.0-alpha.0` (REQ-063)

Cần một provider OpenCode và một provider Pi `available` trên daemon. Đổi provider gốc của vai trò bằng `node dist/index.js install --home ~/.paseo-bm --role <vai trò>=<provider>/<model>`, và trả lại như cũ sau mỗi kiểm.

| # | Kiểm | Cách làm | Kết quả mong đợi | Kết quả |
|---|---|---|---|---|
| 14.1 | Worker trên OpenCode làm xong một yêu cầu Nhỏ | `--role worker=opencode/<model>`; mở Beads Manager, giao một yêu cầu Nhỏ trên fixture nghiệm thu | Worker được tạo với một agent OpenCode (mode) và `auto_accept` bật; Manager nhận cả `received` và `finished` | Chưa đo |
| 14.2 | Reviewer trên OpenCode được tạo | `--role reviewer=opencode/<model>`; một yêu cầu Nhỏ | Reviewer được tạo **không lỗi**, `auto_accept` **tắt**; nếu agent OpenCode hỏi quyền, yêu cầu duyệt hiện trong Paseo | Chưa đo |
| 14.3 | Reviewer trên Pi được tạo | `--role reviewer=pi/<model>`; một yêu cầu Nhỏ | Reviewer được tạo không lỗi, không có mode; `## Runtime facts` của Worker ghi `Reviewer mode: none` | Chưa đo |
| 14.4 | Worker Pi thiếu `pi-mcp-adapter` sinh `BM-TOOLS` | Trên máy chưa có adapter: `--role worker=pi/<model>`; giao một yêu cầu | Chat Manager nhận `BM-TOOLS …` trước khi lượt đầu của Worker kết thúc; màn Setup có dòng cảnh báo Worker | Chưa đo |
| 14.5 | Tín hiệu `supportsMcpServers` | Như 14.4, rồi `get_agent_status` của Worker Pi | `capabilities.supportsMcpServers` là `false`. **Nếu là `true` hay không có**, ghi lại nguyên văn và báo: tín hiệu của thiết kế §4.2.4 sai | Chưa đo |
| 14.6 | Tín hiệu nạp skill trên OpenCode và Pi | Sau 14.1 và 14.3, mở Dashboard → request | Cột skill của Worker OpenCode / Reviewer Pi: ghi lại có hay "không ghi nhận" (giới hạn đã biết, thiết kế §4.2.8) | Chưa đo |
| 14.7 | Cột skill Pi và OpenCode | Mở Beads Manager → Setup | Có cột Pi (`~/.pi/agent/skills`) và OpenCode (`~/.config/opencode/skill`) | Chưa đo |
| 14.8 | Giá theo `metadata.cost` | Sau 14.1, Dashboard → request | Lượt của Worker OpenCode có tiền (không chỉ token) | Chưa đo |

