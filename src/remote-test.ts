import assert from "node:assert/strict";
import { buildListCommand, parseListing } from "./remote.js";

// 命令:路径被单引号保护,~ 展开成 $HOME,只读
assert.equal(buildListCommand("/data/my dir"), `cd -- '/data/my dir' && pwd && LC_ALL=C ls -lA -p --time-style=long-iso -- . | head -n 3002`);
assert.match(buildListCommand("~"), /^cd -- "\$HOME" && pwd/);
assert.match(buildListCommand("~/proj x"), /^cd -- "\$HOME"\/'proj x' && pwd/);
assert.match(buildListCommand("/a'b; rm -rf /"), /^cd -- '\/a'\\''b; rm -rf \/' && pwd/);
assert.ok(!/\brm\b(?! -rf \/')/.test(buildListCommand("/x")));

// 解析:目录和链接排在文件前、各自按名称排序;符号链接取箭头前的名字;带空格的文件名;设备文件和 total 行忽略
const sample = [
  "/data/project",
  "total 48",
  "drwxr-xr-x  3 root root  4096 2026-10-25 18:20 src/",
  "-rw-r--r--  1 root root   127 2026-10-24 09:01 README.md",
  "drwxr-xr-x  2 root root  4096 2026-10-23 11:00 .git/",
  "lrwxrwxrwx  1 root root    11 2026-10-22 08:00 latest -> releases/v1",
  "-rw-r--r--  1 root root 12345 2026-10-21 07:30 my file.txt",
  "crw-rw-rw-  1 root root  1, 3 2026-10-20 06:00 null",
  "-rw-r--r--. 1 root root     5 2026-10-19 05:00 selinux.txt",
].join("\n");
const parsed = parseListing(sample);
assert.equal(parsed.path, "/data/project");
assert.deepEqual(
  parsed.entries.map((e) => `${e.type}:${e.name}`),
  ["dir:.git", "link:latest", "dir:src", "file:my file.txt", "file:README.md", "file:selinux.txt"],
);
assert.equal(parsed.entries.find((e) => e.name === "my file.txt")?.size, 12345);
assert.equal(parsed.entries.find((e) => e.name === "src")?.mtime, "2026-10-25 18:20");
assert.equal(parsed.truncated, false);

console.log("remote-test: ok");
