import mongoose from "mongoose";
import ProductDetail from "./ProductDetail.js";

const CategoryLandingProductSchema = new mongoose.Schema(
  {
    categoryName: String,
    rnList: [
      {
        type: String,
        ref: "ProductDetail",
      },
    ],
    volList: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductDetail",
      },
    ],
    psList: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductDetail",
      },
    ],
    offList: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductDetail",
      },
    ],
  },
  { versionKey: false }
);

const CategoryLandingProduct =
  mongoose.models.CategoryLandingProduct ||
  mongoose.model("CategoryLandingProduct", CategoryLandingProductSchema); // ← 공백 제거

export default CategoryLandingProduct;
