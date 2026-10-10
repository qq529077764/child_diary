const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:5178";

const facts = [
  ["morning", "detail", "早上我很早起床，穿好衣服，背好书包", "早上我很早就起床，穿好衣服，背好书包"],
  ["arrival", "what", "妈妈走了，我进到学校里，然后进到教室里", "妈妈走了，我进到学校里，然后进到教室里"],
  ["check", "what", "医生姐姐给我检查身体，检查没有问题", "医生姐姐给我检查身体，检查没有问题"],
  ["breakfast", "what", "我在超市里吃早餐，吃了山药、鸡蛋和粥", "我在教室里吃早餐，吃了山药、鸡蛋和粥"],
  ["sand", "what", "我跟同学们去户外的沙池锻炼", "我跟同学们去户外的沙池锻炼"],
  ["lunch", "what", "到了午饭时间，我们回到教室吃午饭", "到了午饭时间，我们回到教室吃午饭"],
  ["nap", "what", "吃完午饭我们玩了一会儿，然后睡午觉", "吃完午饭我们玩了一会儿，然后睡午觉"],
  ["book", "what", "午睡起来后，老师给我们讲了《三只小猪》的绘本", "午睡起来后，老师给我们讲的绘本是三只小猪"],
  ["tea", "what", "讲完绘本之后，我们吃下午茶", "讲完绘本之后，我们吃下午茶"],
  ["home", "what", "放学后妈妈来接我", "放学后妈妈来接我"],
  ["feeling", "feeling", "我很开心", "我很开心"]
].map(([id, slot, text, quote]) => ({ id, slot, text, quote, label: text.slice(0, 8), active: true }));

const sentences = [
  ["s_morning", "早上我很早就起床，穿好衣服，背好书包。", ["morning"]],
  ["s_arrival", "妈妈走了，我进到学校里，然后进到教室里。", ["arrival"]],
  ["s_check", "医生姐姐给我检查身体，检查没有问题。", ["check"]],
  ["s_breakfast", "我在超市里吃早餐，吃了山药、鸡蛋和粥。", ["breakfast"]],
  ["s_sand", "我跟同学们去户外的沙池锻炼。", ["sand"]],
  ["s_lunch", "到了午饭时间，我们回到教室吃午饭。", ["lunch"]],
  ["s_nap", "吃完午饭我们玩了一会儿，然后睡午觉。", ["nap"]],
  ["s_book", "午睡起来后，老师给我们讲了《三只小猪》的绘本。", ["book"]],
  ["s_tea", "讲完绘本之后，我们吃下午茶。", ["tea"]],
  ["s_home", "放学后妈妈来接我。", ["home"]],
  ["s_feeling", "我很开心。", ["feeling"]]
].map(([id, text, factIds]) => ({ id, text, factIds }));

const scenarios = [
  {
    name: "明确纠正地点",
    instruction: "早餐不是在超市吃的，是在教室里吃的。",
    requireArticle: ["教室", "山药", "鸡蛋", "粥"],
    forbidAll: ["超市"]
  },
  {
    name: "只重说正确地点",
    instruction: "我在教室里吃早餐，吃了山药、鸡蛋和粥。",
    requireArticle: ["教室", "山药", "鸡蛋", "粥"],
    forbidAll: ["超市"]
  },
  {
    name: "连续过程重新排序",
    instruction: "妈妈走了，我先进入学校，医生姐姐给我检查身体，检查没有问题，我才进教室吃早餐。",
    requireArticle: ["进入学校", "医生姐姐", "教室", "早餐"],
    order: ["进入学校", "医生姐姐", "早餐"],
    forbidAll: ["超市"]
  },
  {
    name: "补充绘本地点",
    instruction: "老师是在教室里给我们讲绘本的。",
    requireArticle: ["教室", "三只小猪"],
    preserveFacts: ["tea", "home"]
  },
  {
    name: "纠正绘本名称",
    instruction: "绘本不是三只小猪，是小红帽。",
    requireArticle: ["小红帽"],
    forbidAll: ["三只小猪"]
  },
  {
    name: "删除局部描述",
    instruction: "不要写我起得很早，穿衣服和背书包要保留。",
    requireArticle: ["穿好衣服", "背好书包"],
    forbidArticle: ["很早"]
  },
  {
    name: "删除完整事件",
    instruction: "医生姐姐检查身体这件事不要写。",
    forbidAll: ["医生姐姐", "检查身体"],
    preserveFacts: ["breakfast", "book", "tea"]
  },
  {
    name: "插入新事件",
    instruction: "午睡起来以后，我们还在教室里画了一幅画，然后老师讲绘本。",
    requireArticle: ["画了一幅画", "三只小猪"],
    order: ["画了一幅画", "三只小猪"],
    preserveFacts: ["book", "tea"]
  },
  {
    name: "纠正感受程度",
    instruction: "不是很开心，是特别开心。",
    requireArticle: ["特别开心"],
    forbidAll: ["我很开心"]
  },
  {
    name: "断续长段重述",
    instruction: "妈妈走了，我就进到学校里，然后医生姐姐给我检查身体，检查，没有问题，我就进到教室里吃早餐，这里吃早餐，在教室里吃早餐。",
    requireArticle: ["学校", "医生姐姐", "教室", "早餐"],
    order: ["学校", "医生姐姐", "早餐"],
    forbidAll: ["超市"],
    forbidArticle: ["在教室里吃早餐，在教室里吃早餐", "在这里吃早餐"]
  },
  {
    name: "含糊指令",
    instruction: "前面那一段帮我改一下。",
    expectUnchanged: true
  },
  {
    name: "旧事件简略复述",
    instruction: "老师讲了绘本。",
    expectUnchanged: true
  },
  {
    name: "未说完的修改",
    instruction: "那个医生姐姐，然后就是……",
    expectUnchanged: true
  },
  {
    name: "补充孩子形容词",
    instruction: "沙池里的沙子软软的。",
    requireArticle: ["软软", "同学"],
    preserveFacts: ["book", "tea"]
  },
  {
    name: "删除一项保留其余",
    instruction: "早餐里的山药不要写，鸡蛋和粥要保留。",
    requireArticle: ["鸡蛋", "粥"],
    forbidAll: ["山药"]
  },
  {
    name: "结尾补充新事件",
    instruction: "妈妈接我回家以后，我和爸爸搭了一个好高好高的城堡。",
    requireArticle: ["爸爸", "好高好高", "城堡"],
    order: ["妈妈来接我", "好高好高的城堡"],
    preserveFacts: ["home"]
  },
  {
    name: "中间补充新事件",
    instruction: "午饭前我们洗了手，洗完手才吃午饭。",
    requireArticle: ["洗了手", "吃午饭"],
    order: ["洗了手", "吃午饭"],
    preserveFacts: ["lunch", "nap"]
  },
  {
    name: "一次纠正两处",
    instruction: "早餐是在教室里吃的，放学是爸爸来接我。",
    requireArticle: ["教室", "爸爸来接我", "山药", "鸡蛋", "粥"],
    forbidAll: ["超市", "妈妈来接我"]
  },
  {
    name: "新增同时纠正",
    instruction: "午睡起来以后我们先画了一幅画，绘本不是三只小猪，是小红帽。",
    requireArticle: ["画了一幅画", "小红帽"],
    order: ["画了一幅画", "小红帽"],
    forbidAll: ["三只小猪"],
    preserveFacts: ["tea"]
  },
  {
    name: "纠正话术不得进入正文",
    instruction: "医生姐姐给我检查身体，检查没有问题。讲完故事后，不是考察，是开始吃下午茶。",
    requireArticle: ["医生姐姐给我检查身体", "吃下午茶"],
    forbidAll: ["不是考察", "没有提问", "看看", "听听", "量量"],
    preserveFacts: ["check", "book", "home"],
    allowUnchanged: true
  },
  {
    name: "长篇续讲反复然后",
    instruction: "妈妈接我回家以后，然后呢，然后呢，我和爸爸搭了一个好高好高的城堡，然后呢，我还画了一只圆圆的小猫，然后呢，然后呢。",
    requireArticle: ["爸爸", "好高好高", "城堡", "圆圆", "小猫"],
    order: ["妈妈来接我", "城堡", "小猫"],
    forbidAll: ["然后呢"],
    preserveFacts: ["home"]
  },
  {
    name: "一段口述纠正多个事件",
    instruction: "早餐呢，然后呢，不是在超市吃，是在教室里吃，山药不要了，只吃鸡蛋和粥。然后呢，放学不是妈妈来接，是爸爸来接我。",
    requireArticle: ["教室", "鸡蛋", "粥", "爸爸来接我"],
    forbidAll: ["超市", "山药", "妈妈来接我", "然后呢"],
    preserveFacts: ["book", "tea"]
  }
];

async function post(path, body, token) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${data.error || JSON.stringify(data)}`);
  return data;
}

function containsInOrder(article, values) {
  let cursor = -1;
  for (const value of values || []) {
    const next = article.indexOf(value, cursor + 1);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

async function evaluate(scenario, token) {
  const startedAt = Date.now();
  try {
    const result = await post("/api/revise", {
      instruction: scenario.instruction,
      title: "开心的一天",
      facts,
      sentences
    }, token);
    if (scenario.expectUnchanged) {
      return { name: scenario.name, passed: result.changed === false, elapsedMs: Date.now() - startedAt, changed: result.changed, message: result.message || "" };
    }
    if (scenario.allowUnchanged && result.changed === false) {
      return { name: scenario.name, passed: true, elapsedMs: Date.now() - startedAt, changed: false, message: result.message || "" };
    }
    const article = (result.sentences || []).map(item => item.text).join("");
    const ledger = (result.facts || []).map(item => item.text).join("；");
    const combined = `${article}；${ledger}`;
    const checks = [];
    for (const value of scenario.requireArticle || []) checks.push({ check: `正文包含:${value}`, ok: article.includes(value) });
    for (const value of scenario.forbidArticle || []) checks.push({ check: `正文不含:${value}`, ok: !article.includes(value) });
    for (const value of scenario.forbidAll || []) checks.push({ check: `正文和事实不含:${value}`, ok: !combined.includes(value) });
    if (scenario.order) checks.push({ check: `顺序:${scenario.order.join("→")}`, ok: containsInOrder(article, scenario.order) });
    const factById = new Map((result.facts || []).map(fact => [fact.id, fact.text]));
    for (const id of scenario.preserveFacts || []) {
      const original = facts.find(fact => fact.id === id)?.text;
      checks.push({ check: `保留事实:${id}`, ok: factById.get(id) === original });
    }
    const passed = result.changed === true && checks.every(item => item.ok);
    return {
      name: scenario.name,
      passed,
      elapsedMs: Date.now() - startedAt,
      changed: result.changed,
      failedChecks: checks.filter(item => !item.ok).map(item => item.check),
      article,
      ledger
    };
  } catch (error) {
    return { name: scenario.name, passed: false, elapsedMs: Date.now() - startedAt, error: error.message };
  }
}

async function main() {
  const session = await post("/api/auth/session", { installationId: `revision-eval-${Date.now()}` });
  await post("/api/guardian-consent", { policyVersion: "revision-eval-2026-10-10" }, session.token);
  const selectedScenarios = process.env.SCENARIO_FILTER
    ? scenarios.filter(scenario => scenario.name.includes(process.env.SCENARIO_FILTER))
    : scenarios;
  const results = [];
  const queue = [...selectedScenarios];
  const workerCount = Math.max(1, Math.min(4, Number(process.env.EVAL_WORKERS) || 2));
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const scenario = queue.shift();
      const result = await evaluate(scenario, session.token);
      results.push(result);
      console.log(JSON.stringify({ name: result.name, passed: result.passed, elapsedMs: result.elapsedMs, changed: result.changed, error: result.error, failedChecks: result.failedChecks }));
    }
  });
  await Promise.all(workers);
  const ordered = selectedScenarios.map(scenario => results.find(result => result.name === scenario.name));
  console.log(JSON.stringify({ passed: ordered.filter(item => item.passed).length, total: ordered.length, results: ordered }, null, 2));
  if (ordered.some(item => !item.passed)) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
