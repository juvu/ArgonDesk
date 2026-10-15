# Daily workflow · 0.4.1

[简体中文](使用说明.md) · [Full guide](README.md)

1. For a new installation, open Start-ArgonDesk.cmd once to prepare the official tunnel client. Afterward use ArgonDesk.exe or a shortcut.
2. Check the HTTPS status, choose a folder and permission, then enable file access.
3. Start a fresh task in the English Gemini website. The previously verified path was Task → Argon. Type @ and select your registered app from the menu.
4. Describe what should be done in the current workspace. Review and approve the website's Allow card for writes.
5. Check Activity and the actual files.

Use the gear button → Preferences to change between English and Simplified Chinese. Changing folders or permissions, and restarting, pauses access. The private MCP URL stays the same across folder changes.

For initial setup, save your own ngrok development domain and token in Connection, then register the private URL as a custom Gemini app. Optional auto-connect restores the tunnel on launch. No old browser extension, green overlay or long Insert prompt is required.

**Google currently requires manual write confirmation.** Ask Gemini to combine related changes to the same file into one edit_file edits array to reduce tool calls. This does not remove confirmations.

“HTTPS online” is connection state; “Tool activity” requires an actual successful remote tool call. A handshake or a code block is not proof of file access.

Closing the panel leaves the service in the tray. Use the power button or Stop service and quit to stop it. Reload the panel after an update.

TUN depends on your network and is not a universal requirement. Routing rules determine which traffic uses a proxy. ArgonDesk does not change network settings. See the full guide for installation, boundaries and troubleshooting.
