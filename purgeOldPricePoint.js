// // scripts/purgeOldPricePoints.js
// import mongoose from "mongoose";
// import ProductDetail from "./models/ProductDetail.js";
// import dbConnect from "./utils/dbConnect.js";

// async function run() {
//   await dbConnect();

//   const now = new Date();
//   const monthAgo = new Date(now);
//   monthAgo.setMonth(monthAgo.getMonth() - 1);

//   const res = await ProductDetail.updateMany({}, [
//     {
//       $set: {
//         "sku_info.sil": {
//           // 1) 각 SKU의 pd를 monthAgo 이후 키만 남기도록 정리
//           $let: {
//             vars: {
//               cleaned: {
//                 $map: {
//                   input: { $ifNull: ["$sku_info.sil", []] },
//                   as: "s",
//                   in: {
//                     $mergeObjects: [
//                       "$$s",
//                       {
//                         pd: {
//                           $arrayToObject: {
//                             $filter: {
//                               input: {
//                                 $objectToArray: { $ifNull: ["$$s.pd", {}] },
//                               },
//                               as: "pp",
//                               cond: {
//                                 $gte: [
//                                   {
//                                     $dateFromString: {
//                                       dateString: "$$pp.k",
//                                       onError: new Date(0),
//                                       onNull: new Date(0),
//                                     },
//                                   },
//                                   monthAgo,
//                                 ],
//                               },
//                             },
//                           },
//                         },
//                       },
//                     ],
//                   },
//                 },
//               },
//             },
//             // 2) 정리 후 pd가 비어버린 SKU는 제거
//             in: {
//               $filter: {
//                 input: "$$cleaned",
//                 as: "s",
//                 cond: {
//                   $gt: [
//                     {
//                       $size: {
//                         $objectToArray: { $ifNull: ["$$s.pd", {}] },
//                       },
//                     },
//                     0,
//                   ],
//                 },
//               },
//             },
//           },
//         },
//       },
//     },
//   ]);

//   console.log(
//     `matched: ${res.matchedCount ?? res.n}, modified: ${
//       res.modifiedCount ?? res.nModified
//     }`
//   );

//   await mongoose.disconnect();
// }

// run().catch((e) => {
//   console.error(e);
//   process.exit(1);
// });
