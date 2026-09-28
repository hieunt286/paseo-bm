# Biên bản phát hành 0.4.1 — 2026-09-28

| Trường | Giá trị |
|---|---|
| Người duyệt | hieu.nt10 ("vậy tôi cần phát hành sớm", 2026-09-28) |
| Người chạy | Claude |
| Gói | `paseo-bm-plugin@0.4.1` trên `latest`, SLSA provenance v1. `paseo-bm` không publish (dừng ở `0.4.0`, owner đã `npm deprecate` cùng ngày) |
| Commit | `bc454a9` (release.yml chỉ publish plugin), `5a97d1d` (`chore(release): 0.4.1`), tag `v0.4.1` |
| Kết luận | **Đạt** |

## 1. Trước khi publish

- Bản ứng viên `0.4.1-rc.0` (mã plugin của `7a6c76e`, giống `0.4.1` trừ hai file version) cài qua registry thử trên daemon cô lập: cập nhật từ `0.4.0` thật (Manager, lịch sử, vai trò, công tắc giữ nguyên; Manager tạo thời 0.4.0 xin model Claude, Worker/Reviewer chạy trên Codex như Setup đặt); cài mới (câu từ chối lần đầu có câu vai trò, lần sau không; không agent nào khi tool tắt; model Claude cũ kèm thinking `max` chạy trên `gpt-5.6-sol`, thinking `xhigh`; gỡ sạch). Quét paseo.cafe: 0 phát hiện.
- `release.yml` mới: YAML parse được, `bash -n` qua 20 khối `run:`, không nháy đơn trong `node -e`. Diễn tập ở `bc454a9` (run 36366128864) **đỏ ở dry-run** vì version còn là `0.4.0`, đã có trên npm (`You cannot publish over the previously published versions: 0.4.0`); mọi bước khác đạt. Runbook §1.6 nay nói diễn tập sau khi nâng version.
- `5a97d1d`: `verify` (107 file, 2816 test) và `smoke:packed` trên worktree sạch; CI run 36366403060; diễn tập run 36366478899 xanh, `Dry-run publish of paseo-bm-plugin@0.4.1 with dist-tag latest`, hai bước thật `skipped`.

## 2. Publish

Trước: `paseo-bm-plugin` `latest` = `0.4.0`, `next` = `0.4.0-alpha.0`; `paseo-bm` `latest` = `0.4.0`. Release run 36366673399: `Assert the plugin version`, `Publish payload (dry-run)`, `Publish payload to npm`, `Verify published payload` đều đạt. Sau: `paseo-bm-plugin` `latest` = `0.4.1` (`next` không đổi), provenance `https://slsa.dev/provenance/v1`; `paseo-bm` không đổi.

## 3. Nghiệm thu trên registry thật (daemon cô lập, `scripts/manual-test/`)

| # | Mục | Kết quả |
|---|---|---|
| V1 | Cài `npm:paseo-bm-plugin@0.4.0`, tạo Manager, rồi `paseo plugin update paseo-bm` không cờ | đạt: `--check` nhắm `0.4.1`; `updated`, `running`; `resolved` từ registry.npmjs.org, `integrity` khớp `npm view`; Manager cũ mở lại (`created: false`) và làm xong một việc, trả lời tiếng Việt |
| V2 | `paseo plugin add npm:paseo-bm-plugin` trên daemon mới | đạt: `0.4.1`; lần mở đầu có câu vai trò + câu từ chối, lần hai chỉ câu từ chối, không agent nào; cho phép rồi Manager được tạo; gỡ cấu hình `restored`, 3 provider bị xoá |
| V3 | `validate-registry.ts` và `scanNpmTarget` của paseo.cafe trên `paseo-bm-plugin@latest` | đạt: `✓ 1 registry entry validated OK.`; `passed`, 0 blocking, 0 advisory, 104 file, 1 344 959 byte |

Chưa nhìn tận mắt trong app: dòng lỗi launcher và câu trạng thái Setup (có unit test). Owner xem sau khi `paseo plugin update paseo-bm` trên máy mình.
