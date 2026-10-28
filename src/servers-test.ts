import assert from "node:assert/strict";
import { parseConfig, parseServer } from "./config.js";
import { mergeSshConfig, parseSshG, renderSshBlock } from "./servers.js";

const server = { alias: "dev", host: "1.2.3.4", port: 2222, user: "root" };
const block = renderSshBlock(server, "C:\\Users\\me\\.ssh\\mutagen-panel_ed25519");
assert.match(block, /Host dev\n/);
assert.match(block, /Port 2222/);
assert.match(block, /IdentityFile "C:\/Users\/me\/\.ssh\/mutagen-panel_ed25519"/);

// 空配置:直接写入;已有内容:追加且保留原文
assert.equal(mergeSshConfig("", "dev", block), block);
const existing = "Host other\n    HostName 9.9.9.9\n";
const appended = mergeSshConfig(existing, "dev", block);
assert.ok(appended.startsWith(existing));
assert.ok(appended.endsWith(block));

// 再次写入同一别名:替换面板条目,不重复
const updated = mergeSshConfig(appended, "dev", renderSshBlock({ ...server, port: 22 }, "k"));
assert.equal(updated.split("Host dev\n").length, 2);
assert.match(updated, /Port 22\n/);
assert.ok(updated.includes("Host other"));

// 删除:去掉面板条目,其余保留;没有该条目时原样返回
assert.equal(mergeSshConfig(appended, "dev", null).trim(), existing.trim());
assert.equal(mergeSshConfig(existing, "dev", null), existing);

// 与手写的同名 Host 冲突时拒绝
assert.throws(() => mergeSshConfig("Host dev\n    HostName x\n", "dev", block), /已经有手写的 Host dev/);
assert.throws(() => mergeSshConfig("host a dev\n", "dev", block), /已经有手写的 Host dev/);

// 服务器字段校验
assert.deepEqual(parseServer({ alias: "a-1", host: "example.com", user: "root" }), { alias: "a-1", host: "example.com", port: 22, user: "root" });
for (const bad of [
  { alias: "-oProxyCommand=x", host: "h", user: "u" },
  { alias: "a b", host: "h", user: "u" },
  { alias: "a", host: "h; rm -rf /", user: "u" },
  { alias: "a", host: "-h", user: "u" },
  { alias: "a", host: "h", user: "u u" },
  { alias: "a", host: "h", user: "u", port: 0 },
  { alias: "a", host: "h", user: "u", port: 70000 },
  { alias: "a", host: "300.1.1.1", user: "u" },
]) {
  assert.throws(() => parseServer(bad), Error, JSON.stringify(bad));
}

// servers 写进配置:别名不能重复,默认为空数组
const session = { id: "s", name: "s1", remotePath: "/r", local: "E:/l", mode: "two-way-safe" };
assert.deepEqual(parseConfig({ host: "x", sessions: [session] }).servers, []);
assert.throws(() => parseConfig({ host: "x", sessions: [session], servers: [{ alias: "a", host: "h", user: "u" }, { alias: "A", host: "h2", user: "u" }] }), /不能重复/);

// ssh -G 输出解析
assert.equal(parseSshG("user root\nhostname 1.2.3.4\nport 2222\nidentityfile x\n"), "root@1.2.3.4:2222");
assert.equal(parseSshG("port 22\n"), "");

console.log("servers tests passed");
