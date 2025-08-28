// models/ProductDetail.js
import mongoose from "mongoose";
import { kstISO } from "../utils/kstISO.js";

const toNumber = (v) =>
  v == null ? undefined : Number(String(v).replace(/[^\d.-]/g, ""));

// 날짜별 가격 포인트
const PricePointSchema = new mongoose.Schema(
  {
    price_with_tax: { type: Number, set: toNumber, required: true },
    sale_price_with_tax: { type: Number, set: toNumber, required: true },
    collected_at: { type: Date, default: () => kstISO() },
  },
  { _id: false }
);

// SKU 1개
const SkuInfoItemSchema = new mongoose.Schema(
  {
    sku_id: { type: Number, required: true }, // 키
    color: { type: String, default: "" },
    link: { type: String, required: true },

    // 최신가(스냅샷)
    sku_properties: { type: String, default: "" },
    currency: { type: String, default: "KRW" },

    // ✅ 날짜별 가격 이력 (Map)
    // key: "YYYY-MM-DD" (KST 기준 권장)
    price_by_date: {
      type: Map,
      of: PricePointSchema,
      default: () => ({}),
    },
  },
  { _id: false }
);

// SKU 컨테이너
const SkuInfoSchema = new mongoose.Schema(
  {
    sku_info_list: {
      type: [SkuInfoItemSchema],
      default: [],
      // 같은 문서 내 sku_id 중복 방지
      validate: {
        validator(arr) {
          const ids = arr.map((x) => x.sku_id).filter((x) => x != null);
          return ids.length === new Set(ids).size;
        },
        message: "sku_info_list 내 sku_id가 중복되었습니다.",
      },
    },
  },
  { _id: false }
);

// 상품 1문서 = 1상품
const ProductDetailSchema = new mongoose.Schema(
  {
    _id: { type: Number, alias: "productId", required: true },
    volume: { type: Number, required: true },

    original_link: { type: String, required: true },
    promotion_link: { type: String, required: true },

    category_id_1: { type: Number, required: true },
    category_id_2: { type: Number },
    category_id_3: { type: Number },
    category_name_1: { type: String, required: true },
    category_name_2: { type: String },
    category_name_3: { type: String },

    title: { type: String, required: true },
    store_name: { type: String, required: true },
    product_score: { type: Number, required: true },
    review_number: { type: Number, required: true },

    image_link: { type: String, required: true },
    additional_image_links: { type: [String], default: [] },

    sku_info: { type: SkuInfoSchema, default: () => ({ sku_info_list: [] }) },
  },
  { versionKey: false, timestamps: false, id: false }
);

// 조회 가속
ProductDetailSchema.index({ "sku_info.sku_info_list.sku_id": 1 });

const ProductDetail =
  mongoose.models.ProductDetail ||
  mongoose.model("ProductDetail", ProductDetailSchema);

export default ProductDetail;
