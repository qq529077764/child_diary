const assert = require("node:assert/strict");
const {
  assignRevisionOperationsToSentences,
  compositionHardViolations,
  compositionPenalty,
  dedupeSemanticFacts,
  deterministicRevisionText,
  fallbackRevisionOperations,
  normalizeRevisionOperations,
  revisionChangeIsValid,
  revisionWritingViolations
} = require("../server");

const reversedNegation = compositionHardViolations({
  sentences: [{ text: "我起得很早，赖床，自己穿好了衣服。", factTexts: ["没有赖床", "自己穿好衣服"] }]
}, [
  { id: "negative", text: "没有赖床" },
  { id: "dressed", text: "自己穿好衣服" }
]);
assert.equal(reversedNegation.some(item => item.type === "negation_lost"), true, "否定事实被写成肯定时必须拒绝成文");
assert.equal(compositionHardViolations({
  sentences: [{ text: "我起得很早，没有赖床，还自己穿好了衣服。", factTexts: ["没有赖床", "自己穿好衣服"] }]
}, [
  { id: "negative", text: "没有赖床" },
  { id: "dressed", text: "自己穿好衣服" }
]).length, 0, "正文保留否定关系时应通过校验");

const brokenCompletion = compositionHardViolations({
  sentences: [
    { text: "休息结束后，我们吃了点心，吃完点心。", factTexts: [] },
    { text: "就准备回家了，妈妈来接我。", factTexts: [] }
  ]
}, []);
assert.equal(brokenCompletion.some(item => item.type === "dependent_clause_without_subject"), true, "依赖前句却没有主语的新句必须拒绝");
assert.equal(brokenCompletion.some(item => item.type === "completion_split_from_result"), true, "完成动作不能与后续结果错误断开");
assert.equal(compositionHardViolations({
  sentences: [{ text: "吃完点心后，我们就准备回家了，妈妈来接我。", factTexts: [] }]
}, []).length, 0, "完成动作与后续结果合并且主语清楚时应通过");
assert.equal(compositionHardViolations({
  sentences: [{ text: "后来，我们回到教室了。", factTexts: [] }]
}, []).length, 0, "连接词后通过逗号写出明确主语时不能误报");
assert.equal(compositionHardViolations({
  sentences: [
    { text: "我们玩完了滑梯。", factTexts: [] },
    { text: "后来，小狗跑过来了。", factTexts: [] }
  ]
}, []).length, 0, "任意事物都可以作主语，不能因不在人称词表中而误报");
assert.equal(compositionHardViolations({
  sentences: [{ text: "后来，天气变凉了。", factTexts: [] }]
}, []).length, 0, "自然现象作主语时不能误报");

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

const sequenceFacts = [
  { id: "breakfast", slot: "what", text: "吃早餐", active: true },
  { id: "outside", slot: "what", text: "去户外玩", active: true },
  { id: "lunch", slot: "what", text: "吃午饭", active: true },
  { id: "lunch-duplicate", slot: "what", text: "然后就吃午饭", active: true },
  { id: "nap", slot: "what", text: "睡午觉", active: true },
  { id: "fruit", slot: "what", text: "吃水果", active: true },
  { id: "finish", slot: "what", text: "放学", active: true }
];
const sequenceInstruction = "顺序不对，吃完早餐后去户外玩，回来先吃午饭，再睡午觉，睡醒后吃水果，最后放学。";
const sequenceFallback = fallbackRevisionOperations({ instruction: sequenceInstruction, facts: sequenceFacts, diary: [] });
assert.equal(sequenceFallback[0]?.type, "reorder", "纠正多个已有事件的顺序时必须生成结构化重排操作");
assert.deepEqual(sequenceFallback[0]?.ordered_fact_ids, ["breakfast", "outside", "lunch", "nap", "fruit", "finish"], "重排事实编号必须遵循孩子重新讲述的顺序");
const normalizedSequence = normalizeRevisionOperations({
  instruction: sequenceInstruction,
  facts: sequenceFacts,
  diary: [],
  revisionIntent: "related_restatement"
}, [
  { type: "replace", target_fact_id: "fruit", new_text: "吃水果", conflict: true },
  sequenceFallback[0]
]);
assert.deepEqual(normalizedSequence.map(operation => operation.type), ["reorder"], "同文替换不能冒充修改，顺序修正只保留重排操作");
const sequenceDiary = [
  { id: "morning", text: "吃完早餐后，我们去户外玩。", factIds: ["breakfast", "outside"], factTexts: ["吃早餐", "去户外玩"] },
  { id: "noon", text: "回来以后，我们吃午饭，再睡午觉。", factIds: ["lunch", "nap"], factTexts: ["吃午饭", "睡午觉"] },
  { id: "afternoon", text: "睡醒后我们吃水果，然后放学。", factIds: ["fruit", "finish"], factTexts: ["吃水果", "放学"] }
];
const sequenceAssignments = assignRevisionOperationsToSentences(
  sequenceDiary,
  normalizedSequence,
  new Map(sequenceFacts.map(fact => [fact.id, fact])),
  new Map()
);
assert.deepEqual([...sequenceAssignments.assignments.keys()], [0, 1, 2], "顺序修正必须锁定第一个到最后一个相关句子的完整局部场景");
assert.equal(sequenceAssignments.unmatched.length, 0, "可定位的顺序修正不能掉入未匹配状态");
assert.equal(revisionWritingViolations([{ text: "玩完回来，我们先吃的午饭，然后睡午觉，睡醒后才吃的水果。", factTexts: ["去户外玩", "吃午饭", "睡午觉", "吃水果"] }]).length > 0, true, "照抄修改口述的倒装长句必须被拒绝");
assert.equal(revisionWritingViolations([
  { text: "玩完回来，我们吃了午饭。", factTexts: ["去户外玩", "吃午饭"] },
  { text: "吃完午饭后，我们睡午觉。", factTexts: ["睡午觉"] },
  { text: "睡醒之后，我们吃了水果，然后就放学了。", factTexts: ["吃水果", "放学"] }
]).length, 0, "按主谓宾和事件边界重整后的句子应通过修改质量校验");

const oneTargetOnce = normalizeRevisionOperations({ instruction: "不是原来的说法，我重新说", facts, diary }, [
  { type: "replace", target_fact_id: "f1", new_text: "我进教室吃早餐" },
  { type: "replace", target_fact_id: "f1", new_text: "检查结束以后，我进教室吃早餐" }
]);
assert.equal(oneTargetOnce.length, 1, "同一事实一次修改只能保留一个最终操作");
assert.equal(oneTargetOnce[0].new_text, "检查结束以后，我进教室吃早餐", "同一事实应保留信息更完整的修改");

const readingFacts = [
  { id: "book", slot: "what", text: "跟老师一起读绘本", active: true },
  { id: "outside", slot: "what", text: "去户外骑自行车", active: true }
];
const readingDiary = [
  { id: "school", text: "我到了学校。", factIds: [], factTexts: ["到学校"] },
  { id: "reading", text: "吃完早餐后，我和老师一起读了绘本。", factIds: [], factTexts: ["跟老师一起读绘本"] },
  { id: "outside", text: "接着我去户外骑了自行车。", factIds: ["outside"], factTexts: ["去户外骑自行车"] }
];
const readingInstruction = "绘本是三只小猪的故事";
const normalizedReadingDetail = normalizeRevisionOperations({
  instruction: readingInstruction,
  facts: readingFacts,
  diary: readingDiary,
  revisionIntent: "related_addition"
}, [
  { type: "add", anchor_fact_id: "book", placement: "merge", new_text: "绘本是三只小猪的故事" },
  { type: "add", anchor_fact_id: "book", placement: "merge", new_text: "读了三只小猪的绘本" }
]);
assert.equal(normalizedReadingDetail.length, 1, "同一次修改拆出的同义新增事实只能保留一条");
assert.equal(normalizedReadingDetail[0].new_text, readingInstruction, "同义新增事实应保留最贴近孩子原话的一条");

const readingFactMap = new Map(readingFacts.map(fact => [fact.id, fact]));
const readingOperation = { ...normalizedReadingDetail[0], applied_fact_id: "book-detail" };
const readingAssignments = assignRevisionOperationsToSentences(
  readingDiary,
  [readingOperation],
  readingFactMap,
  new Map()
);
assert.deepEqual([...readingAssignments.assignments.keys()], [1], "事实编号缺失时也应只锁定语义最相关的原句");
assert.equal(readingAssignments.unmatched.length, 0, "可定位的局部修改不能掉入未消费状态");
assert.equal(
  revisionChangeIsValid("吃完早餐后，我和老师一起读了绘本。", [readingOperation], readingFactMap),
  false,
  "正文没有写入新增细节时不能仅凭 factTexts 判定修改成功"
);
assert.equal(
  revisionChangeIsValid("吃完早餐后，我和老师一起读了三只小猪的故事。", [readingOperation], readingFactMap),
  true,
  "正文真正写入新增细节后应通过局部修改校验"
);

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
