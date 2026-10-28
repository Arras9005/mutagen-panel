import assert from "node:assert/strict";
import { defaultConfig, parseConfig, repairSessionNames, resolveConfigFile, serializeConfig } from "./config.js";

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "view",
  name: "bdp-view",
  remotePath: "/data/project",
  local: "E:/mirror/project",
  mode: "one-way-replica",
  ...overrides,
});

const base = (sessions: unknown[], extra: Record<string, unknown> = {}) => ({ host: "myserver", sessions, ...extra });

// 默认值与规范化
const ok = parseConfig(base([session({ ignore: ["node_modules", 1, ""], ignoreVcs: true })]));
assert.equal(ok.port, 8765);
assert.equal(ok.host, "myserver");
assert.equal(ok.mutagen, "mutagen");
assert.equal(ok.openBrowser, true);
assert.equal(ok.sessions[0]?.host, "myserver");
assert.equal(ok.sessions[0]?.label, "bdp-view");
assert.deepEqual(ok.sessions[0]?.ignore, ["node_modules"]);
assert.equal(ok.sessions[0]?.ignoreVcs, true);

// 会话内 host 覆盖顶层 host;顶层可以省略
const own = parseConfig({ sessions: [session({ host: "other" })] });
assert.equal(own.sessions[0]?.host, "other");

// 各类非法配置
assert.deepEqual(parseConfig(base([])).sessions, []);
assert.deepEqual(parseConfig({}).sessions, []);
assert.throws(() => parseConfig({ sessions: "x" }), /sessions 必须是数组/);
assert.deepEqual(parseConfig(JSON.parse(serializeConfig(defaultConfig()))), defaultConfig());

// 配置文件位置:显式参数 > 环境变量 > npm 安装用用户目录 > 源码目录
assert.equal(resolveConfigFile("/opt/app", "/x/c.json", {}, "/home/u"), "/x/c.json");
assert.equal(resolveConfigFile("/opt/app", undefined, { PANEL_CONFIG: "/y/c.json" }, "/home/u"), "/y/c.json");
assert.equal(resolveConfigFile("/usr/lib/node_modules/mutagen-panel", undefined, {}, "/home/u").replace(/\\/g, "/"), "/home/u/.mutagen-panel/config.json");
assert.equal(resolveConfigFile("/opt/app", undefined, {}, "/home/u").replace(/\\/g, "/"), "/opt/app/config.json");
// Windows 风格的包路径(反斜杠)同样识别为"通过 npm 安装"
assert.match(resolveConfigFile("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\mutagen-panel", undefined, {}, "/home/u").replace(/\\/g, "/"), /\.mutagen-panel\/config\.json$/);
assert.throws(() => parseConfig({ sessions: [session()] }), /没有 host/);
assert.throws(() => parseConfig(base([session({ name: "bad name" })])), /会话名只能/);
assert.throws(() => parseConfig(base([session({ name: "file_sync" })])), /会话名只能/);
assert.throws(() => parseConfig(base([session({ name: "1sync" })])), /会话名只能/);
assert.equal(parseConfig(base([session({ name: "file-sync2" })])).sessions[0]?.name, "file-sync2");
assert.throws(() => parseConfig(base([session({ mode: "sync-everything" })])), /mode 必须是/);
assert.throws(() => parseConfig(base([session({ remotePath: "" })])), /缺少 remotePath 或 local/);
assert.throws(() => parseConfig(base([session()], { port: 99999 })), /port 必须是/);

// id、name、local 不能重复(local 不区分大小写,避免两个会话写同一目录)
assert.throws(
  () => parseConfig(base([session(), session({ id: "other", name: "other", local: "e:/MIRROR/project" })])),
  /不能重复/,
);
assert.throws(() => parseConfig(base([session(), session({ local: "E:/another" })])), /不能重复/);

// 序列化后可以被重新解析,且与顶层 host 相同的会话不重复写 host
const text = serializeConfig(parseConfig(base([session(), session({ id: "b", name: "b", local: "E:/b", host: "other" })])));
const again = JSON.parse(text) as { sessions: Array<{ host?: string }> };
assert.equal(again.sessions[0]?.host, undefined);
assert.equal(again.sessions[1]?.host, "other");
assert.equal(parseConfig(again).sessions.length, 2);

// 会话名自动修复:非法字符、数字开头、留空、修复后重名(追加随机后缀);合法名字不动
const fixed = repairSessionNames([
  { name: "file_sync", id: "a" },
  { name: "1sync", id: "b" },
  { name: "", id: "c" },
  { name: "file_sync", id: "d" },
  { name: "ok-name" },
]);
const names = (fixed.value as Array<{ name: string; id: string }>).map((s) => s.name);
assert.equal(names[0], "file-sync");
assert.equal(names[1], "sync-1sync");
assert.match(names[2] ?? "", /^sync-[0-9a-f]{6}$/);
assert.match(names[3] ?? "", /^file-sync-[0-9a-f]{6}$/);
assert.equal(names[4], "ok-name");
assert.equal((fixed.value as Array<{ id: string }>)[4]?.id, "ok-name");
assert.equal(fixed.notes.length, 4);
const complete = (fixed.value as Array<Record<string, unknown>>).map((item, i) => ({ ...item, remotePath: "/r", local: `E:/l${i}`, mode: "two-way-safe" }));
assert.doesNotThrow(() => parseConfig(base(complete)));

// 分组:读写往返;会话的分组不在列表里时按未分组;分组名不能重复
const grouped = parseConfig(base([session({ group: "开发" }), session({ id: "b", name: "b1", local: "E:/l2", group: "已删除的组" })], { groups: ["开发", "测试"] }));
assert.deepEqual(grouped.groups, ["开发", "测试"]);
assert.equal(grouped.sessions[0]?.group, "开发");
assert.equal(grouped.sessions[1]?.group, "");
const groupedText = serializeConfig(grouped);
assert.equal(JSON.parse(groupedText).sessions[0].group, "开发");
assert.equal(JSON.parse(groupedText).sessions[1].group, undefined);
assert.deepEqual(parseConfig(JSON.parse(groupedText)).groups, ["开发", "测试"]);
assert.throws(() => parseConfig(base([session()], { groups: ["a", "A"] })), /不能重复/);
assert.deepEqual(parseConfig(base([session()])).groups, []);

console.log("config-test: ok");
