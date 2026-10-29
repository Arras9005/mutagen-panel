import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { parseConfig, parseServer, repairSessionNames, saveConfig, type PanelConfig, type ServerConfig, type SessionConfig } from "./config.js";
import { buildExcludes, pullDirectory } from "./pull.js";
import { compareFiles, diffFile, type DiffSides, type FileCompare, type FileDiff } from "./files.js";
import { listRemote, type RemoteListing } from "./remote.js";
import { removeServerEntry, resolveEndpoint, setupServer, testServer } from "./servers.js";
import { checkSsh, parseConflicts, parseList, type ConflictItem, run, sameEndpoint, type ParsedSession, type RunResult } from "./mutagen.js";

export interface ActionResult {
  ok: boolean;
  out: string;
}

export interface SessionView extends Partial<ParsedSession> {
  id: string;
  name: string;
  label: string;
  group: string;
  mode: string;
  remote: string;
  /** 该会话使用的 SSH 别名。 */
  host: string;
  /** 该别名解析出的 用户@主机:端口(`ssh -G` 解析,手写的别名也有);解析失败时为空。 */
  hostInfo: string;
  local: string;
  /** 排除规则;"覆盖本地"不会碰这些文件。 */
  ignore: string[];
  ignoreVcs: boolean;
  /** 冲突的具体文件;没有冲突时为空。 */
  conflicts: ConflictItem[];
  exists: boolean;
  /** 配置里的服务器/本地路径与已创建会话实际使用的不一致时的说明;一致则为空。 */
  drift: string;
}

/** 供界面编辑的配置视图;与顶层 host 相同的会话不带 host。 */
export interface EditableConfig {
  host: string;
  groups: string[];
  sessions: Array<Omit<SessionConfig, "host"> & { host?: string }>;
}

export interface ServerList {
  /** 通过面板添加的服务器。 */
  servers: ServerConfig[];
  /** 可供会话选择的全部 SSH 别名:面板添加的 + 顶层默认 + 会话里已在用的(含手写在 ~/.ssh/config 的)。 */
  aliases: string[];
}

export interface PanelState {
  /** 用户自定义的分组,按显示顺序。 */
  groups: string[];
  sessions: SessionView[];
  others: string[];
  listError: string;
  error?: string;
}

export interface ActionRequest {
  action?: string;
  id?: string;
  confirm?: boolean;
}

export class Panel {
  constructor(
    private config: PanelConfig,
    private readonly configFile: string,
  ) {}

  getEditableConfig(): EditableConfig {
    const { host, sessions, groups } = this.config;
    return {
      host,
      groups,
      sessions: sessions.map(({ host: own, ...rest }) => (own === host ? rest : { ...rest, host: own })),
    };
  }

  /** 校验并保存界面提交的会话配置;其余字段(mutagen 路径、端口等)沿用当前值。 */
  saveEditedConfig(body: { host?: unknown; groups?: unknown; sessions?: unknown }): ActionResult {
    const current = this.config;
    try {
      const repair = repairSessionNames(body.sessions);
      const next = parseConfig({
        mutagen: current.mutagen,
        port: current.port,
        openBrowser: current.openBrowser,
        ...(current.token ? { token: current.token } : {}),
        servers: current.servers,
        groups: body.groups ?? current.groups,
        host: body.host ?? current.host,
        sessions: repair.value,
      });
      saveConfig(this.configFile, next);
      this.config = next;
      return { ok: true, out: ["配置已保存。", ...repair.notes].join("\n") };
    } catch (error) {
      return { ok: false, out: (error as Error).message };
    }
  }

  getServers(): ServerList {
    const { servers, host, sessions } = this.config;
    const aliases = new Set<string>(servers.map((s) => s.alias));
    if (host) aliases.add(host);
    for (const session of sessions) aliases.add(session.host);
    return { servers, aliases: [...aliases] };
  }

  /** 添加或更新服务器:用密码装好密钥并写入 ~/.ssh/config,成功后才把(不含密码的)服务器信息存进配置。 */
  async saveServer(body: Record<string, unknown>): Promise<ActionResult> {
    let server: ServerConfig;
    try {
      server = parseServer(body);
    } catch (error) {
      return { ok: false, out: (error as Error).message };
    }
    const password = typeof body.password === "string" ? body.password : "";
    const result = await setupServer(server, password);
    if (!result.ok && !/免密登录验证没通过/.test(result.out)) return result;
    // 公钥和 ssh 配置已写好(即使验证没通过也保留),把服务器记进配置
    const others = this.config.servers.filter((s) => s.alias.toLowerCase() !== server.alias.toLowerCase());
    this.persist({ ...this.config, host: this.config.host || server.alias, servers: [...others, server] });
    return result;
  }

  async deleteServer(alias: string): Promise<ActionResult> {
    const known = this.config.servers.some((s) => s.alias === alias);
    if (!known) return { ok: false, out: `没有通过面板添加的服务器:${alias}` };
    const using = this.config.sessions.filter((s) => s.host === alias).map((s) => s.label);
    if (this.config.host === alias || using.length > 0) {
      const who = [...(this.config.host === alias ? ["默认服务器"] : []), ...using].join("、");
      return { ok: false, out: `服务器 ${alias} 还在被使用(${who}),请先把它们改到别的服务器。` };
    }
    try {
      removeServerEntry(alias);
    } catch (error) {
      return { ok: false, out: `清理 ~/.ssh/config 失败:${(error as Error).message}` };
    }
    this.persist({ ...this.config, servers: this.config.servers.filter((s) => s.alias !== alias) });
    return { ok: true, out: `已移除服务器 ${alias}(服务器上 authorized_keys 里的公钥未改动)。` };
  }

  /** 浏览服务器目录(只读);host 必须是已知的 SSH 别名,不接受任意主机。 */
  async browseRemote(host: string, path: string): Promise<RemoteListing> {
    if (!this.getServers().aliases.includes(host)) {
      return { ok: false, out: `未知服务器:${host}`, path, entries: [], truncated: false };
    }
    return listRemote(host, path);
  }

  /** 对比某个会话两端的文件列表(只读);排除规则与同步一致。 */
  compareSessionFiles(id: string): Promise<FileCompare> {
    // 同一个会话的读取正在进行时(比如连点"刷新"),共用同一次读取,不重复跑 ssh 和遍历
    const running = this.compareInflight.get(id);
    if (running) return running;
    const task = this.doCompareSessionFiles(id).finally(() => this.compareInflight.delete(id));
    this.compareInflight.set(id, task);
    return task;
  }

  private readonly compareInflight = new Map<string, Promise<FileCompare>>();

  private async doCompareSessionFiles(id: string): Promise<FileCompare> {
    const session = this.config.sessions.find((s) => s.id === id);
    if (!session) {
      return { ok: false, out: `未知会话:${id}`, rows: [], counts: { "server-only": 0, "local-only": 0, "size-diff": 0, "same-size": 0 }, serverCount: 0, localCount: 0, truncated: false, localMissing: false, timing: { serverMs: 0, localMs: 0, totalMs: 0 } };
    }
    return compareFiles(session.host, session.remotePath, session.local, buildExcludes(session.ignore, session.ignoreVcs));
  }

  /** 读取并对比某个文件在两端的内容;路径只能是会话目录里的相对路径。 */
  async diffSessionFile(id: string, path: string, sides: DiffSides = "both"): Promise<FileDiff> {
    const session = this.config.sessions.find((s) => s.id === id);
    if (!session) {
      return { ok: false, out: `未知会话:${id}`, path, server: { exists: false, size: 0 }, local: { exists: false, size: 0 }, binary: false, tooLarge: false, identical: false, eolOnly: false, eolIgnored: false, added: 0, removed: 0, truncated: false, hunks: [], text: "", skipped: null };
    }
    return diffFile(session.host, session.remotePath, session.local, path, sides);
  }

  testServer(alias: string): Promise<ActionResult> {
    return this.getServers().aliases.includes(alias)
      ? testServer(alias)
      : Promise.resolve({ ok: false, out: `未知服务器:${alias}` });
  }

  private persist(next: PanelConfig): void {
    saveConfig(this.configFile, next);
    this.config = next;
  }

  private mutagen(args: string[], timeoutMs?: number): Promise<RunResult> {
    return run(this.config.mutagen, args, timeoutMs);
  }

  /** 同时到达的状态请求(多个页面、或上一次还没算完)共用同一次计算,不重复调用 Mutagen。 */
  getState(): Promise<PanelState> {
    this.stateInflight ??= this.computeState().finally(() => {
      this.stateInflight = undefined;
    });
    return this.stateInflight;
  }

  private stateInflight: Promise<PanelState> | undefined;
  /** 冲突文件列表的缓存:冲突没变化时不必每次轮询都再调一次 `mutagen sync list --long`。 */
  private readonly conflictCache = new Map<string, { signature: string; at: number; items: ConflictItem[] }>();
  private static readonly CONFLICT_TTL_MS = 15_000;

  private async computeState(): Promise<PanelState> {
    const list = await this.mutagen(["sync", "list"], 20_000);
    if (!list.ok && list.code === -1) {
      return { groups: this.config.groups, sessions: [], others: [], listError: "", error: list.out };
    }
    const found = list.ok ? parseList(list.stdout) : {};
    const hosts = [...new Set(this.config.sessions.map((s) => s.host))];
    const endpoints = new Map(await Promise.all(hosts.map(async (h) => [h, await resolveEndpoint(h)] as const)));
    // 普通的 sync list 只有冲突数量;有冲突的会话再取一次 --long 才能知道是哪些文件
    const conflictFiles = new Map<string, ConflictItem[]>(
      await Promise.all(
        this.config.sessions
          .filter((s) => found[s.name]?.warns.some((w) => /^conflicts?:\s*[1-9]/i.test(w)))
          .map(async (s) => {
            // 冲突数量等没变、且在有效期内,直接用缓存
            const signature = `${found[s.name]?.status ?? ""}|${(found[s.name]?.warns ?? []).join("|")}`;
            const cached = this.conflictCache.get(s.name);
            if (cached && cached.signature === signature && Date.now() - cached.at < Panel.CONFLICT_TTL_MS) return [s.name, cached.items] as const;
            const long = await this.mutagen(["sync", "list", "--long", s.name], 20_000);
            const items = long.ok ? parseConflicts(long.stdout) : [];
            this.conflictCache.set(s.name, { signature, at: Date.now(), items });
            return [s.name, items] as const;
          }),
      ),
    );
    const sessions = this.config.sessions.map((s): SessionView => {
      const parsed = found[s.name];
      return {
        id: s.id,
        name: s.name,
        label: s.label,
        group: s.group,
        mode: s.mode,
        remote: `${s.host}:${s.remotePath}`,
        host: s.host,
        hostInfo: endpoints.get(s.host) || describeServer(this.config.servers.find((x) => x.alias === s.host)),
        local: s.local,
        ignore: s.ignore,
        ignoreVcs: s.ignoreVcs,
        conflicts: conflictFiles.get(s.name) ?? [],
        exists: parsed !== undefined,
        drift: parsed ? describeDrift(s, parsed) : "",
        ...parsed,
      };
    });
    const known = new Set(this.config.sessions.map((s) => s.name));
    return {
      groups: this.config.groups,
      sessions,
      others: Object.keys(found).filter((name) => !known.has(name)),
      listError: list.ok ? "" : list.out,
    };
  }

  async perform(request: ActionRequest): Promise<ActionResult> {
    const { action, id } = request;
    this.conflictCache.clear(); // 同步、重建、删除等操作之后冲突情况可能已经变了
    if (action === "env") return this.checkEnvironment();
    if (action === "register" || action === "unregister") return this.mutagen(["daemon", action], 30_000);

    const all = id === "*";
    const session = all ? undefined : this.config.sessions.find((s) => s.id === id);
    if (!all && !session) return { ok: false, out: `未知会话:${id ?? "(空)"}` };
    const target = session ? [session.name] : ["--all"];

    switch (action) {
      case "create":
        return session ? this.createSession(session) : this.createAll();
      case "flush":
        return session ? this.mutagen(["sync", "flush", session.name], 600_000) : this.flushAll();
      case "open-local":
        return session ? this.openLocal(session) : { ok: false, out: "打开文件夹只能针对单个会话。" };
      case "pull":
        if (!session) return { ok: false, out: "覆盖本地只能针对单个会话。" };
        if (request.confirm !== true) return { ok: false, out: "用服务器覆盖本地需要确认。" };
        return this.pullSession(session);
      case "pause":
      case "resume":
        return this.mutagen(["sync", action, ...target]);
      case "terminate":
        if (request.confirm !== true) return { ok: false, out: "删除会话需要确认。" };
        return this.mutagen(["sync", "terminate", ...target]);
      case "rebuild":
        if (!session) return { ok: false, out: "重建只能针对单个会话。" };
        if (request.confirm !== true) return { ok: false, out: "重建会话需要确认。" };
        return this.rebuildSession(session);
      case "long":
        return this.mutagen(["sync", "list", "--long", ...(session ? [session.name] : [])]);
      default:
        return { ok: false, out: `未知操作:${action ?? "(空)"}` };
    }
  }

  /** mutagen 对已暂停的会话 flush 会报错并中断整批,所以"全部"只对未暂停的会话执行。 */
  private async flushAll(): Promise<ActionResult> {
    const list = await this.mutagen(["sync", "list"], 20_000);
    if (!list.ok) return list;
    const found = parseList(list.stdout);
    const active = Object.keys(found).filter((name) => !found[name]?.paused);
    const skipped = Object.keys(found).length - active.length;
    if (active.length === 0) return { ok: true, out: "没有正在运行的会话,已跳过。" };
    const result = await this.mutagen(["sync", "flush", ...active], 600_000);
    return skipped > 0 ? { ...result, out: `${result.out}\n(已跳过 ${skipped} 个已暂停的会话)` } : result;
  }

  private async checkEnvironment(): Promise<ActionResult> {
    const version = await this.mutagen(["version"], 20_000);
    const daemon = await this.mutagen(["daemon", "start"], 20_000);
    const lines = [`[Mutagen] ${version.out}`, `[后台服务] ${daemon.out || "已运行"}`];
    let ok = version.ok;
    for (const host of new Set(this.config.sessions.map((s) => s.host))) {
      const ssh = await checkSsh(host);
      ok = ok && ssh.ok;
      lines.push(`[SSH] ${ssh.out}`);
    }
    return { ok, out: lines.join("\n") };
  }

  /** 删除已有会话(两端文件都保留)后按当前配置重新创建,用于让路径、模式、排除规则的修改生效。 */
  private async rebuildSession(session: SessionConfig): Promise<ActionResult> {
    const existing = await this.mutagen(["sync", "list", session.name], 20_000);
    let removed = "";
    if (existing.ok) {
      const terminated = await this.mutagen(["sync", "terminate", session.name]);
      if (!terminated.ok) return { ok: false, out: `删除旧会话失败:\n${terminated.out}` };
      removed = `已删除旧会话 ${session.name}。\n`;
    }
    const created = await this.createSession(session);
    return { ok: created.ok, out: `${removed}${created.out}` };
  }

  /**
   * 一次性把服务器目录的文件覆盖到本地:同名文件以服务器为准,本地多出来的文件保留。
   * 会话正在同步时先暂停,拉取完再恢复,避免同步引擎在文件写到一半时介入。
   */
  private async pullSession(session: SessionConfig): Promise<ActionResult> {
    if (session.remotePath.replace(/\/+$/, "") === "") return { ok: false, out: "服务器目录不能是根目录 /,已拒绝。" };
    const ssh = await checkSsh(session.host);
    if (!ssh.ok) return ssh;

    const listed = await this.mutagen(["sync", "list", session.name], 20_000);
    const running = listed.ok && parseList(listed.stdout)[session.name]?.paused === false;
    const paused = running && (await this.mutagen(["sync", "pause", session.name])).ok;

    mkdirSync(session.local, { recursive: true });
    const result = await pullDirectory(session.host, session.remotePath, session.local, buildExcludes(session.ignore, session.ignoreVcs));

    let tail = "";
    if (paused) {
      const resumed = await this.mutagen(["sync", "resume", session.name]);
      tail = resumed.ok ? "\n同步会话已恢复。" : `\n同步会话恢复失败,请在卡片上手动点"恢复":${resumed.out}`;
    }
    return { ok: result.ok, out: `${result.out}${tail}` };
  }

  /** 用系统的文件管理器打开会话的本地目录;路径只取自配置,不接受前端传来的路径。 */
  private openLocal(session: SessionConfig): ActionResult {
    if (!existsSync(session.local)) return { ok: false, out: `本地目录还不存在:${session.local}(创建会话后会自动建出来)` };
    const [command, args]: [string, string[]] =
      process.platform === "win32" ? ["explorer", [session.local]] : process.platform === "darwin" ? ["open", [session.local]] : ["xdg-open", [session.local]];
    try {
      spawn(command, args, { detached: true, stdio: "ignore", windowsHide: false })
        .on("error", () => undefined)
        .unref();
    } catch (error) {
      return { ok: false, out: `打开文件夹失败:${(error as Error).message}` };
    }
    return { ok: true, out: "" };
  }

  private async createAll(): Promise<ActionResult> {
    const parts: string[] = [];
    let ok = true;
    for (const session of this.config.sessions) {
      const result = await this.createSession(session);
      ok = ok && result.ok;
      parts.push(`== ${session.name} ==\n${result.out}`);
    }
    return { ok, out: parts.join("\n\n") };
  }

  private async createSession(session: SessionConfig): Promise<ActionResult> {
    const daemon = await this.mutagen(["daemon", "start"], 20_000);
    if (!daemon.ok && daemon.code === -1) return daemon;

    const existing = await this.mutagen(["sync", "list", session.name], 20_000);
    if (existing.ok) {
      const resumed = await this.mutagen(["sync", "resume", session.name]);
      return { ok: resumed.ok, out: `会话 ${session.name} 已存在,已执行恢复。\n${resumed.out}`.trim() };
    }

    const ssh = await checkSsh(session.host);
    if (!ssh.ok) return ssh;

    const createdDir = !existsSync(session.local);
    mkdirSync(session.local, { recursive: true });
    const dirNote = createdDir ? `本地目录不存在,已新建:${session.local}\n(如果路径拼错了,请编辑会话改正后重建。)\n` : "";
    const args = ["sync", "create", `--name=${session.name}`, `--mode=${session.mode}`];
    if (session.ignoreVcs) args.push("--ignore-vcs");
    for (const pattern of session.ignore) args.push(`--ignore=${pattern}`);
    args.push(`${session.host}:${session.remotePath}`, session.local);

    const created = await this.mutagen(args);
    const note = created.ok ? "\n创建成功。状态出现 Watching for changes 才算首次同步完成。" : "";
    return { ok: created.ok, out: `${ssh.out}\n${dirNote}${created.out}${note}`.trim() };
  }
}

function describeServer(server: ServerConfig | undefined): string {
  return server ? `${server.user}@${server.host}:${server.port}` : "";
}

function describeDrift(session: SessionConfig, parsed: ParsedSession): string {
  const problems: string[] = [];
  if (!sameEndpoint(`${session.host}:${session.remotePath}`, parsed.alphaUrl)) {
    problems.push(`服务器端: 实际 ${parsed.alphaUrl ?? "?"}`);
  }
  if (!sameEndpoint(session.local, parsed.betaUrl)) {
    problems.push(`本地端: 实际 ${parsed.betaUrl ?? "?"}`);
  }
  return problems.length ? `配置与已创建的会话不一致(${problems.join(";")}),点"按配置重建"使其生效。` : "";
}
