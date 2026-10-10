const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const pipeline = fs.readFileSync(path.join(root, "lib/fact-pipeline.js"), "utf8");
const miniapp = fs.readFileSync(path.join(root, "wechat-miniapp/pages/index/index.js"), "utf8");

const handlerBlock = name => {
  const start = server.indexOf(`async function ${name}`);
  const end = server.indexOf("\nasync function ", start + 1);
  return server.slice(start, end < 0 ? server.length : end);
};

assert.match(handlerBlock("handleFinalize"), /finalizeFactDiary\(input, callQwenJson\)/, "第一版接口必须进入事实审计和成文流程");
assert.match(handlerBlock("handleRevise"), /reviseFactDiary\(input, callQwenJson\)/, "修改接口必须基于事实账本完成");
assert.match(handlerBlock("handleCompose"), /legacy_compose_removed/, "旧成文接口必须明确停用");
assert.equal(miniapp.includes('request("/api/compose"'), false, "小程序不得调用旧成文接口");
assert.equal(miniapp.includes("storyModel"), false, "客户端不得继续维护语义事件账本");
assert.equal(miniapp.includes("semanticFactText"), false, "客户端不得机械拼装对应事实");
assert.match(pipeline, /全文‘然后’原则上不超过一次/, "成文规则必须处理重复然后");
assert.doesNotMatch(pipeline, /simpleEventSentence|normalizeRepeatedThen|compositionPenalty/, "不得保留旧的机械拼句和替词逻辑");
assert.equal(fs.existsSync(path.join(root, "lib/semantic-pipeline.js")), false, "旧语义成文模块必须删除");
assert.equal(fs.existsSync(path.join(root, "lib/story-model.js")), false, "旧事件账本模块必须删除");

console.log("server fact routing regression: ok");
