# paseo-bm 0.3.0

**Bản ổn định đầu tiên**, và bản đầu tiên chạy được với **Paseo 0.9.2**.

Từ bản này, dist-tag `latest` do chính `release.yml` đặt bằng OIDC. Trước đây mọi bản đều là prerelease vào `next`, còn `latest` do owner dời tay bằng `npm dist-tag add` — một bước cần OTP, và nó vừa biến mất. `latest` trước bản này trỏ `0.3.0-alpha.7`.

**Cài bản này:** `npx paseo-bm`, hoặc ghim cứng `npx paseo-bm@0.3.0`. Cách cài không đổi. Như mọi bản, hai gói `paseo-bm` và `paseo-bm-plugin` cùng phiên bản.

## Trình cài đặt chạy được với Paseo 0.9.2

Paseo 0.9.2 bỏ trường `cliVersion` khỏi `paseo daemon status --json`. Với `0.3.0-alpha.7` và mọi bản trước, điều đó làm **mọi** lệnh của trình cài đặt — `install`, `doctor`, `uninstall` — dừng ở `E_PASEO_OUTPUT_UNEXPECTED` (exit 3) ngay bước kiểm tra phiên bản, trước khi ghi bất cứ thứ gì.

- Thiếu `cliVersion` thì trình cài đặt đọc `paseo --version` và lấy dòng đầu làm phiên bản CLI; luật của [ADR-004](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/adr/ADR-004-paseo-config-mutation.md) không đổi (CLI phải khớp daemon, `>= 0.8.0`).
- Có `cliVersion` — tức Paseo 0.8 — thì hành vi **không đổi** và `paseo --version` không được gọi.
- `paseo --version` rỗng hoặc lỗi thì vẫn dừng bằng `E_PASEO_OUTPUT_UNEXPECTED` và không ghi gì.

Nếu bạn đang chạy Paseo 0.9.x thì đây là lý do để nâng lên bản này.

## Giao diện: kanban theo trạng thái, chữ yên tĩnh, Setup chia tab, đếm lỗi

- **Màn Beads là bốn cột kanban** — In progress → Blocked → Ready → Closed, mỗi cột có tên kèm số lượng, cột rỗng vẫn hiện nên bố cục không nhảy khi lọc. Cửa sổ rộng hiện các cột cạnh nhau; điện thoại và cửa sổ hẹp hiện một cột mỗi lần, chọn bằng dãy tab trạng thái đọc được bằng trình đọc màn hình. Không chức năng nào mất ở bố cục hẹp.
- **Bead đã đóng hiện sẵn.** Closed là một cột như mọi cột; nút mắt vẫn ẩn/hiện nó kèm số lượng, nhớ trong phiên app rồi về mặc định (hiện) sau khi tải lại.
- **Trạng thái nói bằng chữ, không bằng màu.** Ở mọi chỗ hiện bead — màn Beads, tab "Beads", panel "Beads in this chat", chip bead trong thẻ chat, các con số trên dòng workspace — trạng thái chỉ dùng chữ và độ tương phản: chưa xong màu chữ thường, đã đóng màu chữ mờ. Không cam, không đỏ, không xanh lá; chip vẫn ghi đủ Ready / In progress / Blocked / Closed nên trạng thái không bao giờ chỉ nằm ở màu.
- **Ngoài các chỗ hiện bead, màu giữ nguyên**: dòng lỗi đỏ và cảnh báo vàng ở Metric, Setup, thẻ chat và thẻ fallback không đổi — lỗi thật vẫn phải đập vào mắt.
- **Setup chia ba tab**: Beads tools (`br`, `bv`), Agent skills, Agents (Roles & models + Additional instructions). Dòng tình trạng chung và các cảnh báo về công cụ nằm **trên** dãy tab, nên không tab nào che được một vấn đề.
- **Thẻ "Errors" ở màn Metric** đếm số lần request bị lỗi bất kể lý do: turn kết thúc `failed`, agent kết thúc ở trạng thái `error`, và mỗi sự cố fallback của nhà cung cấp. Mỗi lần chết chỉ đếm một lần, dù nhiều nguồn cùng ghi nhận nó.
- **Dòng kết quả của ba hành động trên bead** (Assign a Worker / Close / Delete) còn nguyên khi bead chuyển sang cột khác ở lần refresh sau; chỉ thẻ xác nhận đang mở thì đóng lại.

## Đường phát hành đổi một chỗ

- `release.yml` **nhận bản không phải prerelease** và đặt dist-tag theo loại phiên bản: prerelease → `next`, ổn định → `latest`. Trước bản này workflow từ chối thẳng mọi bản ổn định và chỉ đặt `next`.
- Vì `npm publish --tag latest` chạy bằng OIDC trong cùng lần chạy, bản ổn định không cần bước `npm dist-tag add` cần OTP nữa.
- Cờ `prerelease` của GitHub Release phải khớp hình dạng phiên bản; đánh dấu sai thì workflow đỏ trước khi publish. Mọi thứ khác không đổi: hai gói một phiên bản, provenance, tên file `release.yml`, toàn bộ ma trận kiểm tra.

## Cần biết khi nâng cấp

- **`next` vẫn trỏ `0.3.0-alpha.7`**, cũ hơn `latest`. Đó là ngữ nghĩa bình thường của npm: `next` là nơi bản prerelease đi vào. Ai dùng `npx paseo-bm@next` mà muốn bản ổn định thì dùng `npx paseo-bm` hoặc ghim `@0.3.0`.
- **Không có thay đổi cấu hình, dữ liệu hay giao thức nào.** `~/.paseo-bm/`, `install.json`, các vai trò `bm-*` và tool của chúng giữ nguyên hình dạng; không có mã lỗi hay exit code nào đổi.
- **Manager đã mở từ trước vẫn chạy như cũ.** Như ghi chú `0.3.0-alpha.7` đã nói, Paseo không cho plugin sửa agent đã tồn tại; điều đó không đổi ở bản này.
- Cài xong nhớ **reload plugin** (hoặc để trình cài làm) để màn hình mới có hiệu lực.

## Hoàn tác

Đường lùi của dự án là **phát hành bản vá `0.3.1`**, không `npm unpublish`.

Lùi tại máy bằng `npx paseo-bm@0.3.0-alpha.7` chỉ dùng được **nếu bạn đang ở Paseo 0.8**: trên Paseo 0.9.2 bản đó không cài được, nó dừng ở `E_PASEO_OUTPUT_UNEXPECTED` (exit 3) như mục đầu đã nói. Ngoài bản vá trình cài đặt ấy, `0.3.0-alpha.7` chỉ thiếu đợt giao diện ở trên và không thiếu tính năng cốt lõi nào (tool dựng khối `BM-*`, sổ hỏi–đáp, dự phòng nhà cung cấp đều đã có).

## Nguồn

[PRD delta REQ-069](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/product/paseo-bm-prd-delta-20260925-kanban-quiet-colours.md) · [design delta kanban-quiet-colours](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/design/paseo-bm-delta-20260925-kanban-quiet-colours.md) · [design delta stable-release](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/design/paseo-bm-delta-20260925b-stable-release.md) · [delta plan phát hành 0.3.0](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/plans/paseo-bm-implementation-plan-delta-20260925b-stable-release-030.md) · [ADR-009](https://github.com/hieunt286/paseo-bm/blob/v0.3.0/docs/adr/ADR-009-payload-as-npm-package.md)
