# codesign-mcp-server

腾讯 CoDesign 设计稿 MCP 服务。让 Claude Code、Cursor 等 AI 编程助手直接读取设计稿的图层标注、下载切图、生成还原规格，然后据此写代码。

```
帮我还原这个设计稿 https://codesign.qq.com/app/s/<分享ID>
```

## 能做什么

把设计稿链接丢给 AI，它就能拿到精确的还原依据：

| 工具 | 作用 |
|---|---|
| `design_get` | 图层树：坐标、尺寸、字体、字号、字距、颜色、圆角、渐变、阴影 |
| `design_download_previews` | 画板整图，让 AI 先"看见"设计 |
| `design_download_slices` | 批量下载切图（默认 2 倍图） |
| `design_get_spec` | 转成前端可直接用的 CSS 规格（默认 750 → 375） |

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
这个设计稿的切图按 3 倍图下载下来
只读取弹窗画板 https://codesign.qq.com/app/s/<分享ID>/<画板ID>
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

分享设置里可能禁止了切图下载（`assetsDownloadable` 为 false），需要设计同学开启。

**读不到图层，只有画板列表**

- 该画板没有上传源文件，只有预览图
- 或者分享设置里没勾选「可查看标注」

**提示某些图层"无法还原"**

设计稿里那些图层是位图（智能对象、图片填充），本身就不含矢量信息。如果它们没有导出切图，细节无从得知——需要在 CoDesign 里把它们标记为切图导出。

**结果被截断**

图层太多时默认只返回前 800 个，结果里会带 `truncated` 提示。可以让 AI 指定单个画板，或调大 `maxLayers`。

**切图不是 2 倍图**

设计稿里没有 2 倍导出时会就近取其他倍率，结果里会列出哪些图被替换了。想让设计同学补 2 倍导出，或直接指定"要 3 倍图"。

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
