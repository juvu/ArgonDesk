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
save({ ...config, enabled: false });
const files = new WorkspaceFiles(config, save);
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
app.use(express.json({ limit: '3mb' }));
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
app.get('/healthz', (_req, res) => res.json({ app: 'gemini-workspace', version: '0.4.1', language: config.language || 'zh-CN', ready: true, pid: process.pid }));
app.get('/', (_req, res) => {
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  res.sendFile(path.join(base, 'index.html'));
});
app.get('/app.js', (_req, res) => res.sendFile(path.join(base, 'app.js')));
app.get('/i18n.js', (_req, res) => res.sendFile(path.join(base, 'i18n.js')));
app.get('/style.css', (_req, res) => res.sendFile(path.join(base, 'style.css')));
app.get('/app-icon.svg', (_req, res) => res.sendFile(path.join(base, 'app-icon.svg')));
app.get('/api/state', (_req, res) => res.json({ ...files.info(), version: '0.4.1', language: config.language || 'zh-CN', publicBase: config.publicBase, csrf, localMcp: `${origin}/mcp/${config.key}`,
  publicMcp: config.publicBase ? `${config.publicBase}/mcp/${config.key}` : '', history, tunnel: tunnel.info(), traffic }));
app.post('/api/preferences', (req, res) => {
  if (!['zh-CN', 'en'].includes(req.body.language)) return res.status(400).json({ error: '语言设置无效。' });
  update({ language: req.body.language }); res.json({ ok: true });
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
  const client = new Client({ name: 'ArgonDesk-local-check', version: '0.4.1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp/${config.key}`)));
    const tools = (await client.listTools()).tools;
    res.json({ ok: true, checkedAt: new Date().toISOString(), checks: [
      { label: '本地文件服务', ok: true, detail: '标准 MCP 握手成功' },
      { label: '文件工具', ok: tools.length === 6, detail: `${tools.length} 项工具可被发现` },
      { label: '工作区状态', ok: fs.existsSync(config.root), detail: config.enabled ? '文件工具已启用' : '文件工具已暂停' },
      { label: 'ngrok 客户端', ok: tunnel.info().installed, detail: tunnel.info().installed ? '已安装' : '尚未安装' },
      { label: 'ngrok 账户令牌', ok: tunnel.info().configured, detail: tunnel.info().configured ? 'Windows 加密保存' : '尚未保存' },
      { label: '官网 HTTPS 连接', ok: tunnel.status === 'online', detail: tunnel.error || (tunnel.status === 'online' ? '隧道在线，官网实际调用仍需验证' : '当前未连接') }
    ] });
  } catch { res.status(500).json({ error: '本地 MCP 检查未完成，请重启工作台后重试。' }); }
  finally { await client.close().catch(() => {}); }
});
app.post('/api/shutdown', async (_req, res) => { update({ enabled: false }); await tunnel.stop(); res.json({ ok: true }); setTimeout(() => process.exit(0), 100); });

const bound = { workspace_id: z.string().describe('从 workspace_info 获取的当前工作区编号') };
const relative = z.string().describe('工作区内的相对路径；禁止绝对路径和父目录');
const definitions = [
  ['workspace_info', '查询用户在本地选择的工作区及当前权限。每次新任务和切换目录后先查询。', {}],
  ['list_files', '列举当前工作区内某个文件夹。', { ...bound, path: relative.default('.') }],
  ['read_file', '按行读取工作区内的 UTF-8 文本文件。', { ...bound, path: relative, offset: z.number().int().min(0).default(0), lines: z.number().int().min(1).max(1000).default(200) }],
  ['write_file', '在工作区内创建、覆写或追加 UTF-8 文本。', { ...bound, path: relative, content: z.string(), mode: z.enum(['rewrite', 'append']).default('rewrite') }],
  ['edit_file', '精确编辑一个文件。优先将多处修改合并到 edits 数组（最多50项），按顺序唯一匹配，全部成功后只写入一次，以减少工具请求和写入确认。兼容单次 old_text/new_text。Batch edits within one file; all changes are validated before writing.', { ...bound, path: relative, old_text: z.string().min(1).optional(), new_text: z.string().optional(), edits: z.array(z.object({ old_text: z.string().min(1), new_text: z.string() })).min(1).max(50).optional() }],
  ['create_directory', '在工作区内创建文件夹。', { ...bound, path: relative }]
];
function makeServer(publicRequest = false) {
  const server = new McpServer({ name: 'Gemini-Workspace', version: '0.4.1' });
  for (const [name, description, inputSchema] of definitions) {
    const mutator = ['write_file', 'edit_file', 'create_directory'].includes(name);
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: !mutator, destructiveHint: mutator, openWorldHint: false }
    }, async args => {
      try {
        const value = files.run(name, args);
        if (publicRequest) traffic.lastToolAt = new Date().toISOString();
        record({ time: new Date().toISOString(), name, path: args.path || '', workspace: config.root, ok: true, ...(value.edits_applied ? { edits: value.edits_applied } : {}) });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: Array.isArray(value) ? { entries: value } : value, isError: false };
      } catch (error) {
        record({ time: new Date().toISOString(), name, path: args.path || '', workspace: config.root, ok: false });
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
