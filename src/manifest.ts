import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DownloadResult, LayerRect } from "./types.js";

/**
 * 切图清单一行的内容。
 *
 * 用户反馈的核心痛点：同名图层只能靠 `_2` / `_3` 后缀猜对应关系，
 * 中文名在 PowerShell / URL 里又是编码雷区。所以清单以 `ref` 和 `objectId` 为主键，
 * 文件名只是落盘结果。
 */
export interface ManifestEntry {
  /** 本次结果内的稳定短标识（s1、s2…），对话里引用它最省事 */
  ref: string;
  objectId: string;
  layerName: string;
  screenId?: number;
  screenName?: string;
  /** slice=图层自带切图（透明）；composite=从合成图裁剪（不透明） */
  tier: "slice" | "composite";
  /** 相对 outDir 的落盘路径 */
  file: string;
  /** 设计稿坐标 */
  x: number;
  y: number;
  width: number;
  height: number;
  z?: number;
  format: string;
  exportScale: number;
  targetScale: number;
  resampled: boolean;
  /** 实际落盘像素尺寸 */
  actualWidth?: number;
  actualHeight?: number;
  bytes: number;
  ok: boolean;
  error?: string;
}

export interface ManifestMeta {
  version: string;
  generatedAt: string;
  outDir: string;
  /** 本次请求的目标倍率，便于核对 */
  targetScale: number;
  total: number;
}

export interface ManifestFile {
  meta: ManifestMeta;
  entries: ManifestEntry[];
}

/** 清单固定文件名，多次下载会覆盖成最新一份，避免目录里堆一堆 */
export const MANIFEST_JSON = "codesign-manifest.json";
export const MANIFEST_CSV = "codesign-manifest.csv";

/** 把下载结果转成清单行；下载结果自身已带齐规划信息 */
export function toManifestEntries(
  results: DownloadResult[],
  screen?: { id: number; name: string },
): ManifestEntry[] {
  return results.map((r) => {
    const rect = r.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      ref: r.ref ?? "",
      objectId: r.objectId ?? "",
      layerName: r.name,
      screenId: screen?.id,
      screenName: screen?.name,
      tier: r.tier ?? "slice",
      file: r.path,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      z: r.z,
      format: r.format ?? "png",
      exportScale: r.exportScale ?? r.scale ?? 1,
      targetScale: r.targetScale ?? r.scale ?? 1,
      resampled: Boolean(r.resampled),
      actualWidth: r.width,
      actualHeight: r.height,
      bytes: r.bytes,
      ok: r.ok,
      ...(r.error ? { error: r.error } : {}),
    };
  });
}

/** CSV 表头顺序固定，方便下游按列解析 */
const CSV_COLUMNS: (keyof ManifestEntry)[] = [
  "ref",
  "objectId",
  "layerName",
  "screenId",
  "screenName",
  "tier",
  "file",
  "x",
  "y",
  "width",
  "height",
  "z",
  "format",
  "exportScale",
  "targetScale",
  "resampled",
  "actualWidth",
  "actualHeight",
  "bytes",
  "ok",
  "error",
];

/**
 * 写 manifest.json（UTF-8）与 manifest.csv。
 *
 * CSV 带 UTF-8 BOM：Excel 和 PowerShell 的 `Import-Csv` 默认按系统代码页读，
 * 没有 BOM 时中文图层名会变成乱码——这正是用户反馈里的实际痛点。
 */
export async function writeManifest(outDir: string, file: ManifestFile): Promise<{ path: string; csvPath: string }> {
  const jsonPath = join(outDir, MANIFEST_JSON);
  const csvPath = join(outDir, MANIFEST_CSV);
  await writeFile(jsonPath, JSON.stringify(file, null, 2), "utf8");
  await writeFile(csvPath, "﻿" + toCsv(file.entries), "utf8");
  return { path: jsonPath, csvPath };
}

/** 生成 CSV 文本（不含 BOM） */
export function toCsv(entries: ManifestEntry[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = entries.map((e) => CSV_COLUMNS.map((c) => csvCell(e[c])).join(","));
  return [header, ...rows].join("\r\n") + "\r\n";
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹并把内部引号翻倍 */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (!/[",\r\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** 汇总信息：按来源层级、按是否重采样分类，便于调用方一眼看出问题 */
export function summarize(entries: ManifestEntry[]) {
  const byTier = { slice: 0, composite: 0 };
  let failed = 0;
  let resampled = 0;
  let bytes = 0;
  for (const e of entries) {
    byTier[e.tier]++;
    if (!e.ok) failed++;
    if (e.resampled) resampled++;
    bytes += e.bytes;
  }
  return { total: entries.length, failed, resampled, bytes, byTier };
}

/** 把 ManifestEntry 里的矩形取出来，便于下游直接用 */
export function entryRect(e: ManifestEntry): LayerRect {
  return { x: e.x, y: e.y, width: e.width, height: e.height };
}
