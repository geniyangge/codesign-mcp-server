import type { Layer, LayerRect, SliceExport, SliceItem } from "./types.js";
import { sanitizeFilename } from "./utils/filename.js";

/**
 * 切图规划：把「图层 + 切图清单」整理成一组可下载的条目。
 *
 * 这里是倍率选择、服务端重采样、文件名分配的唯一真相来源——
 * `design_download_slices`、`design_export`、`design_get_spec` 全部走同一条路径，
 * 否则会出现 spec 告诉调用方 `icon_2.png`、实际落盘却叫 `icon.png` 的分叉。
 */

/** 支持的导出格式 */
export type ExportFormat = "png" | "jpg" | "webp";

/** 单条导出的来源层级 */
export type ExportTier =
  /** 图层自带切图，导出的是干净的单图层内容（透明） */
  | "slice"
  /** 没有切图，从画板合成图上按盒子裁剪——会带上底层内容，不透明 */
  | "composite";

export interface ImageOpsOptions {
  /** 从原图裁剪出这块区域，设计稿坐标 */
  crop?: LayerRect;
  /** 目标像素宽（等比缩放），同时支持缩小与放大 */
  targetWidth?: number;
  /** 输出格式，缺省 png */
  format?: ExportFormat;
  /** jpg/webp 的质量，1–100 */
  quality?: number;
}

/**
 * 组装腾讯云 imageMogr2 操作链。
 *
 * 实测要点：
 * - 必须带 `imageMogr2/` 前缀，裸 `?thumbnail/208x` 不生效
 * - `cut/WxHxXxY` 裁剪，按设计稿像素坐标
 * - `thumbnail/<W>x` 等比缩放到指定宽，**支持放大**（!200p 可把 750 拉到 1500）
 * - 顺序是 cut 在前、thumbnail 在后，两步能正确叠加
 */
export function imageOps(opts: ImageOpsOptions): string[] {
  const ops: string[] = [];
  const crop = opts.crop;
  if (crop && crop.width > 0 && crop.height > 0) {
    const w = Math.round(crop.width);
    const h = Math.round(crop.height);
    const x = Math.max(0, Math.round(crop.x));
    const y = Math.max(0, Math.round(crop.y));
    ops.push(`cut/${w}x${h}x${x}x${y}`);
  }
  if (opts.targetWidth && opts.targetWidth > 0) {
    ops.push(`thumbnail/${Math.round(opts.targetWidth)}x`);
  }
  if (opts.format) ops.push(`format/${opts.format}`);
  // quality 0 是合法输入（会被钳到 1），不能当 falsy 跳过
  if (opts.quality !== undefined && (opts.format === "jpg" || opts.format === "webp")) {
    ops.push(`quality/${clampQuality(opts.quality)}`);
  }
  return ops;
}

function clampQuality(q: number): number {
  return Math.min(100, Math.max(1, Math.round(q)));
}

export interface SlicePlanEntry {
  /** 本次结果内的稳定短标识，供调用方在对话里引用，不必带中文名 */
  ref: string;
  objectId: string;
  name: string;
  tier: ExportTier;
  /** 设计稿坐标下的内容框 */
  rect: LayerRect;
  z?: number;
  format: string;
  /** 原始导出倍率（composite 时等于 targetScale） */
  exportScale: number;
  /** 期望的倍率；resampled 时即重采样后的实际倍率 */
  targetScale: number;
  /** 图层没有目标倍率，已让服务端缩放对齐 */
  resampled: boolean;
  /** 图层没有目标倍率且只能就近取（保留既有语义，与 resampled 并存） */
  substituted: boolean;
  /** 重采样后的目标像素宽 */
  targetWidth: number;
  /** 实际会下载到的像素尺寸（按服务端缩放结果推算） */
  width: number;
  height: number;
  /** 已分配、全局唯一的文件名 */
  file: string;
  /** 已挂好操作链的下载地址 */
  downloadUrl: string;
}

export interface PlanOptions {
  /** 目标倍率，默认 2 */
  scale?: number;
  /** 目标像素宽，优先于 scale */
  targetWidth?: number;
  /** 输出格式，默认沿用切图自带格式 */
  format?: ExportFormat;
  quality?: number;
  /** 命名器，调用方注入才能在多次调用间保持一致 */
  namer: (base: string, ext: string) => string;
}

/**
 * 为每个切图项挑一档导出并规划下载。
 *
 * 倍率优先级：显式 scale > 内置默认 2x。
 * 该图层没有目标倍率时，按既有规则就近取一档，再让服务端重采样到目标尺寸——
 * 这样调用方拿到的图**原始倍率不符但像素尺寸符合预期**，不会出现
 * 「要 2 倍图却拿到 3 倍图、文件体积翻倍」的意外。
 */
export function planSlices(
  slices: SliceItem[],
  layers: Layer[],
  options: PlanOptions,
): SlicePlanEntry[] {
  const byId = indexLayers(layers);
  const targetScale = options.scale ?? 2;
  const entries: SlicePlanEntry[] = [];

  for (const item of slices) {
    if (!item.exports.length) continue;
    const layer = byId.get(String(item.id)) ?? byId.get(String(item.objectId));
    const rect = pickRect(item, layer);
    const picked = pickExport(item, targetScale);
    if (!picked) continue;

    const format = options.format ?? (picked.export.format as ExportFormat) ?? "png";
    // 目标像素宽：显式 targetWidth 优先，否则按设计稿宽度 × 目标倍率
    const wantWidth =
      options.targetWidth && options.targetWidth > 0
        ? Math.round(options.targetWidth)
        : rect.width > 0
          ? Math.round(rect.width * targetScale)
          : Math.round(picked.export.width);
    // 实际导出宽与期望不一致就交给服务端缩放，调用方拿到的永远是对齐后的尺寸
    const needResize = Math.round(picked.export.width) !== wantWidth && wantWidth > 0;

    // 只有发生缩放时才把原先默认挂上的 format/png 换成完整操作链
    const ops = imageOps({
      targetWidth: needResize ? wantWidth : undefined,
      format: options.format,
      quality: options.quality,
    });
    const ext = options.format ?? picked.export.format ?? "png";
    const file = options.namer(sanitizeFilename(sliceFileName(item.name || layer?.name || "slice", targetScale), "slice"), ext);
    const height =
      picked.export.width > 0
        ? Math.round((picked.export.height / picked.export.width) * wantWidth)
        : Math.round(picked.export.height);

    entries.push({
      ref: "",
      objectId: String(item.id ?? item.objectId),
      name: item.name || layer?.name || "",
      tier: "slice",
      rect,
      z: layer?.z,
      format: ext,
      exportScale: picked.export.scale,
      targetScale,
      resampled: needResize,
      substituted: picked.substituted,
      targetWidth: wantWidth,
      width: wantWidth,
      height,
      file,
      downloadUrl: applyCdnOps(picked.export.downloadUrl, ops),
    });
  }

  return withRefs(entries);
}

/** 选中的导出项（含是否发生了倍率降级） */
interface PickedExport {
  export: SliceExport;
  substituted: boolean;
}

/**
 * 每张切图只取一个倍率，避免同一图层下载多份。
 * 若没有正好这个倍率：就近取**不超过**目标的最高档，再退而取最低档。
 */
export function pickExport(item: SliceItem, target: number): PickedExport | undefined {
  if (!item.exports.length) return undefined;

  const exact = item.exports.filter((e) => e.scale === target);
  if (exact.length) return { export: exact[0], substituted: false };

  const scales = [...new Set(item.exports.map((e) => e.scale))].sort((a, b) => a - b);
  const lower = scales.filter((s) => s < target);
  const fallback = lower.length > 0 ? lower[lower.length - 1] : scales[0];
  const hit = item.exports.filter((e) => e.scale === fallback);
  return hit.length ? { export: hit[0], substituted: true } : undefined;
}

/**
 * 切图项的 rect 才是真实内容框。组图层自身的 rect 经常报整屏或 0×0，
 * 拿它当裁剪范围会裁出一大片空白。
 */
function pickRect(item: SliceItem, layer?: Layer): LayerRect {
  const r = item.rect;
  if (r && r.width > 0 && r.height > 0) return r;
  if (layer?.sliceRect) return layer.sliceRect;
  if (layer) return layer.rect;
  return r ?? { x: 0, y: 0, width: 0, height: 0 };
}

/**
 * 生成 `<名字>@<倍率>x` 形式的基础名（不含扩展名）。
 * 倍率用重采样后的实际值，保证文件名与真实像素尺寸自洽。
 */
export function sliceFileName(name: string, scale: number): string {
  const clean = (name || "slice").trim() || "slice";
  const suffix = Number.isFinite(scale) && scale > 0 ? `@${formatScale(scale)}x` : "";
  return `${clean}${suffix}`;
}

/** 2 → "2"；1.5 → "1.5"；2.333 → "2.33" */
function formatScale(scale: number): string {
  const rounded = Math.round(scale * 100) / 100;
  return String(rounded);
}

/**
 * 在已有的 CDN 地址上应用图片操作。
 *
 * 实测坑：`imageMogr2` 里**重复的 format 只认第一个**
 * ——`format/png/format/webp` 返回的仍是 PNG。而 `toCdnUrl` 默认就会挂上 `format/png`，
 * 所以指定 webp 时必须**替换**掉已有的 format，直接追加会静默失效。
 * 其余操作（thumbnail/cut）可以正常追加。
 * svg 是矢量格式，任何 imageMogr2 操作都会报 400，原样返回。
 */
function applyCdnOps(url: string, ops: string[]): string {
  if (!url || !ops.length) return url;
  if (/\.svgz?($|\?)/i.test(url)) return url;

  const existing = url.match(/imageMogr2((?:\/[^?&#]*)?)/);
  if (!existing) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}imageMogr2/${ops.join("/")}`;
  }

  // 拆开已有操作链，丢掉其中的 format/xxx（token 成对出现），再接上本次操作
  const tokens = existing[1].split("/").filter(Boolean);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "format") {
      i++; // 连同它的值一起跳过
      continue;
    }
    kept.push(tokens[i]);
  }
  const merged = [...kept, ...ops.flatMap((op) => op.split("/"))];
  return url.replace(existing[0], `imageMogr2/${merged.join("/")}`);
}

/** 把图层树摊平成 objectId → Layer 的索引，便于按切图反查 */
export function indexLayers(layers: Layer[]): Map<string, Layer> {
  const map = new Map<string, Layer>();
  const walk = (list: Layer[]) => {
    for (const l of list) {
      if (l.objectId) map.set(String(l.objectId), l);
      if (l.children?.length) walk(l.children);
    }
  };
  walk(layers);
  return map;
}

/** 给每一条分配 `s1`、`s2`… 这样的稳定短标识 */
function withRefs(entries: SlicePlanEntry[]): SlicePlanEntry[] {
  return entries.map((e, i) => ({ ...e, ref: `s${i + 1}` }));
}
