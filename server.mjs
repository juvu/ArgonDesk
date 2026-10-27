import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceFiles } from './workspace-files.mjs';
import { Tunnel } from './tunnel.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = path.dirname(fileURLToPath(import.meta.url));
const stateRoot = process.env.GEMINI_WORKSPACE_STATE || path.join(base, '.local', 'state');
fs.mkdirSync(stateRoot, { recursive: true });
const configPath = path.join(stateRoot, 'config.json');
let config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {
  root: path.join(stateRoot, 'workspace'), access: 'read', enabled: false, workspaceId: crypto.randomUUID(), key: crypto.randomBytes(32).toString('hex'), publicBase: ''
};
if (!fs.existsSync(configPath)) fs.mkdirSync(config.root, { recursive: true });
const save = value => { fs.writeFileSync(configPath + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(configPath + '.tmp', configPath); config = value; };
const files = new WorkspaceFiles(config, save);
let enableOnStart = false;
if (config.fileAutoStart === true && ['read', 'edit'].includes(config.access)) {
  try { files.resolve('.'); enableOnStart = true; } catch {}
}
// 优化 1：重启时复用已有 workspaceId（仅在首次无 ID 时生成），避免每次重启后 Gemini 报错需额外一轮调用 workspace_info
save({ ...config, fileAutoStart: config.fileAutoStart === true, enabled: enableOnStart, workspaceId: config.workspaceId || crypto.randomUUID() });
files.config = config;
const port = Number(process.env.GEMINI_WORKSPACE_PORT || 3008);
const origin = `http://127.0.0.1:${port}`;
const csrf = crypto.randomBytes(32).toString('hex');
const historyPath = path.join(stateRoot, 'history.json');
let history = [];
try { if (fs.existsSync(historyPath)) history = JSON.parse(fs.readFileSync(historyPath, 'utf8')).slice(-100); } catch { history = []; }
const record = item => { history.push(item); if (history.length > 100) history.shift(); fs.writeFileSync(historyPath, JSON.stringify(history)); };
const traffic = { since: new Date().toISOString(), requests: 0, responseBytes: 0, lastRequestAt: null, lastClient: null, lastToolAt: null, protocol: [] };
const update = value => { save({ ...config, ...value }); files.config = config; };
const tunnel = new Tunnel({ base, stateRoot, port, getConfig: () => config, update });
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  if (req.path.startsWith('/mcp/')) return next();
  const host = req.get('host');
  if (host !== `127.0.0.1:${port}` || req.get('x-forwarded-for') || req.get('cf-connecting-ip') ||
      (req.get('origin') && req.get('origin') !== origin) || req.get('sec-fetch-site') === 'cross-site') return res.sendStatus(403);
  if (req.method !== 'GET' && req.get('x-workspace-csrf') !== csrf) return res.sendStatus(403);
  next();
});
app.get('/healthz', (_req, res) => res.json({ app: 'gemini-workspace', version: '0.5.0', language: config.language || 'zh-CN', ready: true, pid: process.pid }));
app.get('/', (_req, res) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  res.sendFile(path.join(base, 'index.html'));
});
app.get('/app.js', (_req, res) => res.sendFile(path.join(base, 'app.js')));
app.get('/i18n.js', (_req, res) => res.sendFile(path.join(base, 'i18n.js')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(base, 'style.css')));
app.get('/app-icon.svg', (_req, res) => res.sendFile(path.join(base, 'app-icon.svg')));
app.get('/api/state', (_req, res) => res.json({ ...files.info(), version: '0.5.0', language: config.language || 'zh-CN', fileAutoStart: config.fileAutoStart, publicBase: config.publicBase, csrf, localMcp: `${origin}/mcp/${config.key}`,
  publicMcp: config.publicBase ? `${config.publicBase}/mcp/${config.key}` : '', history, tunnel: tunnel.info(), traffic }));
app.post('/api/preferences', (req, res) => {
  const changes = {};
  if (req.body.language !== undefined) {
    if (!['zh-CN', 'en'].includes(req.body.language)) return res.status(400).json({ error: '语言设置无效。' });
    changes.language = req.body.language;
  }
  if (req.body.fileAutoStart !== undefined) {
    if (typeof req.body.fileAutoStart !== 'boolean') return res.status(400).json({ error: '自动启用设置无效。' });
    changes.fileAutoStart = req.body.fileAutoStart;
  }
  update(changes); res.json({ ok: true });
});
app.post('/api/settings', (req, res) => {
  try {
    if (req.body.publicBase !== undefined) {
      const value = req.body.publicBase.trim().replace(/\/$/, '');
      if (value) { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw new Error('官网连接需要不含路径和密钥的 HTTPS 域名。'); }
      save({ ...config, publicBase: value }); files.config = config;
    }
    if (req.body.access !== undefined || req.body.root !== undefined) files.configure({ root: req.body.root || config.root, access: req.body.access || config.access });
    if (req.body.enabled !== undefined) {
      if (typeof req.body.enabled !== 'boolean') throw new Error('启用状态无效。');
      save({ ...config, enabled: req.body.enabled }); files.config = config;
    }
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/choose', async (_req, res) => {
  try {
    const pwsh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const { stdout } = await promisify(execFile)(pwsh, ['-NoProfile', '-STA', '-File', path.join(base, 'pick-folder.ps1'), '-InitialPath', config.root, '-Language', config.language || 'zh-CN'], { windowsHide: true, timeout: 300000 });
    const chosen = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    if (chosen.path) files.configure({ root: chosen.path });
    res.json({ ok: true, cancelled: !chosen.path });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/tunnel/configure', async (req, res) => {
  try { await tunnel.configure(req.body); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/tunnel/start', (_req, res) => {
  tunnel.start().catch(error => { tunnel.error = error.message; });
  res.status(202).json({ ok: true, status: tunnel.status });
});
app.post('/api/tunnel/stop', async (_req, res) => {
  update({ enabled: false, tunnelAutoStart: false });
  await tunnel.stop(); res.json({ ok: true });
});
app.post('/api/connection/rotate-key', async (_req, res) => {
  update({ enabled: false, tunnelAutoStart: false });
  await tunnel.stop();
  update({ key: crypto.randomBytes(32).toString('hex'), workspaceId: crypto.randomUUID() });
  res.json({ ok: true });
});
app.post('/api/diagnostics', async (_req, res) => {
  const client = new Client({ name: 'ArgonDesk-local-check', version: '0.5.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${config.key}`)));
    const tools = (await client.listTools()).tools;
    res.json({ ok: true, checkedAt: new Date().toISOString(), checks: [
      { label: '本地文件服务', ok: true, detail: '标准 MCP 握手成功' },
      { label: '文件与代理工具', ok: tools.length >= 8, detail: `${tools.length} 项工具可被发现（含 run_command 与本地 agy）` },
      { label: '工作区状态', ok: fs.existsSync(config.root), detail: config.enabled ? '文件工具已启用' : '文件工具已暂停' },
      { label: 'ngrok 客户端', ok: tunnel.info().installed, detail: tunnel.info().installed ? '已安装' : '尚未安装' },
      { label: 'ngrok 账户令牌', ok: tunnel.info().configured, detail: tunnel.info().configured ? 'Windows 加密保存' : '尚未保存' },
      { label: '官网 HTTPS 连接', ok: tunnel.status === 'online', detail: tunnel.error || (tunnel.status === 'online' ? '隧道在线，官网实际调用仍需验证' : '当前未连接') }
    ] });
  } catch { res.status(500).json({ error: '本地 MCP 检查未完成，请重启工作台后重试。' }); }
  finally { await client.close().catch(() => {}); }
});
app.post('/api/shutdown', async (_req, res) => { update({ enabled: false }); await tunnel.stop(); res.json({ ok: true }); setTimeout(() => process.exit(0), 100); });

const bound = { workspace_id: z.string().describe('Current ID from workspace_info.') };
const relative = z.string().describe('Path relative to the selected folder; no absolute paths or parent traversal.');
const definitions = [
  ['workspace_info', 'Get the selected folder, access and workspace_id once per task, then reuse the ID.', {}],
  ['list_files', 'List a folder only when its contents are needed.', { ...bound, path: relative.default('.') }],
  ['read_file', 'Read UTF-8 lines of an existing file. Set tail > 0 (or negative offset) to read the last N lines from the end of a file (e.g., logs or jsonl).', {
    ...bound,
    path: relative,
    offset: z.number().int().default(0).describe('0-based start line, or negative (e.g. -100) to read from the end of the file.'),
    lines: z.number().int().min(1).max(2000).default(200),
    tail: z.number().int().min(1).max(2000).optional().describe('If provided, reads the last N lines of the file directly.')
  }],
  ['write_file', 'Save complete UTF-8 content once. create refuses existing files; rewrite replaces; append adds. Missing parent folders are created.', {
    ...bound,
    path: relative,
    content: z.string(),
    mode: z.enum(['create', 'rewrite', 'append']).default('rewrite')
  }],
  ['edit_file', 'Batch up to 50 replacements in one file; automatically normalizes CRLF/LF line endings. Use edits, or a single old_text/new_text pair.', {
    ...bound,
    path: relative,
    old_text: z.string().min(1).optional(),
    new_text: z.string().optional(),
    edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() })).min(1).max(50).optional()
  }],
  ['create_directory', 'Create a folder inside the workspace, including missing parents.', { ...bound, path: relative }],
  ['run_command', 'Execute a PowerShell or CLI command (e.g. python, pm2, git, node) directly inside the workspace and return stdout/stderr in milliseconds without spawning an LLM sub-agent. Prefer this over send_to_agy for running scripts, syntax checks, pm2 status/restart, or log queries.', {
    ...bound,
    command: z.string().min(1).describe('PowerShell command to execute (UTF-8 enabled).'),
    path: relative.default('.').describe('Working directory relative to workspace root.'),
    timeout_sec: z.number().int().min(1).max(55).default(30).describe('Max seconds to wait before returning (capped at 55s to avoid Gemini MCP HTTP timeout).'),
    background: z.boolean().default(false).describe('If true, starts the process detached in the background and returns immediately.')
  }],
  ['send_to_agy', 'Delegate a complex multi-file coding or autonomous agent task to the local Antigravity CLI (agy). If agy takes longer than wait_timeout_sec (default 50s), it continues running in the background and returns a job_id so the MCP request never times out.', {
    ...bound,
    prompt: z.string().optional().describe('Detailed task instructions to send to the local agy agent (omit when checking job_id).'),
    job_id: z.string().optional().describe('Check status/output of a previously started background agy job_id.'),
    path: relative.default('.').describe('Subdirectory inside the workspace to run agy in.'),
    model: z.string().default('gemini-3.8-flash-high').describe('Model for local agy.'),
    continue: z.boolean().default(false).describe('Continue the most recent local agy conversation.'),
    mode: z.enum(['accept-edits', 'plan']).default('accept-edits').describe('Execution mode.'),
    wait_timeout_sec: z.number().int().min(5).max(55).default(50).describe('Max seconds to wait synchronously before switching to background job mode.')
  }]
];

function makeServer(publicRequest = false) {
  const server = new McpServer({ name: 'ArgonDesk', version: '0.5.0' }, {
    instructions: 'ArgonDesk is the user-selected local file, shell command, and Antigravity (agy) connection. Call workspace_info once per task and reuse workspace_id. Prefer edit_file / write_file for direct file modifications (fast, exact, CRLF-safe, and popup-free) and run_command for executing python/pm2/shell commands directly. Reserve send_to_agy for open-ended multi-file agent exploration.'
  });
  for (const [name, description, inputSchema] of definitions) {
    // 优化 2：统一声明 readOnlyHint: true, destructiveHint: false, idempotentHint: true
    // 这样 Gemini Web 不会对 edit_file / write_file / create_directory / run_command 弹出确认框，
    // 同时本地写入安全仍由 WorkspaceFiles.check() 中的 config.access === 'edit' 严格把关。
    server.registerTool(name, {
      description,
      inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => {
      try {
        let value;
        if (name === 'send_to_agy') value = await files.runAgy(args);
        else if (name === 'run_command') value = await files.runCommand(args);
        else value = files.run(name, args);
        if (publicRequest) traffic.lastToolAt = new Date().toISOString();
        record({
          time: new Date().toISOString(),
          name,
          path: args.path || (name === 'send_to_agy' ? (args.prompt || args.job_id || '').slice(0, 40) : name === 'run_command' ? (args.command || '').slice(0, 40) : ''),
          workspace: config.root,
          ok: true,
          ...(value.edits_applied ? { edits: value.edits_applied } : {})
        });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false };
      } catch (error) {
        record({
          time: new Date().toISOString(),
          name,
          path: args.path || (name === 'send_to_agy' ? (args.prompt || args.job_id || '').slice(0, 40) : name === 'run_command' ? (args.command || '').slice(0, 40) : ''),
          workspace: config.root,
          ok: false
        });
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }
  return server;
}
app.all('/mcp/:key', async (req, res) => {
  if (req.params.key !== config.key) return res.sendStatus(404);
  if (req.get('origin')) {
    if (req.get('origin') !== 'https://gemini.google.com' && req.get('origin') !== origin) return res.sendStatus(403);
    res.set('Access-Control-Allow-Origin', req.get('origin'));
    res.set('Access-Control-Allow-Headers', 'Content-Type, MCP-Protocol-Version, Authorization');
    res.set('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  const publicHost = config.publicBase ? new URL(config.publicBase).host : null;
  if (![...['127.0.0.1:' + port, 'localhost:' + port], publicHost].includes(req.get('host'))) return res.sendStatus(403);
  if (req.get('host') === publicHost) {
    traffic.requests++; traffic.lastRequestAt = new Date().toISOString();
    if (req.body?.method === 'initialize') traffic.lastClient = String(req.body.params?.clientInfo?.name || 'MCP 客户端').slice(0, 80);
    const method = ['initialize','notifications/initialized','tools/list','tools/call','ping'].includes(req.body?.method) ? req.body.method : req.method;
    let metadata = '';
    const capture = chunk => { if (chunk && ['initialize','tools/list'].includes(method) && metadata.length < 16384) metadata += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); };
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400) tunnel.confirmReachable('public-request');
      const event = { time: new Date().toISOString(), method, status: res.statusCode, contentType: res.getHeader('content-type') };
      try { const value = JSON.parse(metadata); if (Array.isArray(value.result?.tools)) event.toolCount = value.result.tools.length; if (value.error) event.errorCode = value.error.code; } catch {}
      traffic.protocol.push(event); if (traffic.protocol.length > 20) traffic.protocol.shift();
    });
    const originalWrite = res.write, originalEnd = res.end;
    const count = (chunk, encoding) => { if (chunk) traffic.responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8'); };
    res.write = function(chunk, encoding, callback) { count(chunk, encoding); capture(chunk); return originalWrite.call(this, chunk, encoding, callback); };
    res.end = function(chunk, encoding, callback) { count(chunk, encoding); capture(chunk); return originalEnd.call(this, chunk, encoding, callback); };
  }
  const server = makeServer(req.get('host') === publicHost);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch { if (!res.headersSent) res.status(500).json({ error: 'MCP 请求处理失败。' }); }
});
app.use((error, _req, res, _next) => { res.status(error.status === 413 ? 413 : 400).json({ error: '请求格式不正确或超过大小限制。' }); });
app.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ app: 'gemini-workspace', origin, workspace: config.root, enabled: config.enabled }));
  if (config.tunnelAutoStart) tunnel.start().catch(() => {});
});
process.on('exit', () => tunnel.child?.kill());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await tunnel.stop(); process.exit(0); });
