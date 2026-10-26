import {
  CoDesignError,
  explainError,
  explainNetworkError,
  isCoDesignError,
} from "./errors.js";
import type {
  DesignRef,
  Layer,
  LayerRect,
  LayerTree,
  ScreenDetail,
  ScreenRef,
  ShareInfo,
  SliceExport,
  SliceItem,
} from "./types.js";

const BASE = "https://codesign.qq.com";
const CDN_ORIGIN = "https://codesign.qq.com";
const DEFAULT_CDN_HOST = "https://cdn4.codesign.qq.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

export interface ClientOptions {
  /** 单次请求超时，毫秒 */
  timeoutMs?: number;
  /** 幂等请求的重试次数（不含首次） */
  retries?: number;
  /** 环境变量里配置的默认访问密码，工具未显式传 password 时作为兜底 */
  defaultPassword?: string;
}

/** 分享链接的各类写法，用于解析分享 ID */
const SHARE_PATTERNS = [
  /#?\/app\/s\/(\d+)/,
  /#?\/s\/(\d+)/,
  /sharings?\/(\d+)/,
  /^\s*(\d{10,})\s*$/,
];

/** 后台链接（需要登录，ID 是设计稿 ID 而非分享 ID），单独识别以便反查分享 */
const BACKEND_DESIGN_RE = /#?\/app\/design\/(\d+)/;
const BACKEND_OTHER_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /#?\/app\/team\//, kind: "团队页" },
  { re: /#?\/app\/project\//, kind: "项目页" },
];

/** 从后台链接里解析设计稿 ID（如 /app/design/<designId>/board） */
export function parseDesignId(url: string): number | undefined {
  const m = url.match(BACKEND_DESIGN_RE);
  return m ? Number(m[1]) : undefined;
}

/** 从分享链接里解析分享 ID，兼容带不带 hash 前缀的写法 */
export function parseShareId(url: string): number {
  for (const re of SHARE_PATTERNS) {
    const m = url.match(re);
    if (m) return Number(m[1]);
  }

  // 后台链接：ID 是设计稿 ID，需要先用 Cookie 反查对应的分享 ID
  if (parseDesignId(url) !== undefined) {
    throw new CoDesignError(
      "这是设计稿后台链接，需要先反查分享 ID",
      undefined,
      "工具会自动用 Cookie 调用后台接口换出分享 ID；若仍失败，请改用分享链接。",
      "BACKEND_LINK",
    );
  }

  for (const { re, kind } of BACKEND_OTHER_PATTERNS) {
    if (re.test(url)) {
      throw new CoDesignError(
        `这是${kind}链接，不是分享链接`,
        undefined,
        [
          "本工具的接口只认「分享」体系。",
          "",
          "获取分享链接：",
          "  1. 浏览器打开该设计稿",
          "  2. 点右上角「分享」→ 复制链接（或开启分享）",
          "  3. 链接形如 https://codesign.qq.com/app/s/<分享ID>",
        ].join("\n"),
        "BACKEND_LINK",
      );
    }
  }

  throw new CoDesignError(
    `无法从链接中解析分享 ID：${url}`,
    undefined,
    [
      "支持的格式：",
      "  https://codesign.qq.com/app/s/<分享ID>",
      "  https://codesign.qq.com/app/s/<分享ID>/<画板ID>",
      "  https://codesign.qq.com/s/<分享ID>/<画板ID>/inspect",
      "  https://codesign.qq.com/app/design/<设计ID>/board（需配 Cookie 反查）",
      "  或直接传纯数字分享 ID",
    ].join("\n"),
  );
}

/** 从分享链接里解析当前打开的画板 ID（可选） */
export function parseScreenId(url: string): number | undefined {
  // 分享链接：/app/s/<shareId>/<screenId> 或 /s/<shareId>/<screenId>/inspect
  const m = url.match(/#?\/(?:app\/)?s\/\d+\/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** 把 Cookie 字符串拆成 map，便于按需取 access_token */
function parseCookies(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export class CoDesignClient {
  private readonly cookie: string;
  private readonly accessToken?: string;
  private readonly cookieTeamId?: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly defaultPassword?: string;
  /** 分享密码 → state-key 缓存，密码有效期由服务端决定（响应里带 expires） */
  private readonly stateKeys = new Map<string, { key: string; expires: number }>();

  constructor(cookie?: string, options: ClientOptions = {}) {
    this.cookie = (cookie ?? "").trim();
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.defaultPassword = options.defaultPassword?.trim() || undefined;
    if (this.cookie) {
      const jar = parseCookies(this.cookie);
      this.accessToken = jar.access_token;
      this.cookieTeamId = jar["X-Team-Id"];
    }
  }

  get hasCookie(): boolean {
    return this.cookie.length > 0;
  }

  /**
   * 用访问密码换 state-key。
   * 带密码的分享，`GET /api/sharings/:id` 会返回 403「请输入密码！」，
   * 必须先 `POST /api/sharings/:id/state-keys` 拿 key，再以 `state-key` 头访问。
   * 注意画板详情接口不需要这个头。
   */
  async exchangePassword(shareId: number, password: string): Promise<string> {
    const cacheKey = `${shareId}:${password}`;
    const cached = this.stateKeys.get(cacheKey);
    if (cached && cached.expires * 1000 > Date.now()) return cached.key;

    const res = await this.send(`${BASE}/api/sharings/${shareId}/state-keys`, {
      method: "POST",
      headers: { ...this.authHeaders(), referer: `${BASE}/s/${shareId}`, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });

    const text = await res.text();
    if (!res.ok) {
      // 错误密码返回 422，错误信息形如「password 必须是 4 个字符」
      throw explainError(res.status, text, `${BASE}/api/sharings/${shareId}/state-keys`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CoDesignError(
        "密码校验接口返回了非 JSON 内容",
        res.status,
        "接口可能已变更，请检查 CoDesign 是否改了分享密码机制。",
      );
    }

    const key = parsed?.key;
    if (typeof key !== "string" || !key) {
      throw new CoDesignError("密码校验未返回 state-key", res.status);
    }

    const expires = typeof parsed.expires === "number" ? parsed.expires : Math.floor(Date.now() / 1000) + 3600;
    this.stateKeys.set(cacheKey, { key, expires });
    return key;
  }

  /** 鉴权接口：Cookie + Bearer（两者缺一不可，只带 Cookie 会返回「非项目成员」） */
  private authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      "x-source": "web",
      "user-agent": UA,
      referer: `${BASE}/`,
    };
    if (this.cookie) h.cookie = this.cookie;
    if (this.accessToken) h.authorization = `Bearer ${this.accessToken}`;
    if (this.cookieTeamId) h["x-team-id"] = this.cookieTeamId;
    return h;
  }

  /** CDN 资源：必须带 Origin，否则 403 */
  private cdnHeaders(): Record<string, string> {
    return {
      origin: CDN_ORIGIN,
      referer: `${BASE}/`,
      "user-agent": UA,
      accept: "*/*",
    };
  }

  /**
   * 带超时与重试的请求。只对幂等方法重试：CDN 素材全是 GET，
   * 本项目的鉴权接口也都是查询，所以默认全部可重试。
   */
  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));

      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        // 5xx / 429 才值得重试；4xx 是确定性的，重试只会白等
        if (res.ok || !isRetryable(res.status) || attempt === this.retries) return res;
        // 读掉 body 释放连接，再等下一轮
        await res.text().catch(() => "");
      } catch (e) {
        lastErr = e;
        if (attempt === this.retries) throw explainNetworkError(e, url);
      }
    }

    // 循环只在最后一次抛错时退出
    throw explainNetworkError(lastErr, url);
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.send(url, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw explainError(res.status, body, url);
    }
    return (await res.json()) as T;
  }

  /**
   * 设计稿元数据。公开分享无需登录即可拿到标题、团队、画板列表；
   * 带密码的分享需要传 password，内部会先换 state-key 再请求。
   */
  async getShare(shareId: number, password?: string): Promise<ShareInfo> {
    // 未显式传密码时退回环境变量里配置的默认密码
    const pwd = password?.trim() || this.defaultPassword;

    // 有密码就先换 key；没密码则直接请求
    let stateKey = pwd ? await this.exchangePassword(shareId, pwd) : undefined;

    const fetchShare = (key?: string) =>
      this.request<any>(`${BASE}/api/sharings/${shareId}`, {
        headers: {
          accept: "application/json",
          referer: `${BASE}/s/${shareId}`,
          "user-agent": UA,
          ...(key ? { "state-key": key } : {}),
        },
      });

    let raw: any;
    try {
      raw = await fetchShare(stateKey);
    } catch (e) {
      // 带 Cookie 请求密码分享时，服务端返回的是「您当前暂无权限」而不是「请输入密码」，
      // 无法从这一条判断是否缺密码。用不含 Cookie / Bearer 的探测请求确认一下。
      if (!stateKey && isCoDesignError(e) && e.code === "NO_PERMISSION" && (await this.needsPassword(shareId))) {
        if (this.defaultPassword) {
          raw = await fetchShare(await this.exchangePassword(shareId, this.defaultPassword));
        } else {
          throw new CoDesignError(
            `设计稿（分享 ${shareId}）需要访问密码`,
            403,
            [
              "该分享开启了密码保护，需要提供访问密码。",
              "请把密码作为 password 参数传入，或设置环境变量 CODESIGN_PASSWORD。",
              '例如：design_get(url, password: "ABCD")',
              "提示：若密码正确仍报「无权限」，说明当前 Cookie 账号不在项目内，",
              "      密码只能解锁分享，解不开团队权限。",
            ].join("\n"),
            "NEED_PASSWORD",
          );
        }
      } else {
        throw e;
      }
    }

    const designs: DesignRef[] = (raw.designs ?? []).map((d: any) => {
      const screens: ScreenRef[] = [];
      for (const section of d.sections ?? []) {
        for (const s of section.screens ?? []) {
          screens.push({ id: s.id, name: s.name });
        }
      }
      return {
        id: d.id,
        name: d.name,
        viewport: d.viewport ?? "",
        screens,
      };
    });

    return {
      id: raw.id,
      title: raw.title,
      teamName: raw.team?.name ?? "",
      permissions: {
        commentable: raw.permissions?.commentable ?? false,
        inspectable: raw.permissions?.inspectable ?? false,
        assetsDownloadable: raw.permissions?.assetsDownloadable ?? false,
      },
      designs,
    };
  }

  /** 画板详情：拿 meta_url / slices_url / 预览图地址 */
  async getScreen(designId: number, screenId: number): Promise<ScreenDetail> {
    this.requireCookie("读取图层标注");
    const raw = await this.request<any>(
      `${BASE}/api/designs/${designId}/screens/${screenId}`,
      { headers: this.authHeaders() },
    );

    const cdnHost: string = (raw.cdn_host ?? DEFAULT_CDN_HOST).replace(/\/$/, "");
    const rewrite = (u?: string) => (u ? new URL(u, cdnHost).href : undefined);

    return {
      id: raw.id,
      name: raw.name,
      width: raw.width,
      height: raw.height,
      designId: raw.design_id ?? designId,
      source: raw.source ?? "",
      metaUrl: rewrite(raw.meta_url),
      slicesUrl: rewrite(raw.slices_url),
      previewUrl: rewrite(raw.preview_path),
      slicesCount: raw.slices_count ?? 0,
    };
  }

  /**
   * 下载并解析图层树 JSON。
   * 注意：CoDesign 的 meta 里 `layers` 与 `groups` 是两个**扁平**数组，
   * 真实层级只体现在 `parent_id` 上，必须自己重建，否则拿到的是一堆没有父子关系的散图层。
   */
  async getMeta(metaUrl: string): Promise<LayerTree> {
    const raw = await this.request<any>(metaUrl, { headers: this.cdnHeaders() });
    const nodes: any[] = [...(raw.layers ?? []), ...(raw.groups ?? [])];
    return {
      name: raw.name ?? "",
      width: raw.width ?? 0,
      height: raw.height ?? 0,
      layers: buildLayerTree(nodes, raw.object_id),
    };
  }

  /** 下载并解析切图清单 JSON */
  async getSlices(slicesUrl: string): Promise<SliceItem[]> {
    const raw = await this.request<any[]>(slicesUrl, { headers: this.cdnHeaders() });
    return (raw ?? []).map((item) => ({
      id: String(item.id ?? item.object_id ?? ""),
      name: item.name ?? "",
      rect: normalizeRect(item.rect),
      exports: (item.exportables ?? []).map((ex: any): SliceExport => ({
        name: item.name ?? "",
        scale: ex.scale ?? 1,
        format: ex.format ?? "png",
        width: ex.screenshot?.width ?? ex.size ?? 0,
        height: ex.screenshot?.height ?? ex.size ?? 0,
        // 清单里给的是 OSS 签名地址，直接下会 AccessDenied，
        // 换到 CDN 域名并加 imageMogr2 参数才可下载（svg 会跳过该参数）
        downloadUrl: toCdnUrl(ex.screenshot?.url ?? "", DEFAULT_CDN_HOST, ex.format),
        objectId: String(ex.object_id ?? item.object_id ?? ""),
      })),
    }));
  }

  /** 下载任意 CDN 图片到 Buffer */
  async downloadImage(url: string): Promise<Buffer> {
    const res = await this.send(url, { headers: this.cdnHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw explainError(res.status, body, url);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * 探测某个分享是否设置了访问密码。
   * 不带 Cookie/Bearer 请求分享详情：密码分享会返回 403「请输入密码！」，
   * 普通分享则正常返回 200。仅用于诊断，失败时按「不需要密码」处理。
   */
  private async needsPassword(shareId: number): Promise<boolean> {
    try {
      const res = await this.send(`${BASE}/api/sharings/${shareId}`, {
        headers: {
          accept: "application/json",
          referer: `${BASE}/s/${shareId}`,
          "user-agent": UA,
        },
      });
      if (res.ok) return false;
      const body = await res.text().catch(() => "");
      const message = (() => {
        try {
          return String(JSON.parse(body)?.message ?? "");
        } catch {
          return body;
        }
      })();
      return res.status === 403 && message.includes("请输入密码");
    } catch {
      return false;
    }
  }

  /**
   * 直接用后台链接的设计稿 ID 读取设计稿。
   *
   * 后台接口 `GET /api/designs/<designId>` 需要 Cookie + Bearer，
   * 返回里带 name / team / sections[].screens[]，结构与分享详情基本一致，
   * 直接映射成 ShareInfo 即可复用后续全部流程，无需去找分享链接。
   *
   * `shareId` 会填成设计稿 ID（此时没有分享 ID 这个概念）。
   */
  async getShareByDesignId(designId: number): Promise<ShareInfo> {
    this.requireCookie("用后台链接读取设计稿");

    const raw: any = await this.request(`${BASE}/api/designs/${designId}`, {
      headers: { ...this.authHeaders(), referer: `${BASE}/app/design/${designId}/board` },
    });

    // 后台返回的 sections 与分享详情同构；某些版本顶层也有 screens，做兜底
    const sections: any[] = Array.isArray(raw?.sections) ? raw.sections : [];
    let screens = sections.flatMap((sec) => (Array.isArray(sec?.screens) ? sec.screens : []));
    if (!screens.length && Array.isArray(raw?.screens)) screens = raw.screens;

    if (!screens.length) {
      throw new CoDesignError(
        `设计稿 ${designId} 里没有找到任何画板`,
        undefined,
        [
          "后台接口返回成功，但 sections/screens 为空。可能原因：",
          "  1. 设计稿还在上传处理中，稍后重试",
          "  2. 当前 Cookie 账号没有该设计稿的查看权限",
          "  3. 该设计稿尚未上传源文件（只有封面图）",
        ].join("\n"),
      );
    }

    // 后台接口用 permission_type / is_member 表达权限，映射成与分享一致的语义
    const canInspect = raw?.is_member === true || raw?.is_team_member === true || raw?.permission_type !== "none";
    const sharingPerm = Array.isArray(raw?.sharings) ? raw.sharings[0]?.permissions : undefined;
    const assetsDownloadable = sharingPerm?.assetsDownloadable ?? raw?.permission?.assets_downloadable ?? true;

    return {
      id: designId,
      title: raw?.name ?? `设计稿 ${designId}`,
      teamName: raw?.team?.name ?? "",
      permissions: {
        commentable: sharingPerm?.commentable ?? true,
        inspectable: canInspect,
        assetsDownloadable: Boolean(assetsDownloadable),
      },
      designs: [
        {
          id: designId,
          name: raw?.name ?? "",
          viewport: raw?.viewport ?? "",
          screens: screens.map((s: any) => ({ id: s.id, name: s.name })),
        },
      ],
    };
  }

  private requireCookie(action: string) {
    if (!this.hasCookie) {
      throw new CoDesignError(
        `需要登录态才能${action}`,
        undefined,
        [
          "未检测到 COOKIE 环境变量。",
          "获取方式：",
          "  1. 浏览器登录 https://codesign.qq.com",
          "  2. 打开目标设计稿分享页，F12 → Network",
          "  3. 任选一条 /api/ 请求 → 右键 → Copy as cURL",
          "  4. 把 -b '...' 引号内的内容设为环境变量 CODESIGN_COOKIE",
        ].join("\n"),
      );
    }
  }
}

/** 5xx 与 429 属于瞬时失败，可重试 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把 OSS 直链换成可下载的 CDN 直链。
 * 注意：`imageMogr2` 是腾讯云图片处理参数，只能处理位图；
 * 对 svg 这类矢量格式会直接报 `InvalidImageFormat` 400，必须跳过。
 */
export function toCdnUrl(url: string, cdnHost = DEFAULT_CDN_HOST, format?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const isVector = isVectorFormat(format) || /\.svgz?$/i.test(u.pathname);
    // cdn4.codesign.qq.com 走腾讯云图片服务，位图必须带 imageMogr2 才放行
    if (/^cdn\d*\.codesign\.qq\.com$/.test(u.hostname)) {
      if (isVector) return url;
      return /imageMogr2/.test(url) ? url : appendImageMogr2(url, u);
    }
    // OSS 签名直链：换域名 + 补参数
    const host = cdnHost.replace(/\/$/, "");
    const rebuilt = `${host}${u.pathname}${u.search}`;
    if (isVector) return rebuilt;
    return appendImageMogr2(rebuilt, u);
  } catch {
    return url;
  }
}

function isVectorFormat(format?: string): boolean {
  return typeof format === "string" && /^(svg|svgz|pdf|eps|ai)$/i.test(format.trim());
}

/** 追加 imageMogr2 时按 URL 解析结果判断分隔符，避免签名链接里已带 ? 时拼错 */
function appendImageMogr2(url: string, parsed: URL): string {
  const sep = parsed.search ? "&" : "?";
  return `${url}${sep}imageMogr2/format/png`;
}

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

/**
 * CoDesign 的颜色对象字段是 r/g/b/a，同时带 color-hex / css-rgba 等现成写法。
 *
 * 实测数据里 alpha 的单位**不固定**：普通填充是 0–1（a:1），
 * 但半透明遮罩会返回 a:100 并把 color-hex 写成 `#000000 10000%`
 * —— 它的 css-rgba 也是 `rgba(0,0,0,100)`，是错的。所以 alpha 必须自己归一化。
 */
export function rgba(c?: Record<string, any>): string | undefined {
  if (!c) return undefined;

  const alpha = resolveAlpha(c);
  const hex = typeof c["color-hex"] === "string" ? c["color-hex"].trim() : undefined;

  if (hex) {
    const m = hex.match(/^(#[0-9a-f]{3,8})(?:\s+(\d+(?:\.\d+)?)%)?$/i);
    if (m) {
      const pct = m[2] !== undefined ? Number(m[2]) / 100 : undefined;
      // color-hex 的百分比与 a 字段矛盾时以 a 为准（见上面的 10000% 案例）
      const a = alpha ?? pct;
      return a !== undefined && a < 1 ? withAlpha(m[1], a) : m[1];
    }
    const colorOnly = hex.split(/\s+/)[0];
    if (/^#([0-9a-f]{3,8})$/i.test(colorOnly)) {
      return alpha !== undefined && alpha < 1 ? withAlpha(colorOnly, alpha) : colorOnly;
    }
  }

  if (typeof c["css-rgba"] === "string") return normalizeCssRgba(c["css-rgba"]);

  const r = clamp255(c.r ?? c.red ?? 0);
  const g = clamp255(c.g ?? c.green ?? 0);
  const b = clamp255(c.b ?? c.blue ?? 0);
  if (alpha !== undefined && alpha < 1) {
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * a/alpha 字段可能是 0–1 也可能是 0–100，实测两种都有。
 * 大于 1 的一律按百分比处理。
 */
function resolveAlpha(c: Record<string, any>): number | undefined {
  const raw = c.a ?? c.alpha;
  if (typeof raw !== "number" || Number.isNaN(raw)) return undefined;
  const a = raw > 1 ? raw / 100 : raw;
  return Number(Math.max(0, Math.min(1, a)).toFixed(3));
}

function clamp255(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;
}

/** 把 `rgba(0,0,0,100)` 这类百分比 alpha 纠正成合法 CSS */
function normalizeCssRgba(css: string): string {
  return css.replace(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i, (_m, r, g, b, a) => {
    const rr = clamp255(r);
    const gg = clamp255(g);
    const bb = clamp255(b);
    if (a === undefined) return `rgb(${rr},${gg},${bb})`;
    const aa = Number(a) > 1 ? Number((Number(a) / 100).toFixed(3)) : Number(a);
    return aa >= 1 ? `rgb(${rr},${gg},${bb})` : `rgba(${rr},${gg},${bb},${aa})`;
  });
}

/** 把 alpha 合进 hex 颜色，输出 8 位 hex（浏览器普遍支持） */
function withAlpha(hex: string, alpha: number): string {
  const body = hex.slice(1);
  if (body.length === 8) return hex; // 已带 alpha
  const full =
    body.length === 3 || body.length === 4
      ? body
          .slice(0, 3)
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : body;
  return `#${full}${Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 图层树重建
// ---------------------------------------------------------------------------

/**
 * 用 parent_id 把扁平的 layers + groups 重建成真正的树。
 * 画板自身的 object_id 是根；找不到父节点的节点挂到根上，避免丢数据。
 */
export function buildLayerTree(nodes: any[], rootId: unknown): Layer[] {
  if (!nodes.length) return [];

  const byId = new Map<string, any>();
  for (const n of nodes) {
    if (n?.object_id !== undefined) byId.set(String(n.object_id), n);
  }

  const childrenOf = new Map<string, any[]>();
  for (const n of nodes) {
    const pid = String(n?.parent_id ?? "");
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(n);
  }

  const build = (n: any, seen: Set<string>): Layer => {
    const layer = normalizeLayer(n);
    const id = String(n?.object_id ?? "");
    seen.add(id);
    const kids = (childrenOf.get(id) ?? []).filter((k) => !seen.has(String(k.object_id)));
    if (kids.length) layer.children = kids.map((k) => build(k, seen));
    return layer;
  };

  const rootChildren = childrenOf.get(String(rootId ?? "")) ?? [];
  if (rootChildren.length) {
    return rootChildren.map((n) => build(n, new Set()));
  }

  // 没有可用的根（例如画板 object_id 缺失）：从“父节点不在集合里”的节点开始
  const orphans = nodes.filter((n) => !byId.has(String(n?.parent_id ?? "")));
  return (orphans.length ? orphans : nodes).map((n) => build(n, new Set()));
}

function normalizeRect(rect?: any): LayerRect {
  return {
    x: rect?.x ?? 0,
    y: rect?.y ?? 0,
    width: rect?.width ?? 0,
    height: rect?.height ?? 0,
  };
}

function normalizeLayer(l: any): Layer {
  const layer: Layer = {
    id: String(l.id ?? l.object_id ?? ""),
    objectId: String(l.object_id ?? ""),
    name: l.name ?? "",
    type: l.type ?? "shape",
    rect: normalizeRect(l.rect),
    visible: l.visible !== false,
    opacity: normalizeOpacity(l.opacity),
    radius: normalizeRadius(l.radius),
    fills: normalizePaints(l.fills),
    borders: normalizeBorders(l.borders),
    images: (l.images ?? []).map((img: any) => toCdnUrl(typeof img === "string" ? img : img?.url ?? "")),
    // 设计稿自带的 CSS 片段是最可靠的样式来源，原样保留
    css: Array.isArray(l.css) ? l.css.map(String) : typeof l.css === "string" ? [l.css] : undefined,
  };

  if (l.rotation) layer.rotation = l.rotation;
  if (l.fillOpacity ?? l.fillopacity) layer.fillOpacity = normalizeOpacity(l.fillOpacity ?? l.fillopacity);
  if (l.clipped) layer.clipped = true;
  if (l.blendOptions?.mode) layer.blendMode = l.blendOptions.mode;
  if (l.path) layer.isVector = true;

  // 位图图层：设计稿里是位图/智能对象，没有矢量信息可还原。
  // 实测这类图层只返回盒子尺寸和 css，没有 fills/borders/effects，只能靠切图还原。
  // 三种形态：带 pixels 的位图、图片填充、以及智能对象（smartObject，无 path）。
  const hasPixels = l.pixels !== undefined && l.pixels !== null;
  const hasImageFill = Array.isArray(l.fills) && l.fills.some((f: any) => f?.fillType === "image");
  const isSmartObject = l.smartObject !== undefined && l.smartObject !== null;
  if (!l.path && (hasPixels || hasImageFill || isSmartObject)) {
    layer.isBitmap = true;
  }

  const effects = normalizeEffects(l.layerEffects);
  if (effects.length) layer.effects = effects;

  if (l.type === "text") {
    layer.text = normalizeText(l);
  }

  return layer;
}

function normalizeOpacity(v: unknown): number | undefined {
  if (typeof v !== "number" || Number.isNaN(v)) return undefined;
  const n = v > 1 ? v / 100 : v;
  return Number(Math.max(0, Math.min(1, n)).toFixed(3));
}

/**
 * 文本样式。
 *
 * 实测要点：
 * - `textStyle.size` 是排版原始字号，会发生缩放；`impliedFontSize` 才是渲染后的实际字号
 * - `fontCaps: "allCaps"` 在当前数据里普遍出现在**越南语/普通文本**上，不是真的大写；
 *   CoDesign 的 `css` 字段也不会输出 text-transform，所以不能据此加 `text-transform:uppercase`
 * - `textKey` 才是正文内容
 */
function normalizeText(l: any): Layer["text"] {
  const tr = l.text?.textStyleRange?.[0]?.textStyle ?? {};
  const size = numberOr(tr.impliedFontSize, numberOr(l.fontSize, tr.size ?? 0));
  const leading = numberOr(tr.impliedLeading, numberOr(l.lineHeight, tr.leading));

  return {
    content: resolveTextContent(l),
    fontName: String(tr.fontName ?? l.fontFace ?? ""),
    // 字重字段在不同文件里既可能是 "Bold" 也可能是 700，统一成字重值
    fontStyleName: normalizeFontWeight(tr.fontStyleName ?? l.fontWeight),
    size,
    tracking: tr.tracking,
    leading,
    lineHeight: leading,
    letterSpacing: numberOr(l.letterSpacing, undefined),
    color: rgba(tr.color) ?? rgba(l.color),
    textAlign: l.textAlign,
    allCaps: false,
  };
}

/** 设计稿的字重可能是数字 700、字符串 "700" 或 "Bold" */
function normalizeFontWeight(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") {
    // "Bold" / "Heavy" 这类保留原名，交给后面映射
    return /^\d+$/.test(v.trim()) ? v.trim() : v;
  }
  return "";
}

/** textKey 才是正文；图层名只是设计工具里的标签 */
function resolveTextContent(l: any): string {
  const raw = l.text ?? {};
  const candidates = [
    raw.textKey,
    raw.content,
    raw.characters,
    raw.value,
    l.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return l.name ?? "";
}

function numberOr<T>(...vals: (T | undefined | null)[]): any {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function normalizeRadius(r: any): number[] | undefined {
  if (r === undefined || r === null) return undefined;
  if (Array.isArray(r)) return r.map((v) => Number(v) || 0);
  if (typeof r === "number") return [r, r, r, r];
  if (typeof r === "object") {
    const vals = [r.topLeft ?? r.tl, r.topRight ?? r.tr, r.bottomRight ?? r.br, r.bottomLeft ?? r.bl];
    if (vals.some((v) => typeof v === "number")) return vals.map((v) => Number(v) || 0);
  }
  return undefined;
}

/**
 * fills/borders 都是 { fillType, color, ... }。
 * `fillType: "gradient"` 时颜色在 gradient 里，直接读 color 会拿到 undefined，
 * 所以保留整个对象交给上层处理。
 */
function normalizePaints(paints?: any[]): Layer["fills"] {
  if (!Array.isArray(paints) || !paints.length) return undefined;
  return paints.map((p) => ({
    type: p.fillType ?? "",
    color: rgba(p.color),
    css: paintToCss(p),
  }));
}

/** 边框额外带 thickness / position，之前只取了颜色 */
function normalizeBorders(borders?: any[]): Layer["borders"] {
  if (!Array.isArray(borders) || !borders.length) return undefined;
  return borders.map((b) => ({
    type: b.fillType ?? "",
    color: rgba(b.color),
    css: paintToCss(b),
    width: numberOr(b.thickness, b.size),
    style: b.position === "inside" ? "inset" : undefined,
    position: b.position,
  }));
}

/** 渐变等非纯色填充，尽量还原成 CSS background 值 */
function paintToCss(p: any): string | undefined {
  if (typeof p.css === "string") return String(p.css).replace(/^background:\s*/, "");
  const g = p.gradient;
  if (!g) return undefined;
  if (typeof g === "string") return g;
  if (Array.isArray(g.stops)) {
    const angle = Math.round(g.angle ?? 180);
    const stops = g.stops
      .map((s: any) => `${rgba(s.color) ?? "transparent"} ${Math.round((s.location ?? 0) * 100)}%`)
      .join(", ");
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  return undefined;
}

/**
 * layerEffects 是 Photoshop 风格的对象：
 * `{ innerGlow: {...}, frameFX: {...} }`，key 就是效果类型。
 * 目前只把能可靠映射成 CSS 的效果转出来，其余原样保留。
 */
function normalizeEffects(effects: any): NonNullable<Layer["effects"]> {
  if (!effects || typeof effects !== "object") return [];
  const out: NonNullable<Layer["effects"]> = [];

  for (const [type, cfg] of Object.entries<any>(effects)) {
    if (!cfg || typeof cfg !== "object") continue;
    out.push({ type, ...cfg });
  }
  return out;
}
