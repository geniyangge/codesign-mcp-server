#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CoDesignClient, parseDesignId, parseScreenId, parseShareId } from "./client.js";
import { CoDesignError, isCoDesignError } from "./errors.js";
import { planLayerExports, planRegionExports, summarizeTiers, type RegionRequest } from "./export.js";
import { summarize, toManifestEntries, writeManifest, type ManifestEntry } from "./manifest.js";
import { buildSpec } from "./spec.js";
import type { ExportFormat, ScaleSpec } from "./slicing.js";
import { attachSlices, NATIVE_SCALE, downloadSlices, downloadPreviews, resolveScreens } from "./tools.js";
import type { Layer, ShareInfo } from "./types.js";
import { mapLimit } from "./utils/concurrency.js";
import { createNamer } from "./utils/filename.js";
import { assignRefs, collectUnreconstructable, projectLayers, type LayerView } from "./views.js";
import { VERSION } from "./version.js";

const COOKIE = process.env.CODESIGN_COOKIE || "";
const DEFAULT_OUT = process.env.CODESIGN_OUT_DIR || "./codesign-assets";
const DEFAULT_PASSWORD = process.env.CODESIGN_PASSWORD || undefined;
const CONCURRENCY = clampInt(process.env.CODESIGN_CONCURRENCY, 4, 1, 16);
const TIMEOUT_MS = clampInt(process.env.CODESIGN_TIMEOUT_MS, 30_000, 1_000, 120_000);
// 默认倍数由 client 侧统一处理，这里只用于文档提示

const client = new CoDesignClient(COOKIE, { timeoutMs: TIMEOUT_MS, defaultPassword: DEFAULT_PASSWORD });

const server = new McpServer({ name: "codesign-mcp-server", version: VERSION });

const urlSchema = z
  .string()
  .min(1)
  .describe(
    "CoDesign 链接，两种都支持：" +
      "① 分享链接 https://codesign.qq.com/app/s/<分享ID> 或 /s/<分享ID>/<画板ID>/inspect；" +
      "② 后台链接 https://codesign.qq.com/app/design/<设计ID>/board（必须配 CODESIGN_COOKIE）。" +
      "另外也可直接传纯数字分享 ID。",
  );
const passwordSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "分享访问密码。若设计稿开启了密码保护，接口会返回 403「请输入密码」，此时必须提供。" +
      `不传则使用环境变量 CODESIGN_PASSWORD${DEFAULT_PASSWORD ? "（当前已配置）" : "（当前未配置）"}。`,
  );
const screenIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("画板 ID；不传则用链接中的画板，链接也没有则处理全部画板");
const outDirSchema = z
  .string()
  .min(1)
  .optional()
  .describe(`输出目录，默认 ${DEFAULT_OUT}`);
const formatSchema = z
  .enum(["png", "jpg", "webp"])
  .optional()
  .describe("输出格式：png 支持透明，webp 体积最小，jpg 不支持透明。默认 png。");
const qualitySchema = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe("jpg/webp 质量（1-100），对 png 无效。");

/**
 * 倍率参数。
 *
 * 「几倍图」在前端语境里默认指 CSS 的 2x（375 × 2 = 750px），
 * 而在设计稿语境里指 750 × 2 = 1500px，两者差整整一倍。
 * 所以拆成两个显式参数，不传就取原图。
 */
const scaleSchema = z
  .number()
  .positive()
  .optional()
  .describe(
    "相对**设计稿**（通常 750 宽）的倍率。scale:2 → 落盘 1500px。不传则取图层原图、不重采样。",
  );
const cssScaleSchema = z
  .number()
  .positive()
  .optional()
  .describe(
    "相对**CSS**（通常 375 宽）的倍率，与前端说的「2 倍图」一致。cssScale:2 → 落盘 750px。与 scale 二选一。",
  );

server.registerTool(
  "design_get",
  {
    title: "读取设计稿图层标注",
    description: [
      "读取腾讯 CoDesign 设计稿：返回设计稿标题、团队、画板列表与图层标注。",
      "支持分享链接和后台链接（/app/design/<设计ID>/board）。",
      "默认只返回第一个画板的精简图层列表（view=summary：ref/objectId/depth/name/type/z/rect/flags），",
      "带 z（全局绘制顺序，越大越靠上）和 parentId，层级不再靠名字前的空格推断。",
      "要更多信息按需升级：view=flat 补样式（css/text/fills/borders），view=tree 给嵌套结构；",
      "只想看部分图层用 types 过滤、subtreeId 取子树、offset/limit 分页、fields 做字段投影。",
      "isBitmap=true 的图层是位图，没有矢量信息：有 slice 就下载切图，",
      "没有 slice 会列进 unreconstructable——这类图层可用 design_export(objectIds) 从合成图裁剪兜底。",
      "多画板时需要全部画板请显式传 allScreens=true，默认只给第一块避免上下文被塞满。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      screenName: z
        .string()
        .min(1)
        .optional()
        .describe("按画板名精确匹配，省去先查 screenId 的一步。"),
      includeLayers: z.boolean().optional().describe("是否返回图层标注，默认 true"),
      view: z
        .enum(["summary", "flat", "tree"])
        .optional()
        .describe(
          "图层视图，默认 summary（精简，最省上下文）。" +
            "flat=补上 css/text/fills/borders 等样式细节；tree=保留嵌套结构（父子关系）。",
        ),
      fields: z
        .array(z.string())
        .optional()
        .describe('字段投影，只保留指定字段。例如 ["rect","name","type","slice"]。objectId 永远保留。'),
      subtreeId: z
        .string()
        .min(1)
        .optional()
        .describe("只返回该 objectId 的子树，适合先看整体再深入某个分组。"),
      types: z
        .array(z.string())
        .optional()
        .describe('按图层类型过滤，例如 ["text"] 只看文本、["group"] 只看分组。'),
      offset: z.number().int().min(0).optional().describe("分页起点，默认 0"),
      limit: z
        .number()
        .int()
        .positive()
        .max(20000)
        .optional()
        .describe("每页数量，默认 200（tree 视图 500）"),
      includeBitmapLayers: z
        .boolean()
        .optional()
        .describe("是否在 unreconstructable 里列出位图图层，默认 true；关掉可省体积。"),
      allScreens: z
        .boolean()
        .optional()
        .describe("是否返回全部画板，默认 false 只给第一块。多画板设计稿全量返回会非常大。"),
      maxLayers: z
        .number()
        .int()
        .positive()
        .max(20000)
        .optional()
        .describe("每个画板最多处理多少图层，默认不限；超出会截断"),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("最多下钻几层图层，默认不限"),
    },
  },
  async (args) => run(() => handleDesignGet(args)),
);

server.registerTool(
  "design_download_slices",
  {
    title: "下载切图",
    description: [
      "批量下载 CoDesign 画板的切图，并输出 codesign-manifest.json / .csv 清单。",
      "自动把 OSS 签名地址转换为可下载的 CDN 地址，文件名统一为「图层名@倍率x」，同名自动加序号。",
      "默认取图层自带的**原图**，不做任何缩放，画质零损失。",
      "需要指定倍率时有两个参数，基准不同、别混用：",
      "  cssScale —— 相对 CSS 宽（375）。cssScale:2 落盘 750px，即前端常说的「2 倍图」",
      "  scale    —— 相对设计稿宽（750）。scale:2 落盘 1500px，对 CSS 其实是 4x",
      "用户说「要 2 倍图」通常指 cssScale:2。设计稿没有该倍率时会由服务端重采样（resampled=true），",
      "落盘尺寸始终等于目标尺寸；源图倍率记在 sourceScale 里。",
      "需要 jpg/webp 或更小的图时传 format / quality / targetWidth。",
      "返回每个文件的 ref、objectId、坐标、倍率与像素尺寸；清单文件可用于批量核对。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      outDir: outDirSchema,
      scale: scaleSchema,
      cssScale: cssScaleSchema,
      targetWidth: z
        .number()
        .positive()
        .optional()
        .describe("目标像素宽，优先于 scale。例如只想要 200px 宽的图就传 200。"),
      format: z
        .enum(["png", "jpg", "webp"])
        .optional()
        .describe("输出格式，默认沿用切图自带格式（通常是 png）。webp 体积最小，jpg 不支持透明。"),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("jpg/webp 质量（1-100），对 png 无效。"),
    },
  },
  async (args) => run(() => handleDownloadSlices(args)),
);

server.registerTool(
  "design_download_previews",
  {
    title: "下载画板预览图",
    description: [
      "下载画板的整图预览（PNG），供 AI 直接读图理解视觉设计。",
      "还原设计稿前建议先调这个，用视觉判断整体布局，再用 design_get 拿精确数值。",
      "原图本身就是设计稿原始分辨率（如 750 宽），需要更大或更小时用 scale / targetWidth。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      outDir: outDirSchema,
      scale: scaleSchema,
      cssScale: cssScaleSchema,
      targetWidth: z.number().positive().optional().describe("目标像素宽，优先于倍率。"),
    },
  },
  async (args) => run(() => handleDownloadPreviews(args)),
);

server.registerTool(
  "design_export",
  {
    title: "导出任意图层或区域",
    description: [
      "把任意图层或任意区域导出成图片，是「无法还原」图层的兜底方案。",
      "按 objectIds 导出：图层有切图就拿原切图（tier=slice，透明）；",
      "没有切图则从画板合成图上按图层盒子裁剪（tier=composite，**不透明**，会带上底层内容）。",
      "按 regions 导出：给设计稿坐标的矩形，直接裁画板合成图。",
      "objectIds 与 regions 二选一，必须传其中一个。",
      "重要：composite 结果会带上被遮挡的底层内容，不能当作透明素材使用；",
      "返回体的 opaque 字段会标出来，warnings 里也会提示。",
      "导出结果同样写入 codesign-manifest.json / .csv。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      screenName: z
        .string()
        .min(1)
        .optional()
        .describe("按画板名精确匹配，省去先调 design_get 查 screenId 的一步（多画板时很有用）。"),
      outDir: outDirSchema,
      objectIds: z
        .array(z.string().min(1))
        .optional()
        .describe("要导出的图层 objectId 列表（design_get 返回的 objectId 字段）。"),
      regions: z
        .array(
          z.object({
            name: z.string().optional().describe("输出文件名用的名字"),
            objectId: z.string().optional().describe("关联的图层 objectId，便于清单对齐"),
            x: z.number().describe("左边界，设计稿坐标"),
            y: z.number().describe("上边界，设计稿坐标"),
            width: z.number().positive().describe("宽度，设计稿像素"),
            height: z.number().positive().describe("高度，设计稿像素"),
          }),
        )
        .optional()
        .describe("要导出的矩形区域列表，坐标为设计稿原始像素（不是 CSS 缩放后的值）。"),
      scale: scaleSchema,
      cssScale: cssScaleSchema,
      targetWidth: z.number().positive().optional().describe("目标像素宽，优先于倍率。"),
      format: formatSchema,
      quality: qualitySchema,
    },
  },
  async (args) => run(() => handleExport(args)),
);

server.registerTool(
  "design_get_spec",
  {
    title: "生成 CSS 还原规格",
    description: [
      "把设计稿图层树转换成前端可直接使用的还原规格：",
      "每个元素的 CSS 盒子（已换算成目标宽度）、font-size/color/letter-spacing/border-radius 等样式、",
      "字体清单、切图位置表。默认按 750 设计稿转 375 CSS 宽。",
    ].join(""),
    inputSchema: {
      url: urlSchema,
      password: passwordSchema,
      screenId: screenIdSchema,
      cssWidth: z
        .number()
        .positive()
        .max(4096)
        .optional()
        .describe("目标 CSS 宽度，默认 375；传 750 则输出设计稿原始 px"),
      maxLayers: z
        .number()
        .int()
        .positive()
        .max(20000)
        .optional()
        .describe("最多输出多少图层，默认 500；超出会截断并在 notes 里说明"),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .max(50)
        .optional()
        .describe("最多下钻几层图层，默认不限"),
      scale: scaleSchema,
      cssScale: cssScaleSchema,
      format: z
        .enum(["png", "jpg", "webp"])
        .optional()
        .describe("切图输出格式，同样要与 design_download_slices 保持一致。"),
    },
  },
  async (args) => run(() => handleGetSpec(args)),
);

/**
 * 把工具参数换算成倍率语义。
 * 都不传就是 native（取原图不重采样）；同时传两个则报错，避免歧义。
 */
function resolveScale(args: { scale?: number; cssScale?: number }): ScaleSpec {
  if (args.scale !== undefined && args.cssScale !== undefined) {
    throw new CoDesignError(
      "scale 与 cssScale 不能同时传",
      undefined,
      [
        "两者的基准不同：",
        "  scale    相对设计稿（750 宽），scale:2 → 落盘 1500px",
        "  cssScale 相对 CSS（375 宽），cssScale:2 → 落盘 750px（即前端常说的 2 倍图）",
        "只传其中一个；都不传则取图层原图、不重采样。",
      ].join("\n"),
    );
  }
  if (args.cssScale !== undefined) return { kind: "css", scale: args.cssScale };
  if (args.scale !== undefined) return { kind: "design", scale: args.scale };
  return NATIVE_SCALE;
}

/** 统一的执行包装：错误翻译成给 AI 看的提示 */
async function run(handler: () => Promise<ReturnType<typeof jsonResult>>) {
  try {
    return await handler();
  } catch (e) {
    return errorResult(formatError(e));
  }
}

/**
 * 解析链接并加载设计稿信息。
 * 支持两种链接：
 * - 分享链接 /app/s/<分享ID>：走公开分享接口
 * - 后台链接 /app/design/<设计ID>/board：直接用 Cookie 调后台接口
 */
async function loadShare(url: string, password?: string) {
  const designId = parseDesignId(url);
  if (designId !== undefined) {
    return client.getShareByDesignId(designId);
  }
  return client.getShare(parseShareId(url), password);
}

async function handleDesignGet(args: {
  url: string;
  password?: string;
  screenId?: number;
  screenName?: string;
  includeLayers?: boolean;
  maxLayers?: number;
  maxDepth?: number;
  view?: LayerView;
  fields?: string[];
  subtreeId?: string;
  types?: string[];
  offset?: number;
  limit?: number;
  includeBitmapLayers?: boolean;
  allScreens?: boolean;
}) {
  const share = await loadShare(args.url, args.password);
  const includeLayers = args.includeLayers !== false;

  // 未指定画板时默认只处理第一块：整份设计稿全部画板实测有 240KB+，
  // 一次塞满上下文反而没法用。需要全量时显式传 allScreens。
  const explicitId = resolveScreenId(share, args.screenId, args.screenName) ?? parseScreenId(args.url);
  const screenId = explicitId ?? (args.allScreens ? undefined : pickFirstScreen(share));

  // 带上切图清单：位图图层本身没有矢量信息，只能靠切图还原，
  // 必须让 AI 知道哪些图层有切图可用
  const targets = await resolveScreens(client, share, screenId, {
    meta: includeLayers,
    slices: includeLayers,
    concurrency: CONCURRENCY,
  });

  const payload: any = {
    share: {
      id: share.id,
      title: share.title,
      team: share.teamName,
      permissions: share.permissions,
    },
    screens: [] as any[],
  };

  // 警示信息可能同时来自截断、位图和缺少 Cookie 三处，统一收集避免后写的覆盖先写的
  const warnings: string[] = [];

  for (const t of targets) {
    const entry: any = {
      id: t.detail.id,
      name: t.detail.name,
      size: `${t.detail.width}×${t.detail.height}`,
      preview: t.detail.previewUrl,
      sliceCount: t.detail.slicesCount,
    };
    // 接口的 slices_count 不可信（实测给 0 但实际有 13 条），如实标出原始值
    if (t.detail.slicesCountReported !== undefined && t.detail.slicesCountReported !== t.detail.slicesCount) {
      entry.sliceCountReported = t.detail.slicesCountReported;
    }

    if (includeLayers && t.tree) {
      // 把切图信息挂到对应图层上，bitmap 图层才能被还原
      const withSlices = assignRefs(attachSlices(t.tree.layers, t.slices ?? []));
      const limited =
        args.maxDepth !== undefined || args.maxLayers !== undefined
          ? limitTree(withSlices, args.maxLayers ?? 800, args.maxDepth ?? Infinity).layers
          : withSlices;

      const view = args.view ?? "summary";
      const projected = projectLayers(limited, {
        view,
        fields: args.fields,
        subtreeId: args.subtreeId,
        types: args.types,
        offset: args.offset,
        limit: args.limit,
      });
      entry.layers = projected.tree ?? projected.layers;
      entry.layerCount = countLayers(withSlices);
      if (projected.filtered > 0) entry.filtered = projected.filtered;
      if (projected.paging.total > projected.layers.length || projected.paging.offset > 0) {
        entry.paging = projected.paging;
      }

      // 统计无法矢量还原、也没有切图的图层，完整列出而不是只举例。
      // 指定了 subtreeId 时只统计该子树，否则整棵树的几十上百条会把省下来的体积又吐回去。
      const missing =
        args.includeBitmapLayers === false
          ? []
          : collectUnreconstructable(limited, args.subtreeId);
      if (missing.length) {
        entry.unreconstructable = missing;
        entry.unreconstructableCount = missing.length;
        entry.unreconstructableHint =
          "这些图层是位图且没有切图。可用 design_export(objectIds) 从合成图裁剪（结果不透明），" +
          "或请设计同学在 CoDesign 里补切图。";
      }
    }
    payload.screens.push(entry);
  }

  // 权限字段与实际不符时提醒：实测 assetsDownloadable=false 但切图全部可下载
  const totalSlices = targets.reduce((n, t) => n + t.detail.slicesCount, 0);
  if (share.permissions.assetsDownloadable === false && totalSlices > 0) {
    warnings.push(
      `permissions.assetsDownloadable 为 false，但实测该设计稿有 ${totalSlices} 个切图可正常下载——` +
        "这个字段不可信，请直接调用 design_download_slices 或 design_export 尝试。",
    );
  }

  // 未配 Cookie 时上面的信息本来就是残缺的，这条放最后但仍保留其余提示
  if (!client.hasCookie) {
    warnings.push("未配置 COOKIE，只返回了基础信息。要读取图层标注和切图，请设置环境变量 CODESIGN_COOKIE。");
  }

  if (warnings.length) payload.warning = warnings.join("\n");

  return jsonResult(payload);
}

async function handleDownloadSlices(args: {
  url: string;
  password?: string;
  screenId?: number;
  outDir?: string;
  scale?: number;
  cssScale?: number;
  targetWidth?: number;
  format?: ExportFormat;
  quality?: number;
}) {
  const scaleSpec = resolveScale(args);
  const share = await loadShare(args.url, args.password);
  const targets = await resolveScreens(client, share, args.screenId ?? parseScreenId(args.url), {
    slices: true,
    meta: true,
    concurrency: CONCURRENCY,
  });

  const outDir = args.outDir || DEFAULT_OUT;
  const results: any[] = [];
  // 全局共享命名器：多画板时才不会互相覆盖同名文件
  const namer = createNamer();
  const manifestEntries: ManifestEntry[] = [];

  for (const t of targets) {
    // 多画板时每个画板一个子目录，目录内各自去重
    const dir = targets.length > 1 ? `${outDir}/${sanitize(t.detail.name)}` : outDir;
    const downloaded = await downloadSlices(client, t.slices ?? [], dir, {
      scale: scaleSpec,
      targetWidth: args.targetWidth,
      format: args.format,
      quality: args.quality,
      concurrency: CONCURRENCY * 2,
      namer,
      layers: t.tree?.layers,
    });
    results.push({ screen: t.detail.name, dir, files: downloaded });

    // 清单以 ref + objectId 为主键，文件名只是落盘结果
    manifestEntries.push(...toManifestEntries(downloaded, { id: t.detail.id, name: t.detail.name }));
  }

  const total = results.reduce((n, r) => n + r.files.filter((f: any) => f.ok).length, 0);
  const failed = results.reduce((n, r) => n + r.files.filter((f: any) => !f.ok).length, 0);

  // 汇总倍率：区分「重采样对齐」与「就近取档」两种情况
  const requestedScale = scaleSpec.kind === "native" ? "native" : scaleSpec.scale;
  const scaleUsage: Record<string, number> = {};
  const substituted: { name: string; scale: number }[] = [];
  const resampled: { name: string; from: number; to: number }[] = [];
  for (const r of results) {
    for (const f of r.files) {
      if (f.scale === undefined) continue;
      scaleUsage[String(f.scale)] = (scaleUsage[String(f.scale)] ?? 0) + 1;
      if (f.substituted) substituted.push({ name: f.name, scale: f.scale });
      if (f.resampled && f.sourceScale !== f.targetScale) {
        resampled.push({ name: f.name, from: f.sourceScale, to: f.targetScale });
      }
    }
  }

  const manifest = await writeManifest(outDir, {
    meta: {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      outDir,
      targetScale: scaleSpec.kind === "native" ? 0 : scaleSpec.scale,
      total: manifestEntries.length,
    },
    entries: manifestEntries,
  });

  const summary = summarize(manifestEntries);
  const warnings: string[] = [];
  if (substituted.length) {
    warnings.push(
      `以下 ${substituted.length} 张切图在设计稿里没有 ${requestedScale} 倍导出，已就近取档：\n` +
        substituted.map((s) => `  ${s.name} → ${s.scale}x`).join("\n"),
    );
  }
  if (resampled.length) {
    warnings.push(
      `以下 ${resampled.length} 张切图已由服务端重采样到 ${requestedScale}x，落盘尺寸按目标倍率对齐：\n` +
        resampled.map((s) => `  ${s.name}: ${s.from}x → ${s.to}x`).join("\n"),
    );
  }

  const payload: any = {
    outDir,
    requestedScale,
    format: args.format ?? "png",
    total,
    failed,
    scaleUsage,
    bytes: summary.bytes,
    manifest: {
      path: manifest.path,
      csvPath: manifest.csvPath,
      total: manifestEntries.length,
      // 清单可能比返回体更适合批量核对，这里只给前若干条概览
      preview: manifestEntries.slice(0, 50),
      truncated: manifestEntries.length > 50 || undefined,
    },
    screens: results,
  };
  if (warnings.length) payload.warning = warnings.join("\n");

  return jsonResult(payload);
}

async function handleDownloadPreviews(args: {
  url: string;
  password?: string;
  screenId?: number;
  outDir?: string;
  scale?: number;
  targetWidth?: number;
}) {
  const share = await loadShare(args.url, args.password);
  // 预览只需要画板详情，不必拉图层树和切图清单
  const targets = await resolveScreens(client, share, args.screenId ?? parseScreenId(args.url), {
    concurrency: CONCURRENCY,
  });

  const outDir = args.outDir || DEFAULT_OUT;
  const files = await downloadPreviews(client, targets, outDir, {
    concurrency: CONCURRENCY,
    scale: resolveScale(args),
    targetWidth: args.targetWidth,
  });
  const failed = files.filter((f) => !f.ok).length;
  return jsonResult({ outDir, total: files.length - failed, failed, files });
}

/** 按图层 / 区域导出，是「位图且没有切图」图层的兜底 */
async function handleExport(args: {
  url: string;
  password?: string;
  screenId?: number;
  screenName?: string;
  outDir?: string;
  objectIds?: string[];
  regions?: RegionRequest[];
  scale?: number;
  cssScale?: number;
  targetWidth?: number;
  format?: ExportFormat;
  quality?: number;
}) {
  const hasLayers = Boolean(args.objectIds?.length);
  const hasRegions = Boolean(args.regions?.length);
  if (!hasLayers && !hasRegions) {
    throw new CoDesignError("需要指定要导出的内容", undefined, [
      "objectIds 与 regions 二选一：",
      "  objectIds: [\"12\", \"46\"]   按图层导出（有切图拿切图，没有则裁合成图）",
      "  regions: [{ x: 0, y: 0, width: 750, height: 1141 }]   按区域导出",
      "图层 objectId 可用 design_get 拿到。",
    ].join("\n"));
  }
  if (hasLayers && hasRegions) {
    throw new CoDesignError("objectIds 与 regions 不能同时传", undefined, "请分两次调用，或用其中一种方式。");
  }

  const share = await loadShare(args.url, args.password);
  const scaleSpec = resolveScale(args);
  const screenId = resolveScreenId(share, args.screenId, args.screenName) ?? parseScreenId(args.url);
  const targets = await resolveScreens(client, share, screenId, {
    meta: true,
    slices: true,
    concurrency: CONCURRENCY,
  });

  const outDir = args.outDir || DEFAULT_OUT;
  const namer = createNamer();
  const results: any[] = [];
  const manifestEntries: ManifestEntry[] = [];
  const warnings: string[] = [];

  for (const t of targets) {
    const dir = targets.length > 1 ? `${outDir}/${sanitize(t.detail.name)}` : outDir;
    await mkdir(dir, { recursive: true });

    const plans = hasLayers
      ? planLayerExports(args.objectIds!, t.tree?.layers ?? [], t.slices ?? [], t.detail, {
          scale: scaleSpec,
          targetWidth: args.targetWidth,
          format: args.format,
          quality: args.quality,
          namer,
        })
      : planRegionExports(args.regions!, t.detail, {
          scale: scaleSpec,
          targetWidth: args.targetWidth,
          format: args.format,
          quality: args.quality,
          namer,
        });

    const files = await mapLimit(plans, CONCURRENCY, async (plan) => {
      if (plan.tier === "fail" || !plan.downloadUrl) {
        return {
          name: plan.name,
          path: "",
          ref: plan.ref,
          objectId: plan.objectId,
          rect: plan.rect,
          z: plan.z,
          format: plan.format,
          tier: plan.tier,
          opaque: plan.opaque || undefined,
          width: 0,
          height: 0,
          bytes: 0,
          ok: false,
          error: plan.reason ?? "导出失败",
        };
      }
      try {
        const buf = await client.downloadImage(plan.downloadUrl);
        await writeFile(join(dir, plan.file), buf);
        return {
          name: plan.name,
          path: plan.file,
          ref: plan.ref,
          objectId: plan.objectId,
          rect: plan.rect,
          z: plan.z,
          format: plan.format,
          tier: plan.tier,
          opaque: plan.opaque || undefined,
          exportScale: plan.exportScale,
          targetScale: plan.targetScale,
          resampled: plan.resampled || undefined,
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
          opaque: plan.opaque || undefined,
          width: plan.width,
          height: plan.height,
          bytes: 0,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    });

    results.push({ screen: t.detail.name, dir, files });
    manifestEntries.push(...toManifestEntries(files as any, { id: t.detail.id, name: t.detail.name }));

    const composite = (files as any[]).filter((f) => f.tier === "composite" && f.ok);
    if (composite.length) {
      warnings.push(
        `${t.detail.name}：${composite.length} 个图层没有切图，已从合成图裁剪（tier=composite）。` +
          "这些图**不透明**，会带上被遮挡的底层内容，不能当透明素材用。",
      );
    }
  }

  const allFiles = results.flatMap((r) => r.files);
  const failed = allFiles.filter((f) => !f.ok).length;
  const manifest = await writeManifest(outDir, {
    meta: {
      version: VERSION,
      generatedAt: new Date().toISOString(),
      outDir,
      targetScale: scaleSpec.kind === "native" ? 0 : scaleSpec.scale,
      total: manifestEntries.length,
    },
    entries: manifestEntries,
  });

  return jsonResult({
    outDir,
    total: allFiles.length - failed,
    failed,
    byTier: summarizeTiers(
      allFiles.map((f) => ({ tier: f.tier })) as any,
    ),
    bytes: summarize(manifestEntries).bytes,
    manifest: {
      path: manifest.path,
      csvPath: manifest.csvPath,
      total: manifestEntries.length,
      preview: manifestEntries.slice(0, 50),
      truncated: manifestEntries.length > 50 || undefined,
    },
    screens: results,
    ...(warnings.length ? { warnings } : {}),
  });
}

/** 按画板名定位；没有同名画板时把可选项列出来 */
function resolveScreenId(
  share: ShareInfo,
  screenId?: number,
  screenName?: string,
): number | undefined {
  if (screenId || !screenName) return screenId;
  const all = listScreens(share);
  const hit = all.find((s) => s.name === screenName);
  if (hit) return hit.id;
  throw new CoDesignError(
    `没有名为「${screenName}」的画板`,
    undefined,
    "可用画板：\n" + all.map((s) => `  ${s.id}  ${s.name}`).join("\n"),
  );
}

async function handleGetSpec(args: {
  url: string;
  password?: string;
  screenId?: number;
  cssWidth?: number;
  maxLayers?: number;
  maxDepth?: number;
  scale?: number;
  cssScale?: number;
  format?: ExportFormat;
}) {
  const share = await loadShare(args.url, args.password);
  const explicit = args.screenId ?? parseScreenId(args.url);
  // 未指定画板时只输出第一个。必须先挑再拉，否则会把每个画板的图层树和切图清单都下载一遍再丢掉
  const picked = explicit ? undefined : pickFirstScreen(share);
  const targets = await resolveScreens(client, share, explicit ?? picked, {
    meta: true,
    slices: true,
    concurrency: CONCURRENCY,
  });

  // 规格与下载共用同一套命名规则，保证 file 字段和实际落盘一致
  const namer = createNamer();
  const specs = targets.map((t) => {
    // 关联切图，位图图层才能知道「有切图可用」而不是「信息缺失」
    const linked = { ...t.tree!, layers: attachSlices(t.tree!.layers, t.slices ?? []) };
    return buildSpec(t.detail, linked, t.slices ?? [], {
      cssWidth: args.cssWidth,
      maxLayers: args.maxLayers,
      maxDepth: args.maxDepth,
      scale: resolveScale(args),
      format: args.format,
      namer,
    });
  });
  return jsonResult({
    title: share.title,
    count: specs.length,
    totalScreens: countScreens(share),
    ...(explicit ? {} : { screenIds: listScreens(share) }),
    specs,
  });
}

/** 全部画板的 id/name，供调用方决定下一步指定哪个 */
function listScreens(share: ShareInfo) {
  return share.designs.flatMap((d) => d.screens).map((s) => ({ id: s.id, name: s.name }));
}

function countScreens(share: ShareInfo): number {
  return share.designs.reduce((n, d) => n + d.screens.length, 0);
}

/** 取第一个画板的 id，用于「未指定画板」时只处理单块 */
function pickFirstScreen(share: ShareInfo): number | undefined {
  return listScreens(share)[0]?.id;
}

/** 统计整棵树的图层数（含隐藏层），用于告知调用方实际规模 */
function countLayers(layers: Layer[]): number {
  return layers.reduce((n, l) => n + 1 + (l.children?.length ? countLayers(l.children) : 0), 0);
}

/**
 * 按数量上限和深度上限裁剪图层树。
 * 返回的是正常图层对象（子树按需截断），不是扁平的，方便 AI 直接读结构。
 */
function limitTree(
  layers: Layer[],
  maxLayers: number,
  maxDepth: number,
  depth = 0,
  state = { count: 0, truncated: false },
): { layers: Layer[]; truncated: boolean; returned: number } {
  const out: Layer[] = [];
  for (const l of layers) {
    if (state.count >= maxLayers) {
      state.truncated = true;
      break;
    }
    state.count++;
    if (depth < maxDepth && l.children?.length) {
      const childLimit = limitTree(l.children, maxLayers, maxDepth, depth + 1, state);
      const { children, ...rest } = l;
      out.push({ ...rest, children: childLimit.layers });
    } else {
      if (l.children?.length) state.truncated = true;
      const { children, ...rest } = l;
      out.push(rest);
    }
  }
  return { layers: out, truncated: state.truncated, returned: state.count };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "screen";
}

function formatError(e: unknown): string {
  if (isCoDesignError(e)) {
    const lines = [`❌ ${e.message}`];
    if (e.hint) lines.push("", e.hint);
    return lines.join("\n");
  }
  return `❌ ${e instanceof Error ? e.message : String(e)}`;
}

/** 超过这个体积就不再缩进输出——缩进对机器消费无意义，纯占上下文 */
const PRETTY_LIMIT = 8000;

/**
 * 结果统一序列化成 JSON 文本。
 * 小结果保留缩进便于人和模型扫读；大结果压缩成单行，
 * 实测 800 图层的 payload 缩进版 484KB、单行 200KB，省掉 59%。
 */
function jsonResult(obj: unknown) {
  const pretty = JSON.stringify(obj, null, 2);
  const text = pretty.length > PRETTY_LIMIT ? JSON.stringify(obj) : pretty;
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const transport = new StdioServerTransport();
await server.connect(transport);
