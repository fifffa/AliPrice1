import data from "./categorieList.json" assert { type: "json" };
import ProductCategories from "./models/productCategories.js";
import dbConnect from "./util/dbConnect.js";

async function inputData() {
  await dbConnect();

  for (const item of data.items) {
    const parentId = Number(item.parent_category_id);
    const catId = Number(item.category_id);
    const name = String(item.category_name || "").trim();
    if (!Number.isFinite(parentId) || !Number.isFinite(catId) || !name)
      continue;

    await ProductCategories.updateOne(
      {}, // 단일 문서
      {
        $addToSet: {
          list: {
            parent_category_id: parentId,
            category_name: name,
            category_id: catId,
          },
        },
      },
      { upsert: true }
    );
  }

  console.log("done");
}

inputData();
