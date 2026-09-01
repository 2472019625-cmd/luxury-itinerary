import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import potracePackage from "potrace";

const { Potrace } = potracePackage;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = path.resolve(root, "..", "assets");
const input = path.join(assetRoot, "logos", "logo-gold.png");
const variants = { gold: "#B28B33", dark: "#3A332B", white: "#FFFFFF" };

await Promise.all(Object.entries(variants).map(([name, color]) => new Promise((resolve, reject) => {
  const tracer = new Potrace({
    color,
    background: "transparent",
    threshold: 220,
    turdSize: 3,
    optCurve: true,
    optTolerance: 0.2,
  });
  tracer.loadImage(input, (error) => {
    if (error) return reject(error);
    const svg = tracer.getSVG();
    fs.writeFileSync(path.join(assetRoot, "logos", `logo-${name}.svg`), svg);
    fs.writeFileSync(path.join(root, "public", "assets", "logos", `logo-${name}.svg`), svg);
    resolve();
  });
})));

console.log("Logo SVG 描摹版本已生成。AI源文件未包含PDF兼容内容，详见字体与Logo清单。")
