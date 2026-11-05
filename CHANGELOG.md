# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [2.0.0] - 2026-11-04

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

- **`design_export` 工具**：导出任意图层或区域。有切图走 `slice`（透明）；没有切图则从画板合成图裁剪，
  标为 `composite`（**不透明**，会带上被遮挡的底层内容）；盒子为空时 `fail` 并给出原因。
  支持 `objectIds`、`namePattern` 正则批量、`regions` 三种方式，两两互斥。
- **`design_get_slices` 清单**：下载切图时写出 `codesign-manifest.json` 与 `codesign-manifest.csv`
  （UTF-8 BOM，Excel / PowerShell 直接可读），以 `ref` 和 `objectId` 为主键，含坐标、倍率、落盘尺寸。
- **切图按目标倍率服务端重采样**：指定倍率时落盘尺寸恒等于目标尺寸，
  结果带 `resampled: true`，源图倍率记在 `sourceScale`。
- **切图格式与尺寸参数**：`format`（png/jpg/webp）、`quality`、`targetWidth`。
- **ASCII 文件名**：`asciiNames: true` 把中文名转成 `icon`、`img-xb4-0202` 这类安全名字
  （无匹配时用 `layer-<objectId>` 兜底），中文原名保留在清单里；`prefix` 可再加分组前缀。
- **按名字正则批量导出**：`namePattern` + `nameTypes`，省去手工从 design_get 抄 objectId。
- **建议导出区域**：`unreconstructable` 每条附 `suggestedRegion`，可直接粘进 `regions`。
- **预览区域裁剪**：`design_download_previews` 支持 `regions`，做像素级比对不必自己裁整板图。
- **spec 文本排版信息**：文本节点新增 `typography`（字体、字号、字重、行高、字距、对齐、
  按显式换行拆分的 `lines`、盒子高度）。
- **图层视图控制**：`view`（summary/flat/tree）、`fields` 字段投影、`subtreeId` 取子树、
  `types` 过滤、`offset`/`limit` 分页、`includeBitmapLayers`。
- **层叠顺序**：图层带 `z` 字段（全局绘制顺序，越大越靠上），兄弟节点按它排序。
- **画板名定位**：`screenName` 参数可直接按画板名选中，省去先查 `screenId` 的一步。
- **预览图倍率**：`design_download_previews` 支持 `scale` / `cssScale` 与 `targetWidth`。
- **盒子可信度**：组图层 `rect` 异常时标 `rectConfidence: "low"` 并给出推定的 `sliceRect`。
- **`unreconstructable` 返回完整列表**，不再只举例 5 个，并附兜底导出建议。

### 已知限制

- **没有切图的位图图层无法透明导出**：CoDesign 不暴露图层级原始资源——实测 42 个位图图层的
  `exportables` 全为空、`pixels` 只是布尔标记、图层里没有任何图片 URL，也没有图层渲染接口。
  这类图层只能从画板合成图裁剪（`composite`，不透明）。需要透明图只能请设计同学补切图。

### 修复

- **图层层叠顺序丢失**：`layers` 与 `groups` 是两个独立数组，直接拼接会把所有组排到所有形状之后
  （实测某画板 6 个组全被推到最后）。现按全局 `index` 排序。
- **`font-size: NaNpx`**：字号等字段可能是 `{ value: 22, units: "pointsUnit" }` 对象，未被解包时算出 NaN。
- **`textAlign` 丢失**：权威来源是 `paragraphStyleRange[].paragraphStyle.align`，此前未读取。
- **`sliceCount` 显示 0 但实际有切图**：接口的 `slices_count` 不可信（实测给 0、实返 13 条），
  现以切图清单长度为准，原值留档到 `sliceCountReported`。
- **阴影方向恒定朝右下**：原先用 `distance` 同时充当 X/Y 偏移，现按 `angle` 拆分。
- **超时提示是死代码**：`AbortSignal.timeout()` 抛的是 `TimeoutError` 而非 `AbortError`。
- **多条警示信息互相覆盖**：截断、位图、缺少 Cookie 三处提示现合并输出。
- **`design_get_spec` 与下载的文件名对不上**：spec 提示 `icon_2.png`、实际落盘却是 `icon.png`。
  现两者共用同一份切图规划。

### 文档

- README 补充清单格式、导出分级、Windows 终端编码说明。
- DEVELOPMENT 记录 imageMogr2 操作链、实测踩坑与输出体积控制手段。

## [1.1.0] - 2026-10-26

### 新增

- 关联图层与切图，标记无法还原的位图图层
- 支持直接用设计稿后台链接

### 修复

- 发版 CHANGELOG 过滤合并提交

### 杂项

- 新增 npm run release 自动发版脚本

