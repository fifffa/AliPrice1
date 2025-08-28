import mongoose from "mongoose";

// 배열 원소 스키마 (_id 제거)
const CategoryItemSchema = new mongoose.Schema(
  {
    parent_category_id: { type: Number, required: true },
    category_name: { type: String, required: true },
    category_id: { type: Number, required: true },
  },
  { _id: false }
);

// 루트 스키마 (여기에 versionKey 등 옵션)
const ProductCategoriesSchema = new mongoose.Schema(
  {
    list: { type: [CategoryItemSchema], default: [] },
  },
  { versionKey: false }
);

// category_id의 전역 유니크 보장 (멀티키 유니크 인덱스)
// - 문서 간 중복 금지
// - 같은 문서(list 내부) 중복도 금지
ProductCategoriesSchema.index(
  { "list.parent_category_id": 1, "list.category_id": 1 },
  { unique: true }
);

const ProductCategories =
  mongoose.models.ProductCategories ||
  mongoose.model("ProductCategories", ProductCategoriesSchema); // ← 공백 제거

export default ProductCategories;
