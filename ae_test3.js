// filename: fetchPopularKR.fixed.js
// Node 18+, package.json: { "type": "module" }
import crypto from "crypto";
import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import pLimit from "p-limit";
import { getSkuDetail } from "./skuIdPruductSearch.js";
import categorieList from "./categorieList.json" assert { type: "json" };

const API = "https://api-sg.aliexpress.com/sync";
const METHOD = "aliexpress.affiliate.product.query";

const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.AE_TRACKING_ID;

const FIELDS = [
  "product_id",
  "product_title",
  "product_detail_url",
  "product_main_image_url",
  "target_app_sale_price",
  "target_app_sale_price_currency",
  "promotion_link",
  "lastest_volume",
  "review_count",
  "first_level_category_id",
  "first_level_category_name",
  "second_level_category_id",
  "second_level_category_name",
].join(",");

// ───────────────────────── 재시도 유틸 ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function calcDelay({ base, factor, attempt, jitter, max }) {
  const backoff = Math.min(base * Math.pow(factor, attempt), max);
  const rand = 1 + (Math.random() * 2 - 1) * jitter; // 1±jitter
  return Math.round(backoff * rand);
}

async function fetchJsonWithRetry(
  url,
  {
    retries = 4,
    base = 600,
    factor = 2,
    jitter = 0.35,
    max = 10000,
    timeoutMs = 18000,
    fetchInit = {},
  } = {}
) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, ...fetchInit });
      clearTimeout(to);

      if (res.ok) {
        const txt = await res.text();
        try {
          return JSON.parse(txt);
        } catch {
          return {};
        }
      }
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        if (attempt === retries)
          throw new Error(`HTTP ${res.status} (max retry)`);
        const ra = res.headers.get("retry-after");
        const delay = ra
          ? Number(ra) * 1000
          : calcDelay({ base, factor, attempt, jitter, max });
        await sleep(delay);
        continue;
      }
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err) {
      clearTimeout(to);
      const code = err?.cause?.code || err?.code;
      const isAbort = err?.name === "AbortError";
      const transient =
        isAbort ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "EAI_AGAIN";
      if (!transient || attempt === retries) throw err;
      const delay = calcDelay({ base, factor, attempt, jitter, max });
      await sleep(delay);
    }
  }
}

async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    base = 800,
    factor = 2,
    jitter = 0.3,
    max = 10000,
  } = opts;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err?.cause?.code || err?.code;
      const transient =
        code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN";
      if (!transient && attempt === 0) throw err;
      if (attempt === retries) throw err;
      const delay = calcDelay({ base, factor, attempt, jitter, max });
      await sleep(delay);
    }
  }
}

// ───────────────────────── 공용 함수들 ─────────────────────────
function signSha256(params, secret) {
  const base = Object.keys(params)
    .filter(
      (k) => params[k] !== undefined && params[k] !== null && k !== "sign"
    )
    .sort()
    .map((k) => k + params[k])
    .join("");
  return crypto
    .createHmac("sha256", secret)
    .update(base, "utf8")
    .digest("hex")
    .toUpperCase();
}

function parseProducts(raw) {
  const arr =
    raw?.aliexpress_affiliate_product_query_response?.resp_result?.result
      ?.products?.product ??
    raw?.resp_result?.result?.products?.product ??
    raw?.result?.products?.product ??
    [];
  return Array.isArray(arr) ? arr : [];
}

function normalize(p) {
  return {
    id: p.product_id,
    title: p.product_title,
    price: p.target_app_sale_price,
    currency: p.target_app_sale_price_currency,
    image: p.product_main_image_url,
    promotion_link: p.promotion_link, // s.click... 이 오면 제휴링크
    c1_id: p.first_level_category_id,
    c1_name: p.first_level_category_name,
    c2_id: p.second_level_category_id,
    c2_name: p.second_level_category_name,
    volume: p.lastest_volume,
    reviews: p.review_count,
  };
}

// ───────────────────────── 카테고리 페치 ─────────────────────────
async function fetchByCategory({ categoryId }) {
  const pageSize = 50;
  const allItems = [];
  let pageNo = 1;
  let lastRaw = null;
  let totalServerCount = 0;
  let totalFilteredCount = 0;

  while (true) {
    const params = {
      app_key: APP_KEY,
      method: METHOD,
      sign_method: "sha256",
      timestamp: Date.now(),
      v: "1.0",
      tracking_id: TRACKING_ID,
      page_no: pageNo,
      page_size: pageSize,
      target_language: "ko",
      target_currency: "KRW",
      ship_to_country: "KR",
      sort: "LAST_VOLUME_DESC",
      fields: FIELDS,
      category_ids: String(categoryId),
      category_id: String(categoryId),
    };
    params.sign = signSha256(params, APP_SECRET);

    const url = API + "?" + new URLSearchParams(params).toString();

    // 네트워크/429/5xx 재시도
    const raw = await fetchJsonWithRetry(url, {
      retries: 4,
      base: 600,
      factor: 2,
      jitter: 0.35,
      max: 10000,
      timeoutMs: 18000,
    }).catch((e) => {
      lastRaw = { fetch_error: String(e) };
      return null;
    });

    if (!raw) {
      return {
        items: allItems,
        raw: lastRaw,
        serverCount: totalServerCount,
        filteredCount: totalFilteredCount,
        note: "fetch_failed",
      };
    }

    lastRaw = raw;

    if (raw?.error_response) {
      return {
        items: allItems,
        raw,
        serverCount: totalServerCount,
        filteredCount: totalFilteredCount,
        note: "error_response",
      };
    }

    const products = parseProducts(raw);
    const filtered = products.filter(
      (p) =>
        Number(p.first_level_category_id) === Number(categoryId) ||
        Number(p.second_level_category_id) === Number(categoryId)
    );

    const final = (filtered.length ? filtered : products).map(normalize);

    totalServerCount += products.length;
    totalFilteredCount += filtered.length;

    if (final.length > 0) allItems.push(...final);

    // 종료 조건 수정: 마지막 페이지면 탈출
    if (products.length === 0 || products.length < pageSize) break;

    pageNo++;
  }

  return {
    items: allItems,
    raw: lastRaw,
    serverCount: totalServerCount,
    filteredCount: totalFilteredCount,
  };
}

// ───────────────────────── 메인 실행부 ─────────────────────────
(async () => {
  await mkdir("./popular_out", { recursive: true });

  const limit = pLimit(7); // 카테고리 동시 7개
  const listTasks = categorieList.items.slice(0, 7).map((item) =>
    limit(async () => {
      const { items, raw, serverCount, filteredCount, note } =
        await fetchByCategory({ categoryId: item.category_id });

      console.log({
        categoryId: item.category_id,
        serverCount,
        filteredCount,
        parsed: items.length,
        ...(note ? { note } : {}),
      });

      if (items.length) {
        console.log(items.slice(0, 3));
      } else {
        console.log(raw?.error_response ?? raw);
      }

      await writeFile(
        `popular_out/popular_${item.category_id}.json`,
        JSON.stringify({ count: items.length, items }, null, 2),
        "utf8"
      );

      return items;
    })
  );

  // 카테고리별 결과 수집 → 평탄화
  const productIdList = (await Promise.all(listTasks)).flat();

  // id 기준 중복 제거(Map: 마지막 항목 유지)
  const uniqueList = [
    ...new Map(productIdList.map((item) => [item.id, item])).values(),
  ];

  // SKU 상세 조회 동시성 제한 + 재시도
  const skuLimit = pLimit(5);
  const skuTasks = uniqueList.map((item) =>
    skuLimit(async () => {
      try {
        const skuData = await withRetry(() => getSkuDetail(item.id), {
          retries: 3,
          base: 800,
          max: 10000,
        });

        const r = skuData?.result ?? {};
        const addImgs =
          r?.ae_item_info?.additional_image_links?.string ??
          r?.ae_item_info?.additional_image_links ??
          [];

        const itemData = {
          id: item.id,
          volume: item.volume ?? null,
          promotion_link: item.promotion_link ?? null,
          original_link: r.original_link ?? null,
          // 카테고리(표시용): sku 결과 우선, 없으면 기존 값
          category_id_1: r.display_category_id_l1 ?? item.c1_id ?? null,
          category_id_2: r.display_category_id_l2 ?? item.c2_id ?? null,
          category_id_3: r.display_category_id_l3 ?? null,
          category_name_1: r.display_category_name_l1 ?? item.c1_name ?? null,
          category_name_2: r.display_category_name_l2 ?? item.c2_name ?? null,
          category_name_3: r.display_category_name_l3 ?? null,
          title: r.title ?? item.title ?? null,
          store_name: r.store_name ?? null,
          product_score: r.product_score ?? null,
          review_number: r.review_number ?? item.reviews ?? null,
          product_category: r.product_category ?? null,
          image_link: r.image_link ?? item.image ?? null,
          additional_image_links: Array.isArray(addImgs) ? addImgs : [addImgs],
          sku_info: {
            sku_info_list: r.ae_item_sku_info?.traffic_sku_info_list ?? [],
          },
        };

        return { ok: true, data: itemData };
      } catch (err) {
        return { ok: false, error: String(err), id: item.id };
      }
    })
  );

  const skuResults = await Promise.all(skuTasks);
  const ok = skuResults.filter((x) => x.ok).map((x) => x.data);
  const fail = skuResults.filter((x) => !x.ok);

  console.log(`SKU 상세 성공: ${ok.length} / 실패: ${fail.length}`);
  if (fail.length) console.log("실패 예시:", fail.slice(0, 3));

  await writeFile(
    "popular_out/combined_unique_list.json",
    JSON.stringify(uniqueList, null, 2),
    "utf8"
  );
  await writeFile(
    "popular_out/combined_sku_enriched.json",
    JSON.stringify(ok, null, 2),
    "utf8"
  );
})();
