import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatCommand,
  buildFindCommand,
  mergeListings,
  computeDiff,
  diffFile,
  makeIgnoreMatcher,
  parseCatOutput,
  parseFindOutput,
  readLocalFile,
  safeRelPath,
  walkLocal,
} from "./files.js";
import { buildExcludes } from "./pull.js";

// ---- 排除规则匹配(和 tar 的 --exclude 语义一致)
const ignored = makeIgnoreMatcher(buildExcludes(["node_modules", "*.log", "/config.json", "src/tmp", ".cache/"], true));
assert.equal(ignored("node_modules"), true);
assert.equal(ignored("a/b/node_modules"), true);
assert.equal(ignored("debug.log"), true);
assert.equal(ignored("a/debug.log"), true);
assert.equal(ignored("config.json"), true);
assert.equal(ignored("sub/config.json"), false); // /config.json 只排除根目录那个
assert.equal(ignored("src/tmp"), true);
assert.equal(ignored("other/src/tmp"), false);
assert.equal(ignored(".git"), true); // ignoreVcs
assert.equal(ignored(".cache"), true);
assert.equal(ignored("src/index.ts"), false);
assert.equal(ignored("my.logger.ts"), false);

// ---- 服务器端命令:路径和模式都被单引号保护,只读
const find = buildFindCommand("/data/my dir/x'y", ["node_modules", "./config.json"]);
assert.ok(find.startsWith(`cd -- '/data/my dir/x'\\''y' && find . \\( -name 'node_modules' -o -path './config.json' \\) -prune -o \\( -type f -o -type l \\)`));
assert.ok(find.includes(`-printf '%P\\t%y\\t%s\\t%T@\\n'`));
assert.ok(!/\brm\b|-delete|-exec/.test(find));
assert.ok(buildFindCommand("/d", []).includes("find . \\( -type f -o -type l \\)"));
assert.equal(buildCatCommand("/d", "a b/c.txt"), `cd -- '/d' && if [ -f './a b/c.txt' ]; then wc -c < './a b/c.txt'; head -c 524289 -- './a b/c.txt'; else echo MISSING; fi`);

// ---- 解析 find 输出
const listing = parseFindOutput("a.txt\tf\t10\t1700000000.5\nsub/b c.md\tf\t20\t1700000100.0\nlink\tl\t3\t1700000200.1\nbad line\nx\tf\tNaN\t1\n");
assert.equal(listing.size, 3);
assert.deepEqual(listing.get("sub/b c.md"), { size: 20, mtime: 1700000100, type: "file" });
assert.equal(listing.get("link")?.type, "link");

// ---- 合并对比
const server = new Map([
  ["same.txt", { size: 5, mtime: 1, type: "file" as const }],
  ["diff.txt", { size: 5, mtime: 1, type: "file" as const }],
  ["only-server.txt", { size: 1, mtime: 1, type: "file" as const }],
]);
const local = new Map([
  ["same.txt", { size: 5, mtime: 2, type: "file" as const }],
  ["diff.txt", { size: 9, mtime: 2, type: "file" as const }],
  ["only-local.txt", { size: 1, mtime: 1, type: "file" as const }],
]);
const merged = mergeListings(server, local);
assert.deepEqual(merged.counts, { "server-only": 1, "local-only": 1, "size-diff": 1, "same-size": 1 });
// 紧凑行:[路径, 状态码(0 仅服务器 1 仅本地 2 大小不同 3 大小相同), 服务器大小, 服务器时间, 本地大小, 本地时间],没有的一边大小为 -1
// 不排序(界面自己按目录分组排序),所以这里不依赖顺序
assert.deepEqual([...merged.rows].sort((a, b) => (a[0] < b[0] ? -1 : 1)), [
  ["diff.txt", 2, 5, 1, 9, 2],
  ["only-local.txt", 1, -1, 0, 1, 1],
  ["only-server.txt", 0, 1, 1, -1, 0],
  ["same.txt", 3, 5, 1, 5, 2],
]);

// ---- 路径安全:拒绝一切可能跳出会话目录的写法
for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "./a", "a/./b", "C:\\x", "C:/x", "a\\..\\b", "a\nb", "a\0b", "a/"]) {
  assert.equal(safeRelPath(bad), null, JSON.stringify(bad));
}
assert.equal(safeRelPath("src/a b/c (1).ts"), "src/a b/c (1).ts");
assert.equal(safeRelPath("..hidden/x"), "..hidden/x");

// ---- 解析 cat 输出
assert.deepEqual(parseCatOutput("MISSING\n"), { exists: false, size: 0, text: "", binary: false, tooLarge: false });
assert.deepEqual(parseCatOutput("6\nhello\n"), { exists: true, size: 6, text: "hello\n", binary: false, tooLarge: false });
assert.equal(parseCatOutput("999999\nxxx").tooLarge, true);
assert.equal(parseCatOutput("3\na\0b").binary, true);
assert.equal(parseCatOutput("0\n").text, "");

// ---- 本地遍历 + 读取(用临时目录)
const root = mkdtempSync(join(tmpdir(), "files-test-"));
mkdirSync(join(root, "src"));
mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
mkdirSync(join(root, ".git"));
writeFileSync(join(root, "src", "a.ts"), "line1\nline2\n");
writeFileSync(join(root, "config.json"), "{}");
writeFileSync(join(root, "node_modules", "pkg", "i.js"), "x");
writeFileSync(join(root, ".git", "HEAD"), "ref");
writeFileSync(join(root, "bin.dat"), Buffer.from([1, 0, 2]));
const walked = await walkLocal(root, ignored);
assert.deepEqual([...walked.files.keys()].sort(), ["bin.dat", "src/a.ts"]);
assert.equal(walked.missing, false);
assert.equal((await walkLocal(join(root, "nope"), ignored)).missing, true);
assert.equal(readLocalFile(root, "src/a.ts").text, "line1\nline2\n");
assert.equal(readLocalFile(root, "bin.dat").binary, true);
assert.equal(readLocalFile(root, "nope.txt").exists, false);
assert.throws(() => readLocalFile(root, "../x"), /路径不合法/);
// 符号链接指到目录外的,不读取
const outside = mkdtempSync(join(tmpdir(), "files-outside-"));
writeFileSync(join(outside, "secret.txt"), "secret");
try {
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  assert.equal(readLocalFile(root, "escape.txt").exists, false);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; // Windows 没有权限建符号链接时跳过
}

// ---- 只读本地:不会去连服务器(host 故意写成连不上的,仍然成功就说明没有调用 ssh)
const localOnly = await diffFile("host-that-does-not-exist", "/nonexistent", root, "src/a.ts", "local");
assert.equal(localOnly.ok, true);
assert.equal(localOnly.text, "line1\nline2\n");
assert.equal(localOnly.skipped, "server");
assert.equal(localOnly.hunks.length, 0);
assert.equal((await diffFile("x", "/nonexistent", root, "bin.dat", "local")).binary, true);
assert.equal((await diffFile("x", "/nonexistent", root, "nope.txt", "local")).ok, false);
assert.equal((await diffFile("x", "/nonexistent", root, "../etc/passwd", "local")).out, "路径不合法。");

// ---- 差异:服务器是旧的(-),本地是新的(+)
const same = computeDiff("a\nb\n", "a\nb\n");
assert.equal(same.identical, true);
const d = computeDiff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nC\nd\ne\nf\ng\nh\ni\n");
assert.equal(d.added, 2);
assert.equal(d.removed, 1);
assert.deepEqual(d.hunks.flatMap((h) => h.lines).filter((l) => l[0] !== " "), ["-c", "+C", "+i"]); // 相距不到 6 行的改动会合成一个块
assert.equal(d.identical, false);
// 只有换行符不同
const eol = computeDiff("a\r\nb\r\n", "a\nb\n");
assert.equal(eol.eolOnly, true);
assert.equal(eol.hunks.length, 0);
// 内容不同,同时一边是 CRLF:忽略换行符差异,只显示真正不同的行
const mixed = computeDiff("a\r\nb\r\nc\r\n", "a\nB\nc\n");
assert.equal(mixed.eolIgnored, true);
assert.equal(mixed.added, 1);
assert.equal(mixed.removed, 1);
// 一边没有内容:全部是新增
const fresh = computeDiff("", "x\ny\n");
assert.equal(fresh.added, 2);
assert.equal(fresh.removed, 0);

console.log("files-test: ok");
