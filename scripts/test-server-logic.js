const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const miniapp = fs.readFileSync(path.join(root, "wechat-miniapp/pages/index/index.js"), "utf8");

const handlerBlock = name => {
  const start = server.indexOf(`async function ${name}`);
  const end = server.indexOf("\nasync function ", start + 1);
  return server.slice(start, end < 0 ? server.length : end);
};

assert.match(handlerBlock("handleFinalize"), /finalizeSemanticDiary\(input, callQwenJson\)/, "第一版接口必须只进入语义事件流程");
assert.doesNotMatch(handlerBlock("handleFinalize"), /finalizeWithQwen\(/, "第一版接口不得回到旧事实文本成文器");
assert.match(handlerBlock("handleRevise"), /reviseSemanticDiary\(input, callQwenJson\)/, "修改接口必须一次完成语义补丁和局部成文事务");
assert.doesNotMatch(handlerBlock("handleRevise"), /fallbackRevisionOperations|revisionChangeIsValid|reviseWithQwen/, "修改接口不得回到旧正则或字面校验");
assert.match(handlerBlock("handleCompose"), /legacy_compose_removed/, "旧成文接口必须明确停用，不能作为隐藏兜底");
assert.equal(miniapp.includes('request("/api/compose"'), false, "小程序不得再调用旧成文接口");
assert.equal(miniapp.includes("revisionOperations"), false, "客户端不得再维护旧事实操作和回滚链路");
assert.match(server, /story_json/, "服务器必须持久化语义事件账本");

console.log("server semantic routing regression: ok");
