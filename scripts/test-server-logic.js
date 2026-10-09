const assert = require("node:assert/strict");
const {
  compositionPenalty,
  dedupeSemanticFacts,
  deterministicRevisionText,
  fallbackRevisionOperations,
  normalizeRevisionOperations
} = require("../server");

const diary = [{
  id: "s1",
  text: "我进教室吃早餐，进去了。",
  factIds: ["f1"],
  factTexts: ["进教室吃早餐"]
}];
const facts = [{ id: "f1", slot: "what", text: "进教室吃早餐", active: true }];

const phraseOperations = fallbackRevisionOperations({
  instruction: "去掉那个进去了",
  facts,
  diary
});
assert.deepEqual(
  phraseOperations.map(operation => [operation.type, operation.target_sentence_id, operation.old_text]),
  [["remove_phrase", "s1", "进去了"]],
  "没有独立事实的句内冗余应定位到句子，不得删除整条事件"
);
assert.equal(
  deterministicRevisionText(diary[0], phraseOperations, facts),
  "我进教室吃早餐。",
  "句内删词兜底应清理多余标点"
);

const longRestatement = "检查结束以后，我进教室吃早餐，早餐很好吃。我是重新把这件事情说完整，不是在后面新增另一个故事。";
const normalizedRestatement = normalizeRevisionOperations({ instruction: longRestatement, facts, diary, revisionIntent: "related_restatement" }, [{
  type: "replace",
  target_fact_id: "f1",
  slot: "what",
  conflict: true,
  new_text: "检查结束以后进教室吃早餐"
}]);
assert.equal(normalizedRestatement[0]?.type, "replace", "自然重说不能再因文字较长被强制改成新增");

const stylisticRestatement = normalizeRevisionOperations({ instruction: longRestatement, facts, diary, revisionIntent: "related_restatement" }, [{
  type: "replace",
  target_fact_id: "f1",
  conflict: false,
  new_text: "我就进教室吃早餐"
}]);
assert.equal(stylisticRestatement.length, 0, "自然重说中的同义或语气变化不能覆盖原事实");

const oneTargetOnce = normalizeRevisionOperations({ instruction: "不是原来的说法，我重新说", facts, diary }, [
  { type: "replace", target_fact_id: "f1", new_text: "我进教室吃早餐" },
  { type: "replace", target_fact_id: "f1", new_text: "检查结束以后，我进教室吃早餐" }
]);
assert.equal(oneTargetOnce.length, 1, "同一事实一次修改只能保留一个最终操作");
assert.equal(oneTargetOnce[0].new_text, "检查结束以后，我进教室吃早餐", "同一事实应保留信息更完整的修改");

const relatedFacts = dedupeSemanticFacts([
  { id: "a", slot: "what", text: "我和哥哥一起玩滑梯" },
  { id: "b", slot: "what", text: "我和哥哥一起玩秋千" }
]);
assert.equal(relatedFacts.length, 2, "同场景中的不同活动不能因文字相似而丢失");

const duplicateSourcePenalty = compositionPenalty({ sentences: [
  { text: "我在教室吃早餐。", factTexts: ["进教室吃早餐"] },
  { text: "我进去以后吃了早餐。", factTexts: ["进教室吃早餐"] }
] });
const singleSourcePenalty = compositionPenalty({ sentences: [
  { text: "我进教室以后吃了早餐。", factTexts: ["进教室吃早餐"] }
] });
assert.ok(duplicateSourcePenalty > singleSourcePenalty, "同一来源写进多句必须触发重复惩罚");

console.log("server logic regression: ok");
