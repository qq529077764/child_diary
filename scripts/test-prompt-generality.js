const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const productionPromptFiles = [
  "server.js",
  "wechat-miniapp/pages/index/index.wxml"
];
const caseSpecificTerms = [
  "滑滑梯",
  "公园",
  "绘本",
  "张学良",
  "张故居",
  "故居",
  "海河",
  "天津",
  "狗不理",
  "八珍豆腐",
  "博物馆"
];

const violations = [];
for (const relativePath of productionPromptFiles) {
  const content = fs.readFileSync(path.join(root, relativePath), "utf8");
  for (const term of caseSpecificTerms) {
    if (content.includes(term)) violations.push(`${relativePath}: ${term}`);
  }
}

const cases = JSON.parse(fs.readFileSync(path.join(root, "regression-cases/cases.json"), "utf8"));
if (!Array.isArray(cases) || !cases.length) violations.push("regression-cases/cases.json: empty case library");

if (violations.length) {
  console.error(`Prompt generality check failed:\n${violations.map(item => `- ${item}`).join("\n")}`);
  process.exit(1);
}

console.log(`Prompt generality check passed (${productionPromptFiles.length} production files, ${cases.length} regression cases).`);
