import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CoDesignClient } from "./client.js";
import { CoDesignError } from "./errors.js";
import { planSlices, imageOps, appendImageOps, toDesignScale, type ExportFormat, type ScaleSpec } from "./slicing.js";
import type {
  DownloadResult,
  Layer,
  LayerTree,
  ScreenDetail,
  ShareInfo,
  SliceExport,
  SliceItem,
} from "./types.js";
import { mapLimit } from "./utils/concurrency.js";
import { createNamer, sanitizeFilename } from "./utils/filename.js";

/** 需要拉取的画板数据：按工具用途惰性加载，避免额外请求 */
export interface ScreenData {
  /** 画板详情（元数据 / 预览图地址） */
  detail?: boolean;
  /** 图层树 */
  meta?: boolean;
  /** 切图清单 */
  slices?: boolean;
}

export interface ResolvedScreen {
  designId: number;
  detail: ScreenDetail;
  tree?: LayerTree;
  slices?: SliceItem[];
}

export interface ResolveOptions extends ScreenData {
  /** 并发度，默认 4 */
  concurrency?: number;
}

/**
 * 决定要处理哪些画板：显式指定 > 链接里的 > 全部。
 * 只按需拉取 meta / slices，且画板之间并发处理。
 * 密码分享的解锁在 getShare 阶段完成，画板详情接口本身不需要 state-key。
 */
export async function resolveScreens(
  client: CoDesignClient,
  share: ShareInfo,
  screenId?: number,
  options: ResolveOptions = {},
): Promise<ResolvedScreen[]> {
  const { detail = true, meta = false, slices = false, concurrency = 4 } = options;

  const all = share.designs.flatMap((d) => d.screens.map((s) => ({ designId: d.id, ...s })));
  if (!all.length) throw new CoDesignError("设计稿里没有找到任何画板");

  const targets = screenId ? all.filter((s) => s.id === screenId) : all;
  if (!targets.length) {
    throw new CoDesignError(
      `画板 ${screenId} 不存在`,
      undefined,
      "可用画板：\n" + all.map((s) => `  ${s.id}  ${s.name}`).join("\n"),
    );
  }

  return mapLimit(targets, concurrency, async (t): Promise<ResolvedScreen> => {
    // 不拿 detail 时就够不着 meta/slices，直接返回最基本信息
    if (!detail) {
      return {
        designId: t.designId,
        detail: {
          id: t.id,
          name: t.name,
          width: 0,
          height: 0,
          designId: t.designId,
          source: "",
          slicesCount: 0,
        },
      };
    }

    const detailInfo = await client.getScreen(t.designId, t.id);
    const [tree, sliceList] = await Promise.all([
      meta && detailInfo.metaUrl ? client.getMeta(detailInfo.metaUrl) : undefined,
      slices && detailInfo.slicesUrl ? client.getSlices(detailInfo.slicesUrl) : undefined,
    ]);

    // 接口的 slices_count 不可信（实测给 0 但清单实返 13 条），有清单就以它为准
    if (sliceList) detailInfo.slicesCount = sliceList.length;

    return { designId: t.designId, detail: detailInfo, tree, slices: sliceList };
  });
}

/**
 * 旧版默认倍率，仅供 `pickExports` 保持向后兼容。
 *
 * 新版工具默认走 `native`（取原图不重采样），不再默认降到 2x——
 * 源图是 3x 时默认降采样属于静默掉画质，该由调用方主动选择。
 */
export const DEFAULT_SCALE = (() => {
  const n = Number(process.env.CODESIGN_SCALE);
  return Number.isFinite(n) && n > 0 ? n : 2;
})();

/** 工具的默认倍率语义：取原图，不做任何重采样 */
export const NATIVE_SCALE: ScaleSpec = { kind: "native" };

/** 每张切图最终选中的导出项，附带是否发生过倍率降级 */
export interface PickedExport {
  export: SliceExport;
  /** 该图层没有请求的倍率，实际用了别的倍率 */
  substituted: boolean;
}

/**
 * 每张切图只取一个倍率，避免同一图层下载多份。
 *
 * 倍率优先级：
 * 1. 调用方显式指定（用户在会话里说「要 3 倍图」）—— 优先满足
 * 2. 环境变量 CODESIGN_SCALE
 * 3. 内置默认 2x
 *
 * 若该图层没有正好这个倍率：就近取**不超过**目标的最高档，再退而取最低档，
 * 并把 `substituted` 标出来，由上层如实告知，不静默替换。
 *
 * 选择逻辑已收敛到 `slicing.ts`，这里只保留返回数组的形状供既有调用方使用。
 */
export function pickExports(item: SliceItem, scale?: number): PickedExport[] {
  if (!item.exports.length) return [];

  const target = scale ?? DEFAULT_SCALE;
  const exactMatch = (s: number) => item.exports.filter((e) => e.scale === s);

  const exact = exactMatch(target);
  if (exact.length) return exact.map((e) => ({ export: e, substituted: false }));

  const sorted = [...new Set(item.exports.map((e) => e.scale))].sort((a, b) => a - b);
  // 优先取不超过目标的最高档（避免下载到比预期更大的文件）
  const lower = sorted.filter((s) => s < target);
  const fallback =
    lower.length > 0
      ? lower[lower.length - 1]
      : // 只有更高档时向上取最小的一档
        sorted[0];

  return exactMatch(fallback).map((e) => ({ export: e, substituted: true }));
}

export interface DownloadOptions {
  /** 倍率语义，默认 native（取原图不重采样） */
  scale?: ScaleSpec;
  /** 目标像素宽，优先于 scale */
  targetWidth?: number;
  /** 输出格式 */
  format?: ExportFormat;
  /** jpg/webp 质量 */
  quality?: number;
  concurrency?: number;
  /** 同一目录内共享命名器，跨画板/跨批次去重 */
  namer?: ReturnType<typeof createNamer>;
  /** 图层树，用于把切图项和真实内容框、z 值对上 */
  layers?: Layer[];
}

/** 把切图清单挂到图层树上，按 object_id 关联 */
export function attachSlices(layers: Layer[], slices: SliceItem[]): Layer[] {
  if (!slices.length) return layers;

  const byId = new Map<string, SliceItem>();
  for (const s of slices) byId.set(String(s.id), s);

  const link = (l: Layer): Layer => {
    const slice = byId.get(l.objectId);
    if (slice && slice.exports.length) {
      const scales = [...new Set(slice.exports.map((e) => e.scale))].sort((a, b) => a - b);
      const formats = [...new Set(slice.exports.map((e) => e.format))];
      // 取最高倍率那一档的实际导出尺寸
      const top = slice.exports.reduce((a, b) => (b.scale > a.scale ? b : a));
      l.slice = {
        objectId: l.objectId,
        scales,
        formats,
        exportWidth: top.width,
        exportHeight: top.height,
      };
    }
    if (l.children?.length) l.children = l.children.map(link);
    return l;
  };

  return layers.map(link);
}

export async function downloadSlices(
  client: CoDesignClient,
  slices: SliceItem[],
  outDir: string,
  options: DownloadOptions = {},
): Promise<DownloadResult[]> {
  await mkdir(outDir, { recursive: true });
  const namer = options.namer ?? createNamer();

  // 统一走 slicing 的规划：它负责挑倍率、算重采样尺寸、分配文件名
  const plans = planSlices(slices, options.layers ?? [], {
    scale: options.scale ?? NATIVE_SCALE,
    targetWidth: options.targetWidth,
    format: options.format,
    quality: options.quality,
    namer,
  });

  return mapLimit(plans, options.concurrency ?? 6, async (plan) => {
    const path = join(outDir, plan.file);
    try {
      const buf = await client.downloadImage(plan.downloadUrl);
      await writeFile(path, buf);
      return {
        name: plan.name,
        path: plan.file,
        ref: plan.ref,
        objectId: plan.objectId,
        rect: plan.rect,
        z: plan.z,
        format: plan.format,
        tier: plan.tier,
        sourceScale: plan.sourceScale,
        exportScale: plan.exportScale,
        targetScale: plan.targetScale,
        resampled: plan.resampled || undefined,
        // 实际落盘的倍率，可能与请求的倍率不同（该图层没导出这个倍率时）
        scale: plan.exportScale,
        substituted: plan.substituted || undefined,
        width: plan.width,
        height: plan.height,
        bytes: buf.length,
        ok: true,
      };
    } catch (e) {
      return {
        name: plan.name,
        path: plan.file,
        ref: plan.ref,
        objectId: plan.objectId,
        rect: plan.rect,
        z: plan.z,
        format: plan.format,
        tier: plan.tier,
        sourceScale: plan.sourceScale,
        exportScale: plan.exportScale,
        targetScale: plan.targetScale,
        resampled: plan.resampled || undefined,
        scale: plan.exportScale,
        substituted: plan.substituted || undefined,
        width: plan.width,
        height: plan.height,
        bytes: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}

export async function downloadPreviews(
  client: CoDesignClient,
  targets: ResolvedScreen[],
  outDir: string,
  options: {
    concurrency?: number;
    namer?: ReturnType<typeof createNamer>;
    /** 倍率语义，默认 native（原图）；design 倍率放大时由服务端处理 */
    scale?: ScaleSpec;
    /** 目标像素宽，优先于 scale */
    targetWidth?: number;
  } = {},
): Promise<DownloadResult[]> {
  await mkdir(outDir, { recursive: true });
  const namer = options.namer ?? createNamer();
  const designScale = toDesignScale(options.scale);

  return mapLimit(targets, options.concurrency ?? 6, async (t) => {
    const wantWidth =
      options.targetWidth && options.targetWidth > 0
        ? Math.round(options.targetWidth)
        : designScale !== undefined
          ? Math.round(t.detail.width * designScale)
          : undefined;
    const ops = wantWidth ? imageOps({ targetWidth: wantWidth }) : [];
    const file = namer(
      sanitizeFilename(`${t.detail.name}_preview${wantWidth ? `@${Math.round(wantWidth / (t.detail.width || 1))}x` : ""}`, "screen"),
      "png",
    );
    if (!t.detail.originalUrl && !t.detail.previewUrl) {
      return {
        name: t.detail.name,
        path: file,
        width: t.detail.width,
        height: t.detail.height,
        bytes: 0,
        ok: false,
        error: "该画板没有预览图",
      };
    }
    const url = appendImageOps(t.detail.originalUrl ?? t.detail.previewUrl!, ops);
    const width = wantWidth ?? t.detail.width;
    const height = wantWidth ? Math.round((t.detail.height / (t.detail.width || 1)) * wantWidth) : t.detail.height;
    try {
      const buf = await client.downloadImage(url);
      await writeFile(join(outDir, file), buf);
      return {
        name: t.detail.name,
        path: file,
        width,
        height,
        bytes: buf.length,
        ok: true,
      };
    } catch (e) {
      return {
        name: t.detail.name,
        path: file,
        width,
        height,
        bytes: 0,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}
