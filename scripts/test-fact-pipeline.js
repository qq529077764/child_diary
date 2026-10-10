const assert = require("node:assert/strict");
const {
  applyFactAudit,
  applyRevisionPlan,
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

const auditInput = [
  { id: "gate", slot: "what", text: "妈妈送我到学校门口", quote: "妈妈送我到学校门口" },
  { id: "bye", slot: "detail", text: "我跟妈妈说再见", quote: "我跟妈妈说再见" },
  { id: "doctor", slot: "what", text: "医生姐姐给我检查身体", quote: "医生姐姐给我检查身体" },
  { id: "read-fragment", slot: "what", text: "我们跟老师在教室里讲了", quote: "我们跟老师在教室里讲了" },
  { id: "book", slot: "detail", text: "老师讲的绘本是三只小猪", quote: "老师给我们讲的绘本是三只小猪" },
  { id: "tea", slot: "what", text: "讲完绘本之后吃下午茶", quote: "讲完绘本之后我们吃下午茶" },
  { id: "loose", slot: "detail", text: "我们说了", quote: "我们说了" },
  { id: "noise", slot: "detail", text: "妈妈提醒我自己说", quote: "妈妈提醒我自己说" }
];
const audited = applyFactAudit(
  auditInput.map(fact => fact.quote).join("。"),
  auditInput,
  {
    finalFacts: [
      { sourceFactIds: ["gate", "bye"], slot: "what", label: "到校", text: "妈妈送我到学校门口，我跟妈妈说再见" },
      { sourceFactIds: ["doctor"], slot: "what", label: "检查", text: "医生姐姐给我检查身体" },
      { sourceFactIds: ["read-fragment", "book"], slot: "what", label: "讲绘本", text: "老师给我们讲了《三只小猪》的绘本" },
      { sourceFactIds: ["tea"], slot: "what", label: "下午茶", text: "讲完绘本之后，我们吃下午茶" }
    ]
  }
);
assert.deepEqual(audited.map(fact => fact.id), ["gate", "doctor", "read-fragment", "tea"]);
assert.equal(audited[0].text, "妈妈送我到学校门口，我跟妈妈说再见", "相邻人物的动作归属不能串换");
assert.equal(audited[2].text, "老师给我们讲了《三只小猪》的绘本", "同一事件的残片应在事实层合并完整");
assert.equal(audited[3].text, "讲完绘本之后，我们吃下午茶", "原话中的明确先后关系应保留在事实层");
assert.deepEqual(audited[2].sourceFactIds, ["read-fragment", "book"]);
assert.equal(audited.some(fact => fact.id === "loose" || fact.id === "noise"), false, "不完整片段和无效收音不必进入正文事实");

const splitEventFacts = applyFactAudit(
  "我和同学一起跳绳，是200个，很多个同学，我感觉很好的。",
  [{ id: "jump-all", slot: "what", text: "我和同学一起跳绳，是200个，很多个同学，我感觉很好的", quote: "我和同学一起跳绳，是200个，很多个同学，我感觉很好的" }],
  {
    finalFacts: [
      { eventKey: "跳绳", sourceFactIds: ["jump-all"], slot: "what", label: "跳绳", text: "我和同学一起跳绳" },
      { eventKey: "跳绳", sourceFactIds: ["jump-all"], slot: "detail", label: "数量", text: "跳了200个" },
      { eventKey: "跳绳", sourceFactIds: ["jump-all"], slot: "detail", label: "同学", text: "当时有很多同学" },
      { eventKey: "跳绳", sourceFactIds: ["jump-all"], slot: "feeling", label: "感受", text: "感觉很好" }
    ]
  }
);
assert.equal(splitEventFacts.length, 4, "同一段原话中的动作、描述和感受必须能拆成独立语义事实");
assert.equal(new Set(splitEventFacts.map(fact => fact.id)).size, 4, "拆分后的事实必须各自拥有唯一ID");
assert.deepEqual(splitEventFacts.map(fact => fact.eventKey), ["跳绳", "跳绳", "跳绳", "跳绳"]);
assert.deepEqual(splitEventFacts.map(fact => fact.slot), ["what", "detail", "detail", "feeling"]);
assert.equal(splitEventFacts.every(fact => fact.sourceFactIds[0] === "jump-all"), true, "拆分事实必须共同指回原始证据");

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

const harmlessUnknownBinding = normalizeComposition({
  title: "上学",
  sentences: [{ text: "妈妈送我去学校。", factIds: ["f2", "model_extra_id"] }]
}, facts);
assert.equal(compositionIssues(harmlessUnknownBinding, facts).hardIssues.length, 0, "模型多返回的无效事实编号不能让正文整篇失败");

async function testFinalize() {
  const stages = [];
  const result = await finalizeFactDiary({
    transcript: "然后我自己穿好衣服。然后妈妈送我去学校。然后医生姐姐给我检查身体。",
    facts
  }, async (messages, options) => {
    stages.push(options.stage);
    if (options.stage === "audit_final_facts") {
      return {
        finalFacts: facts.map(fact => ({ sourceFactIds: [fact.id], slot: fact.slot, label: fact.label, text: fact.text }))
      };
    }
    if (options.stage === "compose_fact_diary") {
      return {
        title: "上学的一天",
        sentences: [
          { text: "我自己穿好衣服后，妈妈送我去了学校。", factIds: ["f1", "f2"] },
          { text: "到了学校，医生姐姐给我检查了身体。", factIds: ["f3"] }
        ]
      };
    }
    throw new Error(`unexpected stage: ${options.stage}`);
  });
  assert.deepEqual(stages, ["audit_final_facts", "compose_fact_diary"], "成文不应再触发整篇二次改写");
  assert.equal((result.sentences.map(sentence => sentence.text).join("").match(/然后/gu) || []).length, 0);
  assert.deepEqual(result.sentences[0].factTexts, ["我自己穿好了衣服", "妈妈送我去学校"]);
  assert.match(result.sentences[0].sourceText, /我自己穿好衣服/);
}

function testRevisionPlan() {
  const bookFacts = [
    { id: "book", slot: "what", label: "讲绘本", text: "老师给我们讲了《三只小猪》的绘本", quote: "老师给我们讲的绘本是三只小猪" },
    { id: "tea", slot: "what", label: "下午茶", text: "讲完绘本后吃下午茶", quote: "讲完绘本后吃下午茶" }
  ];
  const bookSentences = [
    { id: "s_book", text: "老师给我们讲了《三只小猪》的绘本。", factIds: ["book"] },
    { id: "s_tea", text: "讲完绘本后，我们吃下午茶。", factIds: ["tea"] }
  ];
  const result = applyRevisionPlan(bookFacts, bookSentences, {
    mode: "replace",
    targetSentenceIds: ["s_book"],
    facts: [{ key: "book", slot: "what", label: "讲绘本", text: "老师在教室里给我们讲了《三只小猪》的绘本" }],
    sentences: [{ text: "老师在教室里给我们讲了《三只小猪》的绘本。", factKeys: ["book"] }]
  }, "老师是在教室里给我们讲绘本的", "我的日记");
  assert.equal(result.changed, true);
  assert.match(result.sentences[0].text, /教室.*三只小猪/);
  assert.equal(result.sentences[1].text, bookSentences[1].text, "修改范围外的句子由程序原样保留");

  const deleted = applyRevisionPlan(bookFacts, bookSentences, {
    mode: "replace",
    targetSentenceIds: ["s_book"],
    facts: [],
    sentences: []
  }, "讲绘本这件事不要写", "我的日记");
  assert.equal(deleted.changed, true, "删除整件事时局部结果为空是合法修改");
  assert.deepEqual(deleted.sentences.map(sentence => sentence.id), ["s_tea"]);

  const inserted = applyRevisionPlan(bookFacts, bookSentences, {
    mode: "insert",
    targetSentenceIds: [],
    insertBeforeSentenceId: "s_book",
    facts: [{ key: "draw", slot: "what", label: "画画", text: "午睡起来后我画了一幅画" }],
    sentences: [{ text: "午睡起来后，我画了一幅画。", factKeys: ["draw"] }]
  }, "午睡起来后我画了一幅画，然后老师讲绘本", "我的日记");
  assert.match(inserted.sentences[0].text, /画了一幅画/);
  assert.equal(inserted.sentences[1].text, bookSentences[0].text, "插入新事件不能要求模型重写相邻原句");
  assert.match(inserted.sentences[1].text, /三只小猪/);

  const vague = applyRevisionPlan(bookFacts, bookSentences, {
    mode: "no_change",
    targetSentenceIds: [],
    facts: [],
    sentences: [],
    message: "请说清楚想改哪件事"
  }, "前面改一下", "我的日记");
  assert.equal(vague.changed, false);
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
    return {
      additions: [],
      rewrites: [{
        targetSentenceIds: ["s2"],
        facts: [{ key: "check", slot: "what", label: "量身高", text: "医生姐姐给我量了身高" }],
        sentences: [{ text: "到了学校，医生姐姐给我量了身高。", factKeys: ["check"] }]
      }]
    };
  });
  assert.equal(result.changed, true);
  assert.equal(result.facts.find(fact => fact.id === "f3").text, "医生姐姐给我量了身高");
  assert.equal(result.sentences[0].text, currentSentences[0].text);
  assert.equal(result.sentences[0].id, "s1", "修改范围外的句子应由程序原样拼回，不交给模型复述");
  assert.match(result.sentences[1].text, /量了身高/);
}

Promise.all([testFinalize(), testRevision()]).then(() => {
  testRevisionPlan();
  console.log("fact pipeline regression: ok");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
