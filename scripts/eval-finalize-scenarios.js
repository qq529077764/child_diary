const API_BASE_URL = process.env.API_BASE_URL || "http://127.0.0.1:5178";

function makeFacts(items) {
  return items.map(([id, slot, text, quote = text]) => ({
    id,
    slot,
    label: text.slice(0, 10),
    text,
    quote,
    source_role: "child_story",
    story_relation: "main",
    active: true
  }));
}

const scenarios = [
  {
    name: "零散学校一天",
    transcript: "今天我去上学了。然后呢，医生姐姐给我做了检查，检查没有问题。然后呢，我进教室吃早餐，吃的是粥、鸡蛋，还有山药。然后呢，我和同学们出去跳绳，跳了200多个，感觉很好。中午吃完午饭睡午觉。睡醒以后老师给我们讲了三只小猪的绘本。然后呢，吃下午茶，妈妈来接我，我很开心。",
    facts: makeFacts([
      ["school", "what", "今天我去上学了"],
      ["check", "what", "医生姐姐给我做了检查，检查没有问题"],
      ["breakfast", "what", "我进教室吃早餐，吃的是粥、鸡蛋和山药"],
      ["jump", "what", "我和同学们出去跳绳，跳了200多个，感觉很好"],
      ["nap", "what", "中午吃完午饭睡午觉"],
      ["book", "what", "睡醒以后老师给我们讲了《三只小猪》的绘本"],
      ["tea", "what", "讲完绘本后吃下午茶"],
      ["home", "what", "妈妈来接我"],
      ["happy", "feeling", "我很开心"]
    ]),
    require: ["检查", "粥", "鸡蛋", "山药", "跳绳", "200多个", "三只小猪", "下午茶", "开心"],
    order: ["检查", "早餐", "跳绳", "午饭", "三只小猪", "下午茶", "妈妈来接我"],
    forbid: ["然后呢"]
  },
  {
    name: "保留孩子形容词",
    transcript: "放学后妈妈接我回家。然后呢，我和爸爸搭了一个好高好高的城堡。沙子软软的。后来我又画了一只圆圆的小猫，我特别开心。",
    facts: makeFacts([
      ["home", "what", "放学后妈妈接我回家"],
      ["castle", "what", "我和爸爸搭了一个好高好高的城堡"],
      ["sand", "detail", "沙子软软的"],
      ["cat", "what", "我画了一只圆圆的小猫"],
      ["happy", "feeling", "我特别开心"]
    ]),
    require: ["好高好高", "软软的", "圆圆的小猫", "特别开心"],
    order: ["妈妈", "城堡", "小猫"],
    forbid: ["然后呢"]
  },
  {
    name: "纠正口述和旁人声音",
    transcript: "早上我到了学校。早餐不是在超市，是在教室里吃的，吃了鸡蛋和粥。妈妈说你说完了吗。我说还没有。然后呢，我们去沙池锻炼。",
    facts: makeFacts([
      ["arrival", "what", "早上我到了学校"],
      ["breakfast", "what", "我在教室里吃早餐，吃了鸡蛋和粥", "早餐不是在超市，是在教室里吃的，吃了鸡蛋和粥"],
      ["adult", "detail", "妈妈问我说完了吗", "妈妈说你说完了吗"],
      ["sand", "what", "我们去沙池锻炼"]
    ]),
    require: ["教室", "鸡蛋", "粥", "沙池"],
    order: ["学校", "早餐", "沙池"],
    forbid: ["超市", "你说完了吗", "还没有", "然后呢"]
  },
  {
    name: "不完整片段不成文",
    transcript: "午睡起来，我在教室里画了一幅彩虹。老师讲了。老师给我们讲的绘本是三只小猪。讲完绘本以后，我们吃了下午茶。",
    facts: makeFacts([
      ["draw", "what", "午睡起来我在教室里画了一幅彩虹"],
      ["fragment", "what", "老师讲了", "老师讲了"],
      ["book", "detail", "老师给我们讲的绘本是三只小猪"],
      ["tea", "what", "讲完绘本以后我们吃了下午茶"]
    ]),
    require: ["彩虹", "三只小猪", "下午茶"],
    order: ["彩虹", "三只小猪", "下午茶"],
    forbid: ["老师讲了。老师"]
  },
  {
    name: "大量然后重新组织",
    transcript: "然后呢我起床了，然后呢我自己穿好了衣服，然后呢背上书包，然后呢妈妈送我到学校门口，然后呢我跟妈妈说再见，然后呢医生姐姐给我检查身体，然后呢我进了教室。",
    facts: makeFacts([
      ["wake", "what", "我起床了"],
      ["dress", "what", "我自己穿好了衣服"],
      ["bag", "what", "我背上书包"],
      ["gate", "what", "妈妈送我到学校门口"],
      ["bye", "detail", "我跟妈妈说再见"],
      ["check", "what", "医生姐姐给我检查身体"],
      ["room", "what", "我进了教室"]
    ]),
    require: ["起床", "穿好", "书包", "学校门口", "妈妈说再见", "检查身体", "教室"],
    order: ["起床", "穿好", "书包", "学校门口", "再见", "检查", "教室"],
    forbid: ["然后呢"]
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
    cursor = article.indexOf(value, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

function repeatedSentences(article) {
  const parts = article.split(/[。！？!?]/u).map(value => value.replace(/[，、；：\s]/gu, "")).filter(value => value.length >= 5);
  return parts.filter((value, index) => parts.indexOf(value) !== index);
}

async function evaluate(scenario, token) {
  const startedAt = Date.now();
  try {
    const result = await post("/api/finalize", {
      transcript: scenario.transcript,
      facts: scenario.facts
    }, token);
    const article = (result.sentences || []).map(sentence => sentence.text).join("");
    const ledger = (result.facts || []).map(fact => fact.text).join("；");
    const combined = `${article}；${ledger}`;
    const checks = [];
    for (const value of scenario.require || []) checks.push({ check: `包含:${value}`, ok: article.includes(value) });
    for (const value of scenario.forbid || []) checks.push({ check: `不含:${value}`, ok: !combined.includes(value) });
    if (scenario.order) checks.push({ check: `顺序:${scenario.order.join("→")}`, ok: containsInOrder(article, scenario.order) });
    checks.push({ check: "无整句重复", ok: repeatedSentences(article).length === 0 });
    return {
      name: scenario.name,
      passed: checks.every(check => check.ok),
      elapsedMs: Date.now() - startedAt,
      failedChecks: checks.filter(check => !check.ok).map(check => check.check),
      title: result.title,
      article,
      ledger
    };
  } catch (error) {
    return { name: scenario.name, passed: false, elapsedMs: Date.now() - startedAt, error: error.message };
  }
}

async function main() {
  const session = await post("/api/auth/session", { installationId: `finalize-eval-${Date.now()}` });
  await post("/api/guardian-consent", { policyVersion: "finalize-eval-2026-10-11" }, session.token);
  const selected = process.env.SCENARIO_FILTER
    ? scenarios.filter(scenario => scenario.name.includes(process.env.SCENARIO_FILTER))
    : scenarios;
  const queue = [...selected];
  const results = [];
  const workers = Array.from({ length: Math.max(1, Math.min(3, Number(process.env.EVAL_WORKERS) || 2)) }, async () => {
    while (queue.length) {
      const scenario = queue.shift();
      const result = await evaluate(scenario, session.token);
      results.push(result);
      console.log(JSON.stringify({ name: result.name, passed: result.passed, elapsedMs: result.elapsedMs, error: result.error, failedChecks: result.failedChecks }));
    }
  });
  await Promise.all(workers);
  const ordered = selected.map(scenario => results.find(result => result.name === scenario.name));
  const times = ordered.map(result => result.elapsedMs).sort((left, right) => left - right);
  const summary = {
    passed: ordered.filter(result => result.passed).length,
    total: ordered.length,
    averageMs: Math.round(times.reduce((total, value) => total + value, 0) / Math.max(1, times.length)),
    maxMs: times[times.length - 1] || 0,
    results: ordered
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.passed !== summary.total) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
