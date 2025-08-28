// filename: fetchPopularKR.fixed.js
// Node 18+, package.json: { "type": "module" }
import crypto from "crypto";
import "dotenv/config";
import pLimit from "p-limit";
import { getSkuDetail } from "./skuIdPruductSearch.js";
import ProductDetail from "./models/productDetail.js";
import categorieList from "./categorieList.json" assert { type: "json" };
import dbConnect from "./utils/dbConnect.js";
import { dateKeyKST } from "./utils/dateKeyKST.js";
import mongoose from "mongoose";
import { assert } from "console";
const API = "https://api-sg.aliexpress.com/sync";
const METHOD = "aliexpress.affiliate.product.query";

const APP_KEY = process.env.AE_APP_KEY;
const APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.AE_TRACKING_ID;

const norm = (v) =>
  (v ?? "") // null/undefined 방어
    .toString() // 문자열화
    .replace(/[\s\u200B-\u200D\uFEFF]/g, ""); // 일반 공백 + 제로폭 공백 제거

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

/**
 * fetch → JSON 파싱까지 포함한 재시도 래퍼
 * - 429/5xx/타임아웃/네트워크 오류(ECONNRESET 등) 시 지수백오프(+지터)로 재시도
 */
async function fetchJsonWithRetry(
  url,
  {
    retries = 4, // 총 5회(0..4)
    base = 600, // 시작 지연(ms)
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

      // 429/5xx → 재시도
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

      // 그 외 4xx → 즉시 실패
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

/**
 * 임의 함수 재시도(예: getSkuDetail)
 */
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
      if (!transient && attempt === 0) throw err; // 비일시적이면 즉시
      if (attempt === retries) throw err;
      const delay = calcDelay({ base, factor, attempt, jitter, max });
      await sleep(delay);
    }
  }
}

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
    _id: p.product_id,
    title: p.product_title,
    price: p.target_app_sale_price,
    currency: p.target_app_sale_price_currency,
    image: p.product_main_image_url,
    promotion_link: p.promotion_link,
    c1_id: p.first_level_category_id,
    c1_name: p.first_level_category_name,
    c2_id: p.second_level_category_id,
    c2_name: p.second_level_category_name,
    volume: p.lastest_volume,
    reviews: p.review_count,
  };
}

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
      timestamp: Date.now(), // epoch(ms)
      v: "1.0",
      // biz
      tracking_id: TRACKING_ID,
      page_no: pageNo,
      page_size: pageSize,
      target_language: "ko",
      target_currency: "KRW",
      ship_to_country: "KR",
      // country: "KR", // 필요 시만 사용
      sort: "LAST_VOLUME_DESC",
      fields: FIELDS,
      // 카테고리: 서버가 먹는 키를 모두 전달
      category_ids: String(categoryId),
      category_id: String(categoryId),
      // keywords: "", // 섞임 방지로 비움
    };
    params.sign = signSha256(params, APP_SECRET);

    const url = API + "?" + new URLSearchParams(params).toString();
    // const res = await fetch(url);
    // const raw = await res.json().catch(() => ({}));
    const raw = await fetchJsonWithRetry(url);

    lastRaw = raw;

    // 에러 그대로 전달하되, 형태는 아래 호출부와 호환되게 유지
    if (raw?.error_response) {
      return {
        items: [],
        raw,
        serverCount: 0,
        filteredCount: 0,
        note: "error_response",
      };
    }

    // 서버 반환
    const products = parseProducts(raw);
    const filtered = products.filter(
      (p) =>
        Number(p.first_level_category_id) === Number(categoryId) ||
        Number(p.second_level_category_id) === Number(categoryId)
    );

    const final = (filtered.length ? filtered : products).map(normalize);

    totalServerCount += products.length;
    totalFilteredCount += filtered.length;

    // 현 페이지 결과 누적
    if (final.length > 0) {
      allItems.push(...final);
    }

    // 종료 조건:
    // - 서버가 더 이상 주지 않음 (0개)
    // - 페이지 크기 미만(마지막 페이지로 추정)
    if (products.length === 0 && products.length < pageSize) {
      break;
    }

    pageNo++;
  }

  return {
    items: allItems,
    raw: lastRaw, // 마지막 페이지 raw
    serverCount: totalServerCount,
    filteredCount: totalFilteredCount,
  };
}

(async () => {
  const limit = pLimit(10); // 동시에 7개만 실행

  await dbConnect();

  const listTasks = categorieList.items.slice(0, 75).map((item) =>
    limit(async () => {
      const { items, raw, serverCount, filteredCount, note } =
        await fetchByCategory({
          categoryId: item.category_id,
        });

      let res;

      if (!item.parent_category_id) {
        res = await ProductDetail.find({ category_id_1: item.category_id });
      } else {
        res = await ProductDetail.find({ category_id_2: item.category_id });
      }

      if (items.length) {
        console.log(items.slice(0, 5));
      } else {
        console.log(raw?.error_response ?? raw);
      }

      return items;
    })
  );

  // 모든 태스크를 실행 (7개 동시 제한)
  const productIdList = (await Promise.all(listTasks)).flat();
  const uniqueList = [
    ...new Map(
      productIdList
        .filter((item) => item.volume >= 50) // 🔹 volume 조건 먼저 적용
        .map((item) => {
          console.log("item._id:", item._id);
          return [item._id, item];
        })
    ).values(),
  ];

  const failedIds = []; // 실패한 상품 ID 모으기

  // 날짜키: "YYYY-MM-DD" (KST, +9)

  // await ProductDetail.deleteMany({})

  const toNum = (v) => (v == null ? v : Number(v));

  await Promise.all(
    uniqueList.map((item) =>
      limit(async () => {
        try {
          // 0) 외부 API
          const skuData = await withRetry(() => getSkuDetail(item._id), {
            retries: 3,
            base: 800,
            max: 10000,
          });

          const info = skuData?.ae_item_info ?? {};
          const sku = skuData?.ae_item_sku_info ?? {};
          const skuList = sku.traffic_sku_info_list ?? [];

          // 1) 공통 파생값 (한 번만)
          const productId = toNum(item._id);
          const todayKey = dateKeyKST(); // "YYYY-MM-DD" (KST)

          // 2) 본문(upsert) 베이스
          const baseDoc = {
            volume: item.volume ?? 0,

            original_link: info.original_link ?? "",
            promotion_link: item.promotion_link ?? "",

            category_id_1: info?.display_category_id_l1 ?? 0,
            category_id_2: info?.display_category_id_l2 ?? 0,
            category_id_3: info?.display_category_id_l3 ?? 0,
            category_name_1: info?.display_category_name_l1 ?? "",
            category_name_2: info?.display_category_name_l2 ?? "",
            category_name_3: info?.display_category_name_l3 ?? "",

            title: info.title ?? "",
            store_name: info.store_name ?? "",
            product_score: info.product_score ?? 0,
            review_number: info.review_number ?? 0,

            image_link: info.image_link ?? "",
            additional_image_links: info.additional_image_links?.string ?? [],
          };

          // 3) 최초 생성 시에만 넣을 SKU 전체(오늘 포인트 포함)
          const skusForInsert = skuList.map((s) => ({
            sku_id: s.sku_id,
            color: s.color ?? "",
            link: s.link,
            sku_properties: s.sku_properties ?? "",
            currency: s.currency ?? "KRW",
            price_by_date: {
              [todayKey]: {
                price_with_tax: s.price_with_tax,
                sale_price_with_tax: s.sale_price_with_tax,
                collected_at: new Date(),
              },
            },
          }));

          // 4) 기존 문서의 sku_id 집합만 얇게 조회
          const doc = await ProductDetail.findById(productId, {
            _id: 0,
            "sku_info.sku_info_list": 1,
          }).lean();

          const existingIds = new Set(
            doc?.sku_info?.sku_info_list?.map((d) => d.sku_id) ?? []
          );

          const newSkus = [];
          const updSkus = [];
          const lowPriceUpdSkus = [];

          for (const s of skuList) {
            if (s?.sku_id == null) continue;
            if (!existingIds.has(s.sku_id)) {
              newSkus.push(s);
              continue;
            }
            const sColor = norm(s?.color);
            if (doc?.sku_info?.sku_info_list) {
              for (let sku of doc?.sku_info?.sku_info_list) {
                const skuColor = norm(sku?.color);
                if (
                  Number(sku?.sku_id) === Number(s?.sku_id) &&
                  skuColor === sColor
                ) {
                  if (
                    sku?.price_by_date[`${todayKey}`] &&
                    Number(
                      sku?.price_by_date[`${todayKey}`]?.sale_price_with_tax
                    ) > Number(s?.sale_price_with_tax)
                  ) {
                    lowPriceUpdSkus.push(s);
                  } else if (!sku?.price_by_date[`${todayKey}`]) {
                    updSkus.push(s);
                  }
                }
              }
            }
          }

          // 5) bulkWrite 준비
          const ops = [];

          // 5-1) 본문 upsert (문서가 없다면 productId와 sku 전체를 한 번에 삽입)
          ops.push({
            updateOne: {
              filter: { _id: productId },
              update: {
                $set: baseDoc,
                $setOnInsert: {
                  productId,
                  "sku_info.sku_info_list": skusForInsert,
                },
              },
              upsert: true,
            },
          });

          // 5-2) 금일 첫 sku 업데이트
          //      (각 SKU당 1개 updateOne, 하지만 네트워크는 bulk로 1회 전송)
          for (const s of updSkus) {
            const pricePoint = {
              price_with_tax: s.price_with_tax,
              sale_price_with_tax: s.sale_price_with_tax,
              discount_rate: s.discount_rate ?? 0,
              currency: s.currency ?? "KRW",
              collected_at: new Date(),
            };

            ops.push({
              updateOne: {
                filter: {
                  productId,
                  "sku_info.sku_info_list.sku_id": s.sku_id,
                },
                update: {
                  $set: {
                    "sku_info.sku_info_list.$[e].price_with_tax":
                      s.price_with_tax,
                    "sku_info.sku_info_list.$[e].sale_price_with_tax":
                      s.sale_price_with_tax,
                    "sku_info.sku_info_list.$[e].discount_rate":
                      s.discount_rate ?? 0,
                    "sku_info.sku_info_list.$[e].currency": s.currency ?? "KRW",
                    "sku_info.sku_info_list.$[e].link": s.link,
                    "sku_info.sku_info_list.$[e].color": s.color ?? "",
                    "sku_info.sku_info_list.$[e].sku_properties":
                      s.sku_properties ?? "",
                    [`sku_info.sku_info_list.$[e].price_by_date.${todayKey}`]:
                      pricePoint,
                  },
                },
                arrayFilters: [{ "e.sku_id": s.sku_id }],
              },
            });
          }
          // 5-3) 오늘 최저가 새로 갱신한 sku들을 한 번에 push
          const safe = (v, d = "") => (v == null ? d : v);

          for (const s of lowPriceUpdSkus) {
            const sid = Number(s.sku_id);
            if (!Number.isFinite(sid)) continue;

            const pricePoint = {
              price_with_tax: Number(s.price_with_tax),
              sale_price_with_tax: Number(s.sale_price_with_tax),
              discount_rate: Number(s.discount_rate ?? 0),
              currency: safe(s.currency, "KRW"),
              collected_at: new Date(), // 키에 점만 없으면 OK
            };

            // todayKey는 점(.)이 없어야 함. 필요 시 sanitize
            // const todayKeySafe = String(todayKey).replace(/\./g, "_");

            ops.push({
              updateOne: {
                filter: {
                  _id: productId, // 스키마 확인!
                  "sku_info.sku_info_list.sku_id": sid, // 타입 통일
                },
                update: {
                  $set: {
                    "sku_info.sku_info_list.$[e].price_with_tax":
                      pricePoint.price_with_tax,
                    "sku_info.sku_info_list.$[e].sale_price_with_tax":
                      pricePoint.sale_price_with_tax,
                    "sku_info.sku_info_list.$[e].discount_rate":
                      pricePoint.discount_rate,
                    "sku_info.sku_info_list.$[e].currency": pricePoint.currency,
                    "sku_info.sku_info_list.$[e].link": safe(s.link, ""),
                    "sku_info.sku_info_list.$[e].color": safe(s.color, ""),
                    "sku_info.sku_info_list.$[e].sku_properties": safe(
                      s.sku_properties,
                      ""
                    ),
                    [`sku_info.sku_info_list.$[e].price_by_date.${todayKey}`]:
                      pricePoint,
                  },
                },
                arrayFilters: [{ "e.sku_id": sid }], // 타입 통일
              },
            });
          }
          // 5-4) 새로 발견된 sku들을 한 번에 push
          if (newSkus.length > 0 && doc) {
            const toPush = newSkus.map((s) => ({
              sku_id: s.sku_id,
              color: s.color ?? "",
              link: s.link,
              price_with_tax: s.price_with_tax,
              sale_price_with_tax: s.sale_price_with_tax,
              discount_rate: s.discount_rate ?? 0,
              sku_properties: s.sku_properties ?? "",
              currency: s.currency ?? "KRW",
              price_by_date: {
                [todayKey]: {
                  price_with_tax: s.price_with_tax,
                  sale_price_with_tax: s.sale_price_with_tax,
                  discount_rate: s.discount_rate ?? 0,
                  currency: s.currency ?? "KRW",
                  collected_at: new Date(),
                },
              },
            }));

            ops.push({
              updateOne: {
                filter: { productId },
                update: {
                  $push: { "sku_info.sku_info_list": { $each: toPush } },
                },
              },
            });
          }

          // 6) 일괄 실행 (유효성 검사는 스키마에 맡기고, 업데이트 검증은 생략)

          if (ops.length) {
            await ProductDetail.bulkWrite(ops, {
              ordered: false,
              writeConcern: { w: 1 },
            });
          }
        } catch (err) {
          const pid =
            (err &&
              typeof err === "object" &&
              "productId" in err &&
              err.productId) ||
            item._id;
          failedIds.push(pid);
          console.warn("getSkuDetail 실패", {
            productId: pid,
            code: err?.code,
            sub_code: err?.sub_code,
            message: err?.message,
          });
        }
      })
    )
  );

  console.log("실패한 상품 IDs:", failedIds);

  process.exit(0);
  // console.log("uniqueList:", uniqueList);
})();
