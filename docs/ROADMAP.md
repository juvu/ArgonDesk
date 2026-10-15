# Validation and roadmap

[简体中文](ROADMAP.zh-CN.md)

## Current preview

Implemented: six scoped text-file tools, read-only/edit selection, pause and workspace IDs, path/link guards, native MCP JSON results, ngrok process management, recovery status, bilingual UI/tray, history and batched replacements.

Evidence from the current Windows installation includes real MCP fixture tests, a public-endpoint ping/tool listing, an earlier genuine Gemini approved write/read-back, and human confirmation of the folder picker. Local package, installer and UI checks are separate from hosted CI and another-PC testing.

## Known limits

Windows x64 only. No shell, full computer control, binary editing, deletion, multi-workspace concurrency or Google-bound OAuth. Google write confirmations remain manual. The integrated provider is ngrok. No long-term uptime or all-account/model compatibility claim is made. The desktop entry is unsigned.

## Iteration directions

- Test clean installs on independent Windows machines.
- Include and expand a reproducible UI regression harness.
- Prototype Cloudflare/stable HTTPS adapters and genuinely verify Gemini behavior.
- Improve first-run guidance and provider diagnostics without expanding default file authority.
- Evaluate account-bound authorization and stronger OS isolation as separate designs.
- Consider packaging/signing and other platforms after native validation.

These are directions, not delivery dates or promises. A usable, bounded first preview is preferred over claiming unfinished integrations.
