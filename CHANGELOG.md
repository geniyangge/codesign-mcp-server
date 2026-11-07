# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.0.0] - 2026-11-07

### 破坏性变更

- **`download_slices` / `design_export` 默认不再重采样**：不传倍率时直接取图层自带原图，
  不再默认降到 2 倍。源图 3 倍就拿 3 倍，画质零损失。
- **倍率参数拆成 `scale` 与 `cssScale`**，基准不同、同时传会报错：
  `cssScale` 相对 CSS 宽（375），`cssScale: 2` 落盘 750px，即前端常说的「2 倍图」；
  `scale` 相对设计稿宽（750），`scale: 2` 落盘 1500px。
  旧代码依赖「`scale: 2` 就得到 2 倍图」的，应改用 `cssScale: 2`。
- **`design_get` 默认只返回第一个画板**：整份设计稿全部画板实测 240KB+，一次塞满上下文没法用。
  需要全部画板请显式传 `allScreens: true`。
- **`design_get` 的 `layers` 由嵌套树改为扁平数组**，层级改用 `depth` + `parentId` 表达，
  不再往 `name` 里塞缩进空格（那样按名字匹配和去重都不可靠）。
  需要嵌套结构请传 `view: "tree"`。
- **`design_get` 默认视图变为 `summary`**：只给 `ref`/`objectId`/`depth`/`parentId`/`name`/`type`/`z`/`rect`/`flags`。
  要样式细节（`css`/`text`/`fills`/`borders`）传 `view: "flat"`。
- **切图文件名统一加 `@倍率x` 后缀**：`图标@2x.png`、`图层 5@3x.png`。
  旧版本落盘的文件不会自动重命名，重新下载即可。
- **`design_get_spec` 的 `slices[]` 只列被选中的那一档倍率**，并新增 `ref`/`z`/`pixelWidth` 等字段。
  旧版本会把同一图层的所有倍率都列出来，且文件名与实际落盘对不上。

### 新增

- **previews,spec**: 预览支持区域裁剪，spec 补文本排版信息
- **tools**: 工具层接入 asciiNames / prefix / namePattern
- **export**: 支持 ASCII 文件名、前缀与按名字正则批量导出
- **tools**: 工具层接入 cssScale 并拒绝同时传两种倍率
- **slicing**: 默认取原图不重采样，拆分 design/css 两种倍率语义
- **get**: 默认只返首个画板并按需压缩 JSON
- **views**: 新增图层视图投影模块
- **export**: 注册 design_export 工具并支持按画板名定位
- **previews**: 预览图支持 scale 与 targetWidth
- **export**: 新增任意图层与区域导出模块
- **download**: 工具层接入清单输出与新参数
- **download**: 切图按目标倍率重采样并支持格式与尺寸参数
- **slicing**: 新增切图规划与清单模块

### 修复

- **spec**: 切图列表与下载共用同一份规划
- **get**: 合并多条警示信息并修正截断提示
- **errors**: 识别 AbortSignal.timeout 抛出的 TimeoutError
- **spec**: 阴影偏移按 angle 拆分 X/Y
- **client**: 图层树按 index 排序并校正盒子可信度

### 文档

- CHANGELOG 移除手写的 v2.0.0 条目
- README 标题改用 h1 标签以便居中
- 徽章顺序调整为 MIT 在前、下载量在后
- 补 MIT LICENSE，徽章改为居中一行并修正 Node 徽章
- README 标题加 npm 版本、月下载量等徽章
- 更新倍率语义、ASCII 命名与已知限制说明
- 手工补写 v2.0.0 的破坏性变更说明
- 更新 v2 的工具说明、清单格式与实测坑

### 测试

- 测试样例改用通用图层名
- 覆盖 typography 输出与单行/非文本场景
- 覆盖 native 默认、design/css 倍率换算与 sourceScale
- 覆盖视图投影、字段投影、分页与子树过滤
- 覆盖切图规划、清单生成与文件名校验
- 覆盖层叠顺序、数值解包、盒子可信度等回归点

### 构建

- 包管理器从 npm 切换到 pnpm

### 已知限制

- **没有切图的位图图层无法透明导出**：CoDesign 不暴露图层级原始资源——实测 42 个位图图层的
  `exportables` 全为空、`pixels` 只是布尔标记、图层里没有任何图片 URL，也没有图层渲染接口。
  这类图层只能从画板合成图裁剪（`composite`，不透明）。需要透明图只能请设计同学补切图。

## [1.1.0] - 2026-10-26

### 新增

- 关联图层与切图，标记无法还原的位图图层
- 支持直接用设计稿后台链接

### 修复

- 发版 CHANGELOG 过滤合并提交

### 杂项

- 新增 npm run release 自动发版脚本

