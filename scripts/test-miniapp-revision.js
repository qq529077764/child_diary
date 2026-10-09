const assert = require("node:assert/strict");

let pageDefinition;
const storage = new Map();
const modals = [];

global.Page = definition => { pageDefinition = definition; };
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  showModal: options => { modals.push(options); },
  getRecorderManager: () => ({ stop() {} })
};

require("../wechat-miniapp/pages/index/index.js");

function createPage(overrides = {}) {
  const page = {
    ...pageDefinition,
    data: structuredClone(pageDefinition.data),
    setData(update) { Object.assign(this.data, update); },
    recorder: { stop() {} },
    ...overrides
  };
  page.resetRuntime();
  return page;
}

async function run() {
  const facts = [
    { id: "f1", text: "去了公园", slot: "what", active: true },
    { id: "f2", text: "很开心", slot: "feeling", active: true }
  ];
  const page = createPage();
  const restored = page.presentDiary({
    id: "diary_old",
    title: "公园日记",
    savedAt: 100,
    facts,
    sentences: [{ id: "s1", text: "我去了公园。", factTexts: ["去了公园"] }]
  });
  assert.deepEqual(restored.sentences[0].factIds, ["f1"], "历史日记应补全事实关联");

  page.data.selectedDiary = restored;
  page.restoreDiaryForRevision();
  assert.equal(page.editingDiaryId, "diary_old", "恢复历史日记后应保留原编号");
  assert.equal(page.editingDiarySavedAt, 100, "恢复历史日记后应保留原保存时间");

  let savedRecord;
  page.readDiaryHistory = () => [restored];
  page.loadDiaryHistory = () => [];
  page.ensureCloudSession = async () => "token";
  page.rawRequest = async (path, method, record) => { if (path === "/api/diaries" && method === "POST") savedRecord = record; return {}; };
  page.refreshCloudHistory = async () => [];
  page.data.diaryTitle = restored.title;
  page.data.diarySentences = restored.sentences;
  page.transcript = "我去了公园";
  page.facts = structuredClone(facts);
  await page.saveDiary();
  assert.equal(savedRecord.id, "diary_old", "修改历史日记后应更新原记录，不能新增一篇");
  assert.equal(page.data.phase, "success", "本地保存后应立即进入成功页");

  const revisionPage = createPage();
  revisionPage.data.phase = "revise";
  revisionPage.data.diaryTitle = "公园日记";
  revisionPage.data.diarySentences = [
    { id: "s1", text: "我去了公园。", factIds: ["f1"], factTexts: ["去了公园"] },
    { id: "s2", text: "我很开心。", factIds: ["f2"], factTexts: ["很开心"] }
  ];
  revisionPage.facts = structuredClone(facts);
  revisionPage.revisionTranscript = "不是很开心，是特别开心";
  revisionPage.revisionBaseSnapshot = {
    title: revisionPage.data.diaryTitle,
    sentences: structuredClone(revisionPage.data.diarySentences),
    facts: structuredClone(revisionPage.facts)
  };
  let revisionRequest;
  revisionPage.request = async (path, data) => {
    assert.equal(path, "/api/revise");
    revisionRequest = data;
    return { operations: [{ type: "replace", target_fact_id: "f2", new_text: "特别开心", slot: "feeling" }] };
  };
  let composeOptions;
  revisionPage.composeDiary = async options => { composeOptions = options; };
  await revisionPage.finishRevision();
  assert.equal(revisionPage.facts.find(fact => fact.id === "f2").text, "特别开心", "明确替换应更新目标事实");
  assert.equal(revisionRequest.diary[0].id, "s1", "修改判定必须接收句子 id，不能只传纯文本");
  assert.deepEqual(revisionRequest.diary[0].factIds, ["f1"], "修改判定必须接收句子与事实的关联");
  assert.equal(composeOptions.lockedDiary[0].text, "我去了公园。", "未涉及句子必须锁定");
  assert.equal(composeOptions.revisionOperations[0].old_text, "很开心", "局部成文必须知道被替换的旧事实");

  const newEventPage = createPage();
  newEventPage.data.phase = "revise";
  newEventPage.data.diaryTitle = "公园日记";
  newEventPage.data.diarySentences = structuredClone(revisionPage.data.diarySentences);
  newEventPage.facts = structuredClone(facts);
  newEventPage.revisionTranscript = "后来我和哥哥玩了滑滑梯，我们还一起开了粉色的小汽车，回家前我看见了很多小鸟，我特别开心。";
  newEventPage.revisionBaseSnapshot = {
    title: newEventPage.data.diaryTitle,
    sentences: structuredClone(newEventPage.data.diarySentences),
    facts: structuredClone(newEventPage.facts)
  };
  newEventPage.request = async () => ({
    revisionMode: "new_event",
    operations: [
      { type: "add", slot: "what", label: "新活动", new_text: "和哥哥玩了滑滑梯", anchor_fact_id: "f1", placement: "after" },
      { type: "add", slot: "detail", label: "新活动", new_text: "一起开了粉色的小汽车", anchor_fact_id: "f1", placement: "after" },
      { type: "add", slot: "detail", label: "看到", new_text: "回家前看见了很多小鸟", anchor_fact_id: "f2", placement: "before" },
      { type: "add", slot: "feeling", label: "感受", new_text: "特别开心", anchor_fact_id: "f2", placement: "merge" }
    ]
  });
  let newEventCompose;
  newEventPage.composeDiary = async options => { newEventCompose = options; };
  await newEventPage.finishRevision();
  assert.equal(newEventCompose.revisionOperations.length, 4, "新事件口述中的多个事实必须全部进入局部成文");
  assert.equal(newEventPage.facts.filter(fact => fact.id.startsWith("rev_")).length, 4, "新事件不能只保留前两项事实");
  assert.equal(newEventCompose.revisionMode, "new_event", "客户端必须把语义修改意图交给局部成文器");
  assert.deepEqual(
    newEventCompose.revisionOperations.map(operation => [operation.anchor_fact_id, operation.placement]),
    [["f1", "after"], ["f1", "after"], ["f2", "before"], ["f2", "merge"]],
    "客户端必须把事实锚点和插入位置原样交给局部成文器"
  );

  const phrasePage = createPage();
  phrasePage.data.phase = "revise";
  phrasePage.data.diaryTitle = "上学日记";
  phrasePage.data.diarySentences = [{ id: "s3", text: "我进教室吃早餐，进去了。", factIds: ["f3"], factTexts: ["进教室吃早餐"] }];
  phrasePage.facts = [{ id: "f3", text: "进教室吃早餐", slot: "what", active: true }];
  phrasePage.revisionTranscript = "去掉那个进去了";
  phrasePage.revisionBaseSnapshot = {
    title: phrasePage.data.diaryTitle,
    sentences: structuredClone(phrasePage.data.diarySentences),
    facts: structuredClone(phrasePage.facts)
  };
  phrasePage.request = async () => ({
    revisionMode: "explicit_edit",
    operations: [{ type: "remove_phrase", target_sentence_id: "s3", old_text: "进去了" }]
  });
  let phraseCompose;
  phrasePage.composeDiary = async options => { phraseCompose = options; };
  await phrasePage.finishRevision();
  assert.equal(phraseCompose.revisionOperations[0].type, "remove_phrase", "句内冗余删除不能因没有独立事实而丢失");
  assert.equal(phrasePage.facts.length, 1, "句内删词不能误删原句事实");

  const unclearPage = createPage();
  unclearPage.data.phase = "revise";
  unclearPage.data.diarySentences = restored.sentences;
  unclearPage.facts = structuredClone(facts);
  unclearPage.revisionTranscript = "嗯我想一下";
  unclearPage.request = async () => ({ operations: [], message: "请说清楚要改哪里" });
  modals.length = 0;
  await unclearPage.finishRevision();
  assert.equal(modals.at(-1).title, "还没有修改", "无明确操作时不能误报已恢复版本");

  console.log("miniapp revision regression: ok");
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
