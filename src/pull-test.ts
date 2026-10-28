import assert from "node:assert/strict";
import { buildExcludes, buildRemoteCommand, shellQuote } from "./pull.js";

assert.equal(shellQuote("/data/a b"), "'/data/a b'");
assert.equal(shellQuote("it's"), "'it'\\''s'");

// 排除规则翻译
assert.deepEqual(buildExcludes(["node_modules", "*.log", "/config.json", ".cache/", "src/tmp", "!keep", "  ", "# c"], false), [
  "node_modules",
  "*.log",
  "./config.json",
  ".cache",
  "./src/tmp",
]);
assert.deepEqual(buildExcludes(["build"], true), [".git", ".svn", ".hg", ".bzr", "_darcs", "build"]);
assert.deepEqual(buildExcludes(["a\nb"], false), []);

// 远程命令:路径和模式都被单引号保护,只读打包
const cmd = buildRemoteCommand("/data/my dir/x'y", ["node_modules", "./config.json"]);
assert.equal(cmd, `tar -c -f - --exclude='node_modules' --exclude='./config.json' -C '/data/my dir/x'\\''y' .`);
assert.ok(!/\brm\b|--remove-files/.test(cmd));

console.log("pull-test: ok");
