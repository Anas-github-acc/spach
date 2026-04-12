const googleFormApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemma-4-31b-it:generateContent?key=${googleFormApiKey}`;
const GOOGLE_FORM_PROGRESS_STORAGE_KEY = "spachbob_google_form_progress_v1";
const googleFormRunState = {
  formKey: "",
  signature: "",
  nextHalf: 0
};

function isEditableElement(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function extractGoogleFormQuestions() {
  const blocks = document.querySelectorAll(".Qr7Oae");
  const questions = [];

  blocks.forEach((block, index) => {
    const titleEl = block.querySelector(".M7eMe") || block.querySelector('[role="heading"]');
    if (!titleEl) return;

    const questionText = normalizeText(titleEl.innerText);
    if (!questionText) return;

    const radioOptions = Array.from(block.querySelectorAll('[role="radio"]'));
    const checkboxOptions = Array.from(block.querySelectorAll('[role="checkbox"]'));
    const textInput = block.querySelector('textarea, input[type="text"]');

    if (radioOptions.length > 0) {
      const options = radioOptions
        .map((el) => ({
          text: normalizeText(el.getAttribute("aria-label") || el.innerText),
          element: el
        }))
        .filter((opt) => opt.text.length > 0);

      if (options.length > 0) {
        questions.push({
          index: index + 1,
          question: questionText,
          type: "single-choice",
          options
        });
      }
      return;
    }

    if (checkboxOptions.length > 0) {
      const options = checkboxOptions
        .map((el) => ({
          text: normalizeText(el.getAttribute("aria-label") || el.innerText),
          element: el
        }))
        .filter((opt) => opt.text.length > 0);

      if (options.length > 0) {
        questions.push({
          index: index + 1,
          question: questionText,
          type: "multi-choice",
          options
        });
      }
      return;
    }

    if (textInput) {
      questions.push({
        index: index + 1,
        question: questionText,
        type: "text",
        input: textInput
      });
    }
  });

  return questions;
}

function buildQuestionsSignature(questions) {
  return questions.map((q) => `${q.index}|${q.type}|${q.question}`).join("||");
}

function getCurrentFormKey() {
  return `${location.origin}${location.pathname}`;
}

function readAllFormProgress() {
  try {
    const raw = localStorage.getItem(GOOGLE_FORM_PROGRESS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (_err) {
    return {};
  }
}

function writeAllFormProgress(progress) {
  try {
    localStorage.setItem(GOOGLE_FORM_PROGRESS_STORAGE_KEY, JSON.stringify(progress));
  } catch (_err) {
    // Ignore storage failures.
  }
}

function readFormProgress(formKey) {
  const all = readAllFormProgress();
  const entry = all[formKey];
  if (!entry || typeof entry !== "object") return null;
  return {
    signature: typeof entry.signature === "string" ? entry.signature : "",
    nextHalf: Number.isInteger(entry.nextHalf) ? Math.max(0, Math.min(2, entry.nextHalf)) : 0
  };
}

function writeFormProgress(formKey, state) {
  const all = readAllFormProgress();
  all[formKey] = {
    signature: state.signature || "",
    nextHalf: Number.isInteger(state.nextHalf) ? Math.max(0, Math.min(2, state.nextHalf)) : 0,
    updatedAt: Date.now()
  };
  writeAllFormProgress(all);
}

function setRunState(formKey, signature, nextHalf) {
  googleFormRunState.formKey = formKey;
  googleFormRunState.signature = signature;
  googleFormRunState.nextHalf = Math.max(0, Math.min(2, Number(nextHalf) || 0));
  writeFormProgress(formKey, googleFormRunState);
}

function pickQuestionsHalf(questions) {
  const formKey = getCurrentFormKey();
  const signature = buildQuestionsSignature(questions);

  if (googleFormRunState.formKey !== formKey || googleFormRunState.signature !== signature) {
    const saved = readFormProgress(formKey);
    if (saved && saved.signature === signature) {
      setRunState(formKey, signature, saved.nextHalf);
    } else {
      setRunState(formKey, signature, 0);
    }
  }

  const mid = Math.ceil(questions.length / 2);
  const halves = [questions.slice(0, mid), questions.slice(mid)];
  const halfIndex = googleFormRunState.nextHalf;

  if (halfIndex > 1) {
    return { halfIndex: -1, selected: [] };
  }

  return { halfIndex, selected: halves[halfIndex] || [] };
}

function buildGoogleFormPrompt(questions) {
  const lines = questions.map((q) => {
    if (q.type === "text") {
      return `${q.index}. [text] ${q.question}`;
    }

    const opts = q.options.map((opt, i) => `  ${i + 1}) ${opt.text}`).join("\n");
    const typeLabel = q.type === "single-choice" ? "single-choice" : "multi-choice";
    return `${q.index}. [${typeLabel}] ${q.question}\n${opts}`;
  });

  return [
    "You are solving a Google Form.",
    "Return ONLY answer lines using this exact compact format:",
    "Q1:2",
    "Q2:1,3",
    "Q3:\"short text answer\"",
    "Rules:",
    "- One line per question.",
    "- Use question number exactly from the list.",
    "- single-choice: one option number.",
    "- multi-choice: comma-separated option numbers.",
    "- text: short quoted answer.",
    "- No analysis, no bullets, no markdown, no extra words.",
    "Questions:",
    lines.join("\n\n")
  ].join("\n");
}

function extractJsonPayload(text) {
  const cleaned = (text || "").trim();
  const fencedBlocks = Array.from(cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
    .map((m) => (m[1] || "").trim())
    .filter(Boolean);
  if (fencedBlocks.length > 0) return fencedBlocks[0];
  return cleaned;
}

function isValidAnswerSchema(value) {
  return !!(value && typeof value === "object" && Array.isArray(value.answers));
}

function collectJsonObjectCandidates(text) {
  const src = (text || "").trim();
  const candidates = [];

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start !== -1) {
        candidates.push(src.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseAnswersFromAiText(aiText) {
  const payload = extractJsonPayload(aiText);

  const directCandidates = [payload, ...collectJsonObjectCandidates(payload), ...collectJsonObjectCandidates(aiText)];

  for (const candidate of directCandidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isValidAnswerSchema(parsed)) return parsed.answers;
    } catch (_err) {
      // Keep trying other candidates.
    }
  }

  throw new Error("Could not parse valid JSON answers from AI response");
}

function parseLooseAnswerToken(token, questionType) {
  const cleaned = String(token || "")
    .replace(/^[\s*\-:]+/, "")
    .replace(/[\s.]+$/, "")
    .trim();

  if (questionType === "text") {
    const quoted = cleaned.match(/"([^"]+)"|'([^']+)'/);
    if (quoted) return quoted[1] || quoted[2] || "";
    return cleaned;
  }

  const bracketNums = cleaned.match(/\[(.*?)\]/);
  if (bracketNums && bracketNums[1]) {
    return bracketNums[1]
      .split(/[,\s]+/)
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  const nums = cleaned.match(/\d+/g);
  if (!nums) return [];
  return nums.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0);
}

function parseAnswersFromJsonObjectsInText(aiText) {
  const objects = collectJsonObjectCandidates(aiText);
  const out = [];

  for (const chunk of objects) {
    try {
      const parsed = JSON.parse(chunk);
      if (isValidAnswerSchema(parsed)) {
        out.push(...parsed.answers);
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Object.prototype.hasOwnProperty.call(parsed, "question") &&
        Object.prototype.hasOwnProperty.call(parsed, "answer")
      ) {
        out.push(parsed);
      }
    } catch (_err) {
      // Ignore invalid chunks.
    }
  }

  return out;
}

function parseAnswersFromNarrativeText(aiText, questions) {
  const out = [];
  const matches = Array.from(
    String(aiText || "").matchAll(/(?:Question|Q)\s*(\d+)[\s\S]{0,800}?Correct\s*answer\s*:\s*([^\n\r]+)/gi)
  );

  const typeMap = new Map((questions || []).map((q) => [q.index, q.type]));

  matches.forEach((m) => {
    const qNum = Number(m[1]);
    if (!Number.isInteger(qNum) || qNum <= 0) return;
    const qType = typeMap.get(qNum) || "single-choice";
    const parsedToken = parseLooseAnswerToken(m[2], qType);
    out.push({ question: qNum, type: qType, answer: parsedToken });
  });

  return out;
}

function parseAnswersFromCompactLines(aiText, questions) {
  const src = String(aiText || "");
  const typeMap = new Map((questions || []).map((q) => [q.index, q.type]));
  const out = [];
  const matches = Array.from(src.matchAll(/Q\s*(\d+)\s*[:=-]\s*([^\n\r]+)/gi));

  matches.forEach((m) => {
    const qNum = Number(m[1]);
    if (!Number.isInteger(qNum) || qNum <= 0) return;
    const qType = typeMap.get(qNum) || "single-choice";
    let raw = String(m[2] || "").trim();

    raw = raw.replace(/\s*\*+\s*$/, "").trim();

    if (qType === "text") {
      raw = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
      if (!raw) return;
      out.push({ question: qNum, type: "text", answer: raw });
      return;
    }

    const nums = (raw.match(/\d+/g) || []).map((n) => Number(n));
    if (!nums.length) return;
    out.push({ question: qNum, type: qType, answer: nums });
  });

  return out;
}

function normalizeAnswersForQuestions(rawAnswers, questions) {
  const byQuestion = new Map();
  const qMap = new Map((questions || []).map((q) => [q.index, q]));

  (rawAnswers || []).forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const qNum = Number(raw.question);
    const q = qMap.get(qNum);
    if (!q) return;

    if (q.type === "text") {
      let value = raw.answer;
      if (Array.isArray(value)) value = value[0];
      if (typeof value === "number") value = String(value);
      if (typeof value !== "string") return;
      value = value.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
      if (!value) return;
      byQuestion.set(qNum, { question: qNum, type: "text", answer: value });
      return;
    }

    let indices = raw.answer;
    if (typeof indices === "number") indices = [indices];
    if (typeof indices === "string") {
      indices = (indices.match(/\d+/g) || []).map((n) => Number(n));
    }
    if (!Array.isArray(indices)) return;

    const valid = [...new Set(indices.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0 && n <= q.options.length))];
    if (valid.length === 0) return;
    byQuestion.set(qNum, { question: qNum, type: q.type, answer: valid });
  });

  return Array.from(byQuestion.values()).sort((a, b) => a.question - b.question);
}

function parseAnswersRobust(aiText, questions) {
  const compact = parseAnswersFromCompactLines(aiText, questions);

  const strict = (() => {
    try {
      return parseAnswersFromAiText(aiText);
    } catch (_err) {
      return [];
    }
  })();

  const fromObjects = parseAnswersFromJsonObjectsInText(aiText);
  const fromNarrative = parseAnswersFromNarrativeText(aiText, questions);

  const normalized = normalizeAnswersForQuestions(
    [...compact, ...strict, ...fromObjects, ...fromNarrative],
    questions
  );

  if (!normalized.length) {
    throw new Error("Could not parse valid answers from AI response");
  }

  return normalized;
}

async function fetchWithBackoff(url, options, maxRetries = 3, baseDelay = 1000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        throw new Error(`Retryable status ${response.status}`);
      }
      return response;
    } catch (error) {
      attempt += 1;
      if (attempt >= maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function getGoogleFormAnswersFromAI(questions) {
  console.log('getting response...')
  const prompt = buildGoogleFormPrompt(questions);
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "text/plain"
    }
  };

  const response = await fetchWithBackoff(googleFormApiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log('raw response:', text);
  
  
  if (!text) {
    throw new Error("Gemini response missing text");
  }

  return parseAnswersRobust(text, questions);
}

function clickChoiceElement(el) {
  if (!el) return;
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  el.click();
}

function fillGoogleFormAnswers(questions, answers) {
  const questionByIndex = new Map(questions.map((q) => [q.index, q]));

  answers.forEach((ans) => {
    const q = questionByIndex.get(Number(ans.question));
    if (!q) return;

    if (q.type === "text") {
      const value = typeof ans.answer === "string" ? ans.answer : "";
      if (!value || !q.input) return;
      if (normalizeText(q.input.value).length > 0) return;
      q.input.focus();
      q.input.value = value;
      q.input.dispatchEvent(new Event("input", { bubbles: true }));
      q.input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (!Array.isArray(ans.answer) || ans.answer.length === 0) return;

    const optionIndices = [...new Set(ans.answer.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];

    optionIndices.forEach((n) => {
      const option = q.options[n - 1];
      if (!option) return;
      if (q.type === "single-choice") {
        const anySelected = q.options.some((opt) => opt.element.getAttribute("aria-checked") === "true");
        if (anySelected) return;
      }
      if (option.element.getAttribute("aria-checked") === "true" && q.type === "multi-choice") return;
      clickChoiceElement(option.element);
    });
  });
}

async function handleGoogleFormWithAI() {
  if (!location.hostname.includes("docs.google.com") || !location.pathname.startsWith("/forms/")) {
    return;
  }

  const questions = extractGoogleFormQuestions();
  if (!questions.length) {
    console.log("[SpachBob] No Google Form questions found.");
    return;
  }

  const { halfIndex, selected } = pickQuestionsHalf(questions);
  if (halfIndex === -1) {
    console.log("[SpachBob] Both halves already processed for this form.");
    return;
  }

  if (!selected.length) {
    console.log("[SpachBob] No questions found for this half.");
    setRunState(
      googleFormRunState.formKey || getCurrentFormKey(),
      googleFormRunState.signature || buildQuestionsSignature(questions),
      Math.min(googleFormRunState.nextHalf + 1, 2)
    );
    return;
  }

  console.log(`[SpachBob] Processing half ${halfIndex + 1}/2 with ${selected.length} questions.`);
  console.log("[SpachBob] Extracted questions:", selected.map((q) => ({
    index: q.index,
    question: q.question,
    type: q.type,
    options: q.options ? q.options.map((o) => o.text) : []
  })));

  try {
    const answers = await getGoogleFormAnswersFromAI(selected);
    console.log("[SpachBob] AI answers:", answers);
    fillGoogleFormAnswers(selected, answers);
    setRunState(
      googleFormRunState.formKey || getCurrentFormKey(),
      googleFormRunState.signature || buildQuestionsSignature(questions),
      Math.min(googleFormRunState.nextHalf + 1, 2)
    );
    console.log("[SpachBob] Form fill completed.");
  } catch (error) {
    console.error("[SpachBob] Failed to solve Google Form:", error);
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "g") return;
  if (isEditableElement(document.activeElement)) return;

  console.log("[SpachBob] Key 'g' pressed. Processing Google Form...");
  handleGoogleFormWithAI();
});

console.log("[SpachBob] Google Form helper loaded. Press 'g' to auto-fill the form using AI.");
