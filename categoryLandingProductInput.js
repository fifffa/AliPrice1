import mongoose from "mongoose";
import ProductCategories from "./models/ProductCategories.js";
import ProductDetail from "./models/ProductDetail.js";
import dbConnect from "./utils/dbConnect.js";
import CategoryLandingProduct from "./models/CategoryLandingProduct.js";

// ── 기준: 현재로부터 4일
const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

// pd(Map|Object)에서 "가장 최근 날짜" 찾기
function getLatestPdTime(pd) {
  if (!pd || typeof pd !== "object") return null;

  let latest = null;

  // 1) 값 안의 t 우선 (구 데이터 호환)
  const vals = pd instanceof Map ? Array.from(pd.values()) : Object.values(pd);
  for (const v of vals) {
    const ts = v?.t ? Date.parse(v.t) : NaN;
    if (!Number.isNaN(ts)) latest = latest == null ? ts : Math.max(latest, ts);
  }

  // 2) t가 하나도 없으면 키(날짜 문자열) 기준
  if (latest == null) {
    const keys = pd instanceof Map ? Array.from(pd.keys()) : Object.keys(pd);
    for (const k of keys) {
      const ts = Date.parse(k);
      if (!Number.isNaN(ts)) {
        latest = latest == null ? ts : Math.max(latest, ts);
      }
    }
  }

  return latest == null ? null : new Date(latest);
}

const toNum = (v) =>
  v == null ? NaN : Number(String(v).replace(/[^\d.-]/g, ""));

/**
 * pd(Map | Object) → { p, s, t, ... }[] 로 통일
 * - t는 우선 키(날짜 문자열)를 Date로 파싱
 * - 안 되면 v.t / v.collected_at 사용 (구 구조 호환)
 */
const pdEntries = (pd) => {
  if (!pd || typeof pd !== "object") return [];

  const entries =
    pd instanceof Map ? Array.from(pd.entries()) : Object.entries(pd);

  return entries
    .map(([dateKey, v]) => {
      let t = null;

      // 1순위: 키(날짜 문자열)
      if (dateKey) {
        const d1 = new Date(dateKey);
        if (!Number.isNaN(d1.valueOf())) t = d1;
      }

      // 2순위: 값 안의 t / collected_at (구조 변경 이전 데이터)
      if (!t && v && (v.t || v.collected_at)) {
        const d2 = new Date(v.t || v.collected_at);
        if (!Number.isNaN(d2.valueOf())) t = d2;
      }

      if (!t) return null; // 날짜 해석 안 되면 버림

      return {
        ...v,
        t, // Date 객체
      };
    })
    .filter(Boolean);
};

// 날짜가 기간 안인지
const inRange = (t, start, end) => {
  const tt = t ? new Date(t).getTime() : NaN;
  if (!Number.isFinite(tt)) return true; // (방어용) 날짜 없으면 포함
  if (start && tt < new Date(start).getTime()) return false;
  if (end && tt > new Date(end).getTime()) return false;
  return true;
};

// 평균 "판매가" 계산: s(세일가) 우선, 없으면 p 사용
// ✅ 이제 pdEntries를 써서 "키 기반 날짜"로 기간 필터
const avgSaleFromPd = (pd, start, end) => {
  const nums = pdEntries(pd)
    .filter((pp) => inRange(pp?.t, start, end))
    .map((pp) => toNum(pp?.s ?? pp?.p))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
};

function getRange(rangeParam) {
  const now = new Date();
  if (rangeParam === "calendarMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start, end: now, label: "calendarMonth" };
  }
  const end = now;
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end, label: "rolling30" };
}

/**
 * pdObj(Map | Object)를 기간 내 포인트들 기준으로 분석
 * - lowestSale: 기간 내 최저 s
 * - latestSale: 기간 내 가장 최근 포인트의 s
 * - isFlat: 기간 내 s가 전부 같은지 여부
 */
function analyzePd(pdObj, start, end) {
  if (!pdObj || typeof pdObj !== "object") {
    return {
      lowestSale: null,
      lowestPoints: [],
      latestSale: null,
      latestPoint: null,
      isFlat: false,
    };
  }

  // ✅ pdEntries를 사용해서 키 기반 날짜까지 반영
  const all = pdEntries(pdObj)
    .map((v) => {
      const t = v?.t ? new Date(v.t) : null;
      const rawS = v?.s ?? v?.p ?? null;
      const s = rawS == null ? null : Number(rawS);
      const p = v?.p ?? null;
      return t ? { p, s, t } : null;
    })
    .filter(Boolean);

  const inRangePoints = all.filter(
    ({ t, s }) => t >= start && t < end && s != null
  );

  if (inRangePoints.length === 0) {
    return {
      lowestSale: null,
      lowestPoints: [],
      latestSale: null,
      latestPoint: null,
      isFlat: false,
    };
  }

  // flat 판단: s 유니크 개수
  const uniqS = new Set(inRangePoints.map(({ s }) => s));
  const isFlat = uniqS.size <= 1; // 기간 내 내내 같은 가격이면 true

  // 최저 s
  let lowestSale = null;
  for (const { s } of inRangePoints) {
    lowestSale = lowestSale == null ? s : Math.min(lowestSale, s);
  }
  const lowestPoints = inRangePoints.filter(({ s }) => s === lowestSale);

  // 최신 포인트(가장 큰 t)
  let latestPoint = null;
  for (const pt of inRangePoints) {
    if (!latestPoint || pt.t > latestPoint.t) latestPoint = pt;
  }
  const latestSale = latestPoint?.s ?? null;

  return { lowestSale, lowestPoints, latestSale, latestPoint, isFlat };
}

async function getServerSideProps(ctx) {
  await dbConnect();

  const categoryList = [
    { categoryName: "음식", categoryId: "2" },
    { categoryName: "가전제품", categoryId: "6" },
    { categoryName: "태블릿", categoryId: "200001086" },
    { categoryName: "문구", categoryId: "21" },
    { categoryName: "생활용품", categoryId: "13" },
    { categoryName: "뷰티/헬스", categoryId: "66" },
    { categoryName: "주방용품", categoryId: "200000920" },
    { categoryName: "남성의류", categoryId: "200000343" },
    { categoryName: "여성의류", categoryId: "200000345" },
    { categoryName: "신발", categoryId: "322" },
    { categoryName: "스포츠", categoryId: "18" },
    { categoryName: "완구/취미", categoryId: "26" },
    { categoryName: "자동차용품", categoryId: "34" },
    { categoryName: "안전/보안", categoryId: "30" },
    { categoryName: "조명", categoryId: "39" },
  ];

  const allProductPsList = [];
  const allProductVolList = [];
  const allProductRnList = [];
  const allProductOffList = [];

  const { start, end, label: range } = getRange(undefined);

  // 1) 카테고리별 원문 조회 및 분석
  for (let category of categoryList) {
    const catDoc = await ProductCategories.findOne({
      cId: String(category.categoryId),
    }).lean();
    const cid = catDoc?._id?.toString();

    let raw = await ProductDetail.find({ cId1: cid }).lean();
    if (!raw?.length) raw = await ProductDetail.find({ cId2: cid }).lean();

    const allSkus = [];

    // ─────────────────────────────────────
    // ① 평균가 대비 현재가가 가장 싸게 내려와 있는 리스트 (offList 후보)
    const offList = raw
      .map((doc) => {
        const sil = doc?.sku_info?.sil || [];

        const sku_filtered = sil
          .map((sku) => {
            const { lowestSale, latestSale, isFlat } = analyzePd(
              sku?.pd,
              start,
              end
            );

            if (!doc._id) return null;

            // 기간 내 포인트 없거나 flat 제거
            if (lowestSale == null || latestSale == null) return null;
            if (isFlat) return null;

            // 최신가가 기간 최저가와 같지 않으면 제거
            if (Number(latestSale) !== Number(lowestSale)) return null;

            // 최신 가격 포인트 날짜(키/혹은 구 t 기준) 가져오기
            const latestPdAt = getLatestPdTime(sku?.pd);
            const now = new Date();
            const newerThan4d =
              latestPdAt &&
              now.getTime() - latestPdAt.getTime() <= FOUR_DAYS_MS;

            if (!newerThan4d) return null;

            // ★ 평균 판매가 계산 (기간 내)
            const avgSale = avgSaleFromPd(sku?.pd, start, end);
            if (avgSale == null || !Number.isFinite(avgSale) || avgSale <= 0)
              return null;

            const latest = Number(latestSale);
            const ratio = latest / avgSale; // 낮을수록 "평균 대비 현재가"가 저렴

            // 상위 랭킹용 풀 컬렉션에 적재
            allSkus.push({
              pid: String(doc._id),
              _id: String(doc._id),
              sId: sku?.sId,
              link: sku?.link,
              c: sku?.c,
              sp: sku?.sp,
              cur: sku?.cur || "KRW",
              latestSale: latest,
              avgSale,
              ratio,
            });

            // 필요 시 제품 내부용 데이터 유지하려면 리턴 유지
            return {
              pid: String(doc._id),
              _id: String(doc._id),
              sId: sku?.sId,
              link: sku?.link,
              c: sku?.c,
              sp: sku?.sp,
              cur: sku?.cur || "KRW",
              pd: sku?.pd || {},
              latest_sale: latest,
              avg_sale: avgSale,
              ratio,
            };
          })
          .filter(Boolean);

        if (sku_filtered.length === 0) return null;

        return {
          _id: doc._id,
          // 필요하면 sku_filtered를 보존:
          // sku_info: sku_filtered,
        };
      })
      .filter(Boolean);

    // ─────────────────────────────────────
    // ② 리뷰 많은 순 리스트 (rnList)
    const rnList = raw
      .map((doc) => {
        const sil = doc?.sku_info?.sil || [];

        const sku_filtered = sil
          .map((sku) => {
            const { lowestSale, latestSale, isFlat } = analyzePd(
              sku?.pd,
              start,
              end
            );

            if (lowestSale == null || latestSale == null) return null;
            if (isFlat) return null;

            const latestPdAt = getLatestPdTime(sku?.pd);
            const now = new Date();
            const newerThan4d =
              latestPdAt &&
              now.getTime() - latestPdAt.getTime() <= FOUR_DAYS_MS;

            if (!newerThan4d) return null;

            return { sId: sku?.sId };
          })
          .filter(Boolean);

        if (sku_filtered.length === 0) return null;

        return {
          _id: doc._id,
          rn: doc.rn,
        };
      })
      .filter(Boolean);

    // ─────────────────────────────────────
    // ③ 판매량 많은 순 리스트 (volList)
    const volList = raw
      .map((doc) => {
        const sil = doc?.sku_info?.sil || [];

        const sku_filtered = sil
          .map((sku) => {
            const { lowestSale, latestSale, isFlat } = analyzePd(
              sku?.pd,
              start,
              end
            );

            if (lowestSale == null || latestSale == null) return null;
            if (isFlat) return null;

            const latestPdAt = getLatestPdTime(sku?.pd);
            const now = new Date();
            const newerThan4d =
              latestPdAt &&
              now.getTime() - latestPdAt.getTime() <= FOUR_DAYS_MS;

            if (!newerThan4d) return null;

            return { sId: sku?.sId };
          })
          .filter(Boolean);

        if (sku_filtered.length === 0) return null;

        return {
          _id: doc._id,
          vol: doc.vol,
        };
      })
      .filter(Boolean);

    // ─────────────────────────────────────
    // ④ 평점 높은 순 리스트 (psList)
    const psList = raw
      .map((doc) => {
        const sil = doc?.sku_info?.sil || [];

        const sku_filtered = sil
          .map((sku) => {
            const { lowestSale, latestSale, isFlat } = analyzePd(
              sku?.pd,
              start,
              end
            );

            if (lowestSale == null || latestSale == null) return null;
            if (isFlat) return null;

            const latestPdAt = getLatestPdTime(sku?.pd);
            const now = new Date();
            const newerThan4d =
              latestPdAt &&
              now.getTime() - latestPdAt.getTime() <= FOUR_DAYS_MS;

            if (!newerThan4d) return null;

            return { sId: sku?.sId };
          })
          .filter(Boolean);

        if (sku_filtered.length === 0) return null;

        return {
          _id: doc._id,
          ps: doc.ps,
          // sku: sku_filtered,
        };
      })
      .filter(Boolean);

    // ─────────────────────────────────────
    // 카테고리 내 Top20 추리기

    const psTop20 = psList
      .sort((a, b) => b.ps - a.ps)
      .slice(0, 20)
      .map((item) => {
        allProductPsList.push(item);
        return item._id;
      });

    const volTop20 = volList
      .sort((a, b) => b.vol - a.vol)
      .slice(0, 20)
      .map((item) => {
        allProductVolList.push(item);
        return item._id;
      });

    const rnTop20 = rnList
      .sort((a, b) => b.rn - a.rn)
      .slice(0, 20)
      .map((item) => {
        allProductRnList.push(item);
        return item._id;
      });

    // ─────────────────────────────────────
    // 카테고리 내 할인 Top20 (ratio 낮은 순)
    // allSkus: { pid, _id, sId, c, sp, cur, latestSale, avgSale, ratio }

    const offTop20 = [];
    const seen = new Set();

    for (const item of allSkus.sort(
      (a, b) => a.ratio - b.ratio || a.latestSale - b.latestSale
    )) {
      const product = item.productId ?? item._id ?? item.pid;
      if (!product) continue;

      const key =
        product?.toHexString?.() ?? product?.toString?.() ?? String(product);
      if (seen.has(key)) continue;
      seen.add(key);

      offTop20.push({
        product,
        sId: item.sId ?? null,
        c: item.c ?? null,
        sp: item.sp,
      });

      if (offTop20.length === 20) break;
    }

    // 카테고리별 집계 결과를 전체 랭킹 풀에도 쌓기
    allProductOffList.push(...allSkus); // 전체 할인 랭킹 후보
    allProductRnList.push(...rnTop20);
    allProductPsList.push(...psTop20);
    allProductVolList.push(...volTop20);

    // 카테고리 문서 업데이트
    await CategoryLandingProduct.updateOne(
      { categoryName: category.categoryName },
      {
        $set: {
          rnList: rnTop20,
          volList: volTop20,
          psList: psTop20,
          offList: offTop20,
        },
        $setOnInsert: { categoryName: category.categoryName },
      },
      { runValidators: true, upsert: true }
    );
  }

  // ─────────────────────────────────────
  // 전체 카테고리(“전체”)용 Top20 계산

  const allProductPsTop20 = allProductPsList
    .sort((a, b) => b.ps - a.ps)
    .slice(0, 20)
    .map((item) => item._id);

  const allProductVolTop20 = allProductVolList
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 20)
    .map((item) => item._id);

  const allProductRnTop20 = allProductRnList
    .sort((a, b) => b.rn - a.rn)
    .slice(0, 20)
    .map((item) => item._id);

  const allProductOffTop20 = [];
  const seen = new Set();

  for (const item of allProductOffList.sort(
    (a, b) => a.ratio - b.ratio || a.latestSale - b.latestSale
  )) {
    const product = item.productId ?? item._id ?? item.pid;
    if (!product) continue;

    const key =
      product?.toHexString?.() ?? product?.toString?.() ?? String(product);
    if (seen.has(key)) continue;
    seen.add(key);

    allProductOffTop20.push({
      product,
      c: item.c ?? null,
      sp: item.sp,
      sId: item.sId ?? null,
    });

    if (allProductOffTop20.length === 20) break;
  }

  await CategoryLandingProduct.updateOne(
    { categoryName: "전체" },
    {
      $set: {
        rnList: allProductRnTop20,
        volList: allProductVolTop20,
        psList: allProductPsTop20,
        offList: allProductOffTop20,
      },
      $setOnInsert: { categoryName: "전체" },
    },
    { runValidators: true, upsert: true }
  );

  process.exit(0);
}

async function test() {
  await dbConnect();
  const res = await CategoryLandingProduct.find({
    categoryName: "음식",
  })
    .populate({
      path: "rnList",
      model: "ProductDetail",
    })
    .lean();

  console.log("res:", res[0].rnList);
}
// test();

getServerSideProps();
