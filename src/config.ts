import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

export const SYNC_MODES = ["one-way-replica", "one-way-safe", "two-way-safe", "two-way-resolved"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface SessionConfig {
  id: string;
  name: string;
  label: string;
  /** 所属分组名;空表示未分组。必须是 PanelConfig.groups 里的一项,否则按未分组处理。 */
  group: string;
  host: string;
  remotePath: string;
  local: string;
  mode: SyncMode;
  ignoreVcs: boolean;
  ignore: string[];
}

/** 通过面板添加的服务器:别名对应 ~/.ssh/config 里的 Host,不保存密码。 */
export interface ServerConfig {
  alias: string;
  host: string;
  port: number;
  user: string;
}

export interface PanelConfig {
  mutagen: string;
  /** 顶层默认 SSH 别名;会话未单独写 host 时使用。 */
  host: string;
  port: number;
  openBrowser: boolean;
  token?: string;
  servers: ServerConfig[];
  /** 用户自定义的分组,按显示顺序排列。 */
  groups: string[];
  sessions: SessionConfig[];
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
/** SSH 别名:字母数字开头,后面可含 . _ -,避免被 ssh 当成选项或写坏配置文件。 */
export const SERVER_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SERVER_HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;
const SERVER_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** Mutagen 会话名:以字母开头,只能含字母、数字和连字符(不允许下划线)。 */
const SESSION_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

export function randomSuffix(): string {
  return randomBytes(3).toString("hex");
}

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (/^[A-Za-z]/.test(cleaned)) return cleaned;
  return cleaned ? `sync-${cleaned}` : `sync-${randomSuffix()}`;
}

/**
 * 自动修复不合规的会话名:非法字符换成 -、不以字母开头则加 sync- 前缀、留空则随机生成;
 * 修复后与其他会话重名时追加随机后缀。合法的名字原样保留(真正的重名仍由 parseConfig 报错)。
 */
export function repairSessionNames(value: unknown): { value: unknown; notes: string[] } {
  if (!Array.isArray(value)) return { value, notes: [] };
  const notes: string[] = [];
  const used = new Set<string>();
  const repaired = value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const session = { ...(item as Record<string, unknown>) };
    const raw = typeof session.name === "string" ? session.name.trim() : "";
    let name = SESSION_NAME.test(raw) ? raw : sanitizeName(raw);
    if (name !== raw) {
      while (used.has(name.toLowerCase())) name = `${name}-${randomSuffix()}`;
      notes.push(raw ? `会话名 ${raw} 已自动改为 ${name}` : `已为未命名的会话生成名称 ${name}`);
      session.name = name;
    }
    used.add(name.toLowerCase());
    if (typeof session.id !== "string" || !session.id.trim()) session.id = name;
    return session;
  });
  return { value: repaired, notes };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 校验一台服务器的字段;别名、主机、用户名都会写进 ssh 配置和命令行,所以限制为安全字符。 */
export function parseServer(raw: unknown, what = "服务器"): ServerConfig {
  const s = asRecord(raw, what);
  const alias = text(s.alias);
  const host = text(s.host);
  const user = text(s.user);
  const port = Number(s.port ?? 22);
  if (!SERVER_ALIAS.test(alias)) throw new Error(`别名只能用字母、数字、. _ -,且以字母或数字开头:${alias || "(空)"}`);
  if (!SERVER_HOST.test(host)) throw new Error(`主机地址不合法(填 IP 或域名):${host || "(空)"}`);
  // 四段数字的写法按 IPv4 校验,每段不能超过 255(否则会被当成域名去解析,报 ENOTFOUND)
  if (/^\d+(\.\d+){3}$/.test(host) && host.split(".").some((part) => Number(part) > 255)) {
    throw new Error(`IP 地址不合法(每一段不能超过 255):${host}`);
  }
  if (!SERVER_USER.test(user)) throw new Error(`用户名只能用字母、数字、. _ -:${user || "(空)"}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须是 1-65535 的整数");
  return { alias, host, port, user };
}

/** 校验并规范化配置;任何问题都抛出带中文说明的 Error。 */
export function parseConfig(raw: unknown): PanelConfig {
  const root = asRecord(raw, "config.json");
  const topHost = text(root.host);
  // 会话可以为空:首次运行或删光会话后,在页面里再添加
  const rawSessions = root.sessions === undefined ? [] : root.sessions;
  if (!Array.isArray(rawSessions)) throw new Error("sessions 必须是数组");

  const ids = new Set<string>();
  const names = new Set<string>();
  const locals = new Set<string>();
  const sessions = rawSessions.map((item, index): SessionConfig => {
    const s = asRecord(item, `sessions[${index}]`);
    const id = text(s.id);
    const name = text(s.name);
    if (!SAFE_ID.test(id)) throw new Error(`会话 id 只能用字母、数字、下划线、短横线:${id || "(空)"}`);
    if (!SESSION_NAME.test(name)) throw new Error(`会话名只能以字母开头,只含字母、数字和连字符 -(不能用下划线):${name || "(空)"}`);

    const mode = text(s.mode) as SyncMode;
    if (!SYNC_MODES.includes(mode)) throw new Error(`会话 ${name} 的 mode 必须是 ${SYNC_MODES.join(" / ")}`);

    const remotePath = text(s.remotePath);
    const localRaw = text(s.local);
    if (!remotePath || !localRaw) throw new Error(`会话 ${name} 缺少 remotePath 或 local`);

    const host = text(s.host) || topHost;
    if (!host) throw new Error(`会话 ${name} 没有 host(顶层 host 或会话内 host 至少填一个)`);

    const local = normalize(localRaw);
    const localKey = local.toLowerCase();
    if (ids.has(id) || names.has(name) || locals.has(localKey)) {
      throw new Error(`会话的 id、name、local 都不能重复:${name}`);
    }
    ids.add(id);
    names.add(name);
    locals.add(localKey);

    const ignore = Array.isArray(s.ignore) ? s.ignore.filter((p): p is string => typeof p === "string" && p !== "") : [];
    return {
      id,
      name,
      label: text(s.label) || name,
      group: text(s.group),
      host,
      remotePath,
      local,
      mode,
      ignoreVcs: s.ignoreVcs === true,
      ignore,
    };
  });

  const rawServers = root.servers === undefined ? [] : root.servers;
  if (!Array.isArray(rawServers)) throw new Error("servers 必须是数组");
  const aliases = new Set<string>();
  const servers = rawServers.map((item, index) => {
    const server = parseServer(item, `servers[${index}]`);
    if (aliases.has(server.alias.toLowerCase())) throw new Error(`服务器别名不能重复:${server.alias}`);
    aliases.add(server.alias.toLowerCase());
    return server;
  });

  const rawGroups = root.groups === undefined ? [] : root.groups;
  if (!Array.isArray(rawGroups)) throw new Error("groups 必须是数组");
  const groups: string[] = [];
  for (const item of rawGroups) {
    const name = text(item);
    if (name === "") continue;
    if (name.length > 40) throw new Error(`分组名太长(最多 40 个字符):${name}`);
    if (groups.some((g) => g.toLowerCase() === name.toLowerCase())) throw new Error(`分组名不能重复:${name}`);
    groups.push(name);
  }
  // 会话的分组不在列表里时按未分组处理,避免删除分组后留下悬空引用
  for (const session of sessions) {
    if (!groups.includes(session.group)) session.group = "";
  }

  const port = Number(root.port ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port 必须是 1-65535 的整数");

  const token = text(root.token);
  return {
    mutagen: text(root.mutagen) || "mutagen",
    host: topHost,
    port,
    openBrowser: root.openBrowser !== false,
    ...(token ? { token } : {}),
    servers,
    groups,
    sessions,
  };
}

/** 首次运行时写入的默认配置:没有服务器和会话,打开页面后再添加。 */
export function defaultConfig(): PanelConfig {
  return { mutagen: "mutagen", host: "", port: 8765, openBrowser: true, servers: [], groups: [], sessions: [] };
}

/**
 * 配置文件放哪:`--config` 或环境变量 PANEL_CONFIG 优先;
 * 通过 npm 安装(包目录在 node_modules 里)时放在用户目录 ~/.mutagen-panel/,升级包不会丢配置;
 * 从源码目录运行时仍用目录下的 config.json。
 */
export function resolveConfigFile(packageRoot: string, explicit?: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (explicit) return explicit;
  if (env.PANEL_CONFIG) return env.PANEL_CONFIG;
  // 两种分隔符都认:Windows 的包路径是反斜杠,测试和其他平台用正斜杠
  return packageRoot.split(/[\\/]/).includes("node_modules") ? join(home, ".mutagen-panel", "config.json") : join(packageRoot, "config.json");
}

/** 配置文件不存在就写一份默认的;返回是否新建。 */
export function ensureConfig(file: string): boolean {
  if (existsSync(file)) return false;
  mkdirSync(dirname(file), { recursive: true });
  saveConfig(file, defaultConfig());
  return true;
}

export function loadConfig(file: string): PanelConfig {
  if (!existsSync(file)) {
    throw new Error(`找不到配置文件 ${file}。`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`config.json 不是合法 JSON(Windows 路径请用 / 或 \\\\):${(error as Error).message}`);
  }
  // 旧配置里不合规的会话名自动修复并写回,避免启动即报错
  const root = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const repair = repairSessionNames(root?.sessions);
  const config = parseConfig(root ? { ...root, sessions: repair.value } : raw);
  if (repair.notes.length > 0) {
    saveConfig(file, config);
    for (const note of repair.notes) console.log(`[配置] ${note}`);
  }
  return config;
}

/** 序列化为 config.json 的内容;与顶层 host 相同的会话不重复写 host。 */
export function serializeConfig(config: PanelConfig): string {
  const slash = (path: string) => path.replace(/\\/g, "/");
  return (
    JSON.stringify(
      {
        mutagen: slash(config.mutagen),
        host: config.host,
        port: config.port,
        openBrowser: config.openBrowser,
        ...(config.token ? { token: config.token } : {}),
        ...(config.servers.length > 0 ? { servers: config.servers } : {}),
        ...(config.groups.length > 0 ? { groups: config.groups } : {}),
        sessions: config.sessions.map((s) => ({
          id: s.id,
          name: s.name,
          label: s.label,
          ...(s.group ? { group: s.group } : {}),
          ...(s.host !== config.host ? { host: s.host } : {}),
          remotePath: s.remotePath,
          local: slash(s.local),
          mode: s.mode,
          ignoreVcs: s.ignoreVcs,
          ignore: s.ignore,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

/** 先写临时文件再改名,避免写到一半断电留下损坏的配置。 */
export function saveConfig(file: string, config: PanelConfig): void {
  const temp = `${file}.tmp`;
  // 配置里可能有令牌,只允许当前用户读写(Windows 上忽略该权限位)
  writeFileSync(temp, serializeConfig(config), { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
}
