const assert = require("node:assert/strict");
const {
  applyStoryPatch,
  normalizeStory,
  validateCompositionStructure,
  validateStory
} = require("../lib/story-model");
const { deterministicStyleIssues, finalizeSemanticDiary, reviseSemanticDiary } = require("../lib/semantic-pipeline");

function baseStory() {
  return normalizeStory({
    titleHint: "公园日记",
    spans: [
      { id: "span_1", text: "我跟妈妈去公园", role: "child_story", accepted: true },
      { id: "span_2", text: "鸽子好多好多，我喂了鸽子", role: "child_story", accepted: true },
      { id: "span_noise", text: "你再说说鸽子", role: "adult_guidance", accepted: false }
    ],
    scenes: [{ id: "scene_park", label: "在公园", order: 0, sourceSpanIds: ["span_1", "span_2"] }],
    events: [
      {
        id: "event_arrive", sceneId: "scene_park", subject: "我和妈妈", action: "去", object: "公园",
        polarity: "positive", certainty: "certain", sourceSpanIds: ["span_1"], status: "active", confidence: 0.98
      },
      {
        id: "event_feed", sceneId: "scene_park", subject: "我", action: "喂", object: "鸽子",
        polarity: "positive", certainty: "certain", childExpressions: [{ text: "好多好多", bindTo: "object", policy: "preserve" }],
        sourceSpanIds: ["span_2"], status: "active", confidence: 0.97
      }
    ],
    relations: [{ id: "relation_order", type: "before", from: "event_arrive", to: "event_feed", sourceSpanIds: ["span_1", "span_2"] }]
  });
}

const story = baseStory();
assert.deepEqual(validateStory(story), [], "有效事件账本应通过结构校验");
assert.equal(story.spans.find(span => span.id === "span_noise").accepted, false, "成人提示必须留在审计记录但不得被接受");

const invalidNegativeDetail = normalizeStory({
  spans: [{ id: "negative_span", text: "我没有骑自行车", role: "child_story", accepted: true }],
  scenes: [{ id: "negative_scene", order: 0, sourceSpanIds: ["negative_span"] }],
  events: [{ id: "watch_event", sceneId: "negative_scene", subject: "我", action: "看", object: "哥哥骑车", details: ["没有骑自行车"], sourceSpanIds: ["negative_span"], status: "active", certainty: "certain" }]
});
assert.equal(validateStory(invalidNegativeDetail).some(error => error.startsWith("negative_detail_must_be_event")), true, "明确否定不得藏在普通细节中而被成文遗漏");

const explicitTimeStory = normalizeStory({
  spans: [{ id: "time_span", text: "早上画画，下午喂鸽子", role: "child_story", accepted: true }],
  scenes: [
    { id: "morning_scene", order: 0, sourceSpanIds: ["time_span"] },
    { id: "afternoon_scene", order: 1, sourceSpanIds: ["time_span"] }
  ],
  events: [
    { id: "morning_event", sceneId: "morning_scene", subject: "我", action: "画", object: "画", time: "早上", sourceSpanIds: ["time_span"], status: "active", certainty: "certain" },
    { id: "afternoon_event", sceneId: "afternoon_scene", subject: "我", action: "喂", object: "鸽子", time: "下午", sourceSpanIds: ["time_span"], status: "active", certainty: "certain" }
  ],
  relations: [{ id: "ambiguous_after", type: "after", from: "morning_event", to: "afternoon_event", sourceSpanIds: ["time_span"] }]
});
assert.deepEqual(
  explicitTimeStory.relations[0],
  { id: "ambiguous_after", type: "before", from: "morning_event", to: "afternoon_event", sourceSpanIds: ["time_span"] },
  "明确时间必须把含糊的after关系规一为早到晚"
);

const validComposition = {
  title: "公园日记",
  sentences: [{
    id: "sentence_1",
    sceneId: "scene_park",
    text: "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。",
    eventIds: ["event_arrive", "event_feed"]
  }]
};
assert.deepEqual(validateCompositionStructure(story, validComposition), [], "同一场景的连续事件可以合并在一句里");

const reversed = {
  title: "公园日记",
  sentences: [
    { id: "sentence_feed", sceneId: "scene_park", text: "我喂了鸽子。", eventIds: ["event_feed"] },
    { id: "sentence_arrive", sceneId: "scene_park", text: "我和妈妈去了公园。", eventIds: ["event_arrive"] }
  ]
};
assert.equal(validateCompositionStructure(story, reversed).some(error => error.type === "relation_reversed"), true, "明确事件顺序不得反转");

const duplicated = {
  title: "公园日记",
  sentences: [
    { id: "sentence_1", sceneId: "scene_park", text: "我喂了鸽子。", eventIds: ["event_feed"] },
    { id: "sentence_2", sceneId: "scene_park", text: "我又给鸽子吃东西。", eventIds: ["event_feed", "event_arrive"] }
  ]
};
assert.equal(validateCompositionStructure(story, duplicated).some(error => error.type === "duplicate_event"), true, "同一事件不得被两句重复消费");

const attributeStory = normalizeStory({
  spans: [{ id: "attribute_span", text: "苹果甜甜的，红红的", role: "child_story", accepted: true }],
  scenes: [{ id: "attribute_scene", order: 0, sourceSpanIds: ["attribute_span"] }],
  events: [
    { id: "sweet", sceneId: "attribute_scene", subject: "苹果", action: "是", object: "甜甜的", sourceSpanIds: ["attribute_span"], status: "active", certainty: "certain" },
    { id: "red", sceneId: "attribute_scene", subject: "苹果", action: "是", object: "红红的", sourceSpanIds: ["attribute_span"], status: "active", certainty: "certain" }
  ]
});
assert.equal(deterministicStyleIssues(attributeStory, {
  sentences: [{ id: "attribute_sentence", sceneId: "attribute_scene", text: "苹果是甜甜的，苹果是红红的。", eventIds: ["sweet", "red"] }]
}).some(issue => issue.type === "repeated_subject"), true, "同一对象连续属性的机械主语重复应触发一次软重写");

const updated = applyStoryPatch(story, {
  operations: [{
    type: "update_event",
    eventId: "event_feed",
    changes: {
      object: "白鸽子",
      childExpressions: [{ text: "白白的", bindTo: "object", policy: "preserve" }]
    }
  }]
});
assert.deepEqual(updated.affectedSceneIds, ["scene_park"], "字段修改只影响目标场景");
assert.equal(updated.story.events.find(event => event.id === "event_feed").object, "白鸽子", "修改必须落在事件字段而不是正文字符串");
assert.equal(updated.story.events.find(event => event.id === "event_feed").action, "喂", "字段修改不得清空本次没有提到的旧字段");

const reordered = applyStoryPatch(story, {
  operations: [{
    type: "set_relation",
    relation: { id: "relation_reordered", type: "after", from: "event_arrive", to: "event_feed", sourceSpanIds: ["span_2"] }
  }]
});
assert.equal(reordered.story.relations.some(relation => relation.id === "relation_order"), false, "新顺序关系必须替换同一事件对的旧顺序，不能留下冲突关系");

const deleted = applyStoryPatch(story, { operations: [{ type: "delete_event", eventId: "event_feed" }] });
assert.equal(deleted.story.events.find(event => event.id === "event_feed").status, "deleted", "删除事件应保留历史身份并标记状态");

async function testFinalizePipeline() {
  const responses = [
    baseStory(),
    { hardErrors: [], verdict: "pass" },
    {
      title: "公园日记",
      scenes: [{ sceneId: "scene_park", sentences: [{ text: "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。", eventIds: ["event_arrive", "event_feed"] }] }]
    },
    { hardErrors: [], softIssues: [], verdict: "pass" }
  ];
  const result = await finalizeSemanticDiary({ transcript: "我跟妈妈去公园，鸽子好多好多，我喂了鸽子。" }, async () => responses.shift());
  assert.equal(result.story.schemaVersion, 2, "第一版必须返回版本化事件账本");
  assert.deepEqual(result.sentences[0].eventIds, ["event_arrive", "event_feed"], "正文来源使用事件编号而不是事实原句");
  assert.equal(responses.length, 0, "语义正确时应完成事件提取、来源审计、成文和正文审计");

  await assert.rejects(
    finalizeSemanticDiary({ transcript: "孩子只说了去公园。" }, async () => baseStory()),
    /source_span_not_in_transcript/,
    "模型虚构的来源片段必须在成文前被拒绝"
  );
}

async function testRevisionPipeline() {
  const original = baseStory();
  const currentStory = normalizeStory({
    ...original,
    spans: [...original.spans, { id: "span_school", text: "早上我去了学校", role: "child_story", accepted: true }],
    scenes: [...original.scenes, { id: "scene_school", label: "上学", order: 1, sourceSpanIds: ["span_school"] }],
    events: [...original.events, {
      id: "event_school", sceneId: "scene_school", subject: "我", action: "去", object: "学校",
      polarity: "positive", certainty: "certain", sourceSpanIds: ["span_school"], status: "active", confidence: 0.98
    }]
  });
  const current = {
    title: "公园日记",
    sentences: [
      { id: "sentence_1", sceneId: "scene_park", text: "我和妈妈去了公园，那里有好多好多鸽子，我还喂了它们。", eventIds: ["event_arrive", "event_feed"], sourceSpanIds: ["span_1", "span_2"] },
      { id: "sentence_locked", sceneId: "scene_school", text: "早上我去了学校。", eventIds: ["event_school"], sourceSpanIds: ["span_school"] }
    ]
  };
  const crossSceneReorder = applyStoryPatch(currentStory, {
    operations: [{
      type: "set_relation",
      relation: { id: "relation_school_first", type: "before", from: "event_school", to: "event_arrive", sourceSpanIds: ["span_school"] }
    }]
  });
  assert.deepEqual(crossSceneReorder.story.scenes.map(scene => scene.id), ["scene_school", "scene_park"], "跨场景顺序修正必须同时调整场景顺序");
  const responses = [
    { hardErrors: [], verdict: "pass" },
    {
      title: "公园日记",
      scenes: [{ sceneId: "scene_park", sentences: [{ text: "我和妈妈去了公园，那里有好多好多小小的鸟，我还喂了它们。", eventIds: ["event_arrive", "event_feed"] }] }]
    },
    { hardErrors: [], softIssues: [], verdict: "pass" }
  ];
  let revisionCall = 0;
  const result = await reviseSemanticDiary({ instruction: "不是鸽子，是小小的鸟", story: currentStory, ...current }, async messages => {
    if (revisionCall++ === 0) {
      const revisionSpanId = JSON.parse(messages.at(-1).content).revisionSpan.id;
      return {
        intent: "correct",
        operations: [{ type: "update_event", eventId: "event_feed", changes: { object: "小鸟", childExpressions: { add: [{ text: "小小的", bindTo: "object", policy: "preserve" }], removeTexts: [] } }, sourceSpanIds: [revisionSpanId] }]
      };
    }
    return responses.shift();
  });
  assert.equal(result.changed, true, "明确纠正必须生成新版本");
  assert.equal(result.story.events.find(event => event.id === "event_feed").object, "小鸟", "纠正应更新事件对象");
  assert.equal(result.sentences[0].text.includes("小小的"), true, "修改口述里的儿童形容词应进入局部成文");
  assert.equal(result.sentences[1].text, "早上我去了学校。", "修改一个场景时，未涉及场景必须逐字保留");
  assert.equal(result.sentences[1].id, "sentence_locked", "未涉及句子的稳定编号必须保留");
  const revisionSources = result.story.spans.filter(span => span.reason === "revision");
  assert.equal(revisionSources.length, 1, "修改口述必须作为独立来源保存在事件账本中");
  assert.match(revisionSources[0].id, /^revision_/, "每次修改必须使用唯一来源编号，不能覆盖上一次修改证据");
  assert.equal(revisionSources[0].text, "不是鸽子，是小小的鸟", "修改来源必须保留孩子本次原话");
  assert.equal(result.story.events.find(event => event.id === "event_feed").sourceSpanIds.includes(revisionSources[0].id), true, "被纠正事件必须引用本次修改原话");
}

async function testCorrectionSourceAudit() {
  const transcript = "树是甜甜的，不对，是苹果甜甜的。苹果红红的。";
  const extracted = {
    titleHint: "苹果",
    spans: [{ id: "span_correction", text: transcript, role: "child_story", accepted: true }],
    scenes: [{ id: "scene_correction", order: 0, sourceSpanIds: ["span_correction"] }],
    events: [
      { id: "old_tree", sceneId: "scene_correction", subject: "树", action: "是", object: "甜甜的", polarity: "negative", sourceSpanIds: ["span_correction"], status: "active", certainty: "certain" },
      { id: "sweet_apple", sceneId: "scene_correction", subject: "苹果", action: "是", object: "甜甜的", sourceSpanIds: ["span_correction"], status: "active", certainty: "certain" },
      { id: "red_apple", sceneId: "scene_correction", subject: "苹果", action: "是", object: "红红的", sourceSpanIds: ["span_correction"], status: "active", certainty: "certain" }
    ],
    corrections: [{ id: "correction_tree_apple", discardedText: "树是甜甜的", adoptedText: "苹果甜甜的", sourceSpanIds: ["span_correction"] }]
  };
  const responses = [
    extracted,
    { hardErrors: [{ type: "correction_retained", eventIds: ["sweet_apple"], discardedMeaning: "树是甜甜的", adoptedMeaning: "苹果甜甜的" }], verdict: "hard_fail" },
    { title: "苹果", sentences: [{ sceneId: "scene_correction", text: "苹果甜甜的、红红的。", eventIds: ["sweet_apple", "red_apple"] }] },
    { hardErrors: [], softIssues: [], verdict: "pass" }
  ];
  const result = await finalizeSemanticDiary({ transcript, facts: [] }, async () => responses.shift());
  assert.equal(result.sentences[0].text, "苹果甜甜的、红红的。", "被撤回旧意应删除，最终采用内容和儿童形容词必须完整保留");
  assert.equal(result.story.events.find(event => event.id === "old_tree").status, "superseded", "只有与discardedText语义一致的旧事件才可自动标为已撤回");
  assert.equal(result.story.events.find(event => event.id === "sweet_apple").status, "active", "最终采用内容不能因审计事件编号误判而删除");
}

Promise.all([testFinalizePipeline(), testRevisionPipeline(), testCorrectionSourceAudit()]).then(() => {
  console.log("semantic story regression: ok");
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
