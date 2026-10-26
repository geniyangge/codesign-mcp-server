# 开发说明

面向想了解实现细节或参与贡献的开发者。普通用户请看 [README](README.md)。

## 环境要求

- Node.js ≥ 18.17
- TypeScript 5.7

## 常用命令

```bash
npm run dev           # tsc --watch
npm run build         # 产出 dist/
npm test              # 校验版本号 + 编译测试 + node:test 跑单测
npm run version:check # 校验 src/version.ts 与 package.json 是否一致
npm run version:sync  # 把 src/version.ts 的版本号同步到 package.json
```

测试覆盖纯函数（链接解析、CDN 地址改写、文件名、并发池、规格生成）以及 client 的鉴权头、错误翻译与重试行为。

## 代码结构

```
src/
  index.ts      MCP 入口：工具注册、参数校验（zod）、handler 路由
  client.ts     HTTP 客户端：鉴权、重试、图层树重建、字段归一化
  tools.ts      画板解析、切图/预览下载、切图与图层关联
  spec.ts       图层树 → CSS 规格
  types.ts      全部类型定义
  errors.ts     错误翻译（面向 AI 的可操作提示）
  version.ts    版本号唯一来源
  utils/        并发池、文件名处理
scripts/
  version.mjs   版本号校验/同步
  release.mjs   自动发版
```

## 发布新版本

版本号只维护 **`src/version.ts`** 一处，`package.json` 与 `package-lock.json` 都是它的副本。

一条命令完成发版（改版本 + 更新 CHANGELOG + 提交 + 打 tag）：

```bash
# 先预览，不改动任何文件
npm run release

# 确认无误后执行
npm run release -- --minor            # 新功能，1.1.0 → 1.2.0
npm run release -- --patch            # 修 bug，1.2.0 → 1.2.1
npm run release -- --major            # 破坏性变更，1.2.1 → 2.0.0
npm run release -- --set 2.1.0        # 指定确切版本号

# 发版后自动推送提交与 tag
npm run release -- --minor --push
```

不传 `--patch/--minor/--major/--set` 时只做预览。版本类型也可由提交记录自动推断（`feat` → minor，`fix` → patch，`BREAKING CHANGE` → major）。

脚本会依次校验：在 `master` 分支上、工作区干净、与远端同步、版本号一致，然后跑测试，全部通过才继续。

CHANGELOG.md 会自动按 Conventional Commits 分类生成，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> 发版只允许在 `master` 上进行，可用环境变量 `RELEASE_BRANCH` 覆盖。

## 技术说明

CoDesign 没有开放 API，本项目通过逆向其内部接口实现。

| 接口 | 鉴权 |
|---|---|
| `/api/sharings/<shareId>` | 无需登录；密码分享需 `state-key` 头 |
| `/api/sharings/<shareId>/state-keys` | `POST {password}` → `{key, expires}` |
| `/api/designs/<designId>` | Cookie + `Authorization: Bearer`（后台链接用） |
| `/api/designs/<designId>/screens/<screenId>` | Cookie + `Authorization: Bearer` |
| `cdn4.codesign.qq.com/meta/...`（图层/切图 JSON） | 需 `Origin: https://codesign.qq.com` |
| 切图图片 | 同上，位图需带 `?imageMogr2/format/png`，svg 不能带 |

已处理的坑（均经真实设计稿实测）：

- 切图清单给的是 OSS 签名直链，直接下会 `AccessDenied` → 自动换 CDN 域名并追加 `imageMogr2` 参数（保留原有签名参数顺序，不重排）
- CDN 资源只带 Referer 会 403，必须有 Origin
- 鉴权接口只带 Cookie 会返回「非项目成员」，必须显式带 Bearer token
- **meta 里的 `layers` 与 `groups` 是两个扁平数组**，真实层级只存在于 `parent_id` 上，代码会重建整棵树（否则拿到的是没有父子关系的散图层，`maxDepth` 也会失效）
- `rect` 已经是相对画板的绝对坐标，不需要逐层累加
- 文本字号要取 `impliedFontSize`，`textStyle.size` 是会被缩放的排版原始值（两者可能相差 15% 以上）
- `textKey` 才是正文内容
- `fontCaps: "allCaps"` 在线上数据里普遍出现在越南语等普通文本上，**不是真的大写**，因此不输出 `text-transform`
- 颜色 alpha 单位不固定：普通填充是 0–1，半透明遮罩会返回 `a:100`、`color-hex: "#000000 10000%"`，`css-rgba` 也是非法的 `rgba(0,0,0,100)`。代码会统一归一化
- CoDesign 自带的 `css` 字段里也有非法 alpha（形如 `rgba(R,G,B,100)`），浏览器会整条丢弃，代码会修正后再用
- 组图层本身通常没有 `css`，视觉效果要么来自子图层，要么由切图提供；两种情况代码都在 notes 里提示
- 密码保护的分享：**带 Cookie 访问时返回的是「您当前暂无权限」而不是「请输入密码」**，无法从一次请求判断是否缺密码；代码会用一个不含 Cookie 的探测请求确认后再提示补密码
- 密码错误返回 `403「密码错误！」`（不是 422）；`422` 只用于密码长度等格式校验
- 接口返回的 JSON 会把中文转义成 `\uXXXX`，错误判断必须先解开 `message` 字段，否则永远匹配不到「请输入密码」
- `imageMogr2` 只能处理位图，对 svg 会返回 `400 InvalidImageFormat`，代码按导出格式自动跳过
- `fontStyleName` 既可能是 `"Bold"` 也可能是数字 `700`，两者都要能转成 CSS `font-weight`
- 位图图层（智能对象、图片填充）只返回盒子尺寸和 css，没有 fills/borders/effects，只能靠切图还原

实现要点：

- **按需加载**：`design_download_previews` 不会去拉图层树，`design_get` 不传 `includeLayers` 也不拉
- **并发**：画板解析与切图下载都走固定并发池（`mapLimit`），不会一个画板一个画板地串行等
- **超时与重试**：每个请求带超时；`5xx` / `429` 自动退避重试，`4xx` 直接失败不白等
- **文件名**：统一走 `sanitizeFilename`，处理 Windows 非法字符、保留名（CON/NUL…）和尾部点空格，同名自动加序号
- **样式优先级**：图层自带的 `css` > 代码从 fills/radius/borders/effects 拼接

## 风险提示

这是对未公开接口的逆向实现，腾讯调整接口或加强风控都可能让它失效。遵守 CoDesign 的服务条款，不要用于批量抓取或绕过权限的场景。
