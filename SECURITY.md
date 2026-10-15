# Security / 安全说明

## English

ArgonDesk exposes six UTF-8 text-file tools through a capability URL. There are no shell, browser-control, delete, move or permission-management tools. Read-only access, paused state and workspace IDs are enforced by the server, independently of tool annotations.

Requests must use relative paths and the current workspace ID. Folder/permission changes rotate the ID and pause access. Restarting rotates the ID and defaults to paused. The optional startup file-access preference enables the saved root and permission on launch; a missing, replaced or invalid root remains paused. With this option on, a manual pause lasts for the current run. It is off until explicitly chosen. Absolute paths, parent traversal, NTFS streams, device/trailing aliases, symbolic links, junctions and hard links are rejected. A root replaced by a junction is rejected too.

This is a file-tool boundary, not an operating-system sandbox. It does not change Windows permissions, isolate generated programs you run, or guarantee protection against concurrent filesystem tampering by another local process.

The dashboard listens on loopback, checks Host/Origin and requires CSRF for mutations. ngrok forwards only the exact private MCP path. The complete URL contains a random key: someone who knows it and can reach the endpoint may attempt allowed tools while access is enabled. Google-account-bound OAuth is not implemented.

Requested file contents travel through ngrok to Google. History stores operation metadata, not file bodies. Local state can contain real paths, keys, encrypted tokens and logs. Never publish `.local/`, a used installation folder, private URLs or browser state.

Tokens use current-user Windows DPAPI. This does not protect against software with the same user's authority. Google currently requires manual write confirmation; ArgonDesk does not auto-click Allow or disguise write tools as read-only. Inspect changes and keep recoverable copies.

For sensitive reports, use GitHub private vulnerability reporting if enabled, or contact the maintainer through the project profile. Do not post tokens, real URLs, personal paths or file contents in public issues. Use synthetic reproductions. Rotate an exposed connection key locally, then update its URL in Gemini.

## 简体中文

ArgonDesk 通过带随机密钥的能力 URL 提供六项 UTF-8 文本工具，没有终端、浏览器控制、删除、移动或权限管理工具。只读、暂停和工作区编号由服务端检查，不依赖模型或工具注解自律。

请求必须使用相对路径和当前编号。切换目录或权限会更换编号并暂停；重启也更换编号，默认暂停。只有主动开启“启动时自动启用文件工具”，才会在启动时按保存的目录和权限启用；目录失效、被替换或权限无效时保持暂停。开启该项后，手动暂停只对本次运行有效。拒绝绝对路径、父目录穿越、NTFS 附加流、设备名和尾部别名、符号链接、目录联接点及硬链接；根目录被替换成联接点时也会拒绝访问。

这是文件工具的范围控制，不是操作系统沙箱：不改变 Windows 权限，不隔离你手动运行的程序，也不保证抵御其他本地进程并发篡改文件系统。

面板仅监听本机回环地址，检查 Host/Origin，修改需要 CSRF。ngrok 只转发准确的私人 MCP 路径。完整 URL 含能力密钥，知道它且能访问端点的人，可能在文件访问启用时尝试调用允许的工具。本版尚未实现绑定 Google 账户的 OAuth。

文件内容经过 ngrok 传给 Google。历史记操作元数据，不记正文；本机状态仍可能有真实路径、密钥、加密令牌和日志。不要公开 `.local/`、已使用的完整安装目录、私人 URL 或浏览器状态。

令牌使用当前 Windows 用户的 DPAPI 加密，不能防御拥有同一用户权限的软件。Google 当前要求人工确认写入，工作台不自动点 Allow、不把写工具伪装成只读。请检查结果并为重要工作保留可恢复副本。

敏感问题可通过仓库已启用的 GitHub 私密漏洞报告，或项目资料中维护者的联系方式提交。公开 Issue 不要贴令牌、真实地址、个人路径和文件正文；请使用虚构样例复现。密钥泄漏后，在本地更换密钥，再到 Gemini 更新 URL。
