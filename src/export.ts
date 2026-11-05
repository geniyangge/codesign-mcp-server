import type { Layer, LayerRect, ScreenDetail, SliceItem } from "./types.js";
import { appendImageOps, imageOps, indexLayers, pickExport, sliceFileName, toDesignScale, type ExportFormat, type ScaleSpec } from "./slicing.js";
import { sanitizeFilename } from "./utils/filename.js";

/**
 * 任意图层 / 任意区域导出。
 *
 * 用户反馈的核心缺口：设计稿里 86 个图层有 42 个是位图且没标切图，
 * 工具只能导出被标记为切图的图层，剩下的直接判定「无法还原」——
 * 用户只能自己用 System.Drawing 从预览图按包围盒手工裁剪。
 *
 * 这里按三级降级：
 * 1. `slice`     —— 图层有导出项，拿原切图（透明，干净）
 * 2. `composite` —— 没有切图，从画板合成图上按盒子裁剪（**不透明**，会带上底层内容）
 * 3. `fail`      —— 没有切图且盒子无效，导出不了
 */

export type ExportTier = "slice" | "composite" | "fail";

export interface ExportPlan {
  ref: string;
  objectId: string;
  name: string;
  tier: ExportTier;
  /** 设计稿坐标下的导出区域 */
  rect: LayerRect;
  z?: number;
  format: string;
  /** 源图自带倍率：slice 是切图的导出倍率，composite 是画板自身（记 1） */
  sourceScale: number;
  /** 实际选中的导出倍率；composite 时等于 targetScale */
  exportScale: number;
  targetScale: number;
  resampled: boolean;
  /** 从合成图裁剪时不透明，因为会带上底层内容 */
  opaque: boolean;
  width: number;
  height: number;
  file: string;
  /** 空字符串表示这一条导不出来 */
  downloadUrl: string;
  /** tier 为 fail 时的原因 */
  reason?: string;
}

export interface ExportOptions {
  /** 倍率语义，默认 native（取原图不重采样） */
  scale?: ScaleSpec;
  /** 目标像素宽，优先于 scale */
  targetWidth?: number;
  format?: ExportFormat;
  quality?: number;
  /** 命名器，调用方注入才能跨调用保持一致 */
  namer: (base: string, ext: string) => string;
}

/** 一次导出请求：按图层或按区域 */
export interface RegionRequest {
  name?: string;
  objectId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 按图层 objectId 规划导出。
 * 有切图走 slice 层级；没有则退到 composite（从合成图裁剪）。
 */
export function planLayerExports(
  objectIds: string[],
  layers: Layer[],
  slices: SliceItem[],
  screen: ScreenDetail,
  options: ExportOptions,
): ExportPlan[] {
  const byId = indexLayers(layers);
  const sliceById = new Map<string, SliceItem>();
  for (const s of slices) {
    sliceById.set(String(s.id), s);
    if (s.objectId) sliceById.set(String(s.objectId), s);
  }

  const plans: ExportPlan[] = [];
  for (const id of objectIds) {
    const layer = byId.get(String(id));
    if (!layer) {
      plans.push({
        ...emptyPlan(String(id), String(id), options),
        tier: "fail",
        reason: "设计稿里没有这个 objectId，请先用 design_get 确认图层标识",
      });
      continue;
    }
    const item = sliceById.get(String(id));
    const picked = item ? pickExport(item, toDesignScale(options.scale)) : undefined;

    if (item && picked) {
      plans.push(slicePlan(item, layer, picked, options));
      continue;
    }
    plans.push(compositePlan(layer.name, layer.objectId, boxOf(layer), screen, layer.z, options));
  }

  return withRefs(plans);
}

/** 按区域规划导出，直接裁画板合成图 */
export function planRegionExports(
  regions: RegionRequest[],
  screen: ScreenDetail,
  options: ExportOptions,
): ExportPlan[] {
  return withRefs(
    regions.map((r) =>
      compositePlan(
        r.name || r.objectId || "region",
        r.objectId ?? "",
        { x: r.x, y: r.y, width: r.width, height: r.height },
        screen,
        undefined,
        options,
      ),
    ),
  );
}

/** 图层有切图时的规划 */
function slicePlan(
  item: SliceItem,
  layer: Layer,
  picked: { export: SliceItem["exports"][number]; substituted: boolean },
  options: ExportOptions,
): ExportPlan {
  const rect = boxOf(layer, item.rect);
  const designScale = toDesignScale(options.scale);
  const wantWidth =
    options.targetWidth && options.targetWidth > 0
      ? Math.round(options.targetWidth)
      : designScale !== undefined && rect.width > 0
        ? Math.round(rect.width * designScale)
        : Math.round(picked.export.width);
  const needResize = wantWidth > 0 && Math.round(picked.export.width) !== wantWidth;
  const ext = options.format ?? picked.export.format ?? "png";

  const ops = imageOps({
    targetWidth: needResize ? wantWidth : undefined,
    format: options.format,
    quality: options.quality,
  });
  const height =
    picked.export.width > 0
      ? Math.round((picked.export.height / picked.export.width) * wantWidth)
      : Math.round(picked.export.height);
  const nameScale = designScale ?? picked.export.scale;

  return {
    ref: "",
    objectId: String(item.id ?? item.objectId),
    name: item.name || layer.name,
    tier: "slice",
    rect,
    z: layer.z,
    format: ext,
    sourceScale: picked.export.scale,
    exportScale: picked.export.scale,
    targetScale: nameScale,
    resampled: needResize,
    opaque: false,
    width: wantWidth,
    height,
    file: options.namer(
      sanitizeFilename(sliceFileName(item.name || layer.name || "slice", nameScale), "slice"),
      ext,
    ),
    downloadUrl: appendImageOps(picked.export.downloadUrl, ops),
  };
}

/**
 * 没有切图时，从画板合成图上裁剪。
 * 合成图是全分辨率的整块画板，裁出来**必然带上底层内容**，所以 opaque=true。
 */
function compositePlan(
  name: string,
  objectId: string,
  rect: LayerRect,
  screen: ScreenDetail,
  z: number | undefined,
  options: ExportOptions,
): ExportPlan {
  const ext = options.format ?? "png";
  const designScale = toDesignScale(options.scale);
  // 没有切图时只能裁合成图，源就是画板自身的分辨率，所以 sourceScale 记 1
  const targetScale = designScale ?? 1;
  const base = { ref: "", objectId, name, tier: "composite" as const, rect, z, format: ext, sourceScale: 1, exportScale: targetScale, targetScale, opaque: true };

  if (!screen.originalUrl) {
    return { ...base, resampled: false, width: 0, height: 0, file: "", downloadUrl: "", tier: "fail", reason: "该画板没有可裁剪的原图" };
  }
  if (!(rect.width > 0 && rect.height > 0)) {
    return {
      ...base,
      resampled: false,
      width: 0,
      height: 0,
      file: "",
      downloadUrl: "",
      tier: "fail",
      reason: "图层盒子为空（0x0），既没有切图也没有可裁剪区域——需要设计同学在 CoDesign 里补切图",
    };
  }

  // 裁剪按设计稿坐标；native 时保持原尺寸，指定倍率才缩放
  const wantWidth =
    options.targetWidth && options.targetWidth > 0
      ? Math.round(options.targetWidth)
      : designScale !== undefined
        ? Math.round(rect.width * designScale)
        : Math.round(rect.width);
  const ops = imageOps({
    crop: rect,
    targetWidth: Math.round(rect.width) !== wantWidth ? wantWidth : undefined,
    format: options.format,
    quality: options.quality,
  });
  const height = Math.round((rect.height / rect.width) * wantWidth);

  return {
    ...base,
    resampled: Math.round(rect.width) !== wantWidth,
    width: wantWidth,
    height,
    file: options.namer(
      sanitizeFilename(sliceFileName(`${name}_composite`, targetScale), "composite"),
      ext,
    ),
    downloadUrl: appendImageOps(screen.originalUrl, ops),
  };
}

function emptyPlan(objectId: string, name: string, options: ExportOptions): ExportPlan {
  const designScale = toDesignScale(options.scale) ?? 1;
  return {
    ref: "",
    objectId,
    name,
    tier: "fail",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    format: options.format ?? "png",
    sourceScale: 1,
    exportScale: designScale,
    targetScale: designScale,
    resampled: false,
    opaque: false,
    width: 0,
    height: 0,
    file: "",
    downloadUrl: "",
  };
}

/** 图层盒子优先用校正后的 sliceRect，其次才是 rect */
function boxOf(layer: Layer, fallback?: LayerRect): LayerRect {
  if (layer.rectConfidence === "low" && layer.sliceRect) return layer.sliceRect;
  if (layer.rect.width > 0 && layer.rect.height > 0) return layer.rect;
  if (fallback && fallback.width > 0 && fallback.height > 0) return fallback;
  if (layer.sliceRect) return layer.sliceRect;
  return layer.rect;
}

/** 给每一条分配 `e1`、`e2`… 这样的稳定短标识 */
function withRefs(plans: ExportPlan[]): ExportPlan[] {
  return plans.map((p, i) => ({ ...p, ref: `e${i + 1}` }));
}

/** 汇总各层级的数量，便于调用方判断是否需要人工介入 */
export function summarizeTiers(plans: ExportPlan[]) {
  const byTier = { slice: 0, composite: 0, fail: 0 };
  for (const p of plans) byTier[p.tier]++;
  return byTier;
}
