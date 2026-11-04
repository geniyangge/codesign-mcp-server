# codesign-mcp-server

腾讯 CoDesign 设计稿 MCP 服务。让 Claude Code、Cursor 等 AI 编程助手直接读取设计稿的图层标注、下载切图、生成还原规格，然后据此写代码。

```
帮我还原这个设计稿 https://codesign.qq.com/app/s/<分享ID>
```

## 能做什么

把设计稿链接丢给 AI，它就能拿到精确的还原依据：

| 工具 | 作用 |
|---|---|
| `design_get` | 图层结构：坐标、层级、层叠顺序（默认精简视图，可按需展开样式） |
| `design_download_previews` | 画板整图，让 AI 先「看见」设计 |
| `design_download_slices` | 批量下载切图，输出 manifest 清单 |
| `design_export` | **导出任意图层或区域**，没有切图的位图也能兜底导出 |
| `design_get_spec` | 转成前端可直接用的 CSS 规格（默认 750 → 375） |

### v2 的几处变化

- **`design_get` 默认只返回第一个画板**，需要全部画板时传 `allScreens: true`。整份设计稿一次返回可能有几百 KB。
- **默认视图是 `summary`**（`ref` / `objectId` / `depth` / `parentId` / `type` / `z` / `rect` / `flags`）。要样式细节传 `view: "flat"`，要嵌套结构传 `view: "tree"`。
- **切图文件名统一带倍率后缀**：`图标@2x.png`、`图层 5@3x.png`。
- **层级不再靠名字前的空格推断**，改用 `depth` + `parentId`。

## 快速开始

### 1. 安装

在**你要写代码的项目**根目录建 `.mcp.json`：

```json
{
  "mcpServers": {
    "codesign": {
      "command": "npx",
      "args": ["-y", "codesign-mcp-server"],
      "env": {
        "CODESIGN_COOKIE": "你的 Cookie"
      }
    }
  }
}
```

Cookie 怎么拿见下一节。也可以用命令行一条搞定：

```bash
claude mcp add codesign --scope user \
  -e CODESIGN_COOKIE="你的 Cookie" \
  -- npx -y codesign-mcp-server
```

### 2. 配置 Cookie

读取图层标注和切图需要 CoDesign 登录态。

1. 浏览器登录 https://codesign.qq.com
2. 打开目标设计稿
3. `F12` → **Network** 面板
4. 刷新页面，任选一条 `/api/` 开头的请求
5. 右键 → **Copy** → **Copy as cURL (bash)**
6. 取 `-b '...'` 引号里的整段内容，粘到 `CODESIGN_COOKIE`

> `access_token` 一般 30 天有效，失效后重新复制一次即可。

**不希望 Cookie 写进配置文件？** 用环境变量引用：

```json
"env": { "CODESIGN_COOKIE": "${CODESIGN_COOKIE}" }
```

然后设置系统环境变量 `CODESIGN_COOKIE`（Windows：`setx CODESIGN_COOKIE "..."`，设完需要重开终端）。

### 3. 重启 Claude Code

配置改完必须重启。用 `/mcp` 确认状态：

```
codesign  ✓ connected (4 tools)
```

## 使用

直接自然语言说：

```
帮我还原这个设计稿 https://codesign.qq.com/app/s/<分享ID>
```

AI 会自动走完：看预览图 → 读图层标注 → 下切图 → 生成 CSS → 写代码。

其他常见说法：

```
用 Vue3 + Tailwind 还原这个设计稿 https://codesign.qq.com/app/s/<分享ID>
这个设计稿的切图按 3 倍图下载下来，转成 webp
只读取弹窗画板 https://codesign.qq.com/app/s/<分享ID>/<画板ID>
把这个分组单独导出给我
这几块没切图，按区域裁出来：左上角 750×1141
```

### 切图与清单

`design_download_slices` 会在输出目录写两份清单：

- `codesign-manifest.json` — 程序读取
- `codesign-manifest.csv` — 带 UTF-8 BOM，Excel / PowerShell 直接打开不乱码

清单以 `ref`（`s1`、`s2`…）和 `objectId` 为主键，中文图层名和文件名只是附带信息，适合批量核对。

**倍率一定按预期对齐**：设计稿只有 3 倍图、你要 2 倍图时，会由服务端重采样到 2 倍尺寸（`resampled: true`），不会给你一张 3 倍的大图。

```json
{ "scale": 2, "format": "webp", "quality": 80 }
```

`targetWidth` 可以脱离倍率，直接指定像素宽。

### 导出没有切图的图层

设计稿里常见的「位图且没标切图」，`design_get` 会列在 `unreconstructable` 里。这时用 `design_export`：

```json
{ "objectIds": ["12", "46"], "scale": 2 }
```

导出分三级，返回体的 `tier` 会标出来：

| tier | 情况 | 是否透明 |
|---|---|---|
| `slice` | 图层有切图 | 透明 |
| `composite` | 没有切图，从画板合成图裁剪 | **不透明**，会带上被遮挡的底层内容 |
| `fail` | 没有切图且盒子为空 | — |

> `composite` 的结果不能当透明素材用。要透明图，只能请设计同学在 CoDesign 里补切图。

按区域导出把 `objectIds` 换成 `regions` 即可，坐标为**设计稿原始像素**（不是 CSS 缩放后的值）：

```json
{ "regions": [{ "name": "顶部横幅", "x": 0, "y": 0, "width": 750, "height": 1141 }] }
```

### 支持的链接

直接粘贴地址就行，工具会自动识别：

| 链接 | 样例 | 需要 Cookie |
|---|---|---|
| 分享链接 | `https://codesign.qq.com/app/s/<分享ID>` | 读图层/切图时需要 |
| 邀请链接 | `https://codesign.qq.com/s/<分享ID>/<画板ID>/inspect` | 同上 |
| 工作台链接 | `https://codesign.qq.com/app/design/<设计ID>/board` | **必须** |

分享链接需要设计稿已开启分享；工作台链接只要你的账号有权限即可，不需要额外分享。

### 带密码的设计稿

分享时设了密码的，直接把密码告诉 AI：

```
还原这个设计稿 https://codesign.qq.com/s/<分享ID>/<画板ID>/inspect，密码 ABCD
```

或者设一次环境变量，之后都不用提：

```json
"env": { "CODESIGN_PASSWORD": "ABCD" }
```

> 密码只解锁"分享内容"这一层。如果当前 Cookie 账号本身不在设计稿所属项目里，密码正确也会提示无权限，需要换有权限的账号。

## 配置项

| 变量 | 必填 | 说明 |
|---|---|---|
| `CODESIGN_COOKIE` | 读图层/切图必填 | CoDesign 登录 Cookie |
| `CODESIGN_PASSWORD` | 否 | 默认分享访问密码 |
| `CODESIGN_SCALE` | 否 | 默认切图倍率，默认 `2` |
| `CODESIGN_OUT_DIR` | 否 | 切图输出目录，默认 `./codesign-assets` |
| `CODESIGN_CONCURRENCY` | 否 | 并发请求数，默认 4，范围 1–16；被限流时调小 |
| `CODESIGN_TIMEOUT_MS` | 否 | 单次请求超时，默认 30000 |

## 常见问题

**提示"非项目成员"或"无权限"**

Cookie 对应的账号不在该设计稿所属团队。让设计同学把账号加进项目，或者请对方开启分享页的「可查看标注」。

**切图下载失败**

分享里的 `assetsDownloadable` 字段**不可信** —— 实测有设计稿该字段为 false 但切图全部能下载。工具现在会在这种情况下给出提示，直接试着下载即可。

**读不到图层，只有画板列表**

- 该画板没有上传源文件，只有预览图
- 或者分享设置里没勾选「可查看标注」

**提示某些图层"无法还原"**

设计稿里那些图层是位图（智能对象、图片填充），本身就不含矢量信息。

不再只能干看着——`design_export(objectIds: [...])` 会从画板合成图上按图层盒子裁剪（`tier: "composite"`）。**注意结果不透明**，会带上被遮挡的底层内容；要干净的透明图需要设计同学在 CoDesign 里补切图。

**结果被截断 / 太大**

- 默认只返回第一个画板，多画板要全部时传 `allScreens: true`
- 用 `types: ["text"]` 只看某类图层，用 `subtreeId` 深入某个组
- 用 `offset` / `limit` 分页，或 `fields: ["rect","name","type"]` 做字段投影

**切图不是 2 倍图**

设计稿没有该倍率时，会由服务端重采样到目标尺寸，落盘像素尺寸恒等于「设计稿宽 × 目标倍率」，结果里 `resampled: true`。

**Windows 终端中文乱码**

文件内容是 UTF-8，乱码来自终端代码页。PowerShell 里先执行 `chcp 65001`，或改用 Windows Terminal。清单文件 `codesign-manifest.csv` 带 BOM，Excel 直接打开正常。若在命令行里引用图层，用 `ref`（`s1`）或 `objectId` 比中文名更稳。

**接口失效**

本项目依赖 CoDesign 的内部接口，官方调整后可能失效。遇到异常先确认网页端是否正常，然后提 issue。

## 本地构建安装

不想用 npx 的话：

```bash
git clone https://github.com/geniyangge/codesign-mcp-server.git
cd codesign-mcp-server
npm install
npm run build
```

然后 `.mcp.json` 里改用绝对路径：

```json
{
  "mcpServers": {
    "codesign": {
      "command": "node",
      "args": ["/path/to/codesign-mcp-server/dist/index.js"],
      "env": { "CODESIGN_COOKIE": "你的 Cookie" }
    }
  }
}
```

> Windows 路径写成 `"D:/path/to/codesign-mcp-server/dist/index.js"` 或把 `/` 转义成 `\\\\`。

## 相关链接

- [开发说明](DEVELOPMENT.md) — 代码结构、实现细节、发版流程
- [更新日志](CHANGELOG.md)

## License

MIT
