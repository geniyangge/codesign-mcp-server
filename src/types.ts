export interface ScreenRef {
  id: number;
  name: string;
}

export interface DesignRef {
  id: number;
  name: string;
  viewport: string;
  screens: ScreenRef[];
}

export interface ShareInfo {
  id: number;
  title: string;
  teamName: string;
  permissions: {
    commentable: boolean;
    inspectable: boolean;
    assetsDownloadable: boolean;
  };
  designs: DesignRef[];
}

export interface ScreenDetail {
  id: number;
  name: string;
  width: number;
  height: number;
  designId: number;
  source: string;
  metaUrl?: string;
  slicesUrl?: string;
  previewUrl?: string;
  /** 全分辨率原图，按区域裁剪时的源（实测与 previewUrl 指向同一文件） */
  originalUrl?: string;
  /** 实际切图数，由切图清单长度覆盖 */
  slicesCount: number;
  /** 接口原样返回的 slices_count，可能不准（实测给 0 但实际有 13 条） */
  slicesCountReported?: number;
}

export interface LayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextStyle {
  fontName: string;
  fontStyleName: string;
  /** 渲染后的实际字号（已按设计稿缩放换算），不是排版原始值 */
  size: number;
  /** Photoshop 千分之一单位，换算 CSS 时 /1000 * size */
  tracking?: number;
  leading?: number;
  allCaps?: boolean;
  lineHeight?: number;
  letterSpacing?: number;
  color?: string;
  textAlign?: string;
  content?: string;
}

export interface LayerFill {
  type: string;
  color?: string;
  css?: string;
}

export interface LayerBorder extends LayerFill {
  /** 边框粗细 */
  width?: number;
  /** inside / outside / center */
  position?: string;
  style?: string;
}

/** 图层效果，`type` 为设计稿里的效果名（innerGlow / frameFX / dropShadow…） */
export interface LayerEffect {
  type: string;
  [key: string]: unknown;
}

/** 切图清单里的一条导出项（关联到图层时使用） */
export interface LayerSlice {
  /** 该图层的 object_id */
  objectId: string;
  /** 可用的导出倍率 */
  scales: number[];
  formats: string[];
  /** 导出图的像素尺寸，按倍率给出最高的一档 */
  exportWidth: number;
  exportHeight: number;
}

export interface Layer {
  id: string;
  /** CoDesign 的 object_id，切图清单里用它关联图层 */
  objectId: string;
  /** 本次结果内的稳定短标识（L1、L2…），对话里引用它比中文名省事 */
  ref?: string;
  /** 父图层 objectId，替代原先靠缩进空格推断层级的做法 */
  parentId?: string;
  name: string;
  type: string;
  rect: LayerRect;
  visible: boolean;
  /** 全局绘制顺序（源数据的 index），兄弟节点按它升序排列 */
  z?: number;
  /**
   * rect 的可信度。组图层经常返回整屏尺寸或 0×0，
   * 真实内容框要看切图项的 rect（见 sliceRect），据此降到 "low"。
   */
  rectConfidence?: "high" | "low";
  /** 从子图层并集或切图项校正后的盒子，rectConfidence 为 low 时才有 */
  sliceRect?: LayerRect;
  opacity?: number;
  fillOpacity?: number;
  /** 圆角，按 topLeft/topRight/bottomRight/bottomLeft 顺序 */
  radius?: number[];
  fills?: LayerFill[];
  borders?: LayerBorder[];
  /** 阴影/发光/描边等效果 */
  effects?: LayerEffect[];
  /** 设计稿自带的 CSS 片段，是最可靠的样式来源 */
  css?: string[];
  text?: TextStyle;
  images?: string[];
  clipped?: boolean;
  blendMode?: string;
  rotation?: number;
  /** 图层带矢量路径 */
  isVector?: boolean;
  /**
   * 位图图层：设计稿里是位图（智能对象/图片填充），没有矢量信息可还原。
   * 这类图层只能靠切图还原，`slice` 字段给出可下载的切图。
   */
  isBitmap?: boolean;
  /** 该图层在切图清单里的信息（仅当它被标记为切图时才有） */
  slice?: LayerSlice;
  children?: Layer[];
}

export interface LayerTree {
  name: string;
  width: number;
  height: number;
  /** 已经按 parent_id 重建成真正的嵌套树 */
  layers: Layer[];
}

export interface SliceExport {
  name: string;
  scale: number;
  format: string;
  width: number;
  height: number;
  downloadUrl: string;
  objectId: string;
}

export interface SliceItem {
  id: string;
  /** 该切图对应的图层 object_id，与 id 可能相同也可能不同 */
  objectId?: string;
  name: string;
  rect: LayerRect;
  exports: SliceExport[];
}

export interface DownloadResult {
  name: string;
  /** 相对 outDir 的路径，便于调用方定位 */
  path: string;
  /** 本次结果内的稳定短标识（s1、s2…），供调用方在对话里引用 */
  ref?: string;
  /** 对应图层的 object_id，与切图清单可对上 */
  objectId?: string;
  /** 设计稿坐标下的内容框 */
  rect?: LayerRect;
  /** 全局绘制顺序 */
  z?: number;
  /** 输出格式 */
  format?: string;
  /** 切图来源层级：slice=图层自带切图，composite=从合成图裁剪 */
  tier?: "slice" | "composite";
  /** 从合成图裁剪时不透明（会带上底层内容） */
  opaque?: boolean;
  /** 原始导出倍率 */
  exportScale?: number;
  /** 目标倍率；resampled 时即重采样后的实际倍率 */
  targetScale?: number;
  /** 图层没有目标倍率，已让服务端缩放对齐 */
  resampled?: boolean;
  /** 实际落盘尺寸 */
  actualWidth?: number;
  actualHeight?: number;
  /** 实际使用的导出倍率（默认 2x；该图层没有时会就近取） */
  scale?: number;
  /** 该图层没有请求的倍率，实际用了另一个倍率 */
  substituted?: boolean;
  width: number;
  height: number;
  bytes: number;
  ok: boolean;
  error?: string;
}

export interface SpecNode {
  name: string;
  type: string;
  objectId: string;
  box: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  style: string[];
  text?: string;
  /** 文本排版信息，便于直接落地（行高、对齐、断行位置） */
  typography?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: string;
    lineHeight?: number;
    letterSpacing?: number;
    textAlign?: string;
    /** 原始内容里的显式换行按行拆开，便于核对断行位置 */
    lines?: string[];
    /** 图层盒子高度与「行数 × 行高」的差值，用于判断垂直居中方式 */
    boxHeight?: number;
  };
}

export interface SpecResult {
  screen: string;
  size: { width: number; height: number };
  cssWidth: number;
  /** 设计稿宽度 -> 目标 CSS 宽度的缩放比 */
  scale: number;
  nodes: SpecNode[];
  slices: {
    name: string;
    objectId: string;
    left: number;
    top: number;
    width: number;
    height: number;
    /** 设计稿坐标下的原始像素宽高 */
    designWidth?: number;
    designHeight?: number;
    scale: number;
    /** 原始导出倍率 */
    exportScale?: number;
    targetScale?: number;
    /** 已按目标倍率重采样 */
    resampled?: boolean;
    /** 本次结果内的稳定短标识 */
    ref?: string;
    z?: number;
    /** 落盘像素尺寸 */
    pixelWidth?: number;
    pixelHeight?: number;
    file: string;
    style?: string[];
  }[];
  notes: string[];
  /** 图层被截断时的说明 */
  truncated?: { total: number; returned: number };
}
