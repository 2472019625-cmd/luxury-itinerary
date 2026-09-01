import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(fs.readFileSync(path.join(root, "data", "sample-itinerary-africa.json"), "utf8"));
const errors = [];

if (data.days.length !== 10) errors.push(`预期10天，实际${data.days.length}天`);
if (!data.hotels?.length) errors.push("缺少精选住宿数据");
if (!data.transportSummary?.length) errors.push("缺少全程交通数据");
if (data.highlights?.length !== 6) errors.push("产品亮点应由公司优势与路线差异化组成6项");
if (!data.hotelReplacementPolicy) errors.push("缺少住宿板块统一说明");
if (!data.transportDisclaimer) errors.push("缺少交通板块统一说明");
for (const [index, day] of data.days.entries()) {
  if (!day.theme) errors.push(`DAY ${index + 1} 缺少每日主题`);
  if (!day.routeNodes?.length) errors.push(`DAY ${index + 1} 缺少路线节点`);
  if (!day.estimatedTravelTime) errors.push(`DAY ${index + 1} 缺少预计移动时间`);
  if (!day.mealPlan) errors.push(`DAY ${index + 1} 缺少结构化餐食`);
  if (![2, 4].includes(day.spots?.length)) errors.push(`DAY ${index + 1} 图片数为${day.spots?.length || 0}，必须为2或4`);
  for (const spot of day.spots || []) {
    if (/原始资料照片|经地点核验/.test(spot.description || "")) errors.push(`DAY ${index + 1} 客户文案暴露内部图片溯源措辞：${spot.name}`);
    const file = path.join(root, "public", spot.image.replace(/^\//, ""));
    if (!fs.existsSync(file)) errors.push(`DAY ${index + 1} 缺失图片：${spot.image}`);
  }
}
for (const hotel of data.hotels || []) {
  if (hotel.status) errors.push(`住宿总览不应展示逐卡状态：${hotel.officialName}`);
  if (!hotel.editorialCopy || !hotel.proofPoints?.length) errors.push(`酒店缺少高端价值叙事：${hotel.officialName}`);
  for (const image of hotel.images || []) {
    if (image.label) errors.push(`酒店图片不应带右下角角标：${hotel.officialName}`);
    if (!image.src.includes("/hotels/")) errors.push(`酒店未使用真实酒店素材：${hotel.officialName}`);
    const file = path.join(root, "public", image.src.replace(/^\//, ""));
    if (!fs.existsSync(file)) errors.push(`酒店缺失图片：${image.src}`);
  }
}
for (const transport of data.transportSummary || []) {
  if (transport.disclaimer) errors.push(`交通说明应统一放在板块底部：${transport.category}`);
  if (!transport.editorialCopy) errors.push(`交通缺少体验价值叙事：${transport.category}`);
  for (const image of transport.images || []) {
    if (image.label) errors.push(`交通图片不应带右下角角标：${transport.category}`);
    const file = path.join(root, "public", image.src.replace(/^\//, ""));
    if (!fs.existsSync(file)) errors.push(`交通缺失图片：${image.src}`);
  }
}
if (data.startDate || data.endDate) errors.push("原资料没有日期，不应自行补写日期");
if (data.designer) errors.push("原资料没有定制师信息，不应套用样例定制师");

const result = { passed: errors.length === 0, dayCount: data.days.length, imageCounts: data.days.map((day) => day.spots.length), errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exitCode = 1;
