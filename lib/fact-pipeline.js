const crypto = require("crypto");

const FACT_SLOTS = new Set(["what", "detail", "result", "feeling"]);
const EXCLUSION_REASONS = new Set([
  "adult_guidance",
  "background_audio",
  "meta_speech",
  "unrelated",
  "uncertain"
]);

function text(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function compactText(value) {
  return text(value, 30000).replace(/[\s，。！？、,.!?；;：:“”"'（）()《》]/gu, "");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => text(value)).filter(Boolean))];
}

function joinEvidence(values) {
  const items = uniqueStrings(values);
  if (items.length <= 1) return items[0] || "";
  return items.map(item => item.replace(/[，。；,.;]+$/u, "")).join("；");
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeFact(value, options = {}) {
  const factText = text(value?.text);
  if (!factText) return null;
  const id = text(value?.id, 128) || newId(options.prefix || "fact");
  const slot = FACT_SLOTS.has(value?.slot) ? value.slot : "detail";
  return {
    id,
    slot,
    label: text(value?.label, 80) || "日记事实",
    text: factText,
    quote: text(value?.quote, 1000),
    source: text(value?.source, 80) || options.source || "实时识别",
    active: true
  };
}

function dedupeFacts(values) {
  const result = [];
  const seenIds = new Set();
  const seenMeanings = new Set();
  for (const value of values || []) {
    const fact = normalizeFact(value);
    if (!fact || seenIds.has(fact.id)) continue;
    const meaning = compactText(fact.text);
    const quote = compactText(fact.quote);
    const key = `${fact.slot}:${meaning}:${quote}`;
    if (meaning && seenMeanings.has(key)) continue;
    seenIds.add(fact.id);
    if (meaning) seenMeanings.add(key);
    result.push(fact);
  }
  return result;
}

function transcriptContainsQuote(transcript, quote) {
  const source = compactText(transcript);
  const fragment = compactText(quote);
  return fragment.length >= 2 && source.includes(fragment);
}

function factAuditMessages(transcript, knownFacts) {
  return [
    {
      role: "system",
      content: "你是5—9岁儿童口述日记的事实审计员。你只确认事实，不写文章。以实时事实池为基础，对照完整口述，排除成人引导、讲述过程讨论、无关背景声和不确定内容，并补充确实遗漏的孩子叙事。所有事实必须来自孩子口述，不得推测、扩写或润色。保留孩子使用的称呼、形容词、叠词和有特点的表达。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "审核已抽取事实，并补充实时阶段遗漏的有效事实。",
        schema: {
          excludedFacts: [{ id: "knownFacts中的事实ID", reason: "adult_guidance|background_audio|meta_speech|unrelated|uncertain" }],
          addedFacts: [{ slot: "what|detail|result|feeling", label: "简短标签", text: "简洁事实", quote: "完整口述中真实出现的孩子原话" }]
        },
        rules: [
          "只保留孩子亲口讲述且与这篇日记有关的内容。",
          "成人提问、提醒怎么说、讨论是否说完、无关背景声不属于日记事实；成人问题要排除，但孩子的有效回答要保留。",
          "同一天可以有多个连续事件，不能因为话题变化就误删后面的相关事件。",
          "addedFacts只补knownFacts没有覆盖的内容，quote必须逐字来自fullTranscript；找不到原话就不能补充。",
          "事实只做简洁归纳，不写成作文句子；保留孩子原本的人物关系、物品名称和特色词，不自行换词。",
          "不确定、猜测、未听清或冲突且无法确认的内容不写入事实；孩子明确纠正时采用纠正后的内容。"
        ],
        fullTranscript: transcript,
        knownFacts: knownFacts.map(fact => ({
          id: fact.id,
          slot: fact.slot,
          text: fact.text,
          quote: fact.quote
        }))
      })
    }
  ];
}

function applyFactAudit(transcript, knownFacts, audit) {
  const knownIds = new Set(knownFacts.map(fact => fact.id));
  const excludedIds = new Set((Array.isArray(audit?.excludedFacts) ? audit.excludedFacts : [])
    .filter(item => knownIds.has(text(item?.id, 128)) && EXCLUSION_REASONS.has(item?.reason))
    .map(item => text(item.id, 128)));
  const accepted = knownFacts.filter(fact => !excludedIds.has(fact.id));
  const additions = (Array.isArray(audit?.addedFacts) ? audit.addedFacts : [])
    .map(item => normalizeFact(item, { prefix: "fact", source: "最终审计" }))
    .filter(Boolean)
    .filter(fact => transcriptContainsQuote(transcript, fact.quote));
  const ordered = dedupeFacts([...accepted, ...additions]);
  const transcriptText = String(transcript || "");
  return ordered
    .map((fact, index) => ({ fact, index, position: fact.quote ? transcriptText.indexOf(fact.quote) : -1 }))
    .sort((left, right) => {
      if (left.position < 0 && right.position < 0) return left.index - right.index;
      if (left.position < 0) return 1;
      if (right.position < 0) return -1;
      return left.position - right.position || left.index - right.index;
    })
    .map(item => item.fact);
}

function compositionMessages(facts) {
  return [
    {
      role: "system",
      content: "你是帮助5—9岁儿童学习语言组织的口述日记整理老师。把已经确认的事实整理成简洁、自然、有顺序的儿童日记。内容只能来自事实池，不得添加孩子没说过的人物、动作、地点、物品、原因、结果或心情。可以重组语序、补全必要语法成分，并根据已经确认的先后顺序添加少量自然过渡。保留孩子自己的称呼、形容词、叠词和口吻，不擅自造词，不写成人作文腔。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把finalFacts组织成一篇小学低年级能学习的短日记。",
        schema: {
          title: "简短标题",
          sentences: [{ text: "自然完整的句子。", factIds: ["本句实际使用的事实ID"] }]
        },
        rules: [
          "正文只能使用finalFacts中的内容；所有事实都要自然表达，factIds必须使用真实ID。",
          "按事实的真实顺序组织。可根据已确认的先后补少量承接词，但不能虚构具体时间、原因或因果。",
          "文章要像完整日记，不能逐条照抄事实，也不能把人物、动作、地点等字段机械拼接。",
          "每个事件首次出现时把人物、动作和对象表达清楚；同一人物的连续动作可以自然共用主语，但不能产生歧义。",
          "同一件事的残片、重复表达和连续动作自然合并；人物、时间或事件明显变化时自然分句，不强制一条事实一句话。",
          "只补必要的主语、宾语、标点和过渡词；去掉语气词、重复词和收音残片，不补新的事件信息。",
          "优先保留孩子合理的形容词、叠词、称呼和有特点的说法，不擅自替换近义词或创造形容。",
          "孩子反复用‘然后’时不要逐次照抄：无信息的直接删除，同一事件的动作合并，有明确节点时改成对应的时间承接，普通先后也可直接分句。全文‘然后’原则上不超过一次，不能机械地逐个替换成不同连接词。",
          "心情只能来自feeling事实；标题依据主要事件或孩子明确的感受，不拔高主题。"
        ],
        finalFacts: facts.map(fact => ({
          id: fact.id,
          slot: fact.slot,
          text: fact.text,
          quote: fact.quote
        }))
      })
    }
  ];
}

function normalizeComposition(raw, facts, options = {}) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const allowedSentenceIds = new Set(options.allowedSentenceIds || []);
  const seenSentenceIds = new Set();
  const invalidFactIds = [];
  const sentences = [];
  for (const item of (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, 20)) {
    let sentenceText = text(item?.text, 1200);
    if (!sentenceText) continue;
    if (!/[。！？!?]$/u.test(sentenceText)) sentenceText += "。";
    const requestedIds = uniqueStrings(item?.factIds).map(value => text(value, 128));
    for (const id of requestedIds) if (!factById.has(id)) invalidFactIds.push(id);
    const factIds = requestedIds.filter(id => factById.has(id));
    if (!factIds.length) continue;
    let id = text(item?.id, 128);
    if (!id || seenSentenceIds.has(id) || (allowedSentenceIds.size && !allowedSentenceIds.has(id))) id = newId("sentence");
    seenSentenceIds.add(id);
    const linkedFacts = factIds.map(factId => factById.get(factId));
    const factTexts = uniqueStrings(linkedFacts.map(fact => fact.text));
    const sourceTexts = uniqueStrings(linkedFacts.map(fact => fact.quote));
    sentences.push({
      id,
      text: sentenceText,
      factIds,
      factTexts,
      factSummary: factTexts.join("；"),
      sourceText: joinEvidence(sourceTexts)
    });
  }
  return {
    title: text(raw?.title, 80) || options.fallbackTitle || "我的日记",
    sentences,
    diagnostics: { invalidFactIds: uniqueStrings(invalidFactIds) }
  };
}

function compositionIssues(composition, facts, options = {}) {
  const hardIssues = [];
  const softIssues = [];
  if (!composition.sentences.length) hardIssues.push({ type: "empty_diary" });
  if (composition.diagnostics.invalidFactIds.length) {
    hardIssues.push({ type: "unknown_fact_ids", factIds: composition.diagnostics.invalidFactIds });
  }
  const useCount = new Map(facts.map(fact => [fact.id, 0]));
  for (const sentence of composition.sentences) {
    for (const id of sentence.factIds) useCount.set(id, (useCount.get(id) || 0) + 1);
  }
  const missing = [...useCount].filter(([, count]) => count === 0).map(([id]) => id);
  const duplicate = [...useCount].filter(([, count]) => count > 1).map(([id]) => id);
  if (missing.length) hardIssues.push({ type: "missing_facts", factIds: missing });
  if (duplicate.length) hardIssues.push({ type: "duplicate_fact_use", factIds: duplicate });
  const article = composition.sentences.map(sentence => sentence.text).join("");
  const thenCount = (article.match(/然后/gu) || []).length;
  if (thenCount > 1) softIssues.push({ type: "repeated_then", count: thenCount });
  const lockedSentences = Array.isArray(options.lockedSentences) ? options.lockedSentences : [];
  for (const locked of lockedSentences) {
    const candidate = composition.sentences.find(sentence => sentence.id === locked.id);
    if (!candidate || candidate.text !== locked.text || JSON.stringify(candidate.factIds) !== JSON.stringify(locked.factIds || [])) {
      hardIssues.push({ type: "locked_sentence_changed", sentenceId: locked.id });
    }
  }
  return { hardIssues, softIssues };
}

function repairCompositionMessages(facts, draft, issues, options = {}) {
  return [
    {
      role: "system",
      content: "你是儿童日记纠错老师。只修复检查结果指出的问题，不重新发挥，不增加事实。尽量保留草稿中已经正确、自然的句子。遗漏事实要放回正确顺序，不能机械追加到文章末尾。反复出现的‘然后’要按语义删除、合并或自然改写，不能逐个换成不同连接词。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "修复draft中的指定问题，返回完整日记。",
        schema: { title: "简短标题", sentences: [{ id: "保留的旧句ID或new", text: "完整句子。", factIds: ["事实ID"] }] },
        rules: [
          "只使用finalFacts，不新增事实，所有事实各覆盖一次。",
          "只处理issues指出的问题，其他正确表达尽量保持。",
          "lockedSentences必须使用相同id、text和factIds原样返回。",
          "不要把遗漏事实机械追加到文末；按真实顺序自然合并。",
          "全文‘然后’原则上不超过一次，但不得机械替词。"
        ],
        issues,
        finalFacts: facts.map(fact => ({ id: fact.id, slot: fact.slot, text: fact.text, quote: fact.quote })),
        lockedSentences: options.lockedSentences || [],
        draft: { title: draft.title, sentences: draft.sentences.map(sentence => ({ id: sentence.id, text: sentence.text, factIds: sentence.factIds })) }
      })
    }
  ];
}

function issueScore(issues) {
  return issues.hardIssues.length * 100 + issues.softIssues.reduce((score, issue) => score + (issue.type === "repeated_then" ? issue.count : 1), 0);
}

async function composeAndRepair(facts, callJson, options = {}) {
  const messages = options.messages || compositionMessages(facts);
  const raw = await callJson(messages, { stage: options.stage || "compose_fact_diary", maxTokens: 2400, timeoutMs: 45000 });
  let composition = normalizeComposition(raw, facts, {
    fallbackTitle: options.fallbackTitle,
    allowedSentenceIds: options.allowedSentenceIds
  });
  let issues = compositionIssues(composition, facts, { lockedSentences: options.lockedSentences });
  if (issues.hardIssues.length || issues.softIssues.some(issue => issue.type === "repeated_then")) {
    const repairedRaw = await callJson(repairCompositionMessages(facts, composition, issues, {
      lockedSentences: options.lockedSentences
    }), { stage: options.repairStage || "repair_fact_diary", maxTokens: 2400, timeoutMs: 45000 });
    const repaired = normalizeComposition(repairedRaw, facts, {
      fallbackTitle: composition.title,
      allowedSentenceIds: options.allowedSentenceIds
    });
    const repairedIssues = compositionIssues(repaired, facts, { lockedSentences: options.lockedSentences });
    if (issueScore(repairedIssues) < issueScore(issues)) {
      composition = repaired;
      issues = repairedIssues;
    }
  }
  if (issues.hardIssues.length) {
    const error = new Error("日记事实没有完整整理好，请再试一次");
    error.code = "FACT_COMPOSITION_INVALID";
    error.issues = issues.hardIssues;
    throw error;
  }
  return { ...composition, quality: { softIssues: issues.softIssues } };
}

async function finalizeFactDiary(input, callJson) {
  const transcript = text(input?.transcript, 30000);
  if (!transcript) throw new Error("没有听到可以写进日记的事情");
  const knownFacts = dedupeFacts((Array.isArray(input?.facts) ? input.facts : []).filter(fact => fact?.active !== false));
  let audit = { excludedFacts: [], addedFacts: [] };
  try {
    audit = await callJson(factAuditMessages(transcript, knownFacts), {
      stage: "audit_final_facts",
      maxTokens: 1800,
      timeoutMs: 40000
    });
  } catch (error) {
    if (!knownFacts.length) throw error;
    console.error("Final fact audit failed; using realtime facts:", error.code || error.message);
  }
  const facts = applyFactAudit(transcript, knownFacts, audit);
  if (!facts.length) throw new Error("没有听到可以写进日记的事情");
  const composition = await composeAndRepair(facts, callJson);
  return { title: composition.title, sentences: composition.sentences, facts, quality: composition.quality };
}

function revisionMessages(input, facts, sentences) {
  return [
    {
      role: "system",
      content: "你是儿童口述日记的事实修改老师。理解孩子是在纠正、删除、补充还是调整顺序，并把明确意思转换为事实操作。只能修改孩子明确提到的内容，不猜测，不因为孩子重新讲了一段话就删除未提到的旧事实。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "根据instruction生成最少且明确的事实操作。",
        schema: {
          operations: [{
            type: "replace|delete|add|reorder",
            targetFactId: "replace、delete、reorder使用的现有事实ID",
            text: "replace或add后的完整事实",
            slot: "what|detail|result|feeling",
            label: "简短标签",
            beforeFactId: "需要放在某事实前时填写",
            afterFactId: "需要放在某事实后时填写"
          }],
          message: "没有明确操作时，简短说明还需要说清什么"
        },
        rules: [
          "‘不是A，是B’或明确纠正通常是replace；只修改对应事实。",
          "只有明确说删掉、不要写、没有发生或没说过时才能delete。",
          "明确补充的新事情使用add；根据孩子表达填写beforeFactId或afterFactId，不能一律放到文末。",
          "明确调整先后顺序使用reorder；不能确定目标事实时operations返回空数组。",
          "修改指令本身不是日记事实，text只写孩子最终想表达的内容；保留孩子在修改中使用的特色词。"
        ],
        instruction: text(input?.instruction, 5000),
        facts: facts.map(fact => ({ id: fact.id, slot: fact.slot, text: fact.text, quote: fact.quote })),
        diary: sentences.map(sentence => ({ id: sentence.id, text: sentence.text, factIds: sentence.factIds }))
      })
    }
  ];
}

function applyRevisionOperations(facts, rawOperations, instruction) {
  const next = facts.map(fact => ({ ...fact }));
  const operations = [];
  const affectedFactIds = new Set();
  const ids = () => new Set(next.map(fact => fact.id));
  const locate = id => next.findIndex(fact => fact.id === id);
  for (const raw of (Array.isArray(rawOperations) ? rawOperations : []).slice(0, 20)) {
    const type = raw?.type;
    const targetFactId = text(raw?.targetFactId, 128);
    if (!['replace', 'delete', 'add', 'reorder'].includes(type)) continue;
    if (type === "replace") {
      const index = locate(targetFactId);
      const replacementText = text(raw?.text);
      if (index < 0 || !replacementText) continue;
      next[index] = {
        ...next[index],
        slot: FACT_SLOTS.has(raw?.slot) ? raw.slot : next[index].slot,
        label: text(raw?.label, 80) || next[index].label,
        text: replacementText,
        quote: text(instruction, 1000),
        source: "语音修改"
      };
      affectedFactIds.add(targetFactId);
      operations.push({ type, targetFactId });
      continue;
    }
    if (type === "delete") {
      const index = locate(targetFactId);
      if (index < 0) continue;
      next.splice(index, 1);
      affectedFactIds.add(targetFactId);
      operations.push({ type, targetFactId });
      continue;
    }
    if (type === "add") {
      const added = normalizeFact({
        ...raw,
        id: newId("fact"),
        quote: text(instruction, 1000),
        source: "语音修改"
      });
      if (!added) continue;
      const beforeFactId = ids().has(text(raw?.beforeFactId, 128)) ? text(raw.beforeFactId, 128) : "";
      const afterFactId = ids().has(text(raw?.afterFactId, 128)) ? text(raw.afterFactId, 128) : "";
      const insertAt = beforeFactId ? locate(beforeFactId) : afterFactId ? locate(afterFactId) + 1 : next.length;
      next.splice(Math.max(0, insertAt), 0, added);
      affectedFactIds.add(added.id);
      if (beforeFactId) affectedFactIds.add(beforeFactId);
      if (afterFactId) affectedFactIds.add(afterFactId);
      operations.push({ type, appliedFactId: added.id, beforeFactId, afterFactId });
      continue;
    }
    const index = locate(targetFactId);
    if (index < 0) continue;
    const beforeFactId = ids().has(text(raw?.beforeFactId, 128)) ? text(raw.beforeFactId, 128) : "";
    const afterFactId = ids().has(text(raw?.afterFactId, 128)) ? text(raw.afterFactId, 128) : "";
    if ((!beforeFactId && !afterFactId) || beforeFactId === targetFactId || afterFactId === targetFactId) continue;
    const [moving] = next.splice(index, 1);
    const insertAt = beforeFactId ? locate(beforeFactId) : locate(afterFactId) + 1;
    next.splice(Math.max(0, insertAt), 0, moving);
    affectedFactIds.add(targetFactId);
    if (beforeFactId) affectedFactIds.add(beforeFactId);
    if (afterFactId) affectedFactIds.add(afterFactId);
    operations.push({ type, targetFactId, beforeFactId, afterFactId });
  }
  return { facts: dedupeFacts(next), operations, affectedFactIds: [...affectedFactIds] };
}

function revisionCompositionMessages(facts, current, instruction, lockedSentences) {
  return [
    {
      role: "system",
      content: "你是儿童日记的局部修改老师。依据修改后的事实池重新整理受影响内容，未涉及的句子必须原样保留。可以为了承上启下调整受影响句子的相邻句，但不得借机重写整篇，不得加入事实池以外的信息。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "根据finalFacts和instruction返回修改后的完整日记。",
        schema: { title: "标题", sentences: [{ id: "原句ID或new", text: "完整句子。", factIds: ["事实ID"] }] },
        rules: [
          "正文只使用finalFacts，所有事实各覆盖一次。",
          "lockedSentences必须使用相同id、text和factIds原样返回。",
          "替换和删除在原来的位置处理；新增事件按事实顺序插入，不能统一追加到文末。",
          "受影响内容要重新组成自然完整的句子，保留孩子的特色词，不照抄修改指令。",
          "反复出现的‘然后’按语义删除、合并或自然改写；全文原则上不超过一次，不能机械替词。"
        ],
        instruction,
        finalFacts: facts.map(fact => ({ id: fact.id, slot: fact.slot, text: fact.text, quote: fact.quote })),
        lockedSentences,
        currentDiary: current
      })
    }
  ];
}

function lockedSentencesForRevision(sentences, affectedFactIds) {
  const affected = new Set(affectedFactIds);
  const mutableIndexes = new Set();
  sentences.forEach((sentence, index) => {
    if ((sentence.factIds || []).some(id => affected.has(id))) {
      mutableIndexes.add(index);
      if (index > 0) mutableIndexes.add(index - 1);
      if (index + 1 < sentences.length) mutableIndexes.add(index + 1);
    }
  });
  if (!mutableIndexes.size && sentences.length) mutableIndexes.add(sentences.length - 1);
  return sentences
    .filter((sentence, index) => !mutableIndexes.has(index))
    .map(sentence => ({ id: sentence.id, text: sentence.text, factIds: sentence.factIds || [] }));
}

async function reviseFactDiary(input, callJson) {
  const facts = dedupeFacts((Array.isArray(input?.facts) ? input.facts : []).filter(fact => fact?.active !== false));
  const sentences = (Array.isArray(input?.sentences) ? input.sentences : [])
    .map(item => ({ id: text(item?.id, 128), text: text(item?.text, 1200), factIds: uniqueStrings(item?.factIds) }))
    .filter(item => item.id && item.text);
  const instruction = text(input?.instruction, 5000);
  if (!instruction) return { changed: false, message: "刚才没有听清要修改的内容。" };
  if (!facts.length || !sentences.length) return { changed: false, message: "这篇旧日记缺少事实来源，原文已经保留。" };
  const parsed = await callJson(revisionMessages(input, facts, sentences), {
    stage: "parse_fact_revision",
    maxTokens: 1400,
    timeoutMs: 40000
  });
  const applied = applyRevisionOperations(facts, parsed?.operations, instruction);
  if (!applied.operations.length) {
    return { changed: false, message: text(parsed?.message, 200) || "还没有找到明确要修改的内容，请再说清楚一点。" };
  }
  if (!applied.facts.length) throw new Error("这次修改会删掉整篇日记，请直接使用删除日记功能");
  const lockedSentences = lockedSentencesForRevision(sentences, applied.affectedFactIds);
  const allowedSentenceIds = sentences.map(sentence => sentence.id);
  const current = { title: text(input?.title, 80) || "我的日记", sentences };
  const composition = await composeAndRepair(applied.facts, callJson, {
    messages: revisionCompositionMessages(applied.facts, current, instruction, lockedSentences),
    stage: "compose_fact_revision",
    repairStage: "repair_fact_revision",
    fallbackTitle: current.title,
    lockedSentences,
    allowedSentenceIds
  });
  return {
    changed: true,
    title: composition.title,
    sentences: composition.sentences,
    facts: applied.facts,
    quality: composition.quality
  };
}

module.exports = {
  applyFactAudit,
  applyRevisionOperations,
  compositionIssues,
  compositionMessages,
  factAuditMessages,
  finalizeFactDiary,
  normalizeComposition,
  reviseFactDiary
};
