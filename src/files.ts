import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { structuredPatch } from "diff";
import { run } from "./mutagen.js";
import { shellQuote } from "./pull.js";

export type FileState = "server-only" | "local-only" | "size-diff" | "same-size";

export interface FileInfo {
  size: number;
  /** 修改时间,秒(Unix 时间戳)。 */
  mtime: number;
  type: "file" | "link";
}

/**
 * 传给界面的紧凑格式(2.7 万个文件时比对象数组小 60% 以上、序列化快 3 倍):
 * [路径, 状态码, 服务器大小, 服务器修改时间, 本地大小, 本地修改时间],不存在的一边大小为 -1。
 * 状态码:0 仅服务器、1 仅本地、2 大小不同、3 大小相同。
 */
export type WireRow = [path: string, state: 0 | 1 | 2 | 3, serverSize: number, serverMtime: number, localSize: number, localMtime: number];
export interface FileCompare {
  ok: boolean;
  out: string;
  rows: WireRow[];
  counts: Record<FileState, number>;
  serverCount: number;
  localCount: number;
  /** 某一边的文件太多,被截断。 */
  truncated: boolean;
  /** 本地目录还不存在。 */
  localMissing: boolean;
  /** 各部分用时(毫秒),用来判断慢在哪一边。两边是同时读取的,所以 total 约等于较慢的一边。 */
  timing: { serverMs: number; localMs: number; totalMs: number };
}

export const MAX_FILES = 20_000;
/** 单侧文件超过这个大小就不读内容、不做差异。 */
export const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 6000;

// ---------------------------------------------------------------- 排除规则

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of glob) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * 把 buildExcludes 的结果(tar 的 --exclude 模式)变成匹配函数:
 * 以 ./ 开头的只匹配根目录下的相对路径,其余匹配任意层级的文件名或目录名。
 * 参数是以 / 分隔、不带 ./ 的相对路径。
 */
export function makeIgnoreMatcher(excludes: string[]): (relPath: string) => boolean {
  const anchored: RegExp[] = [];
  const names: RegExp[] = [];
  for (const pattern of excludes) {
    if (pattern.startsWith("./")) anchored.push(globToRegExp(pattern.slice(2)));
    else names.push(globToRegExp(pattern));
  }
  return (relPath) => {
    if (anchored.some((re) => re.test(relPath))) return true;
    const name = relPath.slice(relPath.lastIndexOf("/") + 1);
    return names.some((re) => re.test(name));
  };
}

// ---------------------------------------------------------------- 服务器端列表

/** 服务器上执行的只读命令:列出所有文件(含符号链接),跳过被排除的目录和文件。 */
export function buildFindCommand(root: string, excludes: string[]): string {
  const conditions = excludes.map((pattern) => (pattern.startsWith("./") ? `-path ${shellQuote(pattern)}` : `-name ${shellQuote(pattern)}`));
  const prune = conditions.length > 0 ? `\\( ${conditions.join(" -o ")} \\) -prune -o ` : "";
  return `cd -- ${shellQuote(root)} && find . ${prune}\\( -type f -o -type l \\) -printf '%P\\t%y\\t%s\\t%T@\\n' | head -n ${MAX_FILES + 1}`;
}

export function parseFindOutput(stdout: string): Map<string, FileInfo> {
  const files = new Map<string, FileInfo>();
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 4) continue;
    const [path = "", kind = "", size = "", mtime = ""] = parts;
    if (path === "" || (kind !== "f" && kind !== "l")) continue;
    const bytes = Number(size);
    const seconds = Number(mtime);
    if (!Number.isFinite(bytes) || !Number.isFinite(seconds)) continue;
    files.set(path, { size: bytes, mtime: Math.floor(seconds), type: kind === "l" ? "link" : "file" });
  }
  return files;
}

export async function listRemoteFiles(host: string, root: string, excludes: string[]): Promise<{ ok: boolean; out: string; files: Map<string, FileInfo> }> {
  if (host === "" || host.startsWith("-")) return { ok: false, out: "服务器别名不合法。", files: new Map() };
  // 文件列表是文本且很长,开启压缩对慢速网络效果明显
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "Compression=yes", host, buildFindCommand(root, excludes)], 90_000);
  if (result.code === -1) return { ok: false, out: result.out, files: new Map() };
  const files = parseFindOutput(result.stdout);
  // find 遇到没有权限的子目录会返回非 0,但列表仍然有效;只有一个文件都没读到时才当作失败
  if (files.size === 0 && !result.ok) {
    const reason = result.out.replace(/^bash: line \d+: /, "").trim();
    return { ok: false, out: reason || "无法读取服务器目录(目录不存在、没有权限,或 SSH 连接失败)。", files };
  }
  return { ok: true, out: "", files };
}

// ---------------------------------------------------------------- 本地列表

/**
 * 遍历本地目录,返回所有文件(含符号链接)的大小和修改时间,按排除规则剪枝。
 *
 * 用同步的 readdir / lstat(逐个调用最快),但每做 10 毫秒就让出一次事件循环,
 * 所以不会卡住面板的其他请求,而且服务器端的 ssh 子进程同时在跑。
 * (实测:改成异步并发调用反而慢了 8 倍,因为每次调用都要在线程池里来回切换。)
 */
export async function walkLocal(root: string, isIgnored: (rel: string) => boolean): Promise<{ files: Map<string, FileInfo>; truncated: boolean; missing: boolean }> {
  const files = new Map<string, FileInfo>();
  try {
    if (!lstatSync(root).isDirectory()) return { files, truncated: false, missing: true };
  } catch {
    return { files, truncated: false, missing: true };
  }

  const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  let sliceStart = Date.now();
  let processed = 0;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries;
    try {
      entries = readdirSync(dir.abs, { withFileTypes: true });
    } catch {
      continue; // 没有权限的目录跳过
    }
    for (const entry of entries) {
      const rel = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
      if (isIgnored(rel)) continue;
      const abs = dir.abs + sep + entry.name; // 不用 path.join:它要做路径规范化,实测占了遍历时间的 30%
      if (entry.isDirectory()) {
        stack.push({ abs, rel });
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.size > MAX_FILES) return { files, truncated: true, missing: false };
        try {
          const stat = lstatSync(abs);
          files.set(rel, { size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000), type: entry.isSymbolicLink() ? "link" : "file" });
        } catch {
          // 列出后又被删除的文件跳过
        }
      }
      processed += 1;
      if (processed % 64 === 0 && Date.now() - sliceStart > 10) {
        await yieldNow();
        sliceStart = Date.now();
      }
    }
  }
  return { files, truncated: false, missing: false };
}

// ---------------------------------------------------------------- 合并对比

/**
 * 把两边的文件列表合并成紧凑行。一遍扫描、直接产出最终数组:不建中间对象、不建大 Set,
 * 2.7 万个文件时垃圾回收压力小得多;也不排序(界面按目录分组时本来就要自己排)。
 */
export function mergeListings(server: Map<string, FileInfo>, local: Map<string, FileInfo>): { rows: WireRow[]; counts: Record<FileState, number> } {
  const byCode: [number, number, number, number] = [0, 0, 0, 0];
  const rows: WireRow[] = [];
  for (const [path, s] of server) {
    const l = local.get(path);
    if (l) {
      const state: 2 | 3 = s.size === l.size ? 3 : 2;
      byCode[state] += 1;
      rows.push([path, state, s.size, s.mtime, l.size, l.mtime]);
    } else {
      byCode[0] += 1;
      rows.push([path, 0, s.size, s.mtime, -1, 0]);
    }
  }
  for (const [path, l] of local) {
    if (server.has(path)) continue;
    byCode[1] += 1;
    rows.push([path, 1, -1, 0, l.size, l.mtime]);
  }
  return { rows, counts: { "server-only": byCode[0], "local-only": byCode[1], "size-diff": byCode[2], "same-size": byCode[3] } };
}

export async function compareFiles(host: string, serverRoot: string, localRoot: string, excludes: string[]): Promise<FileCompare> {
  const empty = { "server-only": 0, "local-only": 0, "size-diff": 0, "same-size": 0 };
  const started = Date.now();
  // 服务器和本地同时读取:总时间取决于较慢的一边,而不是两边相加
  const [remote, local] = await Promise.all([
    (async () => {
      const t = Date.now();
      return { result: await listRemoteFiles(host, serverRoot, excludes), ms: Date.now() - t };
    })(),
    (async () => {
      const t = Date.now();
      return { result: await walkLocal(localRoot, makeIgnoreMatcher(excludes)), ms: Date.now() - t };
    })(),
  ]);
  const timing = { serverMs: remote.ms, localMs: local.ms, totalMs: Date.now() - started };
  if (!remote.result.ok) {
    return { ok: false, out: remote.result.out, rows: [], counts: empty, serverCount: 0, localCount: 0, truncated: false, localMissing: false, timing };
  }
  const serverFiles = remote.result.files;
  const truncated = local.result.truncated || serverFiles.size > MAX_FILES;
  if (serverFiles.size > MAX_FILES) {
    for (const key of [...serverFiles.keys()].slice(MAX_FILES)) serverFiles.delete(key);
  }
  const { rows, counts } = mergeListings(serverFiles, local.result.files);
  return { ok: true, out: "", rows, counts, serverCount: serverFiles.size, localCount: local.result.files.size, truncated, localMissing: local.result.missing, timing };
}

// ---------------------------------------------------------------- 路径安全

/**
 * 校验前端传来的相对路径:不能是绝对路径、盘符、含 ..、空段、反斜杠或控制字符。
 * 通过则返回规范化后的路径,否则返回 null。
 */
export function safeRelPath(rel: string): string | null {
  if (rel === "" || rel.length > 4096) return null;
  if (/[\0\r\n\\]/.test(rel) || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

// ---------------------------------------------------------------- 读取文件内容

export interface SideContent {
  exists: boolean;
  size: number;
  /** 文件内容(超过大小限制时为空)。 */
  text: string;
  binary: boolean;
  tooLarge: boolean;
}

const MISSING: SideContent = { exists: false, size: 0, text: "", binary: false, tooLarge: false };

export function readLocalFile(root: string, rel: string): SideContent {
  const safe = safeRelPath(rel);
  if (safe === null) throw new Error("路径不合法。");
  let abs: string;
  try {
    const realRoot = realpathSync(root);
    abs = realpathSync(join(realRoot, ...safe.split("/")));
    // 符号链接指到根目录之外的不读取
    if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return { ...MISSING };
  } catch {
    return { ...MISSING };
  }
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    return { ...MISSING };
  }
  if (!stat.isFile()) return { ...MISSING };
  if (stat.size > MAX_DIFF_BYTES) return { exists: true, size: stat.size, text: "", binary: false, tooLarge: true };
  const buffer = Buffer.alloc(stat.size);
  const fd = openSync(abs, "r");
  try {
    readSync(fd, buffer, 0, stat.size, 0);
  } finally {
    closeSync(fd);
  }
  return { exists: true, size: stat.size, text: buffer.toString("utf8"), binary: buffer.includes(0), tooLarge: false };
}

/** 服务器上读取单个文件:先打印大小,再打印内容(最多比限制多 1 字节,用来判断是否超限)。 */
export function buildCatCommand(root: string, rel: string): string {
  const file = shellQuote(`./${rel}`);
  return `cd -- ${shellQuote(root)} && if [ -f ${file} ]; then wc -c < ${file}; head -c ${MAX_DIFF_BYTES + 1} -- ${file}; else echo MISSING; fi`;
}

export function parseCatOutput(stdout: string): SideContent {
  const newline = stdout.indexOf("\n");
  const head = (newline < 0 ? stdout : stdout.slice(0, newline)).trim();
  if (head === "MISSING" || head === "") return { ...MISSING };
  const size = Number(head);
  if (!Number.isFinite(size)) return { ...MISSING };
  if (size > MAX_DIFF_BYTES) return { exists: true, size, text: "", binary: false, tooLarge: true };
  const text = newline < 0 ? "" : stdout.slice(newline + 1);
  return { exists: true, size, text, binary: text.includes("\0"), tooLarge: false };
}

export async function readRemoteFile(host: string, root: string, rel: string): Promise<SideContent> {
  const safe = safeRelPath(rel);
  if (safe === null) throw new Error("路径不合法。");
  if (host === "" || host.startsWith("-")) throw new Error("服务器别名不合法。");
  const result = await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, buildCatCommand(root, safe)], 60_000);
  if (result.code === -1) throw new Error(result.out);
  if (result.stdout === "" && !result.ok) throw new Error(result.out || "无法读取服务器上的文件。");
  return parseCatOutput(result.stdout);
}

// ---------------------------------------------------------------- 差异

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 每行以 " "(相同)、"-"(只在服务器)、"+"(只在本地)开头。 */
  lines: string[];
}

export interface FileDiff {
  ok: boolean;
  out: string;
  path: string;
  server: { exists: boolean; size: number };
  local: { exists: boolean; size: number };
  /** 没有读取的一边("local" 表示只读了服务器,"server" 表示只读了本地);两边都读了则为 null。 */
  skipped: "server" | "local" | null;
  binary: boolean;
  tooLarge: boolean;
  /** 内容完全相同。 */
  identical: boolean;
  /** 除了换行符(CRLF / LF)之外没有区别。 */
  eolOnly: boolean;
  /** 比较时忽略了换行符差异。 */
  eolIgnored: boolean;
  added: number;
  removed: number;
  truncated: boolean;
  hunks: DiffHunk[];
  /** 文件内容:两边一致、只有换行符不同、或只在一边有时返回(此时没有 hunks),供界面直接显示。 */
  text: string;
}

/** 对两段文本做行级差异(上下文 3 行);服务器是"旧"的一边(-),本地是"新"的一边(+)。 */
export function computeDiff(serverText: string, localText: string): Pick<FileDiff, "identical" | "eolOnly" | "eolIgnored" | "added" | "removed" | "truncated" | "hunks"> {
  if (serverText === localText) return { identical: true, eolOnly: false, eolIgnored: false, added: 0, removed: 0, truncated: false, hunks: [] };
  const normalize = (text: string): string => text.replace(/\r\n/g, "\n");
  const a = normalize(serverText);
  const b = normalize(localText);
  const eolIgnored = a !== serverText || b !== localText;
  if (a === b) return { identical: false, eolOnly: true, eolIgnored: true, added: 0, removed: 0, truncated: false, hunks: [] };

  const patch = structuredPatch("服务器", "本地", a, b, "", "", { context: 3 });
  let added = 0;
  let removed = 0;
  let budget = MAX_DIFF_LINES;
  let truncated = false;
  const hunks: DiffHunk[] = [];
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    const lines = hunk.lines.slice(0, budget);
    if (lines.length < hunk.lines.length) truncated = true;
    budget -= lines.length;
    hunks.push({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines });
  }
  return { identical: false, eolOnly: false, eolIgnored, added, removed, truncated, hunks };
}

/** 要读取哪一边:绿色(大小一致)的文件只读本地即可,不必再通过 SSH 去读服务器。 */
export type DiffSides = "both" | "local" | "server";

export async function diffFile(host: string, serverRoot: string, localRoot: string, rel: string, sides: DiffSides = "both"): Promise<FileDiff> {
  const base: FileDiff = {
    ok: true,
    out: "",
    path: rel,
    server: { exists: false, size: 0 },
    local: { exists: false, size: 0 },
    skipped: sides === "local" ? "server" : sides === "server" ? "local" : null,
    binary: false,
    tooLarge: false,
    identical: false,
    eolOnly: false,
    eolIgnored: false,
    added: 0,
    removed: 0,
    truncated: false,
    hunks: [],
    text: "",
  };
  if (safeRelPath(rel) === null) return { ...base, ok: false, out: "路径不合法。" };
  let server: SideContent = { ...MISSING };
  let local: SideContent = { ...MISSING };
  try {
    [server, local] = await Promise.all([
      sides === "local" ? Promise.resolve({ ...MISSING }) : readRemoteFile(host, serverRoot, rel),
      Promise.resolve(sides === "server" ? { ...MISSING } : readLocalFile(localRoot, rel)),
    ]);
  } catch (error) {
    return { ...base, ok: false, out: (error as Error).message };
  }
  const result: FileDiff = { ...base, server: { exists: server.exists, size: server.size }, local: { exists: local.exists, size: local.size } };

  // 只读了一边:直接给内容,不做差异
  if (sides !== "both") {
    const one = sides === "local" ? local : server;
    if (!one.exists) return { ...result, ok: false, out: sides === "local" ? "本地没有这个文件。" : "服务器上没有这个文件。" };
    if (one.tooLarge) return { ...result, tooLarge: true };
    if (one.binary) return { ...result, binary: true };
    return { ...result, text: one.text };
  }

  if (!server.exists && !local.exists) return { ...result, ok: false, out: "两边都没有这个文件。" };
  if (server.tooLarge || local.tooLarge) return { ...result, tooLarge: true };
  if (server.binary || local.binary) return { ...result, binary: true };
  // 只在一边有:直接给内容,不做差异(全是新增/删除的"差异"没有意义)
  if (server.exists && !local.exists) return { ...result, text: server.text };
  if (!server.exists && local.exists) return { ...result, text: local.text };
  const diff = computeDiff(server.text, local.text);
  return { ...result, ...diff, text: diff.identical || diff.eolOnly ? local.text : "" };
}
