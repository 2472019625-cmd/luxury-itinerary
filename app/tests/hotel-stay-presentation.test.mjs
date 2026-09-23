import assert from "node:assert/strict";
import test from "node:test";
import { deriveHotelStayLine } from "../src/lib/hotelStayPresentation.js";

const hotels = [
  { officialName: "Angama Amboseli", shortName: "Angama安博塞利", region: "安博塞利 · 乞力马扎罗雪山视野", nights: 2 },
  { officialName: "The Ritz-Carlton, Masai Mara Safari Camp", shortName: "马赛马拉丽思卡尔顿营地", region: "马赛马拉国家保护区", nights: 2 },
  { officialName: "Saruni Leopard Hill", shortName: "Saruni豹山营地", region: "Naboisho 私人保护区", nights: 2 },
];

const days = [
  { hotel: "Angama Amboseli", hotelShortName: "Angama安博塞利", routeNodes: ["乔莫·肯雅塔国际机场", "内罗毕", "安博塞利国家公园", "Angama安博塞利"] },
  { hotel: "Angama Amboseli", hotelShortName: "Angama安博塞利", routeNodes: ["Angama安博塞利", "安博塞利核心区"] },
  { hotel: "The Ritz-Carlton, Masai Mara Safari Camp", hotelShortName: "马赛马拉丽思卡尔顿营地", routeNodes: ["安博塞利", "草原小飞机", "马赛马拉", "马赛马拉丽思卡尔顿营地"] },
  { hotel: "The Ritz-Carlton, Masai Mara Safari Camp", hotelShortName: "马赛马拉丽思卡尔顿营地", routeNodes: ["马赛马拉丽思卡尔顿营地", "马拉核心区"] },
  { hotel: "Saruni Leopard Hill", hotelShortName: "Saruni豹山营地", routeNodes: ["马赛马拉丽思卡尔顿营地", "Naboisho私人保护区", "Saruni豹山营地"] },
  { hotel: "Saruni Leopard Hill", hotelShortName: "Saruni豹山营地", routeNodes: ["Saruni豹山营地", "全天游猎"] },
];

test("酒店卡生成单行入住日期与精简起讫地", () => {
  assert.equal(deriveHotelStayLine(hotels[0], days, hotels, "肯尼亚"), "D1入住 → D3退房 · 连住2晚｜内罗毕 → 安博塞利");
  assert.equal(deriveHotelStayLine(hotels[1], days, hotels, "肯尼亚"), "D3入住 → D5退房 · 连住2晚｜安博塞利 → 马赛马拉");
  assert.equal(deriveHotelStayLine(hotels[2], days, hotels, "肯尼亚"), "D5入住 → D7退房 · 连住2晚｜马赛马拉 → Naboisho");
});

test("单晚住宿显示1晚而不是连住", () => {
  const hotel = { officialName: "JW Marriott Hotel Nairobi", shortName: "内罗毕JW万豪", region: "内罗毕", nights: 1 };
  const singleDay = [{ hotel: "JW Marriott Hotel Nairobi", hotelShortName: "内罗毕JW万豪", routeNodes: ["马赛马拉", "内罗毕", "内罗毕JW万豪"] }];
  assert.equal(deriveHotelStayLine(hotel, singleDay, [hotel], "肯尼亚"), "D1入住 → D2退房 · 1晚｜马赛马拉 → 内罗毕");
});

test("晚数冲突或非连续入住时不猜测展示", () => {
  assert.equal(deriveHotelStayLine({ ...hotels[0], nights: 3 }, days, hotels, "肯尼亚"), "");
  const splitDays = [days[0], { hotel: "Other Hotel", routeNodes: [] }, days[1]];
  assert.equal(deriveHotelStayLine(hotels[0], splitDays, hotels, "肯尼亚"), "");
});
