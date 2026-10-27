import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_BYTES = 10 * 1024 * 1024; // 提升至 10 MiB，避免实盘日志或大代码文件被拒
const MAX_OUTPUT_CHARS = 32000;

function resolveAgyBinary() {
  if (process.env.AGY_PATH && fs.existsSync(process.env.AGY_PATH)) return process.env.AGY_PATH;
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || 'C:\\Users\\Administrator', 'AppData', 'Local');
  const candidate = path.join(localAppData, 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(candidate)) return candidate;
  return 'agy.exe';
}

function truncateOutput(text, limit = MAX_OUTPUT_CHARS) {
  if (!text || text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return text.slice(0, half) + `\n... [truncated ${text.length - limit} chars] ...\n` + text.slice(-half);
}

export class WorkspaceFiles {
  constructor(config, save = () => {}) {
    this.config = config;
    this.save = save;
    this.agyJobs = new Map();
  }
  configure(update) {
    const sameWorkspace = (!update.root || fs.realpathSync(update.root) === this.config.root) && (!update.access || update.access === this.config.access);
    const next = {
      ...this.config,
      ...update,
      enabled: false,
      workspaceId: sameWorkspace && this.config.workspaceId ? this.config.workspaceId : randomUUID()
    };
    next.root = fs.realpathSync(next.root);
    if (!fs.statSync(next.root).isDirectory()) throw new Error('请选择现有文件夹。');
    if (!['read', 'edit'].includes(next.access)) throw new Error('权限设置无效。');
    this.config = next;
    this.save(next);
    return this.info();
  }
  info() {
    const { root, access, enabled, workspaceId } = this.config;
    return { workspace: root, workspace_id: workspaceId, access, enabled };
  }
  check(id, write = false) {
    if (!this.config.enabled) throw new Error('工作区已暂停，请在本地工作台启用。');
    if (id !== this.config.workspaceId) throw new Error('工作区已切换或权限已变化，请重新查询 workspace_info。');
    if (write && this.config.access !== 'edit') throw new Error('当前为只读模式，写入已被服务端拒绝。');
  }

  // 新增：直接执行本地 PowerShell / Python / PM2 命令（毫秒级返回，无需启动慢速 agy LLM）
  async runCommand(args = {}) {
    this.check(args.workspace_id, true);
    if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('命令不能为空。');
    const targetDir = this.resolve(args.path || '.', false);
    if (!fs.statSync(targetDir).isDirectory()) throw new Error('执行路径必须是工作区内的目录。');
    const pwsh = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const timeoutMs = Math.min(Math.max(Number(args.timeout_sec || 30), 1), 55) * 1000;
    const utf8Command = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${args.command}`;

    if (args.background) {
      const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', utf8Command], {
        cwd: targetDir,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0' }
      });
      child.unref();
      return { workspace: targetDir, pid: child.pid, status: 'started_in_background' };
    }

    const startMs = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', utf8Command], {
        cwd: targetDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '0' }
      });
      const stdout = [];
      const stderr = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
      }, timeoutMs);
      child.stdout.on('data', chunk => stdout.push(chunk));
      child.stderr.on('data', chunk => stderr.push(chunk));
      child.on('error', err => {
        clearTimeout(timer);
        reject(new Error('无法启动 PowerShell: ' + err.message));
      });
      child.on('close', code => {
        clearTimeout(timer);
        const outText = truncateOutput(Buffer.concat(stdout).toString('utf8').trim());
        const errText = truncateOutput(Buffer.concat(stderr).toString('utf8').trim());
        resolve({
          workspace: targetDir,
          exit_code: timedOut ? -1 : code,
          timed_out: timedOut,
          elapsed_ms: Date.now() - startMs,
          stdout: outText,
          ...(errText ? { stderr: errText } : {})
        });
      });
    });
  }

  // 优化：支持 50s 软超时自动转后台任务 + job_id 轮询，彻底解决 Gemini Web 60s MCP 请求断连问题
  async runAgy(args = {}) {
    if (args.job_id) {
      this.check(args.workspace_id, false);
      const job = this.agyJobs.get(args.job_id);
      if (!job) throw new Error(`未找到后台任务: ${args.job_id}`);
      return {
        job_id: job.id,
        status: job.done ? 'completed' : 'running',
        elapsed_sec: Math.round((Date.now() - job.startedAt) / 1000),
        exit_code: job.exitCode,
        response: truncateOutput(Buffer.concat(job.stdout).toString('utf8').trim()),
        ...(job.stderr.length ? { stderr: truncateOutput(Buffer.concat(job.stderr).toString('utf8').trim()) } : {})
      };
    }

    const write = args.mode !== 'plan';
    this.check(args.workspace_id, write);
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('提示词不能为空。');
    const targetDir = this.resolve(args.path || '.', false);
    if (!fs.statSync(targetDir).isDirectory()) throw new Error('执行路径必须是工作区内的目录。');
    const binary = resolveAgyBinary();
    const model = (typeof args.model === 'string' && args.model.trim()) ? args.model.trim() : 'gemini-3.8-flash-high';
    const cliArgs = ['--model', model, '--print', args.prompt.trim(), '--add-dir', targetDir, '--print-timeout', '4m0s'];
    if (args.continue) cliArgs.push('--continue');
    if (args.mode === 'plan') {
      cliArgs.push('--mode', 'plan');
    } else {
      cliArgs.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
    }

    const waitTimeoutMs = Math.min(Math.max(Number(args.wait_timeout_sec || 50), 5), 55) * 1000;
    const jobId = randomUUID().slice(0, 8);
    const job = { id: jobId, startedAt: Date.now(), stdout: [], stderr: [], done: false, exitCode: null };
    this.agyJobs.set(jobId, job);
    if (this.agyJobs.size > 30) {
      const oldestKey = this.agyJobs.keys().next().value;
      this.agyJobs.delete(oldestKey);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(binary, cliArgs, {
        cwd: targetDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let settled = false;
      const hardTimer = setTimeout(() => {
        try { child.kill(); } catch {}
        job.done = true;
        job.exitCode = -1;
      }, 245000);

      // 在 Gemini Web 60 秒断连前（默认 50 秒）提前返回 job_id，子进程继续在后台完成
      const softTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          workspace: targetDir,
          job_id: jobId,
          status: 'running_in_background',
          message: `agy 任务已运行 ${Math.round(waitTimeoutMs / 1000)}s 仍在执行中，已自动转为后台任务。可稍后调用 send_to_agy(job_id="${jobId}") 获取最终结果。`,
          partial_response: truncateOutput(Buffer.concat(job.stdout).toString('utf8').trim())
        });
      }, waitTimeoutMs);

      child.stdout.on('data', chunk => job.stdout.push(chunk));
      child.stderr.on('data', chunk => job.stderr.push(chunk));
      child.on('error', err => {
        clearTimeout(hardTimer);
        clearTimeout(softTimer);
        job.done = true;
        if (!settled) {
          settled = true;
          reject(new Error('无法启动本地 agy.exe: ' + err.message));
        }
      });
      child.on('close', code => {
        clearTimeout(hardTimer);
        clearTimeout(softTimer);
        job.done = true;
        job.exitCode = code;
        if (settled) return;
        settled = true;
        const outText = truncateOutput(Buffer.concat(job.stdout).toString('utf8').trim());
        const errText = truncateOutput(Buffer.concat(job.stderr).toString('utf8').trim());
        if (code !== 0 && !outText) {
          reject(new Error(`本地 agy 退出码 ${code}: ${errText || '未知错误'}`));
        } else {
          resolve({
            workspace: targetDir,
            job_id: jobId,
            status: 'completed',
            exit_code: code,
            response: outText,
            ...(errText ? { stderr: errText } : {})
          });
        }
      });
    });
  }

  resolve(relative = '.', missing = false) {
    const rootStat = fs.lstatSync(this.config.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || path.relative(this.config.root, fs.realpathSync(this.config.root)) !== '') throw new Error('所选工作区目录已被替换，请重新选择文件夹。');
    if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || relative.includes(':')) {
      throw new Error('只接受工作区内的相对路径。');
    }
    const segments = relative.split(/[\\/]/);
    for (const segment of segments) {
      if (segment === '..' || (segment !== '.' && (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)))) {
        throw new Error('路径包含不允许的父目录、设备名或别名。');
      }
    }
    const target = path.resolve(this.config.root, relative);
    const within = path.relative(this.config.root, target);
    if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw new Error('路径超出工作区。');
    let current = this.config.root;
    for (const part of within.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (missing && error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('不允许通过符号链接、目录联接点或硬链接访问文件。');
      const realRelative = path.relative(this.config.root, fs.realpathSync(current));
      if (realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) throw new Error('实际路径超出工作区。');
    }
    return target;
  }

  run(name, args = {}) {
    if (name === 'workspace_info') {
      this.check(this.config.workspaceId);
      return this.info();
    }
    const write = ['write_file', 'edit_file', 'create_directory'].includes(name);
    this.check(args.workspace_id, write);
    if (!['list_files', 'read_file', 'write_file', 'edit_file', 'create_directory'].includes(name)) throw new Error('此工具未提供。');
    const target = this.resolve(args.path || '.', write);
    if (name === 'list_files') {
      return fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map(item => ({
        name: item.name, type: item.isSymbolicLink() ? 'blocked_link' : item.isDirectory() ? 'directory' : 'file'
      }));
    }
    if (name === 'create_directory') {
      fs.mkdirSync(target, { recursive: true });
      return { created: args.path };
    }
    if (name === 'read_file') {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('仅支持不超过 10 MiB 的普通文件。');
      // 统一将 CRLF 归一化为 LF 切分，避免行尾残留 \r
      const raw = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
      const lines = raw.split('\n');
      const count = args.tail ?? args.lines ?? 200;
      if (!Number.isInteger(count) || count < 1 || count > 2000) throw new Error('读取行数范围无效。');
      let offset = args.offset ?? 0;
      if (args.tail !== undefined) {
        offset = Math.max(0, lines.length - args.tail);
      } else if (offset < 0) {
        offset = Math.max(0, lines.length + offset);
      }
      if (!Number.isInteger(offset) || offset < 0) throw new Error('读取偏移量无效。');
      return { path: args.path, total_lines: lines.length, offset, text: lines.slice(offset, offset + count).join('\n') };
    }
    let content = args.content;
    let editsApplied = 0;
    if (name === 'edit_file') {
      if (args.edits !== undefined && (args.old_text !== undefined || args.new_text !== undefined)) throw new Error('请使用 edits 批量编辑，或 old_text/new_text 单次编辑，不要混用。');
      const edits = args.edits ?? [{ old_text: args.old_text, new_text: args.new_text }];
      if (!Array.isArray(edits) || !edits.length || edits.length > 50 || edits.some(edit => !edit || typeof edit.old_text !== 'string' || !edit.old_text || typeof edit.new_text !== 'string')) throw new Error('编辑参数无效。');
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('仅支持不超过 10 MiB 的普通文件。');
      const rawContent = fs.readFileSync(target, 'utf8');
      // 优化 3：自动兼容 Windows CRLF (\r\n) 与 LLM 传入的 LF (\n)，并在写回时保留原文件换行格式
      const preferCRLF = rawContent.includes('\r\n');
      let normalizedContent = rawContent.replace(/\r\n/g, '\n');
      for (const edit of edits) {
        const normOld = edit.old_text.replace(/\r\n/g, '\n');
        const normNew = edit.new_text.replace(/\r\n/g, '\n');
        const matches = normalizedContent.split(normOld).length - 1;
        if (matches !== 1) {
          throw new Error(`待替换文本必须恰好匹配一次（当前匹配 ${matches} 次），请先读取文件确认上下文。`);
        }
        normalizedContent = normalizedContent.replace(normOld, () => normNew);
      }
      content = preferCRLF ? normalizedContent.replace(/\n/g, '\r\n') : normalizedContent;
      editsApplied = edits.length;
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new Error('写入内容必须为不超过 10 MiB 的文本。');
    if (name === 'write_file' && args.mode && !['create', 'rewrite', 'append'].includes(args.mode)) throw new Error('写入模式无效。');
    const append = name === 'write_file' && args.mode === 'append';
    const create = name === 'write_file' && args.mode === 'create';
    if (append && fs.existsSync(target) && fs.statSync(target).size + Buffer.byteLength(content) > MAX_BYTES) throw new Error('追加后文件将超过 10 MiB。');
    if (name === 'write_file') fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: create ? 'wx' : append ? 'a' : 'w' });
    return { path: args.path, bytes: fs.statSync(target).size, written: true, ...(editsApplied ? { edits_applied: editsApplied } : {}) };
  }
}
