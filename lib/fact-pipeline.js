const crypto = require("crypto");

const FACT_SLOTS = new Set(["what", "detail", "result", "feeling"]);
const WORD_SEGMENTER = new Intl.Segmenter("zh", { granularity: "word" });
const REVISION_STOP_WORDS = new Set(["我", "我们", "你", "他", "她", "它", "这", "那", "这里", "那里", "这个", "那个", "的", "了", "着", "给", "把", "被", "就", "又", "还", "然后", "先", "再", "才", "和", "跟", "在", "到"]);
const EVENT_CONTEXT_WORDS = new Set(["今天", "早上", "上午", "中午", "下午", "晚上", "后来", "以前", "以后", "之前", "之后", "午睡", "起来", "时间"]);

function text(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function compactText(value) {
  return text(value, 30000).replace(/[\s，。！？、,.!?；;：:“”"'（）()《》]/gu, "");
}

function contentWords(value) {
  return [...WORD_SEGMENTER.segment(text(value, 10000))]
    .filter(item => item.isWordLike)
    .map(item => item.segment)
    .filter(item => !REVISION_STOP_WORDS.has(item));
}

function eventWords(value) {
  return contentWords(value).filter(word => !EVENT_CONTEXT_WORDS.has(word));
}

function isUnstatedReduction(before, after, instruction, addedContext = "") {
  if (/(?:不要|别写|删除|删掉|去掉|取消|不是|改成|改为|换成|应该|其实|顺序|先.+再|先.+才)/u.test(instruction)) return false;
  const beforeWords = new Set(contentWords(before));
  const afterWords = new Set(contentWords(after));
  const contextWords = new Set(contentWords(addedContext));
  if (!beforeWords.size || !afterWords.size) return false;
  const added = [...afterWords].filter(word => !beforeWords.has(word) && !contextWords.has(word));
  const omitted = [...beforeWords].filter(word => !afterWords.has(word));
  return added.length === 0 && omitted.length > 0;
}

function eventOverlapScore(left, right) {
  const leftWords = new Set(eventWords(left));
  const rightWords = new Set(eventWords(right));
  const smaller = Math.min(leftWords.size, rightWords.size);
  if (!smaller) return 0;
  const shared = [...leftWords].filter(word => rightWords.has(word)).length;
  return shared >= 2 ? shared / smaller : 0;
}

function sharesEventCore(left, right) {
  const pairs = words => words.slice(0, -1).map((word, index) => `${word}\u0000${words[index + 1]}`);
  const leftPairs = new Set(pairs(eventWords(left)));
  if (!leftPairs.size) return false;
  return pairs(eventWords(right)).some(pair => leftPairs.has(pair));
}

function isContextOnlyExpansion(before, after, instruction) {
  const beforeWords = new Set(contentWords(before));
  const afterWords = new Set(contentWords(after));
  if (beforeWords.size < 2 || afterWords.size <= beforeWords.size) return false;
  const keepsWholeEvent = [...beforeWords].every(word => afterWords.has(word));
  return keepsWholeEvent && eventOverlapScore(before, instruction) < 0.5;
}

function normalizeRevisionInstruction(value) {
  const source = text(value, 5000);
  return source.replace(/不是([^，,。；;！？!?]{1,100})[，,]\s*(?:而)?是([^，,。；;！？!?]{1,160})/gu, (match, rejected, accepted, offset) => {
    const previous = source[offset - 1] || "";
    return !previous || /[，,。；;！？!?]/u.test(previous) ? accepted.trim() : `是${accepted.trim()}`;
  });
}

function removeRedundantClauses(value) {
  const clauses = text(value, 1200).split(/[，,；;]+/u).map(item => item.trim()).filter(Boolean);
  const kept = [];
  const keptWords = [];
  for (const clause of clauses) {
    const words = new Set(contentWords(clause));
    const repeatsEarlier = words.size >= 2 && keptWords.some(previous => [...words].every(word => previous.has(word)));
    if (repeatsEarlier) continue;
    kept.push(clause);
    keptWords.push(words);
  }
  return kept.join("，");
}

function semanticClauses(value) {
  return normalizeRevisionInstruction(value)
    .replace(/(?:(?:然后呢|然后)[，,。；;！？!?]*)+/gu, "。")
    .split(/[，,。；;！？!?]+/u)
    .map(item => item.trim())
    .filter(item => contentWords(item).length >= 2);
}

function wordCoverage(left, right) {
  const leftWords = new Set(contentWords(left));
  const rightWords = new Set(contentWords(right));
  if (!leftWords.size || !rightWords.size) return 0;
  return [...leftWords].filter(word => rightWords.has(word)).length / Math.min(leftWords.size, rightWords.size);
}

function sharesCharacterPair(left, right) {
  const source = compactText(left);
  const target = compactText(right);
  for (let index = 0; index < source.length - 1; index += 1) {
    if (target.includes(source.slice(index, index + 2))) return true;
  }
  return false;
}

function equivalentMeaningScore(left, right) {
  const leftWords = new Set(eventWords(left));
  const rightWords = new Set(eventWords(right));
  const largest = Math.max(leftWords.size, rightWords.size);
  if (!largest) return 0;
  return [...leftWords].filter(word => rightWords.has(word)).length / largest;
}

function isSemanticSubset(left, right) {
  const leftWords = new Set(eventWords(left));
  const rightWords = new Set(eventWords(right));
  return leftWords.size > 0 && [...leftWords].every(word => rightWords.has(word));
}

function uncoveredRevisionClauses(instruction, facts, proposedChanges) {
  const proposedFacts = (Array.isArray(proposedChanges) ? proposedChanges : []).flatMap(change => Array.isArray(change?.facts) ? change.facts : []).map(fact => text(fact?.text)).filter(Boolean);
  const existingFacts = facts.map(fact => fact.text);
  return semanticClauses(instruction).filter(clause => {
    const coveredByPlan = proposedFacts.some(candidate => eventOverlapScore(clause, candidate) >= 0.5 || sharesEventCore(clause, candidate) || wordCoverage(clause, candidate) >= 0.75);
    if (coveredByPlan) return false;
    const existingContext = existingFacts.some(candidate => equivalentMeaningScore(clause, candidate) >= 0.8 || isSemanticSubset(clause, candidate));
    return !existingContext;
  });
}

function revisionAnchorForClause(clauseIndex, clauses, facts) {
  const bestMatch = candidate => {
    let best = null;
    for (const fact of facts) {
      const score = Math.max(eventOverlapScore(candidate, fact.text), wordCoverage(candidate, fact.text));
      if (!sharesEventCore(candidate, fact.text) && score < 0.5) continue;
      if (!best || score > best.score) best = { factId: fact.id, score };
    }
    return best?.factId || "";
  };
  for (let distance = 1; distance < clauses.length; distance += 1) {
    const beforeIndex = clauseIndex - distance;
    if (beforeIndex >= 0) {
      const factId = bestMatch(clauses[beforeIndex]);
      if (factId) return { insertAfterFactId: factId };
    }
    const afterIndex = clauseIndex + distance;
    if (afterIndex < clauses.length) {
      const factId = bestMatch(clauses[afterIndex]);
      if (factId) return { insertBeforeFactId: factId };
    }
  }
  return null;
}

function revisionClausePosition(value, clauses) {
  let best = null;
  clauses.forEach((clause, index) => {
    const score = Math.max(eventOverlapScore(value, clause), equivalentMeaningScore(value, clause));
    const subset = isSemanticSubset(value, clause) || isSemanticSubset(clause, value);
    if (!subset && !sharesEventCore(value, clause) && score < 0.5) return;
    if (!best || score > best.score) best = { index, score };
  });
  return best?.index;
}

function recoverUncoveredRevisionFacts(reviewed, instruction, facts) {
  const knownFactIds = new Set(facts.map(fact => fact.id));
  const changes = (Array.isArray(reviewed?.changes) ? reviewed.changes : []).filter(change => {
    const mode = text(change?.mode, 20);
    if (mode === "insert") {
      const before = text(change?.insertBeforeFactId, 128);
      const after = text(change?.insertAfterFactId, 128);
      return Boolean(before || after) && !(before && after) && knownFactIds.has(before || after);
    }
    if (["replace", "delete"].includes(mode)) {
      return uniqueStrings(change?.targetFactIds).some(id => knownFactIds.has(id));
    }
    return false;
  }).map(change => ({
    ...change,
    facts: (Array.isArray(change?.facts) ? change.facts : []).map(fact => ({ ...fact }))
  }));
  const missing = new Set(uncoveredRevisionClauses(instruction, facts, changes));
  if (!missing.size) return reviewed;
  const clauses = semanticClauses(instruction);
  clauses.forEach((clause, clauseIndex) => {
    if (!missing.has(clause)) return;
    if (/(?:不要|别写|删除|删掉|去掉|取消|不是|改成|改为|换成|帮我|修改|改一下)/u.test(clause)) return;
    if (/(?:然后|然后呢|呢|就是|那个|这个|我想)$/u.test(clause)) return;
    if (/(?:之前|之后|以前|以后|前|后|时|时候)$/u.test(clause)) return;
    if (/^(?:还有|以及)/u.test(clause) && clauseIndex > 0) {
      const previousClause = clauses[clauseIndex - 1];
      let best = null;
      changes.forEach((change, changeIndex) => {
        (change.facts || []).forEach((fact, factIndex) => {
          const score = Math.max(eventOverlapScore(previousClause, fact.text), wordCoverage(previousClause, fact.text));
          if (!sharesEventCore(previousClause, fact.text) && score < 0.5) return;
          if (!best || score > best.score) best = { changeIndex, factIndex, score };
        });
      });
      if (best) {
        const targetFact = changes[best.changeIndex].facts[best.factIndex];
        const continuation = clause.replace(/^(?:还有|以及)/u, "和");
        targetFact.text = `${text(targetFact.text).replace(/[，,；;]+$/u, "")}${continuation}`;
        return;
      }
    }
    const anchor = revisionAnchorForClause(clauseIndex, clauses, facts);
    if (!anchor) return;
    changes.push({
      mode: "insert",
      targetFactIds: [],
      ...anchor,
      facts: [{ eventKey: "补充事件", slot: "what", label: text(clause, 12), text: clause }]
    });
  });
  return { ...reviewed, changes };
}

function atomizeRevisionChanges(reviewed) {
  if (!Array.isArray(reviewed?.changes)) return reviewed;
  const changes = reviewed.changes.map(change => ({
    ...change,
    facts: (Array.isArray(change?.facts) ? change.facts : []).flatMap(fact => {
      const clauses = text(fact?.text, 1200)
        .replace(/(?:(?:然后呢|然后)[，,。；;！？!?]*)+/gu, "。")
        .split(/[。；;！？!?]+/u)
        .map(item => item.trim())
        .filter(item => contentWords(item).length >= 2);
      if (clauses.length <= 1) return [fact];
      return clauses.map(clause => ({ ...fact, text: clause }));
    })
  }));
  return { ...reviewed, changes };
}

function mergeAnchoredRevisionChanges(reviewed) {
  if (!Array.isArray(reviewed?.changes)) return reviewed;
  const changes = reviewed.changes.map(change => ({
    ...change,
    targetFactIds: uniqueStrings(change?.targetFactIds),
    facts: (Array.isArray(change?.facts) ? change.facts : []).map(fact => ({ ...fact }))
  }));
  const consumed = new Set();
  changes.forEach((change, index) => {
    if (change.mode !== "insert") return;
    const beforeFactId = text(change.insertBeforeFactId, 128);
    const afterFactId = text(change.insertAfterFactId, 128);
    const anchorFactId = beforeFactId || afterFactId;
    if (!anchorFactId) return;
    const replacementIndex = changes.findIndex((candidate, candidateIndex) => (
      candidateIndex !== index
      && candidate.mode === "replace"
      && uniqueStrings(candidate.targetFactIds).includes(anchorFactId)
    ));
    if (replacementIndex < 0) return;
    const replacement = changes[replacementIndex];
    replacement.facts = beforeFactId
      ? [...change.facts, ...replacement.facts]
      : [...replacement.facts, ...change.facts];
    consumed.add(index);
  });
  changes.forEach((change, index) => {
    if (change.mode !== "insert" || consumed.has(index)) return;
    const beforeEventKey = text(change.insertBeforeFactId, 128);
    const afterEventKey = text(change.insertAfterFactId, 128);
    const anchorEventKey = beforeEventKey || afterEventKey;
    if (!anchorEventKey) return;
    const parentIndex = changes.findIndex((candidate, candidateIndex) => (
      candidateIndex !== index
      && !consumed.has(candidateIndex)
      && candidate.mode === "insert"
      && (candidate.facts || []).some(fact => text(fact?.eventKey, 128) === anchorEventKey)
    ));
    if (parentIndex < 0) return;
    const parent = changes[parentIndex];
    parent.facts = beforeEventKey
      ? [...change.facts, ...parent.facts]
      : [...parent.facts, ...change.facts];
    consumed.add(index);
  });
  return { ...reviewed, changes: changes.filter((change, index) => !consumed.has(index)) };
}

function sanitizeRevisionChanges(reviewed, instruction, facts) {
  if (!Array.isArray(reviewed?.changes)) return reviewed;
  const rawClauses = text(instruction, 5000)
    .replace(/(?:然后呢[，,。；;！？!?]*)+/gu, "。")
    .split(/[，,。；;！？!?]+/u)
    .map(item => item.trim())
    .filter(Boolean);
  const negativeClauses = rawClauses.filter(clause => /(?:不要|别写|删除|删掉|去掉|取消|不是|不对)/u.test(clause));
  const positiveClauses = semanticClauses(instruction).filter(clause => !/(?:不要|别写|删除|删掉|去掉|取消|不是|不对)/u.test(clause));
  const hasCorrectionIntent = /(?:不要|别写|删除|删掉|去掉|取消|不是|不对|改成|改为|换成)/u.test(instruction);
  const hasReorderIntent = /(?:顺序|重新排序|调到|移到|先.+再|先.+才)/u.test(instruction);
  const knownFactIds = new Set(facts.map(fact => fact.id));
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const instructionClauses = semanticClauses(instruction);
  const bestConflictFor = candidate => {
    let best = null;
    for (const fact of facts) {
      const score = Math.max(eventOverlapScore(candidate.text, fact.text), equivalentMeaningScore(candidate.text, fact.text));
      const threshold = hasCorrectionIntent ? 0.5 : 0.6;
      if (score < threshold) continue;
      if (!best || score > best.score) best = { factId: fact.id, score };
    }
    return best;
  };
  const changes = reviewed.changes.map(change => {
    const cleanedFacts = (Array.isArray(change?.facts) ? change.facts : []).flatMap(fact => {
      let factText = text(fact?.text);
      const factClauses = factText.split(/[，,；;]+/u).map(clause => clause.trim()).filter(Boolean);
      if (factClauses.length > 1) {
        const declarativeClauses = factClauses.filter(clause => !/(?:不要|别写|删除|删掉|去掉|取消|不是|不对|改成|改为|换成)/u.test(clause));
        if (declarativeClauses.length && declarativeClauses.length < factClauses.length) factText = declarativeClauses.join("，");
      }
      if (!factText || (/呢$/u.test(factText) && eventWords(factText).length <= 2)) return [];
      if (/(?:之前|之后|以前|以后|前|后|时|时候)$/u.test(factText)) return [];
      const accepted = positiveClauses.some(clause => eventOverlapScore(factText, clause) >= 0.5 || sharesEventCore(factText, clause) || wordCoverage(factText, clause) >= 0.75);
      const rejected = !accepted && negativeClauses.some(clause => (
        eventOverlapScore(factText, clause) >= 0.5
        || sharesEventCore(factText, clause)
        || wordCoverage(factText, clause) >= 0.75
        || equivalentMeaningScore(factText, clause) >= 0.6
        || sharesCharacterPair(factText, clause)
      ));
      if (rejected) return [];
      let expandedText = factText;
      let expandedWordCount = eventWords(factText).length;
      for (const clause of expandedWordCount <= 2 ? positiveClauses : []) {
        const clauseWordCount = eventWords(clause).length;
        if (clauseWordCount <= expandedWordCount) continue;
        if (eventOverlapScore(factText, clause) >= 0.5 || sharesEventCore(factText, clause) || wordCoverage(factText, clause) >= 0.75) {
          expandedText = clause;
          expandedWordCount = clauseWordCount;
        }
      }
      return [{ ...fact, text: expandedText }];
    });
    let mode = text(change?.mode, 20);
    let targetFactIds = uniqueStrings(change?.targetFactIds).filter(id => knownFactIds.has(id));
    let insertBeforeFactId = text(change?.insertBeforeFactId, 128);
    let insertAfterFactId = text(change?.insertAfterFactId, 128);
    let executableFacts = cleanedFacts;

    if (mode === "replace" && !hasReorderIntent && targetFactIds.length && executableFacts.length) {
      if (hasCorrectionIntent) {
        executableFacts = executableFacts.filter(candidate => {
          const repeatsTarget = targetFactIds.some(factId => {
            const target = factById.get(factId);
            return target && equivalentMeaningScore(candidate.text, target.text) >= 0.8;
          });
          const statedAsCorrection = positiveClauses.some(clause => (
            eventOverlapScore(candidate.text, clause) >= 0.5
            || sharesEventCore(candidate.text, clause)
            || wordCoverage(candidate.text, clause) >= 0.75
          ));
          return !repeatsTarget || statedAsCorrection;
        });
      }
      const resolvedTargetFactIds = hasCorrectionIntent
        ? uniqueStrings(executableFacts.map(candidate => bestConflictFor(candidate)?.factId))
        : [];
      if (resolvedTargetFactIds.length) {
        mode = "replace";
        targetFactIds = resolvedTargetFactIds;
        insertBeforeFactId = "";
        insertAfterFactId = "";
      }
    }

    if (mode === "insert" && executableFacts.length) {
      executableFacts = executableFacts.filter(candidate => !facts.some(fact => equivalentMeaningScore(candidate.text, fact.text) >= 0.8));
      const conflictFactIds = uniqueStrings(executableFacts.flatMap(candidate => {
        const hasSequence = /(?:之前|之后|以前|以后|前|后|先|再|才)/u.test(candidate.text);
        if (hasSequence) return [];
        const conflict = bestConflictFor(candidate);
        return conflict ? [conflict.factId] : [];
      }));
      if (conflictFactIds.length) {
        mode = "replace";
        targetFactIds = conflictFactIds;
        insertBeforeFactId = "";
        insertAfterFactId = "";
      }
      if (mode === "insert" && executableFacts.length) {
        const anchorFactId = insertBeforeFactId || insertAfterFactId;
        const anchor = factById.get(anchorFactId);
        const anchorPosition = anchor ? revisionClausePosition(anchor.text, instructionClauses) : undefined;
        const factPositions = executableFacts.map(fact => revisionClausePosition(fact.text, instructionClauses)).filter(index => index !== undefined);
        if (anchorPosition !== undefined && factPositions.length) {
          if (Math.max(...factPositions) < anchorPosition) {
            insertBeforeFactId = anchorFactId;
            insertAfterFactId = "";
          } else if (Math.min(...factPositions) > anchorPosition) {
            insertAfterFactId = anchorFactId;
            insertBeforeFactId = "";
          }
        }
      }
    }
    return { ...change, mode, targetFactIds, insertBeforeFactId, insertAfterFactId, facts: executableFacts };
  });
  return { ...reviewed, changes };
}

function removeRedundantSentences(values) {
  const items = values.map((sentence, index) => ({ sentence, index, words: new Set(contentWords(sentence.text)) }));
  return items.filter(item => !items.some(other => {
    if (other.index === item.index || item.words.size < 2 || other.words.size < item.words.size) return false;
    if (other.words.size === item.words.size && other.index > item.index) return false;
    return [...item.words].every(word => other.words.has(word));
  })).map(item => item.sentence);
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
    eventKey: text(value?.eventKey, 80),
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
      content: "你是5—9岁儿童口述日记的语义事实整理员。你只确定孩子说了哪些事情，不写文章，也不添加文章连接词。把零散口述整理成独立、准确、有顺序的中性语义事实；事实text不是原话摘抄，可以修复口头语法，但不能增加原话没有的人物、动作、对象、描述、原因、结果或感受。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把knownFacts整理成可直接用于成文的finalFacts。",
        schema: {
          finalFacts: [{ eventKey: "同一事件共用的简短事件标识", sourceFactIds: ["支撑这条事实的knownFacts ID，可被同一事件的不同事实重复引用"], slot: "what人物动作对象|detail新描述|result明确结果|feeling孩子感受", label: "简短标签", text: "自然语法表达的单一语义事实，简短且不照抄口述句式", quote: "仅在knownFacts完全遗漏时填写完整口述中的连续原话" }]
        },
        rules: [
          "保留故事主线、理解事件所需的背景事实，以及直接相关的描述、结果和感受；动作、描述、结果、感受分别成为独立事实，同一事件用相同eventKey关联，不把整段口述拼进一条text。detail必须提供新信息，不能换句话重复what。",
          "只合并表达同一个语义内容的重复或互补残片；text使用自然简洁的主谓宾，去掉停顿、倒装、重复和口头连接词。保留孩子使用的称呼、物品名称、形容词和叠词，不保留原来的语病和语序。",
          "根据口述中已经明确的时间和先后关系排列事件；不确定的内容不推断，不同人物和不同事件不合并。",
          "成人引导、讲述过程讨论、无关背景声、重复细枝末节和无法完成语义的残片不进入finalFacts；孩子明确纠正时采用纠正后的内容。",
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
  const knownById = new Map(knownFacts.map(fact => [fact.id, fact]));
  const outputIds = new Set();
  const finalFacts = [];

  for (const item of (Array.isArray(audit?.finalFacts) ? audit.finalFacts : [])) {
    const sourceFactIds = uniqueStrings(item?.sourceFactIds).map(value => text(value, 128));
    if (sourceFactIds.some(id => !knownIds.has(id))) continue;
    let quote = "";
    if (sourceFactIds.length) {
      quote = joinEvidence(sourceFactIds.map(id => knownById.get(id)?.quote));
    } else {
      quote = text(item?.quote, 1000);
      if (!transcriptContainsQuote(transcript, quote)) continue;
    }
    const fact = normalizeFact({
      ...item,
      id: sourceFactIds.find(id => !outputIds.has(id)) || undefined,
      sourceFactIds,
      quote,
      source: "最终事实整理"
    }, { prefix: "fact", source: "最终事实整理" });
    if (!fact) continue;
    outputIds.add(fact.id);
    finalFacts.push(fact);
  }
  return dedupeFacts(finalFacts);
}

function compositionMessages(facts) {
  return [
    {
      role: "system",
      content: "你是帮助5—9岁儿童学习语言组织的口述日记整理老师。语义事实只限定文章写什么，不提供可照抄的句式。请统一完成唯一一次语言组织，写成主谓宾清楚、自然连贯、有顺序的儿童日记；不能增加事实池以外的人物、动作、地点、物品、原因、结果或心情。只返回JSON。"
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
          "正文只能使用finalFacts并按已经确认的事件顺序表达；同一eventKey下的动作、描述、结果和感受按可读性组合或分句，不必挤进同一句，factIds标出各句实际使用的事实。",
          "finalFacts的text是内容依据，不是句式模板；按照自然汉语重新组织主谓宾，修复口语语序并合并重复过程，不能机械地逐条复述事实。",
          "保留事实中已有的先后、转折和因果关系；事件转换需要承接时可补少量中性的时间承接词，但不能补具体时间、原因或结果。",
          "去掉收音残片和重复口头语。反复出现的‘然后’按语义删除或合并，全文‘然后’原则上不超过一次，不机械替换成一串连接词。",
          "保留孩子的称呼、物品名称、形容词、叠词和有特点的用词；语序、普通量词、语气词和结构助词按自然语法组织，不保留停顿、倒装、重复及不完整句式。心情只能来自feeling事实，标题只能概括已有主题。"
        ],
        finalFacts: facts.map(fact => ({
          id: fact.id,
          eventKey: fact.eventKey,
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
    softIssues.push({ type: "ignored_unknown_fact_ids", factIds: composition.diagnostics.invalidFactIds });
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
  return { hardIssues, softIssues };
}

async function composeFacts(facts, callJson, options = {}) {
  const messages = options.messages || compositionMessages(facts);
  const raw = await callJson(messages, { stage: options.stage || "compose_fact_diary", maxTokens: 2400, timeoutMs: 45000 });
  const composition = normalizeComposition(raw, facts, {
    fallbackTitle: options.fallbackTitle,
    allowedSentenceIds: options.allowedSentenceIds
  });
  const issues = compositionIssues(composition, facts);
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
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  return [
    {
      role: "system",
      content: "你是儿童口述日记的语义修改员。你只识别修改口述对当前日记事实造成的变化，不写文章。修改口述可能零散、重复或反复说‘然后呢’；请按语义识别新增、纠正、删除和重排，不照抄口述句式，也不猜测新事实。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "比较instruction与当前日记，返回原子化的事实变更计划；程序会保留未涉及的原句，稍后再单独完成局部成文。",
        schema: {
          changes: [{
            mode: "replace|delete|insert",
            targetFactIds: ["replace或delete时，确实需要改变的旧事实ID"],
            insertBeforeFactId: "insert时，在这条旧事实前插入；与insertAfterFactId二选一",
            insertAfterFactId: "insert时，在这条旧事实后插入；与insertBeforeFactId二选一",
            facts: [{ eventKey: "同一事件共用的简短标识", slot: "what|detail|result|feeling", label: "简短标签", text: "自然语法表达的单一语义事实" }]
          }],
          message: "没有明确修改时changes返回空数组，并简短说明还需要说清什么"
        },
        boundaries: [
          "按人物、动作、对象和发生阶段判断是不是同一事件，不按字面是否相同判断。纠正已有事实的人物、动作、地点、对象或结果时replace；给已有事件补充不冲突的新描述或感受时insert在该事实旁边；全新事件也使用insert。",
          "replace的facts表示targetFactIds修改后的完整语义状态：只改变明确纠正或冲突的内容，口述没有再次说到的旧细节继续保留。整件事实明确删除时使用delete且facts为空。",
          "把动作、描述、结果和感受拆成独立事实并用eventKey关联；去掉停顿、重复、纠正话术和无意义的‘然后呢’，保留已经明确的先后关系。无法完成语义的残片不进入事实。",
          "insert只包含原日记不存在的新事件；口述顺带重说的前后旧事件只用于选择insertBeforeFactId或insertAfterFactId，不能写进新增facts。",
          "同一次口述涉及相距较远的旧事实时分别返回change；连续事实被重新排序时可以在一个replace中共同列入targetFactIds。无法确定修改对象或内容时不操作。"
        ],
        abstractExample: {
          diaryFacts: ["fact_A是已有事件A", "fact_B是已有事件B"],
          instructionMeaning: "新增事件X，之后仍是原来的事件B",
          correctChange: "insert事件X并定位在fact_B之前；fact_B只是位置参照，不进入targetFactIds或新增facts"
        },
        instruction: normalizeRevisionInstruction(text(input?.instruction, 5000)),
        diary: sentences.map(sentence => ({
          id: sentence.id,
          text: sentence.text,
          facts: (sentence.factIds || []).map(id => factById.get(id)).filter(Boolean).map(fact => ({ id: fact.id, slot: fact.slot, text: fact.text }))
        }))
      })
    }
  ];
}

function revisionReductionWarnings(instruction, facts, proposedChanges) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const replacementReview = (Array.isArray(proposedChanges) ? proposedChanges : [])
    .filter(change => change?.mode === "replace")
    .map(change => ({
      targetFactIds: uniqueStrings(change?.targetFactIds),
      before: uniqueStrings(change?.targetFactIds).map(id => factById.get(id)?.text).filter(Boolean),
      after: (Array.isArray(change?.facts) ? change.facts : []).map(fact => text(fact?.text)).filter(Boolean)
    }));
  const negativeWords = new Set(text(instruction, 5000)
    .split(/[，,。；;！？!?]+/u)
    .filter(clause => /(?:不要|别写|删除|删掉|去掉|取消|不是|不对|改成|改为|换成)/u.test(clause))
    .flatMap(clause => contentWords(clause)));
  const negativeClauses = text(instruction, 5000)
    .split(/[，,。；;！？!?]+/u)
    .filter(clause => /(?:不要|别写|删除|删掉|去掉|取消|不是|不对|改成|改为|换成)/u.test(clause));
  return replacementReview.flatMap(item => {
    const beforeWords = new Set(item.before.flatMap(value => contentWords(value)));
    const afterWords = new Set(item.after.flatMap(value => contentWords(value)));
    const explicitlyChangedWords = new Set(item.before.flatMap(value => text(value, 1200).split(/[，,；;]+/u)).flatMap(sourceClause => {
      const changed = negativeClauses.some(negative => (
        eventOverlapScore(sourceClause, negative) >= 0.5
        || wordCoverage(sourceClause, negative) >= 0.75
        || sharesCharacterPair(sourceClause, negative)
      ));
      return changed ? contentWords(sourceClause) : [];
    }));
    const omitted = [...beforeWords].filter(word => !afterWords.has(word) && !negativeWords.has(word) && !explicitlyChangedWords.has(word));
    const substantiallyShorter = beforeWords.size >= 4 && afterWords.size < beforeWords.size * 0.75;
    return omitted.length >= 2 && substantiallyShorter ? [{ ...item, omittedMeaningWords: omitted }] : [];
  });
}

function revisionAuditMessages(input, facts, sentences, proposedChanges) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const replacementReview = (Array.isArray(proposedChanges) ? proposedChanges : [])
    .filter(change => change?.mode === "replace")
    .map(change => ({
      targetFactIds: uniqueStrings(change?.targetFactIds),
      before: uniqueStrings(change?.targetFactIds).map(id => factById.get(id)?.text).filter(Boolean),
      after: (Array.isArray(change?.facts) ? change.facts : []).map(fact => text(fact?.text)).filter(Boolean)
    }));
  const possibleUnstatedReductions = revisionReductionWarnings(input?.instruction, facts, proposedChanges);
  return [
    {
      role: "system",
      content: possibleUnstatedReductions.length
        ? "你是儿童日记局部修改的最终复核员。候选替换正在意外缩短原事实。局部修改中‘没有重新说’绝不表示删除：除非rawInstruction明确纠正或删除，旧事实里的对象、数量、描述和结果必须进入替换后的完整语义状态。不要写文章，只返回JSON。"
        : "你是儿童日记语义修改计划的最终复核员。候选计划已经经过一次事实提取和自动补漏；你只确定最终可执行的事实变化，不写文章。对照修改口述和当前日记，合并重复、删除残片、修正遗漏和目标选错。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "把candidateChanges复核成最终可执行的changes；你的输出之后不会再从旧文本或口述残片生成新事实。",
        schema: {
          changes: [{
            mode: "replace|delete|insert",
            targetFactIds: ["replace或delete实际改变的旧事实ID"],
            insertBeforeFactId: "insert时可选",
            insertAfterFactId: "insert时可选",
            facts: [{ eventKey: "同一事件共用标识", slot: "what|detail|result|feeling", label: "简短标签", text: "自然语法表达的单一语义事实" }]
          }],
          message: "没有明确变化时填写说明"
        },
        checks: [
          "修改口述中每个明确的新增、纠正、删除或重排只出现一次；事实必须是人物动作对象、有效描述、明确结果或感受之一，口头连接、数量残片、名词残片和未完成的话不单独成为事实。",
          "逐项判断uncoveredInstructionClauses：只有能组成完整语义且没有被其他候选事实包含时才补入；已包含的食物、地点、数量或描述不能拆出来重复新增。",
          "纠正已有事实时replace并指向正确旧事实；新增事件或给旧事件补充不冲突的新描述、感受时insert在相应位置，顺带重说的旧内容只作为位置参照。",
          "逐项对照replacementReview的before和after。replace后的facts表示目标事件修改后的完整语义状态：只去掉明确纠正、删除或无效的部分；未被修改的对象、数量、描述和结果继续保留，但不要复制停顿、连接词、重复句和不完整残片。",
          "possibleUnstatedReductions表示候选替换可能意外丢掉的旧含义；按instruction判断后，未被明确删除或纠正的内容补回最终facts，被纠正的旧内容不能补回。",
          "同一事件的动作、对象、数量、描述和感受用eventKey关联；相同含义只保留一次。‘不是、改成、不要写’等修改过程不是日记事实。"
        ],
        rawInstruction: text(input?.instruction, 5000),
        instruction: normalizeRevisionInstruction(text(input?.instruction, 5000)),
        uncoveredInstructionClauses: uncoveredRevisionClauses(input?.instruction, facts, proposedChanges),
        replacementReview,
        possibleUnstatedReductions,
        candidateChanges: Array.isArray(proposedChanges) ? proposedChanges : [],
        diary: sentences.map(sentence => ({
          id: sentence.id,
          text: sentence.text,
          facts: (sentence.factIds || []).map(id => factById.get(id)).filter(Boolean).map(fact => ({ id: fact.id, eventKey: fact.eventKey, slot: fact.slot, text: fact.text }))
        }))
      })
    }
  ];
}

function revisionCompletenessMessages(input, facts, proposedChanges) {
  const warnings = revisionReductionWarnings(input?.instruction, facts, proposedChanges);
  return [
    {
      role: "system",
      content: "你是儿童日记局部修改的完整性复核员。你不重新理解整篇日记，只修复replace意外删掉旧细节的问题。局部修改里，没有重新说到但仍然完整、有意义的旧内容应保留；rawInstruction明确纠正或删除的内容，以及旧事实里的停顿、连接词、重复和残片应移除。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "修复candidateChanges中的意外缩短，返回完整changes。所有不在修改范围内的change原样保留。",
        schema: {
          changes: [{
            mode: "replace|delete|insert",
            targetFactIds: ["旧事实ID"],
            insertBeforeFactId: "可选",
            insertAfterFactId: "可选",
            facts: [{ eventKey: "事件标识", slot: "what|detail|result|feeling", label: "标签", text: "完整语义事实" }]
          }]
        },
        rawInstruction: text(input?.instruction, 5000),
        possibleUnstatedReductions: warnings,
        candidateChanges: Array.isArray(proposedChanges) ? proposedChanges : []
      })
    }
  ];
}

function restoreSafeLegacyDetail(reviewed, instruction, facts) {
  if (!Array.isArray(reviewed?.changes)) return reviewed;
  if (!revisionReductionWarnings(instruction, facts, reviewed.changes).length) return reviewed;
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const negativeClauses = text(instruction, 5000)
    .split(/[，,。；;！？!?]+/u)
    .filter(clause => /(?:不要|别写|删除|删掉|去掉|取消|不是|不对|改成|改为|换成)/u.test(clause));
  const changes = reviewed.changes.map(change => {
    if (change?.mode !== "replace") return change;
    const newFacts = (Array.isArray(change?.facts) ? change.facts : []).map(fact => ({ ...fact }));
    for (const targetFactId of uniqueStrings(change?.targetFactIds)) {
      const source = factById.get(targetFactId);
      const clauses = text(source?.text, 1200).split(/[，,；;]+/u).map(value => value.trim()).filter(Boolean);
      if (clauses.length !== 2) continue;
      for (const clause of clauses) {
        const covered = newFacts.some(fact => (
          eventOverlapScore(clause, fact.text) >= 0.5
          || sharesEventCore(clause, fact.text)
          || wordCoverage(clause, fact.text) >= 0.75
        ));
        if (covered || contentWords(clause).length < 2) continue;
        if (!/(?:了|着|过|吃|喝|看|讲|说|做|玩|画|搭|去|来|感觉|觉得|喜欢)/u.test(clause)) continue;
        const contradicted = negativeClauses.some(negative => (
          eventOverlapScore(clause, negative) >= 0.5
          || wordCoverage(clause, negative) >= 0.75
          || sharesCharacterPair(clause, negative)
        ));
        if (contradicted) continue;
        const eventKey = text(newFacts[0]?.eventKey, 80) || text(source?.eventKey, 80) || "保留细节";
        newFacts.push({ eventKey, slot: "detail", label: text(clause, 12), text: clause });
      }
    }
    return { ...change, facts: newFacts };
  });
  return { ...reviewed, changes };
}

function prepareRevisionPlans(parsed, facts, sentences, semanticInstruction) {
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  const sentenceIndexesByFactId = new Map();
  sentences.forEach((sentence, sentenceIndex) => {
    for (const factId of sentence.factIds || []) {
      const indexes = sentenceIndexesByFactId.get(factId) || [];
      indexes.push(sentenceIndex);
      sentenceIndexesByFactId.set(factId, indexes);
    }
  });
  const rawChanges = Array.isArray(parsed?.changes) ? parsed.changes : [];
  const plans = [];
  rawChanges.slice(0, 10).forEach((change, changeIndex) => {
    const mode = text(change?.mode, 20);
    let newFacts = (Array.isArray(change?.facts) ? change.facts : []).slice(0, 30).map((fact, factIndex) => ({
      ...fact,
      key: `new_${changeIndex + 1}_${factIndex + 1}`,
      eventKey: text(fact?.eventKey, 80)
    })).filter(fact => text(fact.text));
    if (mode === "insert") {
      const beforeFactId = text(change?.insertBeforeFactId, 128);
      const afterFactId = text(change?.insertAfterFactId, 128);
      if (!newFacts.length || (!beforeFactId && !afterFactId) || (beforeFactId && afterFactId)) return;
      const anchorFactId = beforeFactId || afterFactId;
      const anchorIndexes = sentenceIndexesByFactId.get(anchorFactId) || [];
      if (!factById.has(anchorFactId) || !anchorIndexes.length) return;
      const anchorSentence = sentences[beforeFactId ? Math.min(...anchorIndexes) : Math.max(...anchorIndexes)];
      plans.push({
        mode: "insert",
        insertBeforeSentenceId: beforeFactId ? anchorSentence.id : "",
        insertAfterSentenceId: afterFactId ? anchorSentence.id : "",
        facts: newFacts,
        compositionFacts: newFacts,
        semanticInstruction
      });
      return;
    }
    if (!['replace', 'delete'].includes(mode)) return;
    const targetFactIds = uniqueStrings(change?.targetFactIds).filter(id => factById.has(id) && sentenceIndexesByFactId.has(id));
    if (!targetFactIds.length || (mode === "replace" && !newFacts.length)) return;
    const targetIndexes = [...new Set(targetFactIds.flatMap(id => sentenceIndexesByFactId.get(id) || []))].sort((left, right) => left - right);
    if (!targetIndexes.length || targetIndexes[targetIndexes.length - 1] - targetIndexes[0] + 1 !== targetIndexes.length) return;
    const targetSentences = sentences.slice(targetIndexes[0], targetIndexes[targetIndexes.length - 1] + 1);
    const correctionIntent = /(?:不要|别写|删除|删掉|去掉|取消|不是|改成|改为|换成|应该|其实)/u.test(semanticInstruction);
    const targetFacts = targetFactIds.map(id => factById.get(id)).filter(Boolean);
    const additiveDetail = mode === "replace" && !correctionIntent && newFacts.every(fact => targetFacts.every(target => eventOverlapScore(fact.text, target.text) < 0.5 && !sharesEventCore(fact.text, target.text) && wordCoverage(fact.text, target.text) < 0.75));
    const removeFactIds = additiveDetail ? [] : targetFactIds;
    const removeSet = new Set(removeFactIds);
    const targetSequence = uniqueStrings(targetSentences.flatMap(sentence => sentence.factIds || [])).filter(id => factById.has(id));
    const compositionFacts = [];
    let replacementsInserted = false;
    for (const factId of targetSequence) {
      if (removeSet.has(factId)) {
        if (!replacementsInserted) {
          compositionFacts.push(...newFacts);
          replacementsInserted = true;
        }
        continue;
      }
      const kept = factById.get(factId);
      compositionFacts.push({
        key: `kept_${changeIndex + 1}_${compositionFacts.length + 1}`,
        existingFactId: kept.id,
        eventKey: kept.eventKey,
        slot: kept.slot,
        label: kept.label,
        text: kept.text
      });
    }
    if (!replacementsInserted) compositionFacts.push(...newFacts);
    plans.push({
      mode: "replace",
      targetSentenceIds: targetSentences.map(sentence => sentence.id),
      removeFactIds,
      facts: newFacts,
      compositionFacts,
      semanticInstruction
    });
  });
  const insertContext = plans.filter(plan => plan.mode === "insert").flatMap(plan => plan.facts.map(fact => fact.text)).join("；");
  return plans.map((plan, index) => ({
    ...plan,
    operationKey: `operation_${index + 1}`,
    additionContext: insertContext
  }));
}

function revisionPlanContext(plan, sentences) {
  const indexById = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  if (plan.mode === "replace") {
    const indexes = uniqueStrings(plan.targetSentenceIds).map(id => indexById.get(id)).filter(index => index !== undefined).sort((left, right) => left - right);
    if (!indexes.length) return { before: "", replaced: [], after: "" };
    const start = indexes[0];
    const end = indexes[indexes.length - 1];
    return {
      before: sentences[start - 1]?.text || "",
      replaced: sentences.slice(start, end + 1).map(sentence => sentence.text),
      after: sentences[end + 1]?.text || ""
    };
  }
  const beforeId = text(plan.insertBeforeSentenceId, 128);
  const afterId = text(plan.insertAfterSentenceId, 128);
  const anchor = indexById.get(beforeId || afterId);
  if (anchor === undefined) return { before: "", replaced: [], after: "" };
  const insertAt = beforeId ? anchor : anchor + 1;
  return {
    before: sentences[insertAt - 1]?.text || "",
    replaced: [],
    after: sentences[insertAt]?.text || ""
  };
}

function revisionCompositionMessages(plans, sentences) {
  return [
    {
      role: "system",
      content: "你是帮助5—9岁儿童整理日记的局部成文老师。语义修改计划已经确定，你只把每个修改范围内的事实组织成自然、简洁、有顺序的句子。相邻原句只用于理解衔接，不能改写、复述或补充其中的事实。只返回JSON。"
    },
    {
      role: "user",
      content: JSON.stringify({
        task: "分别为每个operation写局部替换句；这是修改流程中唯一一次语言组织。",
        schema: {
          operations: [{ key: "原样返回operation key", sentences: [{ text: "自然完整的句子", factKeys: ["本句实际使用的事实key"] }] }]
        },
        boundaries: [
          "句子只能使用对应operation的facts；每条事实都要表达并绑定，不能新增、遗漏或串到其他operation。facts为空表示删除，sentences也返回空数组。",
          "facts的text是内容依据而不是句式模板；同一eventKey的动作、描述、结果和感受按可读性组合或分句，修复口语语序，不机械地一条事实写一句。",
          "去掉收音残片、纠正话术和重复口头语；反复出现的‘然后呢’按语义删除，只有确实需要承接时才使用少量自然过渡。",
          "保留孩子使用的称呼、物品名称、形容词、叠词和有特点的用词；普通语序、量词、语气词和结构助词按自然汉语组织。",
          "before和after仅用于让新句与原文衔接，不能把其中内容写入本次sentences。"
        ],
        operations: plans.map(plan => ({
          key: plan.operationKey,
          mode: plan.mode,
          facts: (Array.isArray(plan.compositionFacts) ? plan.compositionFacts : plan.facts || []).map(fact => ({
            key: text(fact?.key, 128),
            eventKey: text(fact?.eventKey, 80),
            slot: fact?.slot,
            text: text(fact?.text)
          })),
          context: revisionPlanContext(plan, sentences)
        }))
      })
    }
  ];
}

function removeNeighborEcho(value, context) {
  let result = text(value, 1200);
  const neighbors = [context?.before, context?.after]
    .map(item => text(item, 1200).replace(/[。！？!?]+$/u, ""))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const neighbor of neighbors) {
    if (result.startsWith(neighbor) && result.length > neighbor.length) {
      result = result.slice(neighbor.length).replace(/^[，,。；;：:！？!?\s]+/u, "");
    }
    if (result.endsWith(neighbor) && result.length > neighbor.length) {
      result = result.slice(0, -neighbor.length).replace(/[，,。；;：:！？!?\s]+$/u, "");
    }
  }
  return result;
}

function attachRevisionCompositions(plans, raw, sourceSentences) {
  const operations = Array.isArray(raw?.operations)
    ? raw.operations
    : Object.entries(raw || {}).flatMap(([key, value]) => {
      if (Array.isArray(value)) return [{ key, sentences: value }];
      if (value && Array.isArray(value.sentences)) return [{ key, ...value }];
      return [];
    });
  const byKey = new Map();
  for (const operation of operations) {
    const key = text(operation?.key, 128);
    if (!key) continue;
    const existing = byKey.get(key);
    byKey.set(key, existing
      ? { ...existing, sentences: [...(existing.sentences || []), ...(operation.sentences || [])] }
      : operation);
  }
  return plans.map((plan, planIndex) => {
    const context = revisionPlanContext(plan, sourceSentences || []);
    const sourceFacts = Array.isArray(plan.compositionFacts) ? plan.compositionFacts : plan.facts || [];
    const factByKey = new Map(sourceFacts.map(fact => [text(fact?.key, 128), fact]).filter(([key]) => key));
    const expectedKeys = new Set(factByKey.keys());
    const operation = (operations.length === plans.length ? operations[planIndex] : null) || byKey.get(plan.operationKey);
    const sentences = [];
    const usedKeys = new Set();
    for (const item of (Array.isArray(operation?.sentences) ? operation.sentences : []).slice(0, 20)) {
      const sentenceText = removeNeighborEcho(item?.text, context);
      const factKeys = uniqueStrings(item?.factKeys).filter(key => expectedKeys.has(key));
      if (!sentenceText || !factKeys.some(key => !usedKeys.has(key))) continue;
      factKeys.forEach(key => usedKeys.add(key));
      sentences.push({ text: sentenceText, factKeys });
    }
    for (const key of [...expectedKeys].filter(key => !usedKeys.has(key))) {
      const fact = factByKey.get(key);
      const matchingSentence = sentences.find(sentence => eventOverlapScore(sentence.text, fact?.text) >= 0.5 || sharesEventCore(sentence.text, fact?.text) || wordCoverage(sentence.text, fact?.text) >= 0.75);
      if (matchingSentence) {
        matchingSentence.factKeys = uniqueStrings([...(matchingSentence.factKeys || []), key]);
      } else if (text(fact?.text)) {
        let sentenceText = text(fact.text, 1200);
        if (!/[。！？!?]$/u.test(sentenceText)) sentenceText += "。";
        sentences.push({ text: sentenceText, factKeys: [key] });
      }
      usedKeys.add(key);
    }
    if (!expectedKeys.size && sentences.length) {
      console.error("Revision composition incomplete", {
        operationKey: plan.operationKey,
        expectedKeys: [...expectedKeys],
        usedKeys: [...usedKeys],
        sentenceCount: sentences.length,
        receivedOperationKeys: operations.map(item => text(item?.key, 128)),
        receivedFactKeys: (Array.isArray(operation?.sentences) ? operation.sentences : []).flatMap(item => uniqueStrings(item?.factKeys)),
        rawKeys: Object.keys(raw || {})
      });
      const error = new Error("修改内容没有完整组织成句子，原日记已保留");
      error.code = "REVISION_COMPOSITION_INVALID";
      error.operationKey = plan.operationKey;
      throw error;
    }
    return { ...plan, sentences };
  });
}

function revisionApplicationOrder(plans) {
  const ordered = [];
  for (let index = 0; index < plans.length;) {
    const current = plans[index];
    if (current.mode !== "insert") {
      ordered.push(current);
      index += 1;
      continue;
    }
    const anchor = `${text(current.insertBeforeSentenceId, 128)}\u0000${text(current.insertAfterSentenceId, 128)}`;
    const group = [current];
    let cursor = index + 1;
    while (cursor < plans.length) {
      const candidate = plans[cursor];
      const candidateAnchor = `${text(candidate.insertBeforeSentenceId, 128)}\u0000${text(candidate.insertAfterSentenceId, 128)}`;
      if (candidate.mode !== "insert" || candidateAnchor !== anchor) break;
      group.push(candidate);
      cursor += 1;
    }
    ordered.push(...group.reverse());
    index = cursor;
  }
  return ordered;
}

function applyRevisionPlan(facts, sentences, raw, instruction, title) {
  const mode = raw?.mode;
  if (mode === "no_change" || !["replace", "insert"].includes(mode)) {
    return { changed: false, message: text(raw?.message, 200) || "还没有找到明确要修改的内容，请再说清楚一点。" };
  }
  const sentenceIndex = new Map(sentences.map((sentence, index) => [sentence.id, index]));
  const factById = new Map(facts.map(fact => [fact.id, fact]));
  let spliceStart;
  let spliceDeleteCount;
  let targetSentences = [];
  if (mode === "replace") {
    const targetSentenceIds = uniqueStrings(raw?.targetSentenceIds).map(value => text(value, 128));
    const indexes = targetSentenceIds.map(id => sentenceIndex.get(id));
    if (!indexes.length || indexes.some(index => index === undefined)) {
      return { changed: false, message: "还没有找到明确要修改的句子，请再说清楚一点。" };
    }
    indexes.sort((left, right) => left - right);
    const start = indexes[0];
    const end = indexes[indexes.length - 1];
    if (indexes.length !== end - start + 1) {
      return { changed: false, message: "这次修改涉及的位置还不够清楚，请按事情顺序再说一次。" };
    }
    targetSentences = sentences.slice(start, end + 1);
    if (targetSentences.some(sentence => !targetSentenceIds.includes(sentence.id))) {
      return { changed: false, message: "这次修改涉及的位置还不够清楚，请按事情顺序再说一次。" };
    }
    const proposedFacts = (Array.isArray(raw?.facts) ? raw.facts : []).map(item => text(item?.text)).filter(Boolean);
    if (targetSentences.length > 1 && proposedFacts.length) {
      const matched = targetSentences.filter(sentence => {
        const existing = (sentence.factIds || []).map(id => factById.get(id)?.text).filter(Boolean).join("；") || sentence.text;
        return proposedFacts.some(proposed => eventOverlapScore(existing, proposed) >= 0.5 || sharesEventCore(existing, proposed))
          || eventOverlapScore(existing, raw?.semanticInstruction) >= 0.25
          || sharesEventCore(existing, raw?.semanticInstruction);
      });
      const matchedIndexes = matched.map(sentence => sentenceIndex.get(sentence.id));
      const matchedAreContiguous = matchedIndexes.length && Math.max(...matchedIndexes) - Math.min(...matchedIndexes) + 1 === matchedIndexes.length;
      if (matchedAreContiguous) targetSentences = matched;
    }
    const narrowedIndexes = targetSentences.map(sentence => sentenceIndex.get(sentence.id));
    spliceStart = Math.min(...narrowedIndexes);
    spliceDeleteCount = targetSentences.length;
  } else {
    const beforeId = text(raw?.insertBeforeSentenceId, 128);
    const afterId = text(raw?.insertAfterSentenceId, 128);
    if ((!beforeId && !afterId) || (beforeId && afterId)) {
      return { changed: false, message: "还没有找到新增内容应放的位置，请把前后顺序再说清楚一点。" };
    }
    const anchorIndex = sentenceIndex.get(beforeId || afterId);
    if (anchorIndex === undefined) {
      return { changed: false, message: "还没有找到新增内容应放的位置，请把前后顺序再说清楚一点。" };
    }
    spliceStart = beforeId ? anchorIndex : anchorIndex + 1;
    spliceDeleteCount = 0;
  }
  const targetFactIds = uniqueStrings(targetSentences.flatMap(sentence => sentence.factIds || []));
  const outsideFactIds = new Set(sentences
    .filter(sentence => !targetSentences.includes(sentence))
    .flatMap(sentence => sentence.factIds || []));
  const requestedRemoveFactIds = uniqueStrings(raw?.removeFactIds).filter(id => targetFactIds.includes(id));
  const removalCandidates = Array.isArray(raw?.removeFactIds) ? requestedRemoveFactIds : targetFactIds;
  const removableFactIds = removalCandidates.filter(id => !outsideFactIds.has(id));
  const evidence = joinEvidence([
    ...removalCandidates.map(id => factById.get(id)?.quote),
    instruction
  ]);
  const reusableIds = mode === "replace" ? [...removableFactIds] : [];
  const localFacts = [];
  const factKeyToId = new Map();
  for (const item of (Array.isArray(raw?.compositionFacts) ? raw.compositionFacts : [])) {
    const key = text(item?.key, 128);
    const existingFactId = text(item?.existingFactId, 128);
    if (key && existingFactId && factById.has(existingFactId) && !removableFactIds.includes(existingFactId)) {
      factKeyToId.set(key, existingFactId);
    }
  }
  for (const item of (Array.isArray(raw?.facts) ? raw.facts : []).slice(0, 30)) {
    const key = text(item?.key, 128);
    if (!key || factKeyToId.has(key)) continue;
    const fact = normalizeFact({
      ...item,
      text: normalizeRevisionInstruction(removeRedundantClauses(item?.text)),
      id: reusableIds.shift() || newId("fact"),
      sourceFactIds: targetFactIds,
      quote: evidence,
      source: "语音修改"
    }, { source: "语音修改" });
    if (!fact) continue;
    localFacts.push(fact);
    factKeyToId.set(key, fact.id);
  }

  const replacementSentences = [];
  const usedLocalFactIds = new Set();
  for (const item of (Array.isArray(raw?.sentences) ? raw.sentences : []).slice(0, 20)) {
    let sentenceText = normalizeRevisionInstruction(removeRedundantClauses(item?.text));
    if (!sentenceText) continue;
    if (!/[。！？!?]$/u.test(sentenceText)) sentenceText += "。";
    const factIds = uniqueStrings(item?.factKeys).map(key => factKeyToId.get(key)).filter(Boolean);
    if (!factIds.length) continue;
    factIds.forEach(id => usedLocalFactIds.add(id));
    const reuseId = mode === "replace" ? targetSentences[replacementSentences.length]?.id : "";
    replacementSentences.push({ id: reuseId || newId("sentence"), text: sentenceText, factIds });
  }
  const conciseSentences = removeRedundantSentences(replacementSentences);
  replacementSentences.splice(0, replacementSentences.length, ...conciseSentences);
  if (localFacts.length && !replacementSentences.length) {
    return { changed: false, message: "修改内容还没有完整组织成句子，原来的日记已经保留。" };
  }
  usedLocalFactIds.clear();
  replacementSentences.flatMap(sentence => sentence.factIds).forEach(id => usedLocalFactIds.add(id));
  const usedLocalFacts = localFacts.filter(fact => usedLocalFactIds.has(fact.id));
  if (usedLocalFacts.length !== localFacts.length) {
    return { changed: false, message: "修改内容还有事实没有组织进句子，原来的日记已经保留。" };
  }
  if (mode === "replace" && targetSentences.length === 1 && usedLocalFacts.length && replacementSentences.length) {
    const beforeMeaning = targetFactIds.map(id => factById.get(id)?.text).filter(Boolean).join("；") || targetSentences[0].text;
    const afterMeaning = (Array.isArray(raw?.compositionFacts) ? raw.compositionFacts : raw?.facts || []).map(fact => text(fact?.text)).filter(Boolean).join("；");
    const additivePlan = Array.isArray(raw?.removeFactIds) && raw.removeFactIds.length === 0;
    if (!additivePlan && isContextOnlyExpansion(beforeMeaning, afterMeaning, raw?.semanticInstruction || instruction)) {
      return { changed: false, message: "这部分只是修改口述中的前后提示，原句已经保留。" };
    }
    if (isUnstatedReduction(beforeMeaning, afterMeaning, instruction, raw?.additionContext)) {
      return { changed: false, message: "修改口述只是简略提到原来的内容，原有细节已经保留。" };
    }
  }

  const removableSet = new Set(removableFactIds);
  const remainingFacts = facts.filter(fact => !removableSet.has(fact.id));
  let factInsertAt;
  if (mode === "replace") {
    const firstFactIndex = facts.findIndex(fact => removableSet.has(fact.id) || (!removableSet.size && targetFactIds.includes(fact.id)));
    factInsertAt = firstFactIndex < 0
      ? remainingFacts.length
      : facts.slice(0, firstFactIndex).filter(fact => !removableSet.has(fact.id)).length;
  } else {
    const neighbor = sentences[spliceStart] || sentences[spliceStart - 1];
    const neighborIndexes = (neighbor?.factIds || []).map(id => remainingFacts.findIndex(fact => fact.id === id)).filter(index => index >= 0);
    factInsertAt = neighborIndexes.length
      ? (sentences[spliceStart] ? Math.min(...neighborIndexes) : Math.max(...neighborIndexes) + 1)
      : remainingFacts.length;
  }
  remainingFacts.splice(factInsertAt, 0, ...usedLocalFacts);
  const combinedSentences = [
    ...sentences.slice(0, spliceStart),
    ...replacementSentences,
    ...sentences.slice(spliceStart + spliceDeleteCount)
  ];
  if (!combinedSentences.length) throw new Error("这次修改会删掉整篇日记，请直接使用删除日记功能");
  const composition = normalizeComposition({ title, sentences: combinedSentences }, remainingFacts, { fallbackTitle: title });
  if (!composition.sentences.length) {
    return { changed: false, message: "修改内容还没有组成完整句子，请按想要的说法再讲一次。" };
  }
  const beforeText = sentences.map(sentence => sentence.text).join("");
  const afterText = composition.sentences.map(sentence => sentence.text).join("");
  if (beforeText === afterText) return { changed: false, message: "这次说法和原来的日记基本一样，原文已经保留。" };
  const representedFactIds = new Set(composition.sentences.flatMap(sentence => sentence.factIds || []));
  return {
    changed: true,
    title,
    sentences: composition.sentences,
    facts: dedupeFacts(remainingFacts.filter(fact => representedFactIds.has(fact.id)))
  };
}

async function reviseFactDiary(input, callJson) {
  const facts = dedupeFacts((Array.isArray(input?.facts) ? input.facts : []).filter(fact => fact?.active !== false));
  const sentences = (Array.isArray(input?.sentences) ? input.sentences : [])
    .map(item => ({ id: text(item?.id, 128), text: text(item?.text, 1200), factIds: uniqueStrings(item?.factIds) }))
    .filter(item => item.id && item.text);
  const rawInstruction = text(input?.instruction, 5000);
  if (!rawInstruction) return { changed: false, message: "刚才没有听清要修改的内容。" };
  if (!facts.length || !sentences.length) return { changed: false, message: "这篇旧日记缺少事实来源，原文已经保留。" };
  const parsed = await callJson(revisionMessages(input, facts, sentences), {
    stage: "revise_semantic_changes",
    maxTokens: 2000,
    timeoutMs: 40000
  });
  let candidate = atomizeRevisionChanges(parsed);
  candidate = sanitizeRevisionChanges(candidate, rawInstruction, facts);
  candidate = recoverUncoveredRevisionFacts(candidate, rawInstruction, facts);
  candidate = sanitizeRevisionChanges(candidate, rawInstruction, facts);
  let reviewed = candidate;
  if (Array.isArray(candidate?.changes) && candidate.changes.length) {
    try {
      const audit = await callJson(revisionAuditMessages(input, facts, sentences, candidate.changes), {
        stage: "verify_revision_changes",
        maxTokens: 1800,
        timeoutMs: 30000
      });
      if (Array.isArray(audit?.changes)) reviewed = audit;
    } catch (error) {
      console.error("Revision semantic audit failed; using candidate plan:", error.code || error.message);
    }
  }
  const retryCandidate = sanitizeRevisionChanges(
    recoverUncoveredRevisionFacts(reviewed, rawInstruction, facts),
    rawInstruction,
    facts
  );
  const reviewedChangeCount = Array.isArray(reviewed?.changes) ? reviewed.changes.length : 0;
  const retryChangeCount = Array.isArray(retryCandidate?.changes) ? retryCandidate.changes.length : 0;
  const needsCompletenessRetry = revisionReductionWarnings(rawInstruction, facts, reviewed?.changes).length > 0;
  if (retryChangeCount > reviewedChangeCount || needsCompletenessRetry) {
    try {
      const retryMessages = needsCompletenessRetry
        ? revisionCompletenessMessages(input, facts, retryCandidate.changes)
        : revisionAuditMessages(input, facts, sentences, retryCandidate.changes);
      const audit = await callJson(retryMessages, {
        stage: "verify_revision_changes_retry",
        maxTokens: 1800,
        timeoutMs: 30000
      });
      if (Array.isArray(audit?.changes)) reviewed = audit;
    } catch (error) {
      console.error("Revision semantic audit retry failed; using first reviewed plan:", error.code || error.message);
    }
  }
  reviewed = restoreSafeLegacyDetail(reviewed, rawInstruction, facts);
  reviewed = atomizeRevisionChanges(reviewed);
  reviewed = sanitizeRevisionChanges(reviewed, rawInstruction, facts);
  reviewed = mergeAnchoredRevisionChanges(reviewed);
  let plans = prepareRevisionPlans(reviewed, facts, sentences, rawInstruction);
  if (plans.length) {
    const needsComposition = plans.some(plan => Array.isArray(plan.compositionFacts) && plan.compositionFacts.length);
    if (needsComposition) {
      const composed = await callJson(revisionCompositionMessages(plans, sentences), {
        stage: "compose_revision_changes",
        maxTokens: 1200,
        timeoutMs: 40000
      });
      plans = attachRevisionCompositions(plans, composed, sentences);
    } else {
      plans = plans.map(plan => ({ ...plan, sentences: [] }));
    }
  }
  const additions = plans.filter(plan => plan.mode === "insert");
  const rewrites = plans.filter(plan => plan.mode === "replace");
  console.log("Revision plan", {
    additions: additions.length,
    rewrites: rewrites.length,
    targetSentences: plans.reduce((total, plan) => total + (Array.isArray(plan.targetSentenceIds) ? plan.targetSentenceIds.length : 0), 0),
    outputFacts: plans.reduce((total, plan) => total + (Array.isArray(plan.facts) ? plan.facts.length : 0), 0),
    outputSentences: plans.reduce((total, plan) => total + (Array.isArray(plan.sentences) ? plan.sentences.length : 0), 0)
  });
  if (!plans.length) {
    return { changed: false, message: text(reviewed?.message, 200) || text(parsed?.message, 200) || "还没有找到明确要修改的内容，请再说清楚一点。" };
  }
  let state = { facts, sentences };
  let changed = false;
  let message = "";
  const title = text(input?.title, 80) || "我的日记";
  for (const plan of revisionApplicationOrder(plans.slice(0, 10))) {
    const result = applyRevisionPlan(state.facts, state.sentences, plan, rawInstruction, title);
    if (!result.changed) {
      message ||= result.message || "";
      continue;
    }
    changed = true;
    state = { facts: result.facts, sentences: result.sentences };
  }
  return changed ? { changed: true, title, ...state } : { changed: false, message: message || "这次没有找到可以安全修改的内容，原文已经保留。" };
}

module.exports = {
  applyFactAudit,
  applyRevisionPlan,
  compositionIssues,
  compositionMessages,
  factAuditMessages,
  finalizeFactDiary,
  normalizeComposition,
  reviseFactDiary,
  sanitizeRevisionChanges,
  uncoveredRevisionClauses
};
