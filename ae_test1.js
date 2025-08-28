// filename: fetchPopularKR.js
// Node 18+ (fetch 내장), package.json: { "type": "module" }
// 준비: npm i dotenv
// .env: AE_APP_KEY=..., AE_APP_SECRET=..., AE_TRACKING_ID=...

import crypto from "crypto";
import "dotenv/config";

const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.AE_TRACKING_ID;

if (!APP_KEY || !APP_SECRET || !TRACKING_ID) {
  console.error(
    "환경변수(AE_APP_KEY, AE_APP_SECRET, AE_TRACKING_ID)를 확인하세요."
  );
  process.exit(1);
}

// ===== 상수 =====
const METHOD = "aliexpress.affiliate.product.query";
const API_REST = "https://api-sg.aliexpress.com/rest";
const API_SYNC = "https://api-sg.aliexpress.com/sync";
const SORT_POPULAR = "LAST_VOLUME_DESC"; // 최근 판매량 내림차순
const MAX_PAGE_SIZE = 50; // 서버 응답 상한

// ── 카테고리 필드까지 포함(서버 필터 확인용) ──
const FIELDS = [
  "product_id",
  "product_title",
  "product_detail_url",
  "product_main_image_url",
  "app_sale_price",
  "app_sale_price_currency",
  "sale_price",
  "sale_price_currency",
  "target_app_sale_price",
  "target_app_sale_price_currency",
  "evaluate_rate",
  "promotion_link",
  "lastest_volume",
  "review_count",
  "total_review_num",
  "evaluate_count",
  "first_level_category_id",
  "first_level_category_name",
  "second_level_category_id",
  "second_level_category_name",
].join(",");

// ===== 서명 유틸 =====
function buildBase(params) {
  return Object.keys(params)
    .filter(
      (k) => k !== "sign" && params[k] !== undefined && params[k] !== null
    )
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
}
function signMD5(params, secret) {
  const base = buildBase(params);
  return crypto
    .createHash("md5")
    .update(secret + base + secret, "utf8")
    .digest("hex")
    .toUpperCase();
}
function signHMAC256(params, secret) {
  const base = buildBase(params);
  return crypto
    .createHmac("sha256", secret)
    .update(base, "utf8")
    .digest("hex")
    .toUpperCase();
}
const tsEpochMs = () => Date.now();
function tsYYYYMMDD_HHMMSS_UTC() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(
    d.getUTCDate()
  )} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function buildSignedURL(endpoint, params, signMethod) {
  const sign =
    signMethod === "md5"
      ? signMD5(params, APP_SECRET)
      : signHMAC256(params, APP_SECRET);
  const url = new URL(endpoint);
  Object.entries({ ...params, sign }).forEach(([k, v]) =>
    url.searchParams.append(k, String(v))
  );
  return url.toString();
}

// ===== 파싱 & 필터 유틸 =====
const toInt = (v) => {
  if (v === undefined || v === null) return 0;
  const n = Number(String(v).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// 다양한 응답 포맷을 안전하게 풀어주는 헬퍼
function unwrapProducts(root) {
  const paths = [
    ["resp_result", "result", "products", "product"],
    ["resp_result", "result", "products"],
    ["result", "products", "product"],
    ["result", "products"],
    ["data", "products", "product"],
    ["data", "products"],
    [
      "aliexpress_affiliate_product_query_response",
      "resp_result",
      "result",
      "products",
      "product",
    ],
  ];
  for (const path of paths) {
    let cur = root;
    for (const key of path) cur = cur?.[key];
    if (Array.isArray(cur)) return cur;
    if (cur && Array.isArray(cur.product)) return cur.product; // { product: [...] } 방어
  }
  return [];
}

// ── FIELDS의 키 목록
const FIELD_LIST = FIELDS.split(",").map((s) => s.trim());

// 서버 응답의 키 변형을 감안한 매핑
const FIELD_RESOLVERS = {
  product_id: (p) => p?.product_id ?? p?.item_id ?? p?.productId ?? p?.itemId,
  product_title: (p) => p?.product_title ?? p?.title,
  product_detail_url: (p) => p?.product_detail_url ?? p?.product_url ?? p?.url,
  product_main_image_url: (p) =>
    p?.product_main_image_url ?? p?.image_url ?? p?.main_image ?? p?.imageUrl,

  app_sale_price: (p) => p?.app_sale_price ?? p?.app_price ?? p?.price,
  app_sale_price_currency: (p) => p?.app_sale_price_currency ?? p?.currency,

  sale_price: (p) => p?.sale_price ?? p?.price,
  sale_price_currency: (p) => p?.sale_price_currency ?? p?.currency,

  target_app_sale_price: (p) => p?.target_app_sale_price,
  target_app_sale_price_currency: (p) => p?.target_app_sale_price_currency,

  evaluate_rate: (p) => p?.evaluate_rate ?? p?.rating,
  promotion_link: (p) => p?.promotion_link,

  // 실제 응답에 'lastest_volume' 오타가 종종 존재
  lastest_volume: (p) =>
    p?.lastest_volume ?? p?.sale_num ?? p?.volume ?? p?.sales,

  review_count: (p) => p?.review_count,
  total_review_num: (p) => p?.total_review_num,
  evaluate_count: (p) => p?.evaluate_count,

  first_level_category_id: (p) => p?.first_level_category_id,
  first_level_category_name: (p) => p?.first_level_category_name,
  second_level_category_id: (p) => p?.second_level_category_id,
  second_level_category_name: (p) => p?.second_level_category_name,
};

// 안전하게 값 뽑기
function resolveField(p, key) {
  const fn = FIELD_RESOLVERS[key];
  return typeof fn === "function" ? fn(p) : p?.[key];
}

// 요청한 FIELDS 전부를 담고, 동시에 최상위에 평탄화까지(없으면 null 강제)
function parseItems(data) {
  const arr = unwrapProducts(data);

  return arr.map((p) => {
    const fields = {};
    for (const k of FIELD_LIST) {
      const v = resolveField(p, k);
      fields[k] = v === undefined ? null : v; // ★ undefined → null
    }

    const soldRaw =
      fields.lastest_volume ?? p?.sale_num ?? p?.volume ?? p?.sales;
    const reviewCount =
      fields.review_count ??
      fields.total_review_num ??
      fields.evaluate_count ??
      null;

    return {
      // ---- 평탄화: FIELDS를 최상위로도 노출 ----
      ...fields,

      // ---- 추가 정규화 필드(편의용) ----
      id: fields.product_id,
      title: fields.product_title,
      price:
        fields.target_app_sale_price ??
        fields.app_sale_price ??
        fields.sale_price,
      currency:
        fields.target_app_sale_price_currency ??
        fields.app_sale_price_currency ??
        fields.sale_price_currency ??
        "KRW",
      sold: toInt(soldRaw),
      rating: fields.evaluate_rate,
      reviewCount,
      image: fields.product_main_image_url,
      url: fields.promotion_link ?? fields.product_detail_url,

      // 원본 FIELDS 객체도 보존(디버깅/가독성)
      fields,
    };
  });
}

function matchesCategory(it, wantedId) {
  if (!wantedId) return true;
  const c1 = Number(it.first_level_category_id || 0);
  const c2 = Number(it.second_level_category_id || 0);
  return c1 === Number(wantedId) || c2 === Number(wantedId);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 단일 요청 =====
async function requestOnce({
  endpoint,
  signMethod, // 'hmac-sha256' | 'md5'
  tsMode, // 'epoch' | 'topfmt'
  keywords,
  pageNo,
  pageSize,
  categoryId,
  extraBiz = {},
}) {
  const sys = {
    method: METHOD,
    app_key: APP_KEY,
    sign_method: signMethod,
    timestamp: tsMode === "epoch" ? tsEpochMs() : tsYYYYMMDD_HHMMSS_UTC(),
    v: "1.0",
    format: "json",
  };

  const biz = {
    tracking_id: TRACKING_ID,
    page_no: pageNo,
    page_size: Math.min(pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE), // 서버 상한 50
    target_language: "ko",
    target_currency: "KRW",
    country: "KR",
    ship_to_country: "KR",
    sort: SORT_POPULAR,
    fields: FIELDS,
    ...(keywords ? { keywords } : {}),
    ...(categoryId
      ? {
          category_id: categoryId,
          category_ids: String(categoryId),
          categoryId: categoryId,
        }
      : {}),
    ...extraBiz,
  };

  const params = { ...sys, ...biz };
  const url = buildSignedURL(endpoint, params, signMethod);

  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => ({}));

  if (data?.error_response || (data?.resp_code && data?.resp_code !== 200)) {
    console.log(
      "[API ERROR]",
      data?.error_response || { code: data?.resp_code, msg: data?.resp_msg }
    );
  }
  const items = parseItems(data);
  return { data, items };
}

// ===== 자동 재시도 (단일 페이지) =====
async function fetchPopularKRPage({
  keywords = "",
  pageNo = 1,
  pageSize = MAX_PAGE_SIZE,
  categoryId,
  extraBiz = {},
} = {}) {
  // 1) HMAC + epoch + /rest
  let r = await requestOnce({
    endpoint: API_REST,
    signMethod: "hmac-sha256",
    tsMode: "epoch",
    keywords,
    pageNo,
    pageSize,
    categoryId,
    extraBiz,
  });
  if (r.items.length)
    return r.items.filter((it) => matchesCategory(it, categoryId));

  // 2) MD5 + epoch + /rest
  r = await requestOnce({
    endpoint: API_REST,
    signMethod: "md5",
    tsMode: "epoch",
    keywords,
    pageNo,
    pageSize,
    categoryId,
    extraBiz,
  });
  if (r.items.length)
    return r.items.filter((it) => matchesCategory(it, categoryId));

  // 3) HMAC + "YYYY-MM-DD HH:mm:ss" + /rest
  r = await requestOnce({
    endpoint: API_REST,
    signMethod: "hmac-sha256",
    tsMode: "topfmt",
    keywords,
    pageNo,
    pageSize,
    categoryId,
    extraBiz,
  });
  if (r.items.length)
    return r.items.filter((it) => matchesCategory(it, categoryId));

  // 4) MD5 + "YYYY-MM-DD HH:mm:ss" + /rest
  r = await requestOnce({
    endpoint: API_REST,
    signMethod: "md5",
    tsMode: "topfmt",
    keywords,
    pageNo,
    pageSize,
    categoryId,
    extraBiz,
  });
  if (r.items.length)
    return r.items.filter((it) => matchesCategory(it, categoryId));

  // 5) /sync
  r = await requestOnce({
    endpoint: API_SYNC,
    signMethod: "md5",
    tsMode: "topfmt",
    keywords,
    pageNo,
    pageSize,
    categoryId,
    extraBiz,
  });
  if (r.items.length)
    return r.items.filter((it) => matchesCategory(it, categoryId));

  return []; // 페이지 실패시 빈 배열
}

// ===== 페이지네이션으로 최대한 많이 모으기 =====
async function fetchPopularKRAll({
  keywords = "",
  categoryId = undefined,
  startPage = 1,
  maxPages = 40, // 예: 40 * 50 = 2000개
  pageSize = MAX_PAGE_SIZE,
  delayMs = 150, // 호출 간 간격(안정성)
  extraBiz = {},
} = {}) {
  const seen = new Map(); // id -> item
  for (let p = startPage; p < startPage + maxPages; p++) {
    const items = await fetchPopularKRPage({
      keywords,
      pageNo: p,
      pageSize,
      categoryId,
      extraBiz,
    });
    if (!items.length) break;

    for (const it of items) {
      const id = it?.id ?? it?.product_id;
      if (id) seen.set(String(id), it); // 중복 제거
    }

    // 현재 페이지가 꽉 차지 않았으면 다음 페이지는 없다고 보고 종료
    if (items.length < Math.min(pageSize, MAX_PAGE_SIZE)) break;
    if (delayMs) await sleep(delayMs);
  }
  return [...seen.values()];
}

// ===== 실행 예시 =====
(async () => {
  const list = await fetchPopularKRAll({
    keywords: "", // 카테고리 전체 인기
    categoryId: 2, // 예시 카테고리 ID
    maxPages: 40,
    pageSize: 50,
    delayMs: 150,
  });

  console.log("count:", list.length);

  if (list.length) {
    // 직렬화로 필드 확인(없으면 null로 표기됨)
    const sample = {
      product_id: list[0].product_id,
      product_title: list[0].product_title,
      app_sale_price: list[0].app_sale_price,
      app_sale_price_currency: list[0].app_sale_price_currency,
      target_app_sale_price: list[0].target_app_sale_price,
      target_app_sale_price_currency: list[0].target_app_sale_price_currency,
      sale_price: list[0].sale_price,
      sale_price_currency: list[0].sale_price_currency,
      promotion_link: list[0].promotion_link,
      product_detail_url: list[0].product_detail_url,
    };
    console.log("sample item fields:", JSON.stringify(sample, null, 2));
  }
})();
