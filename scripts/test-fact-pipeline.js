const assert = require("node:assert/strict");
const {
  applyFactAudit,
  applyRevisionOperations,
  compositionIssues,
  finalizeFactDiary,
  normalizeComposition,
  reviseFactDiary
} = require("../lib/fact-pipeline");

const facts = [
  { id: "f1", slot: "what", label: "穿衣服", text: "我自己穿好了衣服", quote: "我自己穿好衣服" },
  { id: "f2", slot: "what", label: "上学", text: "妈妈送我去学校", quote: "妈妈送我去学校" },
  { id: "f3", slot: "what", label: "检查", text: "医生姐姐给我检查身体", quote: "医生姐姐给我检查身体" }
];

const audited = applyFactAudit(
  "我自己穿好衣服。妈妈提醒我自己说。妈妈送我去学校。医生姐姐给我检查身体。",
  [...facts, { id: "noise", slot: "detail", text: "妈妈提醒我自己说", quote: "妈妈提醒我自己说" }],
  { excludedFacts: [{ id: "noise", reason: "adult_guidance" }], addedFacts: [] }
);
assert.deepEqual(audited.map(fact => fact.id), ["f1", "f2", "f3"], "最终审计只删除明确标记的无效事实");

const repeatedThen = normalizeComposition({
  title: "上学",
  sentences: [
    { text: "然后我自己穿好了衣服。", factIds: ["f1"] },
    { text: "然后妈妈送我去学校。", factIds: ["f2"] },
    { text: "然后医生姐姐给我检查身体。", factIds: ["f3"] }
  ]
}, facts);
assert.equal(
  compositionIssues(repeatedThen, facts).softIssues.some(issue => issue.type === "repeated_then"),
  true,
  "正文多次出现然后时必须触发自然重整"
);

const imperfectLedger = normalizeComposition({
  title: "上学",
  sentences: [{ text: "我自己穿好衣服后，妈妈送我去了学校。", factIds: ["f1", "f2"] }]
}, facts);
const imperfectLedgerIssues = compositionIssues(imperfectLedger, facts);
assert.equal(imperfectLedgerIssues.hardIssues.length, 0, "事实ID漏标不能把已经生成的文章整篇判失败");
assert.equal(imperfectLedgerIssues.softIssues.some(issue => issue.type === "unmapped_facts"), true);

async function testFinalize() {
  const stages = [];
  const result = await finalizeFactDiary({
    transcript: "然后我自己穿好衣服。然后妈妈送我去学校。然后医生姐姐给我检查身体。",
    facts
  }, async (messages, options) => {
    stages.push(options.stage);
    if (options.stage === "audit_final_facts") return { excludedFacts: [], addedFacts: [] };
    if (options.stage === "compose_fact_diary") {
      return {
        title: "上学的一天",
        sentences: [
          { text: "然后我自己穿好了衣服。", factIds: ["f1"] },
          { text: "然后妈妈送我去学校。", factIds: ["f2"] },
          { text: "然后医生姐姐给我检查身体。", factIds: ["f3"] }
        ]
      };
    }
    return {
      title: "上学的一天",
      sentences: [
        { text: "我自己穿好衣服后，妈妈送我去了学校。", factIds: ["f1", "f2"] },
        { text: "到了学校，医生姐姐给我检查了身体。", factIds: ["f3"] }
      ]
    };
  });
  assert.deepEqual(stages, ["audit_final_facts", "compose_fact_diary", "repair_fact_diary"]);
  assert.equal((result.sentences.map(sentence => sentence.text).join("").match(/然后/gu) || []).length, 0);
  assert.deepEqual(result.sentences[0].factTexts, ["我自己穿好了衣服", "妈妈送我去学校"]);
  assert.match(result.sentences[0].sourceText, /我自己穿好衣服/);
}

function testRevisionOperations() {
  const result = applyRevisionOperations(facts, [
    { type: "replace", targetFactId: "f3", slot: "what", text: "医生姐姐给我量了身高", label: "量身高" },
    { type: "add", slot: "feeling", text: "我很开心", label: "心情", afterFactId: "f3" }
  ], "医生姐姐不是检查身体，是给我量了身高，我很开心");
  assert.equal(result.facts.find(fact => fact.id === "f3").text, "医生姐姐给我量了身高");
  assert.equal(result.facts.at(-1).text, "我很开心");
  assert.equal(result.operations.length, 2);
}

async function testRevision() {
  const currentSentences = [
    { id: "s1", text: "我自己穿好衣服后，妈妈送我去了学校。", factIds: ["f1", "f2"] },
    { id: "s2", text: "到了学校，医生姐姐给我检查了身体。", factIds: ["f3"] }
  ];
  const result = await reviseFactDiary({
    instruction: "医生姐姐不是检查身体，是给我量了身高",
    title: "上学的一天",
    facts,
    sentences: currentSentences
  }, async (messages, options) => {
    if (options.stage === "parse_fact_revision") {
      return { operations: [{ type: "replace", targetFactId: "f3", slot: "what", label: "量身高", text: "医生姐姐给我量了身高" }] };
    }
    return {
      title: "上学的一天",
      sentences: [
        { id: "s1", text: currentSentences[0].text, factIds: ["f1", "f2"] },
        { id: "s2", text: "到了学校，医生姐姐给我量了身高。", factIds: ["f3"] }
      ]
    };
  });
  assert.equal(result.changed, true);
  assert.equal(result.facts.find(fact => fact.id === "f3").text, "医生姐姐给我量了身高");
  assert.equal(result.sentences[0].text, currentSentences[0].text);
  assert.match(result.sentences[1].text, /量了身高/);
}

Promise.all([testFinalize(), testRevision()]).then(() => {
  testRevisionOperations();
  console.log("fact pipeline regression: ok");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
