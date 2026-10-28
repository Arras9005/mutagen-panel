# mutagen-panel

[![CI](https://github.com/Arras9005/mutagen-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/Arras9005/mutagen-panel/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/mutagen-panel)](https://www.npmjs.com/package/mutagen-panel) [![license](https://img.shields.io/github/license/Arras9005/mutagen-panel)](LICENSE)

**本机运行的 [Mutagen](https://mutagen.io) 网页管理面板**:在浏览器里创建、暂停、恢复、立即同步和监控同步会话;用户名加密码添加一次服务器,之后全部走密钥登录;会话可分组、可拖拽;能浏览服务器目录、一键用服务器文件覆盖本地。

> 非官方项目,与 Mutagen 官方无关。已在 Mutagen 0.18.1 上使用。界面语言目前为中文。

<!-- 截图:建议放 docs/screenshots/,例如主界面(浅色/深色)、分组与拖拽、服务器管理、浏览服务器目录 -->

## 为什么需要它

Mutagen 很强,但命令行管理多个会话、多台服务器很麻烦:会话名难记、状态要反复 `mutagen sync list`、冲突和排除规则不直观、换服务器要手敲一串 `ssh` 配置。这个面板把这些都放进一个本机网页:

- **一眼看清所有会话**:同步状态、进度条、冲突提示、连接的是哪台服务器(别名、IP、端口),深色/浅色自动跟随系统。
- **多服务器**:填主机、端口、用户名、密码,面板自动装好 SSH 密钥并写入 `~/.ssh/config`;密码不保存。
- **分组与拖拽**:自定义分组,拖动卡片归类,分组可折叠,折叠后仍能看到各会话的状态小圆点。
- **浏览服务器目录**:双击服务器路径,只读浏览;编辑会话时可直接选目录。
- **覆盖本地**:一次性把服务器文件拉到本地,**同名覆盖、本地多出的文件保留、排除规则内的文件不动**。
- **改配置不用碰 JSON**:会话、服务器、分组都能在页面里改;已创建会话改完可一键重建。
- **只在本机运行**:只监听 `127.0.0.1`,所有接口都要令牌;关掉面板不影响同步。

```
 浏览器 ──(127.0.0.1 + 令牌)──▶ mutagen-panel(Node.js) ──▶ mutagen CLI ──ssh──▶ 服务器
                                      └──▶ ssh / tar(浏览目录、覆盖本地)
```

## 快速开始

**前置条件**

- Node.js 18 或更新版本
- 已安装 [Mutagen](https://github.com/mutagen-io/mutagen/releases)(命令行 `mutagen version` 能运行;`mutagen` 与 `mutagen-agents.tar.gz` 放在同一目录)
- 本机有 OpenSSH 客户端(`ssh`、`ssh-keygen`,Windows 10 以后自带)和 `tar`

**方式一:用 npm 安装(推荐)**

```bash
npx mutagen-panel              # 直接运行,不用安装
# 或全局安装
npm i -g mutagen-panel
mutagen-panel
```

首次运行会自动创建配置文件(`~/.mutagen-panel/config.json`,Windows 是 `C:\Users\你\.mutagen-panel\config.json`),不需要手动复制或编辑,打开页面后在"更多 → 服务器管理"添加服务器、再添加会话即可。命令行选项:

| 选项 | 说明 |
|---|---|
| `--config <文件>` | 指定配置文件(也可用环境变量 `PANEL_CONFIG`) |
| `--port <端口>` | 本次运行使用的端口,不写回配置 |
| `--no-open` | 不自动打开浏览器 |
| `-v, --version` / `-h, --help` | 版本 / 帮助 |

**方式二:从源码运行**

1. 下载或克隆本仓库,放在**同步目录之外**的位置(同步目录里的改动可能被同步清掉)。
2. 运行启动脚本:
   - Windows:双击 `start.bat`
   - macOS:`chmod +x start.command` 后双击 `start.command`
   - Linux:`npm install && npm start`
3. 首次运行会把 `config.example.json` 复制为 `config.json` 并打开,改好 `mutagen`(已在 PATH 里就写 `"mutagen"`)后保存,再运行一次。
4. 控制台会打印带令牌的链接并自动打开浏览器。令牌每次启动随机生成;想固定链接可以在 `config.json` 里写 `"token"`。
5. 在页面"更多 → 服务器管理"里添加服务器,再"添加会话"。

**同步模式**

| 模式 | 方向 | 冲突/删除行为 |
|---|---|---|
| `one-way-replica` 单向镜像 | 服务器 → 本地 | 本地与服务器完全一致,**本地多出的文件会被删除** |
| `one-way-safe` 单向 | 服务器 → 本地 | 保留本地独有的文件;同一文件两边都改了会报冲突 |
| `two-way-safe` 双向 | 两个方向 | 冲突时暂停等你处理,不覆盖任何一边(推荐) |
| `two-way-resolved` 双向·服务器优先 | 两个方向 | 冲突时以服务器为准,**本地的修改可能丢失** |

## 常见问题

**本地文件夹是空的?**
点卡片上的"详情",看 `Alpha`(服务器端)的 `Synchronizable contents`:如果是 0 个文件,说明这个会话选的服务器或目录不对(同一路径在不同服务器上内容不同),在卡片右上角的服务器胶囊里核对别名和 IP。

**卡片提示"冲突"?**
点"详情"看 `Conflicts` 下列出的文件路径。常见原因是两边各自创建了同名但内容不同的文件(比如 `config.json`),把它加入排除规则(`/config.json`)并重建会话即可。

**改了排除规则没生效?**
已创建的会话需要重建才会应用新规则(编辑保存时勾选"保存后立即重建会话")。模式和排除规则的差异,面板检测不出来。

**多台电脑共用一个服务器目录?**
各台电脑各自一份 `config.json`,不要同步它。同一个文件两边同时改会产生冲突,建议用 `two-way-safe`,或一台编辑、其余台用单向镜像。

**找不到 mutagen?**
`config.json` 里 `mutagen` 写 `"mutagen"`(已在 PATH)或完整路径;JSON 里 Windows 路径用 `/`,或把每个 `\` 写成 `\\`。

## 配置

| 字段 | 说明 |
|---|---|
| `mutagen` | `mutagen` 可执行文件的路径;已在 PATH 里可写 `mutagen` |
| `host` | 默认 SSH 别名(`~/.ssh/config` 里的 `Host`);会话内也可单独写 `host` |
| `port` | 面板端口,默认 8765 |
| `openBrowser` | 启动时是否自动打开浏览器,默认 `true` |
| `token` | 固定访问令牌(可选,不写则每次启动随机生成) |
| `servers[]` | 通过面板添加的服务器:`alias`、`host`、`port`、`user`(不含密码) |
| `groups[]` | 分组名,按显示顺序 |
| `sessions[].id` | 面板内部标识,字母、数字、`_`、`-` |
| `sessions[].name` | Mutagen 会话名:字母开头,只含字母、数字和 `-`(**不能用下划线**),不能重复 |
| `sessions[].group` | 所属分组(可选) |
| `sessions[].remotePath` | 服务器上的目录 |
| `sessions[].local` | 本地目录;各会话之间不能相同 |
| `sessions[].mode` | `one-way-replica` / `one-way-safe` / `two-way-safe` / `two-way-resolved` |
| `sessions[].ignoreVcs` | 是否忽略 `.git` 等版本控制目录 |
| `sessions[].ignore` | 排除规则列表,语法同 Mutagen 的 `--ignore`;`/xxx` 表示只匹配同步根目录下的 |

配置文件位置:`--config` 或环境变量 `PANEL_CONFIG` 指定的优先;从 npm 安装时是 `~/.mutagen-panel/config.json`(升级包不会丢);从源码运行时是面板目录下的 `config.json`。不存在会自动创建一份空配置。

## 多台电脑各用各的配置

`config.json` 里有本机的 `mutagen` 路径、本地目录、服务器地址和令牌,**每台电脑各自一份,不要提交到 git,也不要被同步到别的电脑**(仓库的 `.gitignore` 已排除它):

- 如果面板目录处在某个 Mutagen 同步会话的范围内,给那个会话加排除规则 `/config.json`。
- 或者启动前设置 `PANEL_CONFIG` 指向面板目录之外的配置文件。

## 打开本地文件夹

双击卡片上的**本地路径**,会用系统文件管理器(资源管理器、访达)打开该会话的本地目录;单击仍是复制路径。路径只取自配置里的会话,不接受页面传入的任意路径;目录还不存在时会提示。

## 浏览服务器目录

双击卡片上的**服务器路径**(或在编辑会话时点"服务器目录"旁的"浏览"),会弹出服务器目录浏览窗口:点目录进入、"上一级"返回、也可以直接输入路径回车跳转;可切换显示隐藏文件、复制当前路径。从编辑弹窗打开时,点"选择此目录"会把路径填回"服务器目录"。

- 只读:后端通过 `ssh` 在服务器上执行 `cd` + `ls -l`,不会改动服务器上的任何文件。
- 服务器别名必须是已知别名(面板添加的、默认的或会话在用的),路径经过单引号保护,不会被当成命令执行。
- 需要服务器是 GNU/Linux(`ls --time-style`);单个目录最多显示前 3000 项。

## 覆盖本地(把服务器的文件拉下来)

卡片上的"覆盖本地"按钮:一次性把服务器目录的文件覆盖到本地目录。

- 同名文件以服务器为准(本地的修改会丢失);**本地多出来的文件不会被删除**。
- 沿用会话的排除规则和"忽略版本控制目录"设置,被排除的文件既不拉取,也不会动本地同名文件。
- 实现方式是 `ssh` 在服务器上打包(只读)、本机 `tar` 解压,不依赖 Mutagen 的同步模式。本机需要有 `tar`(Windows 10 以后自带 `tar.exe`,macOS、Linux 自带);服务器需要有 `tar`。
- 会话正在同步时,先暂停、拉取完成后自动恢复,避免同步引擎在文件写到一半时介入;已暂停的会话保持暂停。
- 没创建同步会话时也可以使用,适合首次把文件拉到本地。

## 分组

会话多了可以自定义分组:"更多 → 分组管理"(或页面上方的"管理分组")里添加、重命名、删除、上下移动分组;编辑会话时在"分组"下拉框里选择。页面上方的分组标签可以只看某一组,选择会被记住。删除分组不会删除会话,它们会变成"未分组"。配置里对应顶层 `groups` 数组和会话的 `group` 字段。

卡片在宽屏上一行显示两张,窄屏自动变成一张。

## 添加服务器(用户名 + 密码,一次性)

页面右上角"更多 → 服务器管理":填写**别名、用户名、主机地址、端口、密码**,点"连接并保存"。面板会:

1. 在本机 `~/.ssh/` 生成面板专用密钥 `mutagen-panel_ed25519`(没有才生成,需要系统自带的 OpenSSH `ssh-keygen`)。
2. 用密码登录服务器,把公钥追加到 `~/.ssh/authorized_keys`(已存在不重复写)。
3. 在 `~/.ssh/config` 末尾写入一段带 `# >>> mutagen-panel:别名 >>>` 标记的 Host 条目;只改这一段,其余内容不动。若 `~/.ssh/config` 里已有手写的同名 Host,会拒绝并提示换别名。
4. 用密钥免密登录验证一次。

之后所有同步都走密钥,不再需要密码。**密码只用于这一次请求,不写入 `config.json`、日志或任何文件**;`config.json` 里只记录别名、主机、端口、用户名(`servers` 字段)。

- 编辑会话时,"服务器"下拉框列出所有可选别名(面板添加的、默认的、以及你手写在 `~/.ssh/config` 里且已被会话使用的)。
- 服务器管理里可以"测试"免密登录,也可以"移除":删除面板记录和 `~/.ssh/config` 里面板写的那一段,服务器上的公钥不动;还被会话使用的服务器不能移除。
- 要求服务器允许密码登录(或 keyboard-interactive)。首次连接时面板不校验主机指纹,之后 ssh 用 `StrictHostKeyChecking accept-new` 记录指纹并在指纹变化时拒绝连接。
- 依赖 `ssh2`:升级后执行一次 `npm install`(启动脚本发现缺少会自动安装)。

## 安全

- 只监听 `127.0.0.1`,并校验请求的 `Host`,不接受来自其他机器或网页的调用(防 DNS 重绑定)。
- 所有接口都需要启动时打印的令牌;响应带 CSP、`X-Frame-Options` 等安全头,页面不能被嵌入别的网站,也不加载任何外部资源。
- 命令一律用参数数组执行,不经过本机 shell;发往服务器的路径经过单引号保护,别名、主机、用户名限制为安全字符,配置里的内容不会被当成命令。
- 添加服务器时的密码只在那一次请求里使用,不写入配置、日志或任何文件;之后只用密钥登录。
- 首次添加服务器时面板不校验主机指纹(与普通 `ssh` 首次连接一样),之后 `StrictHostKeyChecking accept-new` 会记录指纹并在变化时拒绝连接。
- 面板进程只是控制台:关掉它不会停止同步,同步由 Mutagen 后台服务负责。

发现安全问题请看 [SECURITY.md](SECURITY.md)。问题和建议请到 [Issues](https://github.com/Arras9005/mutagen-panel/issues) 反馈。

## 项目结构

```
config.example.json   配置示例(从源码运行时可复制为 config.json)
start.bat / start.command   Windows / macOS 一键启动(首次自动建配置、安装依赖)
src/config.ts         配置解析与校验
src/mutagen.ts        命令执行、SSH 检查、mutagen sync list 输出解析
src/actions.ts        状态查询、配置保存、各项操作
src/servers.ts        添加服务器:装密钥、写 ~/.ssh/config、解析别名
src/remote.ts         浏览服务器目录
src/pull.ts           覆盖本地(ssh + tar)
src/server.ts         仅监听 127.0.0.1 的 HTTP 服务
src/*-test.ts         单元测试
web/index.html        前端页面(单文件,无构建步骤)
```

## 开发

```bash
npm install
npm run verify   # 类型检查 + 单元测试
npm start        # 用 tsx 直接运行 TypeScript
npm run build    # 编译到 dist/(发布到 npm 前自动执行)
```

## 已知限制

- 界面目前只有中文。
- 浏览服务器目录和覆盖本地需要服务器是 GNU/Linux(`ls --time-style`、`tar`)。
- 添加服务器要求服务器允许密码登录(或 keyboard-interactive)。
- 面板检测不出已创建会话的模式和排除规则是否与配置一致,改完需要手动重建。
- 前端没有自动化测试。

## 许可证

[MIT](LICENSE) © 2026 Arra
