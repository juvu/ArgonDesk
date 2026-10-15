import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(project, '.local', 'tests', 'startup-' + randomUUID().slice(0, 8));
const root = path.join(fixture, 'folder');
fs.mkdirSync(root, { recursive: true });
const linked = path.join(fixture, 'junction');
fs.symlinkSync(root, linked, 'junction');
const cases = [
  { name: 'Existing installations stay paused until opted in', root, access: 'edit', enabled: true, expected: false },
  { name: 'Opted-in edit access starts enabled after a paused run', root, access: 'edit', enabled: false, fileAutoStart: true, expected: true },
  { name: 'Opted-in read access starts enabled but cannot write', root, access: 'read', fileAutoStart: true, expected: true },
  { name: 'Turning the option off restores paused startup', root, access: 'edit', enabled: true, fileAutoStart: false, expected: false },
  { name: 'Missing folders fail closed without being recreated', root: path.join(fixture, 'missing'), access: 'edit', fileAutoStart: true, expected: false },
  { name: 'A root replaced by a junction fails closed', root: linked, access: 'edit', fileAutoStart: true, expected: false },
  { name: 'An invalid saved permission cannot auto-enable', root, access: 'invalid', fileAutoStart: true, expected: false }
];
const results = [];
for (const [index, test] of cases.entries()) {
  const stateDir = path.join(fixture, 'state-' + index);
  fs.mkdirSync(stateDir);
  const config = { ...test, key: randomUUID(), workspaceId: randomUUID(), publicBase: '', language: 'en' };
  delete config.name;
  delete config.expected;
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config));
  const address = 'http://127.0.0.1:3019';
  const child = spawn(process.execPath, [path.join(project, 'server.mjs')], {
    env: { ...process.env, GEMINI_WORKSPACE_PORT: '3019', GEMINI_WORKSPACE_STATE: stateDir },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const client = new Client({ name: 'startup-verifier', version: '1' });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server did not start: ' + stderr)), 8000);
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(stderr)); });
      child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    });
    const state = await (await fetch(address + '/api/state')).json();
    assert.equal(state.enabled, test.expected);
    assert.equal(state.fileAutoStart, test.fileAutoStart === true);
    assert.equal(state.workspace, test.root);
    assert.equal(state.access, test.access);
    assert.equal(state.language, 'en');
    assert.notEqual(state.workspace_id, config.workspaceId);
    assert.ok(state.localMcp.endsWith('/mcp/' + config.key));
    await client.connect(new StreamableHTTPClientTransport(new URL(state.localMcp)));
    const name = 'startup-' + index + '.txt';
    const obsolete = await client.callTool({ name: 'write_file', arguments: { workspace_id: config.workspaceId, path: name, content: 'BAD', mode: 'create' } });
    assert.equal(obsolete.isError, true);
    const write = await client.callTool({ name: 'write_file', arguments: { workspace_id: state.workspace_id, path: name, content: 'AUTHORIZED', mode: 'create' } });
    const canWrite = test.expected && test.access === 'edit';
    assert.equal(write.isError, !canWrite);
    assert.equal(fs.existsSync(path.join(root, name)), canWrite);
    if (canWrite) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'AUTHORIZED');
    if (test.root.endsWith('missing')) assert.equal(fs.existsSync(test.root), false);
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    assert.equal(saved.key, config.key);
    assert.equal(saved.enabled, test.expected);
    results.push({ name: test.name, passed: true });
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
  }
}
fs.writeFileSync(path.join(project, '.local', 'startup-test-results.json'), JSON.stringify({ passed: true, modelRequests: 0, results }, null, 2));
console.log(JSON.stringify({ passed: true, startupChecks: results.length, modelRequests: 0 }));
