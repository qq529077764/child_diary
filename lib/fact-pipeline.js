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
    sourceFactIds: uniqueStrings(value?.sourceFactIds).map(value => text(value, 128)),
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
      content: "你是5—9岁儿童口述日记的事实整理员。你只整理事实，不写文章。对照完整口述，把实时抽取产生的重复、残缺事实合并成一份准确、有序、完整的事实清单。所有内容必须来自孩子口述，不得推测、扩写或润色。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把knownFacts整理成可直接用于成文的finalFacts。",
        schema: {
          excludedFacts: [{ id: "knownFacts中的事实ID", reason: "adult_guidance|background_audio|meta_speech|unrelated|uncertain" }],
          finalFacts: [{ sourceFactIds: ["支撑这条事实的knownFacts ID"], slot: "what|detail|result|feeling", label: "简短标签", text: "人物、动作和对象完整且准确的简洁事实", quote: "仅在knownFacts完全遗漏时填写完整口述中的连续原话" }]
        },
        rules: [
          "每个knownFact必须且只能出现于一个finalFact的sourceFactIds中，或出现在excludedFacts中；同一件事的残片和重复内容合并，不同事件不要强行合并。",
          "每条finalFact必须说清人物、动作和对象，不能留下‘讲了’‘做了’一类缺少对象的残句；相邻人物不能串换归属。",
          "按完整口述的真实顺序输出；原话明确表达先后、转折或因果时，把这层关系保留在对应事实中，无意义的口头‘然后’不必保留。",
          "保留孩子原本的称呼、物品名称、形容词、叠词和有特点的表达，不自行换词。",
          "成人引导、讲述过程讨论、无关背景声和无法确认的内容放入excludedFacts；孩子明确纠正时采用纠正后的内容。",
          "只有knownFacts完全遗漏了有效内容时，才允许sourceFactIds为空；此时quote必须是fullTranscript中逐字连续出现的原话。"
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
  const knownById = new Map(knownFacts.map(fact => [fact.id, fact]));
  const usedIds = new Set();
  const finalFacts = [];
  let invalidContract = !Array.isArray(audit?.finalFacts);

  for (const item of (Array.isArray(audit?.finalFacts) ? audit.finalFacts : [])) {
    const sourceFactIds = uniqueStrings(item?.sourceFactIds).map(value => text(value, 128));
    if (sourceFactIds.some(id => !knownIds.has(id) || excludedIds.has(id) || usedIds.has(id))) {
      invalidContract = true;
      continue;
    }
    let quote = "";
    if (sourceFactIds.length) {
      sourceFactIds.forEach(id => usedIds.add(id));
      quote = joinEvidence(sourceFactIds.map(id => knownById.get(id)?.quote));
    } else {
      quote = text(item?.quote, 1000);
      if (!transcriptContainsQuote(transcript, quote)) {
        invalidContract = true;
        continue;
      }
    }
    const fact = normalizeFact({
      ...item,
      id: sourceFactIds[0] || undefined,
      sourceFactIds,
      quote,
      source: "最终事实整理"
    }, { prefix: "fact", source: "最终事实整理" });
    if (!fact) {
      invalidContract = true;
      continue;
    }
    finalFacts.push(fact);
  }

  const accountedIds = new Set([...usedIds, ...excludedIds]);
  if (knownFacts.some(fact => !accountedIds.has(fact.id))) invalidContract = true;
  if (invalidContract || !finalFacts.length) {
    return knownFacts.filter(fact => !excludedIds.has(fact.id));
  }
  return dedupeFacts(finalFacts);
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
          "正文只能使用finalFacts，按清单顺序表达；factIds使用实际支撑句子的真实ID。",
          "把相关事实组成主谓宾清楚的自然句子，人物变化时说清人物，不能串换人物或留下缺少动作对象的残句。",
          "保留事实中已有的先后、转折和因果关系；事件转换需要承接时可补少量中性的时间承接词，但不能补具体时间、原因或结果。",
          "去掉收音残片和重复口头语。反复出现的‘然后’按语义删除或合并，全文‘然后’原则上不超过一次，不机械替换成一串连接词。",
          "保留孩子的称呼、物品名称、形容词、叠词和口吻；心情只能来自feeling事实，标题不拔高主题。"
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
  if (missing.length) softIssues.push({ type: "unmapped_facts", factIds: missing });
  if (duplicate.length) softIssues.push({ type: "reused_fact_binding", factIds: duplicate });
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

async function composeFacts(facts, callJson, options = {}) {
  const messages = options.messages || compositionMessages(facts);
  const raw = await callJson(messages, { stage: options.stage || "compose_fact_diary", maxTokens: 2400, timeoutMs: 45000 });
  const composition = normalizeComposition(raw, facts, {
    fallbackTitle: options.fallbackTitle,
    allowedSentenceIds: options.allowedSentenceIds
  });
  const issues = compositionIssues(composition, facts, { lockedSentences: options.lockedSentences });
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
  let audit = null;
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
  const composition = await composeFacts(facts, callJson);
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
  const composition = await composeFacts(applied.facts, callJson, {
    messages: revisionCompositionMessages(applied.facts, current, instruction, lockedSentences),
    stage: "compose_fact_revision",
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
