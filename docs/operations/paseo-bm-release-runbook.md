# Runbook phát hành prerelease đầu tiên — paseo-bm

| Trường | Giá trị |
|---|---|
| Bead | `bm-wp-118-4s4.2` |
| Phiên bản đích | `0.1.0-alpha.0`, dist-tag `next`, có provenance |
| Workflow | [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — bước publish thật chỉ chạy khi có **GitHub Release** (`github.event_name == 'release'`); chạy tay là dry-run |
| Trạng thái | Đã chuẩn bị xong (dry-run `34996962249` xanh). **Chưa publish.** |

## Vì sao cần bước giữ chỗ

`npm trust` (cấu hình trusted publishing bằng OIDC) **chỉ làm được khi gói đã tồn tại** trên registry (`npm help trust`: *Package must exist*), cần 2FA ở mức tài khoản và quyền ghi trên gói. `paseo-bm` chưa từng được publish, nên bản **đầu tiên** không thể đi qua OIDC. Owner chọn cách: tự publish một bản **giữ chỗ**, cấu hình trust, rồi để workflow publish bản thật kèm provenance.

Người chạy (Claude) **không** đăng nhập npm và **không** chạm tới thông tin đăng nhập của owner; các lệnh ở mục 1 do owner tự chạy.

> **Đo được 2026-09-23, phase 2a-20.** Không phải "nên" mà là "không thể": tài khoản npm của owner đặt `two-factor auth: auth-and-writes`, nên **mọi** thao tác ghi đòi yếu tố thứ hai. `npm whoami` và `npm token list` chạy được, nhưng `npm publish`, `npm trust` và `npm dist-tag add` đều mở luồng xác thực trình duyệt mà agent không hoàn tất được — thử ba lần, không lần nào publish được gì. Owner chốt Q13 b (cho agent dùng phiên npm) nhưng thực tế bác bỏ nó, nên luật ở trên **giữ nguyên** và được mở rộng: bước giữ chỗ, `npm trust github`, và mọi lần dời dist-tag là việc của owner. Chỉ lần phát hành thật chạy được không cần OTP, vì `release.yml` publish bằng OIDC. Lưu ý thêm: npm đang siết token bỏ qua 2FA, nên đừng coi Granular Access Token là đường vòng lâu dài.

## 1. Owner chạy trên máy mình

```bash
cd /Users/Shared/work/self/paseo-plugins/paseo-bm
git pull                      # lấy bản mới nhất của main

npm login                     # mở trình duyệt, cần 2FA
npm whoami                    # kiểm tra đã đăng nhập đúng tài khoản

# Bản giữ chỗ: KHÔNG dùng dist-tag next hay latest
npm version 0.0.0-placeholder.0 --no-git-tag-version
npm publish --tag placeholder --access public
git checkout package.json     # trả version về 0.1.0-alpha.0, không commit bản giữ chỗ

# Cấu hình trusted publisher cho GitHub Actions
npm trust github paseo-bm --file release.yml --repo hieunt286/paseo-bm --allow-publish
npm trust list paseo-bm       # xác nhận đã có cấu hình
```

Ghi chú:
- Bản giữ chỗ nằm ở dist-tag `placeholder`, nên `npx paseo-bm` và `npx paseo-bm@next` **không** lấy phải nó.
- Không cần `npm unpublish`: npm chỉ cho gỡ trong 72 giờ và đường lùi của dự án là phát hành bản vá, không phải unpublish.
- Nếu `npm trust github` báo đã có cấu hình: `npm trust list paseo-bm` lấy id rồi `npm trust revoke paseo-bm --id <id>` trước khi tạo lại.

Xong thì nhắn cho Claude: **"đã cấu hình trusted publisher"**.

## 2. Claude làm tiếp, sau khi owner duyệt publish

1. Kiểm tra lại: `main` xanh, `npm view paseo-bm dist-tags` có `placeholder`, `npm trust list` do owner xác nhận.
2. Tạo tag và GitHub Release (đây là **điểm phê duyệt**, publish không đảo ngược được sau 72 giờ):
   ```bash
   git tag v0.1.0-alpha.0 && git push origin v0.1.0-alpha.0
   gh release create v0.1.0-alpha.0 --prerelease --title "v0.1.0-alpha.0" --notes-file <ghi chú>
   ```
3. Theo dõi workflow `release.yml` (sự kiện `release`): các bước kiểm tra, `smoke:packed`, `publish --dry-run`, rồi **Publish to npm** và **Verify published version**.
4. Xác minh:
   ```bash
   npm view paseo-bm@next version
   npm view paseo-bm@next dist.attestations    # provenance
   cd "$(mktemp -d)" && npx --yes paseo-bm@next --version
   ```
5. Ghi bằng chứng vào bead `bm-wp-118-4s4.2` rồi đóng bead và epic WP-118.

## 3. Nếu bước giữ chỗ thất bại

- `npm publish` báo tên gói đã có chủ khác → đổi tên gói là quyết định của owner (ảnh hưởng README, `package.json`, trusted publisher); dừng và hỏi.
- `npm trust github` báo thiếu quyền hoặc thiếu 2FA → owner bật 2FA ở mức tài khoản rồi chạy lại; không dùng token bypass 2FA.
- Không muốn có bản giữ chỗ trên registry → phương án còn lại là owner tự publish `0.1.0-alpha.0` (mất provenance cho bản đó) hoặc dùng token một lần trong CI (trái quyết định thiết kế "không NPM_TOKEN", cần errata). Cả hai đều cần owner chọn lại.
