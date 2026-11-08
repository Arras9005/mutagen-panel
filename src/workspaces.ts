import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_ALIAS, type WorkspaceConfig } from "./config.js";
import { checkSsh, run, runWithInput } from "./mutagen.js";
import { beginMark, endMark, ensureKey, keyFile, mergeSshConfig, readSshConfig, slash, sshDir, writeSshConfig } from "./servers.js";

/**
 * 隔离区(envBuilder 的工作区):每套有自己的文件通道,是一个以工作区用户身份运行的 sshd,只在服务器内部可达。
 * 面板经你已经添加的服务器(root)用 ProxyJump 跳过去,所以:
 * - 登录进去就是工作区用户,Mutagen 创建的文件天然属于它,没有权限问题;
 * - 服务器上没有新的对外端口,本机不用开隧道;
 * - 主机密钥由服务器给出,面板直接钉住(StrictHostKeyChecking yes),不是「首次信任」。
 * 服务器上的命令是 /usr/local/sbin/workspace-ctl(files-list、files-info、set-sshkey、clear-sshkey),需要 root。
 */
export const CTL = "/usr/local/sbin/workspace-ctl";
export const WORKSPACE_ID = /^ws0[1-8]$/;
/** 隔离区同步默认排除的东西:体积大、可再生、或各自系统专有的文件 */
export const DEFAULT_IGNORE = ["node_modules", "__pycache__/", ".cache/", "*.log", ".DS_Store", "Thumbs.db"];
/** 默认同步的目录(相对工作区家目录):每套工作区创建时就有的 data 目录(只有这个用户能进) */
export const DEFAULT_REMOTE_DIR = "data";

export interface FilesInfo {
  unit?: { active?: string };
  ok: boolean;
  address: string;
  port: number;
  user: string;
  syncDir: string;
  keys: Array<{ fingerprint: string; comment: string }>;
  hostKey: { type: string; key: string; fingerprint: string } | null;
}

export interface CtlWorkspace {
  id: string;
  state: string;
  user: string;
  files: FilesInfo;
}

export type CtlResult<T> = { ok: true; data: T } | { ok: false; out: string };

/** 在服务器上执行 workspace-ctl。服务器是面板里已添加的 root 别名;参数都是固定的几种,编号先过正则。 */
export type CtlRunner = (server: string, args: string[], input?: string) => Promise<CtlResult<unknown>>;

export function parseCtlOutput(stdout: string, code: number, rawOut: string): CtlResult<unknown> {
  if (code === 127 || /command not found|No such file/i.test(rawOut)) {
    return { ok: false, out: "服务器上没有 workspace-ctl:这台服务器没有装隔离工作区系统,或者更新后还没升级到带文件通道的版本。" };
  }
  let parsed: { ok?: unknown; data?: unknown; message?: unknown; step?: unknown } | undefined;
  try {
    parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "") as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (parsed?.ok === true) return { ok: true, data: parsed.data };
  if (parsed?.ok === false) {
    const message = typeof parsed.message === "string" ? parsed.message : "失败";
    const hint = /root/.test(message) ? "(这台服务器登录用的不是 root,隔离区同步需要 root)" : "";
    return { ok: false, out: `${typeof parsed.step === "string" ? parsed.step + ":" : ""}${message}${hint}` };
  }
  return { ok: false, out: rawOut.trim() || "服务器没有返回可读的结果" };
}

export const sshCtl: CtlRunner = async (server, args, input) => {
  if (!SERVER_ALIAS.test(server)) return { ok: false, out: `服务器别名不合法:${server}` };
  const argv = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", server, CTL, ...args];
  const result = input === undefined ? await run("ssh", argv, 60_000) : await runWithInput("ssh", argv, input, 60_000);
  if (result.code === -1) return { ok: false, out: result.out };
  if (result.code === 255) return { ok: false, out: `连不上服务器 ${server}:\n${result.out}` };
  return parseCtlOutput(result.stdout, result.code, result.out);
};

// ---------------------------------------------------------------- 读取

export interface WorkspaceRow {
  id: string;
  state: string;
  user: string;
  channel: boolean;
  keys: number;
  /** 这一套是不是已经添加到面板(有对应的别名) */
  alias: string;
}

export async function listWorkspaces(ctl: CtlRunner, server: string, linked: WorkspaceConfig[]): Promise<{ ok: true; rows: WorkspaceRow[] } | { ok: false; out: string }> {
  const res = await ctl(server, ["files-list"]);
  if (!res.ok) return res;
  const list = (res.data as { workspaces?: CtlWorkspace[] } | null)?.workspaces;
  if (!Array.isArray(list)) return { ok: false, out: "服务器返回的隔离区列表读不懂,服务器上的系统可能需要更新。" };
  const rows = list
    .filter((w) => WORKSPACE_ID.test(w.id))
    .map((w): WorkspaceRow => ({
      id: w.id,
      state: w.state,
      user: w.user,
      channel: w.files?.ok === true,
      keys: Array.isArray(w.files?.keys) ? w.files.keys.length : 0,
      alias: linked.find((x) => x.server === server && x.id === w.id)?.alias ?? "",
    }));
  return { ok: true, rows };
}

// ---------------------------------------------------------------- ssh 配置和已知主机

export const knownHostsFile = (): string => join(sshDir(), "mutagen-panel_known_hosts");

/** 写进 ~/.ssh/config 的条目:经服务器 ProxyJump,用面板的密钥,主机密钥钉在专用文件里。 */
export function renderWorkspaceBlock(w: WorkspaceConfig, identityFile: string, knownHosts: string): string {
  return [
    beginMark(w.alias),
    `Host ${w.alias}`,
    `    HostName ${w.address}`,
    `    Port ${w.port}`,
    `    User ${w.user}`,
    `    ProxyJump ${w.server}`,
    `    IdentityFile "${slash(identityFile)}"`,
    "    IdentitiesOnly yes",
    `    HostKeyAlias ${w.alias}`,
    `    UserKnownHostsFile "${slash(knownHosts)}"`,
    "    StrictHostKeyChecking yes",
    "    ServerAliveInterval 30",
    "    ServerAliveCountMax 6",
    endMark(w.alias),
    "",
  ].join("\n");
}

/** 把一行主机公钥钉到专用 known_hosts(同一别名的旧行被替换);line 为 null 表示删除这个别名的行。 */
export function mergeKnownHosts(existing: string, alias: string, line: string | null): string {
  const kept = existing.split(/\r?\n/).filter((l) => l !== "" && l.split(/\s+/)[0] !== alias);
  if (line !== null) kept.push(`${alias} ${line}`);
  return kept.length > 0 ? kept.join("\n") + "\n" : "";
}

export function fingerprintOf(publicKeyLine: string): string {
  const blob = Buffer.from(publicKeyLine.trim().split(/\s+/)[1] ?? "", "base64");
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

export interface LinkDeps {
  ctl: CtlRunner;
  publicKey: () => Promise<string>;
  keyPath: () => string;
  knownHostsPath: () => string;
  readSsh: () => string;
  writeSsh: (text: string) => void;
  readKnown: () => string;
  writeKnown: (text: string) => void;
  check: (alias: string) => Promise<{ ok: boolean; out: string }>;
}

export const defaultLinkDeps: LinkDeps = {
  ctl: sshCtl,
  publicKey: ensureKey,
  keyPath: keyFile,
  knownHostsPath: knownHostsFile,
  readSsh: readSshConfig,
  writeSsh: writeSshConfig,
  readKnown: () => (existsSync(knownHostsFile()) ? readFileSync(knownHostsFile(), "utf8") : ""),
  writeKnown: (text) => {
    mkdirSync(sshDir(), { recursive: true });
    writeFileSync(knownHostsFile(), text, "utf8");
  },
  check: checkSsh,
};

export function workspaceAlias(server: string, id: string, existing: WorkspaceConfig[]): string {
  const known = existing.find((w) => w.server === server && w.id === id);
  return known ? known.alias : `${server}-${id}`;
}

/** running:通道现在在线;verified:在线时登录验证通过了(没运行时是 false,也不算失败)。 */
export type LinkResult = { ok: true; out: string; workspace: WorkspaceConfig; running: boolean; verified: boolean } | { ok: false; out: string };

/**
 * 把一套隔离区接到面板上:向服务器取地址和主机公钥 → 登记面板的公钥 → 钉住主机公钥 → 写 ssh 配置 → (运行中时)验证登录。
 * 可以重复执行:公钥按指纹去重,ssh 配置和已知主机按别名替换。
 */
export async function linkWorkspace(deps: LinkDeps, server: string, id: string, existing: WorkspaceConfig[]): Promise<LinkResult> {
  if (!WORKSPACE_ID.test(id)) return { ok: false, out: `隔离区编号不合法:${id}` };
  const alias = workspaceAlias(server, id, existing);
  if (!SERVER_ALIAS.test(alias)) return { ok: false, out: `别名不合法:${alias}` };

  const info = await deps.ctl(server, ["files-info", id]);
  if (!info.ok) return info;
  const data = info.data as { state?: string; files?: FilesInfo } | null;
  const files = data?.files;
  if (!files || !files.hostKey || typeof files.address !== "string" || typeof files.user !== "string") {
    return { ok: false, out: "服务器没有返回文件通道的信息(服务器上的系统版本太旧,请先更新)。" };
  }
  const workspace: WorkspaceConfig = { alias, server, id, user: files.user, address: files.address, port: files.port };

  const publicKey = await deps.publicKey();
  const registered = await deps.ctl(server, ["set-sshkey", id], publicKey + "\n");
  if (!registered.ok) return { ok: false, out: `登记公钥失败:${registered.out}` };

  const block = renderWorkspaceBlock(workspace, deps.keyPath(), deps.knownHostsPath());
  const nextSsh = mergeSshConfig(deps.readSsh(), alias, block);
  const nextKnown = mergeKnownHosts(deps.readKnown(), alias, files.hostKey.key);
  deps.writeKnown(nextKnown);
  deps.writeSsh(nextSsh);

  const running = data?.state === "running" && files.ok === true;
  if (!running) {
    return { ok: true, running, verified: false, workspace, out: `隔离区 ${id} 已添加。它现在没有运行,启动之后会自动连上、开始同步。` };
  }
  const check = await deps.check(alias);
  return check.ok
    ? { ok: true, running, verified: true, workspace, out: `隔离区 ${id} 已就绪:${check.out}` }
    : { ok: true, running, verified: false, workspace, out: `隔离区 ${id} 已添加,但登录验证没通过:\n${check.out}` };
}

/** 撤销:去掉 ssh 配置和已知主机里的条目;尽力在服务器上撤销这把公钥(服务器连不上也没关系)。 */
export async function unlinkWorkspace(deps: LinkDeps, w: WorkspaceConfig): Promise<string> {
  const next = mergeSshConfig(deps.readSsh(), w.alias, null);
  deps.writeSsh(next);
  deps.writeKnown(mergeKnownHosts(deps.readKnown(), w.alias, null));
  let note = "";
  try {
    const fp = fingerprintOf(await deps.publicKey());
    const cleared = await deps.ctl(w.server, ["clear-sshkey", w.id], fp + "\n");
    note = cleared.ok ? "服务器上这把公钥也已撤销。" : "服务器上的公钥没能撤销(可能连不上服务器),不影响本机。";
  } catch {
    note = "服务器上的公钥没能撤销,不影响本机。";
  }
  return `已移除隔离区 ${w.alias}。${note}`;
}

/** 工作区目录:相对路径接在家目录后面,绝对路径必须在家目录里。不允许 .. 和控制字符。返回完整路径,不合法返回 null。 */
export function resolveRemoteDir(user: string, input: string): string | null {
  const home = `/home/${user}`;
  const raw = (input || DEFAULT_REMOTE_DIR).trim();
  if (raw === "" || raw.length > 300 || /[\u0000-\u001f\u007f\\]/.test(raw) || raw.split("/").includes("..")) return null;
  const full = raw.startsWith("/") ? raw : `${home}/${raw}`;
  const clean = full.replace(/\/+/g, "/").replace(/\/$/, "");
  return clean === home || clean.startsWith(`${home}/`) ? clean : null;
}
