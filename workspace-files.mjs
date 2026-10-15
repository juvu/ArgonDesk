import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 2 * 1024 * 1024;
export class WorkspaceFiles {
  constructor(config, save = () => {}) { this.config = config; this.save = save; }
  configure(update) {
    const next = { ...this.config, ...update, enabled: false, workspaceId: randomUUID() };
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
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('仅支持不超过 2 MiB 的普通文件。');
      const lines = fs.readFileSync(target, 'utf8').split('\n');
      const offset = args.offset ?? 0, count = args.lines ?? 200;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(count) || count < 1 || count > 1000) throw new Error('读取范围无效。');
      return { path: args.path, total_lines: lines.length, offset, text: lines.slice(offset, offset + count).join('\n') };
    }
    let content = args.content;
    let editsApplied = 0;
    if (name === 'edit_file') {
      if (args.edits !== undefined && (args.old_text !== undefined || args.new_text !== undefined)) throw new Error('请使用 edits 批量编辑，或 old_text/new_text 单次编辑，不要混用。');
      const edits = args.edits ?? [{ old_text: args.old_text, new_text: args.new_text }];
      if (!Array.isArray(edits) || !edits.length || edits.length > 50 || edits.some(edit => !edit || typeof edit.old_text !== 'string' || !edit.old_text || typeof edit.new_text !== 'string')) throw new Error('编辑参数无效。');
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('仅支持不超过 2 MiB 的普通文件。');
      content = fs.readFileSync(target, 'utf8');
      for (const edit of edits) {
        if (content.split(edit.old_text).length - 1 !== 1) throw new Error('待替换文本必须恰好匹配一次，请先读取文件。');
        content = content.replace(edit.old_text, () => edit.new_text);
      }
      editsApplied = edits.length;
    }
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new Error('写入内容必须为不超过 2 MiB 的文本。');
    if (name === 'write_file' && args.mode && !['create', 'rewrite', 'append'].includes(args.mode)) throw new Error('写入模式无效。');
    const append = name === 'write_file' && args.mode === 'append';
    const create = name === 'write_file' && args.mode === 'create';
    if (append && fs.existsSync(target) && fs.statSync(target).size + Buffer.byteLength(content) > MAX_BYTES) throw new Error('追加后文件将超过 2 MiB。');
    if (name === 'write_file') fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: 'utf8', flag: create ? 'wx' : append ? 'a' : 'w' });
    return { path: args.path, bytes: fs.statSync(target).size, written: true, ...(editsApplied ? { edits_applied: editsApplied } : {}) };
  }
}
