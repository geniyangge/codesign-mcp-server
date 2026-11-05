/**
 * 把图层名/画板名转成安全文件名。
 * Windows 保留名（CON、NUL、COM1…）和非法的尾部点/空格也要处理，否则写文件会失败。
 */
export function sanitizeFilename(name: string, fallback = "unnamed"): string {
  let out = name
    // 保留空格和连字符，只替换真正非法的字符与控制字符
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    // Windows 不允许文件名以 . 或空格结尾
    .replace(/[. ]+$/, "")
    .trim();

  if (
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out) ||
    out.length > 120
  ) {
    out = out.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])/i, "_$1").slice(0, 120);
  }

  return out || fallback;
}

/**
 * 同名文件去重：第二次出现起追加 `_2`、`_3`…
 * 返回一个可复用的命名器，同一目录内共享才能跨画板/跨批次去重。
 */
export function createNamer() {
  const used = new Map<string, number>();
  // 不区分大小写，避免 a.png / A.png 在 macOS/Windows 上互相覆盖
  return (base: string, ext: string): string => {
    const key = `${base}.${ext}`.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    return n === 1 ? `${base}.${ext}` : `${base}_${n}.${ext}`;
  };
}

/**
 * 把名字转成纯 ASCII 文件名。
 *
 * 中文名在部分静态服务器、CI 与 URL 编码链路上是隐患，
 * 用户反馈里 20 个文件全靠手工重命名成 item-color-bubble.png 这类。
 *
 * 不引拼音库：常见 UI 词走内置映射，其余用 `layer-<objectId>` 兜底，
 * 保证结果稳定、可预测、跨平台一致。中文原名保留在 manifest 里。
 */
export function toAsciiName(name: string, objectId?: string): string {
  const out = asciiSlug(name);
  if (out) return out;
  return objectId ? `layer-${objectId}` : "slice";
}

/**
 * ASCII 化但不给兜底：转换后什么都不剩时返回空串，
 * 便于调用方自己决定回退策略（比如前缀为空就干脆不加）。
 */
function asciiSlug(name: string): string {
  const common: Record<string, string> = {
    图标: "icon",
    按钮: "btn",
    背景: "bg",
    图片: "img",
    图层: "layer",
    文字: "text",
    标题: "title",
    头像: "avatar",
    边框: "border",
    弹窗: "dialog",
    卡片: "card",
    列表: "list",
    导航: "nav",
    分割线: "divider",
    阴影: "shadow",
    遮罩: "mask",
    装饰: "decor",
    效果: "effect",
    拷贝: "copy",
    组合: "group",
    容器: "container",
  };

  let out = String(name ?? "");
  // 先替换常见词，再处理剩下的字符
  for (const [zh, en] of Object.entries(common)) {
    out = out.split(zh).join(`-${en}-`);
  }
  return out
    // 全角标点与常见分隔符统一成连字符
    .replace(/[、，。！？：；（）【】《》""'']/g, "-")
    // 非 ASCII 一律丢弃
    .replace(/[^\x20-\x7e]/g, "-")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .toLowerCase()
    .slice(0, 60);
}

/**
 * 给文件名加前缀，便于按来源分组（如 `item-`、`bg-`）。
 * 前缀转换后为空时直接不加，避免拼出 `slice-icon` 这种莫名其妙的名字。
 */
export function withPrefix(base: string, prefix?: string): string {
  if (!prefix) return base;
  const clean = asciiSlug(prefix);
  return clean ? `${clean}-${base}` : base;
}
