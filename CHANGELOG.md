# Changelog / 更新记录

## 0.4.1 — Open-source preview / 开源预览

- Formalized the ArgonDesk name and MIT license.
- Added first-run startup and signature-checked ngrok installation; public packages exclude its binary.
- Added detailed bilingual installation, networking, troubleshooting, AI-assisted setup and contribution guides.
- Added Windows CI definition and release checks. Hosted CI results must be verified after publication.
- Preserved the six tools and directory permissions from 0.4.0.

- 正式命名 ArgonDesk，自己的代码采用 MIT。
- 增加首次启动与签名验证安装，公开包不包含 ngrok 客户端。
- 完善双语安装、网络、排错、智能体协助安装和贡献文档。
- 增加 Windows CI 定义与发布检查；上线后的实际 CI 结果仍需核对。
- 兼容 0.4.0 的六项工具与目录权限。

## 0.4.0 — Local validation / 本地验证

Simplified the workspace, added Chinese/English preferences, repaired picker ownership, improved tunnel recovery and added up to 50 replacements per edit_file call. The picker foreground behavior was manually confirmed on the current Windows installation.

精简工作区、中英文切换、修复选择器层级、完善隧道恢复、增加同文件最多 50 处替换。本机使用者已确认文件夹弹窗置顶正常。
