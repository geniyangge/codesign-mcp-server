import type { Layer, LayerRect, LayerSlice } from "./types.js";

/**
 * 图层输出的分级视图。
 *
 * 用户反馈的痛点：86 个图层返回 197KB 被截断，每层都带 css/fills/borders/images，
 * 没有字段投影、没有按子树取、没有紧凑模式，最后被迫放弃这个接口改用 get_spec。
 *
 * 所以默认只给 `summary`：定位图层所需的标识、类型、坐标、层叠顺序就够写代码了，
 * 样式细节按需用 `flat` 或 `fields` 取。
 */
export type LayerView = "summary" | "flat" | "tree";

export interface ViewOptions {
  view?: LayerView;
  /** 字段投影，只保留指定字段（在视图预设之上再收窄） */
  fields?: string[];
  /** 只取某个 objectId 的子树 */
  subtreeId?: string;
  /** 按图层类型过滤（text / shape / group …） */
  types?: string[];
  /** 是否在 unreconstructable 里包含位图图层 */
  includeBitmapLayers?: boolean;
  offset?: number;
  limit?: number;
}

/** summary 视图包含的字段 */
const SUMMARY_KEYS = ["ref", "objectId", "parentId", "depth", "name", "type", "z", "rect", "flags"] as const;

/** flat 视图在 summary 基础上额外给出的字段 */
const FLAT_EXTRA_KEYS = ["opacity", "radius", "fills", "borders", "css", "text", "effects", "images", "slice", "blendMode", "rotation"] as const;

export interface ProjectedLayer {
  [key: string]: unknown;
}

export interface ProjectResult {
  layers: ProjectedLayer[];
  /** tree 视图时为嵌套结构；扁平视图时与 layers 相同 */
  tree?: ProjectedLayer[];
  paging: { offset: number; limit: number; total: number; hasMore: boolean };
  /** 因为类型/子树过滤被排除的数量 */
  filtered: number;
}

/**
 * 把图层树投影成调用方要的形状。
 *
 * 层级**不再用缩进空格编码在 name 里**——那样按名字匹配和去重都不可靠，
 * 改为独立的 `depth` 与 `parentId` 字段。
 */
export function projectLayers(layers: Layer[], opts: ViewOptions = {}): ProjectResult {
  const view = opts.view ?? "summary";
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? (view === "tree" ? 500 : 200));

  // 先定位子树
  const scoped = opts.subtreeId ? findSubtree(layers, opts.subtreeId) : layers;
  if (!scoped) {
    return {
      layers: [],
      tree: [],
      paging: { offset, limit, total: 0, hasMore: false },
      filtered: 0,
    };
  }

  const flat = flattenWithMeta(scoped);
  const byType = opts.types?.length
    ? flat.filter(({ layer }) => opts.types!.includes(layer.type))
    : flat;
  const filtered = flat.length - byType.length;

  // tree 视图分页前要保持在层级结构里，按整树裁剪更合理
  if (view === "tree") {
    const total = byType.length;
    const pageIds = new Set(byType.slice(offset, offset + limit).map(({ layer }) => layer.objectId));
    const treeTotal = countTree(scoped, opts.types);
    const pageIdsForTree = new Set(
      byType.slice(0, offset + limit).map(({ layer }) => layer.objectId),
    );
    const pruned = pruneTree(scoped, pageIdsForTree, offset === 0 ? undefined : new Set(byType.slice(0, offset).map(({ layer }) => layer.objectId)), opts.types);
    return {
      layers: byType.slice(offset, offset + limit).map(({ layer, depth }) => toSummary(layer, depth, opts)),
      tree: pruned,
      paging: { offset, limit, total: treeTotal, hasMore: offset + limit < treeTotal },
      filtered,
    };
  }

  const total = byType.length;
  const page = byType.slice(offset, offset + limit);
  return {
    layers: page.map(({ layer, depth }) => project(layer, depth, view, opts)),
    paging: { offset, limit, total, hasMore: offset + limit < total },
    filtered,
  };
}

/** 按视图与字段投影单层 */
function project(layer: Layer, depth: number, view: LayerView, opts: ViewOptions): ProjectedLayer {
  const base = toSummary(layer, depth, opts);
  if (view === "summary") return pickKeys(base, opts.fields);

  const full: ProjectedLayer = { ...base };
  for (const key of FLAT_EXTRA_KEYS) {
    const v = (layer as any)[key];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) full[key] = v;
  }
  if (layer.text) full.textContent = layer.text.content;
  return pickKeys(full, opts.fields);
}

/** summary 层的字段 */
function toSummary(layer: Layer, depth: number, opts: ViewOptions): ProjectedLayer {
  const out: ProjectedLayer = {
    ref: layer.ref,
    objectId: layer.objectId,
    depth,
    name: layer.name,
    type: layer.type,
    rect: rectOf(layer),
  };
  if (layer.parentId) out.parentId = layer.parentId;
  if (layer.z !== undefined) out.z = layer.z;
  const flags = layerFlags(layer);
  if (flags.length) out.flags = flags;
  // 低可信盒子附带推定框，避免调用方直接拿 rect 布局踩坑
  if (layer.rectConfidence === "low") {
    out.rectConfidence = "low";
    if (layer.sliceRect) out.sliceRect = layer.sliceRect;
  }
  return out;
}

/** 层标记，替代原先靠 css/notes 推断的做法 */
function layerFlags(layer: Layer): string[] {
  const out: string[] = [];
  if (!layer.visible) out.push("hidden");
  if (layer.type === "text") out.push("text");
  if (layer.isBitmap) out.push(layer.slice ? "bitmap:slice" : "bitmap:no-slice");
  else if (layer.slice) out.push("slice");
  if (layer.isVector) out.push("vector");
  if (layer.children?.length) out.push("group");
  return out;
}

/** 图层盒子：低可信时优先给 sliceRect */
function rectOf(layer: Layer): LayerRect {
  if (layer.rectConfidence === "low" && layer.sliceRect) return layer.sliceRect;
  return { x: layer.rect.x, y: layer.rect.y, width: layer.rect.width, height: layer.rect.height };
}

/** 按 fields 投影；未指定时原样返回 */
function pickKeys(obj: ProjectedLayer, fields?: string[]): ProjectedLayer {
  if (!fields?.length) return obj;
  const out: ProjectedLayer = {};
  for (const k of fields) {
    if (k in obj) out[k] = obj[k];
  }
  // ref/objectId 是定位用的，永远保留，否则投影后无法回指
  if (obj.objectId !== undefined && out.objectId === undefined) out.objectId = obj.objectId;
  return out;
}

interface FlatEntry {
  layer: Layer;
  depth: number;
  parentId?: string;
}

/** 深度优先摊平，带层级与父节点 */
export function flattenWithMeta(layers: Layer[], depth = 0, parentId?: string, out: FlatEntry[] = []): FlatEntry[] {
  for (const l of layers) {
    out.push({ layer: l, depth, parentId: parentId ?? l.parentId });
    if (l.children?.length) flattenWithMeta(l.children, depth + 1, l.objectId, out);
  }
  return out;
}

/** 找到某个 objectId 的子树（返回包含它自身的那一层数组） */
function findSubtree(layers: Layer[], objectId: string): Layer[] | undefined {
  for (const l of layers) {
    if (String(l.objectId) === String(objectId)) return [l];
    if (l.children?.length) {
      const hit = findSubtree(l.children, objectId);
      if (hit) return hit;
    }
  }
  return undefined;
}

function countTree(layers: Layer[], types?: string[]): number {
  return flattenWithMeta(layers).filter(({ layer }) => !types?.length || types.includes(layer.type)).length;
}

/**
 * tree 视图的分页：保留能到目标节点的路径。
 * 简单做法是按「已取到的 id 集合」剪枝——父节点保留但只带命中的子节点。
 */
function pruneTree(layers: Layer[], keep: Set<string>, exclude: Set<string> | undefined, types?: string[]): ProjectedLayer[] {
  const out: ProjectedLayer[] = [];
  for (const l of layers) {
    if (exclude?.has(l.objectId)) continue;
    if (types?.length && !types.includes(l.type)) continue;
    if (!keep.has(l.objectId) && !hasKeptDescendant(l, keep)) continue;
    const node = toSummary(l, 0, {});
    if (l.children?.length) {
      const kids = pruneTree(l.children, keep, exclude, types);
      if (kids.length) node.children = kids;
    }
    out.push(node);
  }
  return out;
}

function hasKeptDescendant(layer: Layer, keep: Set<string>): boolean {
  if (!layer.children?.length) return false;
  for (const c of layer.children) {
    if (keep.has(c.objectId) || hasKeptDescendant(c, keep)) return true;
  }
  return false;
}

/**
 * 找出「位图且没有切图」的图层，按原因分类。
 *
 * 用户反馈：notes 只举例列了 5 个，实际有 42 个。批量处理需要完整结构化列表，
 * 所以这里给全量，并由调用方决定是否需要分页。
 */
export function collectUnreconstructable(layers: Layer[], subtreeId?: string): {
  objectId: string;
  name: string;
  type: string;
  rect: LayerRect;
  z?: number;
  reason: string;
  /** 可用的兜底导出方式 */
  fallback: string;
  /** 建议的导出区域，可直接粘进 design_export 的 regions */
  suggestedRegion?: { objectId: string; x: number; y: number; width: number; height: number };
}[] {
  const out: ReturnType<typeof collectUnreconstructable> = [];
  const scope = subtreeId ? findSubtree(layers, subtreeId) : layers;
  if (!scope) return out;
  for (const { layer } of flattenWithMeta(scope)) {
    if (!layer.isBitmap || layer.slice || !layer.visible) continue;
    const box = rectOf(layer);
    const usable = box.width > 0 && box.height > 0;
    out.push({
      objectId: layer.objectId,
      name: layer.name || layer.type,
      type: layer.type,
      rect: box,
      z: layer.z,
      reason: usable ? "位图图层，设计稿没有矢量信息也没有切图" : "位图图层，且盒子为空，无法定位",
      fallback: usable
        ? "design_export(objectIds) 会从合成图裁剪（不透明）；或 design_export(regions) 用下面的 suggestedRegion"
        : "盒子为空，只能请设计同学在 CoDesign 里补切图",
      // 坐标准备好，调用方不用自己从 rect 换算——这块坐标必须是设计稿原始像素，
      // 不是 CSS 缩放后的值，容易算错
      ...(usable
        ? {
            suggestedRegion: {
              objectId: layer.objectId,
              x: Math.round(box.x),
              y: Math.round(box.y),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
          }
        : {}),
    });
  }
  return out;
}

/** 给每层分配稳定的短标识，便于对话里引用 */
export function assignRefs(layers: Layer[]): Layer[] {
  let n = 0;
  const walk = (list: Layer[]): Layer[] =>
    list.map((l) => {
      const copy: Layer = { ...l, ref: `L${++n}` };
      if (l.children?.length) copy.children = walk(l.children);
      return copy;
    });
  return walk(layers);
}

/**
 * 按图层名匹配批量取 objectId。
 *
 * 用户反馈：只能传 objectIds[]，多图层时要手工从 design_get 里逐个抄 id 再拼数组。
 * 名字是中文且常带「拷贝 2」这类后缀，用正则比精确匹配实用。
 * 非法正则直接抛出可读错误，而不是静默返回空列表。
 */
export function matchLayersByName(
  layers: Layer[],
  pattern: string,
  opts: { types?: string[]; limit?: number } = {},
): { objectId: string; name: string; type: string; z?: number; rect: LayerRect; hasSlice: boolean }[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch (e) {
    throw new Error(`namePattern 不是合法的正则表达式：${pattern}（${e instanceof Error ? e.message : String(e)}）`);
  }

  const out: ReturnType<typeof matchLayersByName> = [];
  for (const { layer } of flattenWithMeta(layers)) {
    if (!layer.visible) continue;
    if (opts.types?.length && !opts.types.includes(layer.type)) continue;
    if (!re.test(layer.name || "")) continue;
    out.push({
      objectId: layer.objectId,
      name: layer.name || layer.type,
      type: layer.type,
      z: layer.z,
      rect: rectOf(layer),
      hasSlice: Boolean(layer.slice),
    });
  }
  // z 越大越靠上，按绘制顺序返回更符合直觉
  out.sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  return opts.limit && opts.limit > 0 ? out.slice(0, opts.limit) : out;
}
