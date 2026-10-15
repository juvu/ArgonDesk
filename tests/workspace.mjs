import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceFiles } from '../workspace-files.mjs';

const runtime = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(runtime, '..');
const fixture = path.join(project, '.local', 'tests', 'workspace-check-' + randomUUID().slice(0, 8));
const root = path.join(fixture, 'project');
const second = path.join(fixture, 'second');
const stateDir = path.join(fixture, 'state');
for (const directory of [root, second, stateDir]) fs.mkdirSync(directory, { recursive: true });
const outside = path.join(fixture, 'outside.txt');
fs.writeFileSync(outside, 'OUTSIDE_MUST_STAY_UNCHANGED');
const config = { root, workspaceId: randomUUID(), enabled: true, access: 'edit', key: randomUUID().replaceAll('-', ''), publicBase: '' };
const files = new WorkspaceFiles(config);
const args = { workspace_id: config.workspaceId, path: 'sample.txt' };
const checks = [];
function check(name, fn) { fn(); checks.push({ name, passed: true }); }
check('UTF-8 create/read/exact-edit round trip', () => {
  files.run('write_file', { ...args, content: '你好，Gemini\n原文' });
  files.run('edit_file', { ...args, old_text: '原文', new_text: '已编辑' });
  assert.equal(files.run('read_file', args).text, '你好，Gemini\n已编辑');
});
check('Traversal, absolute paths, ADS, device names and trailing aliases denied', () => {
  for (const target of ['../outside.txt', '..\\outside.txt', outside, 'sample.txt:stream', 'CON', 'NUL.txt', 'folder. /escape.txt', 'folder /escape.txt']) {
    assert.throws(() => files.run('write_file', { ...args, path: target, content: 'BAD' }));
  }
});
check('Directory junction cannot expose or modify files outside root', () => {
  fs.symlinkSync(fixture, path.join(root, 'junction'), 'junction');
  assert.throws(() => files.run('read_file', { ...args, path: 'junction/outside.txt' }));
  assert.throws(() => files.run('write_file', { ...args, path: 'junction/outside.txt', content: 'BAD' }));
  assert.throws(() => files.run('create_directory', { ...args, path: 'junction/unwanted' }));
});
check('Hard links cannot expose or modify an outside file', () => {
  fs.linkSync(outside, path.join(root, 'hardlink.txt'));
  assert.throws(() => files.run('read_file', { ...args, path: 'hardlink.txt' }));
  assert.throws(() => files.run('write_file', { ...args, path: 'hardlink.txt', content: 'BAD' }));
});
check('Replacing the selected root with a junction cannot redirect file tools', () => {
  const unstable = path.join(fixture, 'mutable-root');
  fs.mkdirSync(unstable);
  const scoped = new WorkspaceFiles({ ...config, root: unstable });
  fs.rmdirSync(unstable);
  fs.symlinkSync(fixture, unstable, 'junction');
  assert.throws(() => scoped.run('list_files', { ...args, path: '.' }));
  assert.throws(() => scoped.run('write_file', { ...args, path: 'outside.txt', content: 'BAD' }));
});
check('Only a unique edit match is accepted', () => {
  assert.throws(() => files.run('edit_file', { ...args, old_text: 'missing', new_text: 'BAD' }));
  files.run('write_file', { ...args, path: 'duplicate.txt', content: 'aa aa' });
  assert.throws(() => files.run('edit_file', { ...args, path: 'duplicate.txt', old_text: 'aa', new_text: 'BAD' }));
});
check('Oversized writes and reads are rejected', () => {
  assert.throws(() => files.run('write_file', { ...args, content: 'x'.repeat(2 * 1024 * 1024 + 1) }));
  fs.writeFileSync(path.join(root, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.throws(() => files.run('read_file', { ...args, path: 'big.txt' }));
});
check('Batch edits apply together and a later mismatch leaves the file unchanged', () => {
  const batch = { ...args, path: 'batch.txt' };
  files.run('write_file', { ...batch, content: 'one two three' });
  const result = files.run('edit_file', { ...batch, edits: [{old_text:'one',new_text:'ONE'}, {old_text:'three',new_text:'THREE'}] });
  assert.equal(result.edits_applied, 2);
  assert.equal(files.run('read_file', batch).text, 'ONE two THREE');
  assert.throws(() => files.run('edit_file', { ...batch, edits: [{old_text:'ONE',new_text:'changed'}, {old_text:'missing',new_text:'BAD'}] }));
  assert.equal(files.run('read_file', batch).text, 'ONE two THREE');
  for (const edits of [[], Array(51).fill({old_text:'ONE',new_text:'BAD'})]) assert.throws(() => files.run('edit_file', {...batch, edits}));
  assert.throws(() => files.run('edit_file', {...batch, old_text:'ONE',new_text:'BAD',edits:[{old_text:'two',new_text:'BAD'}]}));
});
check('Read-only, pause and obsolete workspace IDs are enforced', () => {
  files.configure({ access: 'read' });
  files.config.enabled = true;
  const current = files.config.workspaceId;
  assert.throws(() => files.run('read_file', args));
  assert.equal(files.run('read_file', { ...args, workspace_id: current }).text, '你好，Gemini\n已编辑');
  assert.throws(() => files.run('write_file', { ...args, workspace_id: current, content: 'BAD' }));
  files.config.enabled = false;
  assert.throws(() => files.run('read_file', { ...args, workspace_id: current }));
  assert.throws(() => files.run('workspace_info'));
});
check('Unknown tools and shell/config commands are unavailable', () => {
  files.config.enabled = true;
  for (const name of ['start_process', 'run_shell_command', 'set_config_value', 'browser_run_code_unsafe', 'delete_file']) {
    assert.throws(() => files.run(name, { ...args, workspace_id: files.config.workspaceId }));
  }
});
check('Outside sentinel remains byte-for-byte intact', () => assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_MUST_STAY_UNCHANGED'));

fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ ...config, enabled: false }));
const port = 3018;
const child = spawn(process.execPath, [path.join(project, 'server.mjs')], { env: { ...process.env, GEMINI_WORKSPACE_PORT: String(port), GEMINI_WORKSPACE_STATE: stateDir }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', value => { stderr += value; });
const client = new Client({ name: 'scoped-workspace-verifier', version: '1.0.0' });
const address = 'http://127.0.0.1:' + port;
async function post(route, value, csrf) {
  return fetch(address + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Workspace-Csrf': csrf } : {}) }, body: JSON.stringify(value) });
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start: ' + stderr)), 8000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error(stderr)); });
    child.stdout.on('data', value => { if (value.toString().includes('gemini-workspace')) { clearTimeout(timeout); resolve(); } });
  });
  let state = await (await fetch(address + '/api/state')).json();
  assert.equal((await post('/api/settings', { enabled: true })).status, 403);
  checks.push({ name: 'Dashboard mutations require CSRF token', passed: true });
  assert.equal((await post('/api/preferences', { language: 'en' })).status, 403);
  assert.equal((await post('/api/preferences', { language: 'invalid' }, state.csrf)).status, 400);
  await post('/api/preferences', { language: 'en' }, state.csrf);
  const translated = await (await fetch(address + '/api/state')).json();
  assert.equal(translated.language, 'en');
  assert.ok(state.workspace_id);
  assert.equal(translated.workspace_id, state.workspace_id);
  assert.equal(translated.workspace, state.workspace);
  assert.equal(translated.access, state.access);
  assert.equal(translated.enabled, state.enabled);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir,'config.json'),'utf8')).language,'en');
  assert.equal((await fetch(address+'/i18n.js')).status,200);
  checks.push({ name: 'Language preference persists without changing workspace authority and requires CSRF', passed: true });
  assert.equal((await fetch(address + '/api/state', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const publicStatus = await new Promise((resolve, reject) => {
    const request = http.get(address + '/api/state', { headers: { Host: 'public.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(publicStatus, 403);
  checks.push({ name: 'Public Host and foreign Origin cannot reach dashboard settings', passed: true });
  assert.equal((await fetch(address + '/mcp/wrong-key', { method: 'POST' })).status, 404);
  checks.push({ name: 'MCP capability credential required', passed: true });
  await client.connect(new StreamableHTTPClientTransport(new URL(state.localMcp)));
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['workspace_info', 'list_files', 'read_file', 'write_file', 'edit_file', 'create_directory'].sort());
  checks.push({ name: 'Real SDK handshake and exactly six file tools', passed: true });
  assert.equal((await client.callTool({ name: 'workspace_info', arguments: {} })).isError, true);
  await post('/api/settings', { enabled: true }, state.csrf);
  const infoResult = await client.callTool({ name: 'workspace_info', arguments: {} });
  let info = JSON.parse(infoResult.content[0].text);
  assert.equal(infoResult.isError, false);
  assert.deepEqual(infoResult.structuredContent, info);
  assert.equal(info.workspace, root);
  await post('/api/preferences', { language: 'zh-CN' }, state.csrf);
  const activePreference = await (await fetch(address + '/api/state')).json();
  assert.equal(activePreference.enabled, true);
  assert.equal(activePreference.workspace_id, info.workspace_id);
  checks.push({ name: 'Changing language keeps an active workspace enabled with the same ID', passed: true });
  const params = { workspace_id: info.workspace_id, path: 'http-check.txt' };
  assert.ok(!(await client.callTool({ name: 'write_file', arguments: { ...params, content: 'REAL_MCP_中文' } })).isError);
  assert.equal(JSON.parse((await client.callTool({ name: 'read_file', arguments: params })).content[0].text).text, 'REAL_MCP_中文');
  checks.push({ name: 'Real MCP file round trip within selected directory', passed: true });
  const batchResult=await client.callTool({name:'edit_file',arguments:{...params,edits:[{old_text:'REAL',new_text:'BATCH'},{old_text:'中文',new_text:'成功'}]}});
  assert.equal(batchResult.isError,false);
  assert.equal(batchResult.structuredContent.edits_applied,2);
  assert.equal(fs.readFileSync(path.join(root,params.path),'utf8'),'BATCH_MCP_成功');
  checks.push({ name: 'Real MCP schema accepts multiple replacements in a single tool request', passed: true });
  const listing = await client.callTool({ name: 'list_files', arguments: { workspace_id: info.workspace_id, path: '.' } });
  assert.deepEqual(listing.structuredContent.entries, JSON.parse(listing.content[0].text));
  checks.push({ name: 'MCP results expose structured data and preserve existing text responses', passed: true });
  assert.equal((await client.callTool({ name: 'write_file', arguments: { ...params, path: '../outside.txt', content: 'BAD' } })).isError, true);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { ...params, path: 'junction/outside.txt', content: 'BAD' } })).isError, true);
  assert.equal((await client.callTool({ name: 'start_process', arguments: {} })).isError, true);
  checks.push({ name: 'Real MCP traversal, junction escape and shell calls denied', passed: true });
  await post('/api/settings', { access: 'read' }, state.csrf);
  await post('/api/settings', { enabled: true }, state.csrf);
  info = JSON.parse((await client.callTool({ name: 'workspace_info', arguments: {} })).content[0].text);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { ...params, workspace_id: info.workspace_id, content: 'BAD' } })).isError, true);
  assert.equal((await client.callTool({ name: 'read_file', arguments: params })).isError, true);
  checks.push({ name: 'Real MCP read-only mode and stale workspace IDs enforced', passed: true });
  await post('/api/settings', { root: second, access: 'edit' }, state.csrf);
  state = await (await fetch(address + '/api/state')).json();
  assert.equal(state.workspace, second);
  assert.equal(state.enabled, false);
  checks.push({ name: 'Switching selected folder rotates workspace ID and pauses requests', passed: true });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_MUST_STAY_UNCHANGED');
  const report = { checkedAt: new Date().toISOString(), realGeminiMessagesSent: 0, fixture, toolCount: tools.length, toolSchemaCharacters: JSON.stringify(tools).length, outsideFileUnchanged: true, passed: true, checks };
  fs.writeFileSync(path.join(project, '.local/test-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, toolCount: tools.length, toolSchemaCharacters: report.toolSchemaCharacters, realGeminiMessagesSent: 0 }));
} finally {
  await client.close().catch(() => {});
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); });
}
