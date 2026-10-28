import assert from "node:assert/strict";
import { parseList, sameEndpoint } from "./mutagen.js";

const sample = `-------------------------------------------------------------------------------
Name: bdp-view
Identifier: sync_RG9OFAjLrvy9AmREM1RyUnthhQzCzTd0Obm0nHcMcdb
Alpha:
        URL: myserver:/data/project
        Connected: Yes
        Synchronizable contents:
                1622 directories
Beta:
        URL: E:\\work\\mutagen_data
        Connected: Yes
        Transition problems: 1
Status: Staging files on beta
Staging progress: 860/6289 - 139 MB - 14%
Current file: .git/objects/pack/pack-1.pack (135 MB/488 MB)
-------------------------------------------------------------------------------
Name: data-exchange
Identifier: sync_OFFhGHD61y5nqfSJIgcBvSf6eoXx2pdes3ZOzVjYVBf
Alpha:
        URL: myserver:/data/exchange
        Connected: Yes
Beta:
        URL: E:\\work\\exchange
        Connected: No
Status: Watching for changes
-------------------------------------------------------------------------------
Name: paused-one
Status: [Paused]
-------------------------------------------------------------------------------
`;

const parsed = parseList(sample.replace(/\n/g, "\r\n"));
assert.deepEqual(Object.keys(parsed), ["bdp-view", "data-exchange", "paused-one"]);

const view = parsed["bdp-view"];
assert.ok(view);
assert.equal(view.status, "Staging files on beta");
assert.equal(view.alphaConnected, true);
assert.equal(view.betaConnected, true);
assert.equal(view.progress, "860/6289 - 139 MB - 14%");
assert.match(view.current, /pack-1\.pack/);
assert.deepEqual(view.warns, ["Transition problems: 1"]);
assert.equal(view.alphaUrl, "myserver:/data/project");
assert.equal(view.betaUrl, "E:\\work\\mutagen_data");
assert.equal(view.paused, false);

const exchange = parsed["data-exchange"];
assert.ok(exchange);
assert.equal(exchange.status, "Watching for changes");
assert.equal(exchange.betaConnected, false);
assert.deepEqual(exchange.warns, []);

assert.equal(parsed["paused-one"]?.paused, true);
assert.deepEqual(parseList("No synchronization sessions found"), {});

// 地址比较:忽略斜杠方向、末尾斜杠和大小写
assert.equal(sameEndpoint("E:/work/mutagen_data/", "E:\\work\\mutagen_data"), true);
assert.equal(sameEndpoint("myserver:/data/a", "myserver:/data/b"), false);
assert.equal(sameEndpoint("myserver:/data/a", undefined), false);

console.log("mutagen-test: ok");
