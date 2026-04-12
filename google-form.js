const GOOGLE_FORM_PROGRESS_STORAGE_KEY = "spachbob_google_form_progress_v1";
const QUESTIONS_PER_RUN = 10;
const MAX_IMAGES_PER_QUESTION = 2;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_IMAGES_PER_REQUEST = 8;
const GOOGLE_FORM_MODELS = [googleFormModel, googleFormFallbackModel1, googleFormFallbackModel2]
  .filter((m) => typeof m === "string" && m.trim().length > 0);
const GOOGLE_FORM_KEYS = (Array.isArray(apiKeys) && apiKeys.length > 0 ? apiKeys : [apiKey])
  .filter((k) => typeof k === "string" && k.trim().length > 0);
const googleFormRunState = {
  formKey: "",
  signature: "",
  nextChunk: 0,
  completedChunks: [],
  lastFailedChunk: null
};

function buildGenerateContentUrl(modelName, key) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
}

function classifyApiFailure(status, errorText) {
  const text = String(errorText || "").toLowerCase();
  const isRateLimit = status === 429 || text.includes("rate") || text.includes("quota") || text.includes("resource_exhausted");
  const isModelFailure = status === 404 || status === 400 || status === 501 || text.includes("model") || text.includes("not found");
  const isRetryable = status >= 500 || status === 429;
  return { isRateLimit, isModelFailure, isRetryable };
}

function isEditableElement(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || el.isContentEditable;
}

function normalizeText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function extractQuestionImages(block) {
  const images = Array.from(block.querySelectorAll("img"));
  const seen = new Set();
  const out = [];

  images.forEach((img) => {
    const src = (img.currentSrc || img.src || "").trim();
    if (!src || seen.has(src)) return;
    if (src.startsWith("data:")) return;
    seen.add(src);
    out.push({
      src,
      alt: normalizeText(img.getAttribute("alt") || "")
    });
  });

  return out;
}

function extractGoogleFormQuestions() {
  const blocks = document.querySelectorAll(".Qr7Oae");
  const questions = [];

  blocks.forEach((block, index) => {
    const titleEl = block.querySelector(".M7eMe") || block.querySelector('[role="heading"]');
    const images = extractQuestionImages(block);
    const radioOptions = Array.from(block.querySelectorAll('[role="radio"]'));
    const checkboxOptions = Array.from(block.querySelectorAll('[role="checkbox"]'));
    const textInput = block.querySelector('textarea, input[type="text"]');

    const hasAnswerUI = radioOptions.length > 0 || checkboxOptions.length > 0 || !!textInput;
    if (!hasAnswerUI) return;

    let questionText = titleEl ? normalizeText(titleEl.innerText) : "";
    if (!questionText && images.length > 0) {
      questionText = "Image-based question (no text)";
    }
    if (!questionText) {
      questionText = "Question text unavailable";
    }

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
          options,
          images
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
          options,
          images
        });
      }
      return;
    }

    if (textInput) {
        questions.push({
          index: index + 1,
          question: questionText,
          type: "text",
          input: textInput,
          images
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
  const completedChunks = Array.isArray(entry.completedChunks)
    ? [...new Set(entry.completedChunks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))]
    : [];

  return {
    signature: typeof entry.signature === "string" ? entry.signature : "",
    nextChunk: Number.isInteger(entry.nextChunk)
      ? Math.max(0, entry.nextChunk)
      : (Number.isInteger(entry.nextHalf) ? Math.max(0, entry.nextHalf) : 0),
    completedChunks,
    lastFailedChunk: Number.isInteger(entry.lastFailedChunk) ? Math.max(0, entry.lastFailedChunk) : null
  };
}

function writeFormProgress(formKey, state) {
  const all = readAllFormProgress();
  all[formKey] = {
    signature: state.signature || "",
    nextChunk: Number.isInteger(state.nextChunk) ? Math.max(0, state.nextChunk) : 0,
    completedChunks: Array.isArray(state.completedChunks)
      ? [...new Set(state.completedChunks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))]
      : [],
    lastFailedChunk: Number.isInteger(state.lastFailedChunk) ? Math.max(0, state.lastFailedChunk) : null,
    updatedAt: Date.now()
  };
  writeAllFormProgress(all);
}

function setRunState(formKey, signature, nextChunk, completedChunks = [], lastFailedChunk = null) {
  googleFormRunState.formKey = formKey;
  googleFormRunState.signature = signature;
  googleFormRunState.nextChunk = Math.max(0, Number(nextChunk) || 0);
  googleFormRunState.completedChunks = Array.isArray(completedChunks)
    ? [...new Set(completedChunks.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0))]
    : [];
  googleFormRunState.lastFailedChunk = Number.isInteger(lastFailedChunk) ? Math.max(0, lastFailedChunk) : null;
  writeFormProgress(formKey, googleFormRunState);
}

function getNextPendingChunk(totalChunks, completedChunks) {
  const completedSet = new Set((completedChunks || []).filter((n) => Number.isInteger(n) && n >= 0));
  for (let i = 0; i < totalChunks; i += 1) {
    if (!completedSet.has(i)) return i;
  }
  return totalChunks;
}

function pickQuestionsHalf(questions) {
  const formKey = getCurrentFormKey();
  const signature = buildQuestionsSignature(questions);

  if (googleFormRunState.formKey !== formKey || googleFormRunState.signature !== signature) {
    const saved = readFormProgress(formKey);
    if (saved && saved.signature === signature) {
      setRunState(
        formKey,
        signature,
        saved.nextChunk,
        saved.completedChunks || [],
        saved.lastFailedChunk
      );
    } else {
      setRunState(formKey, signature, 0, [], null);
    }
  }

  const totalChunks = Math.ceil(questions.length / QUESTIONS_PER_RUN);
  const pendingChunk = getNextPendingChunk(totalChunks, googleFormRunState.completedChunks);
  const chunkIndex = Math.max(googleFormRunState.nextChunk, pendingChunk);
  if (googleFormRunState.nextChunk !== chunkIndex) {
    setRunState(
      googleFormRunState.formKey || formKey,
      googleFormRunState.signature || signature,
      chunkIndex,
      googleFormRunState.completedChunks,
      googleFormRunState.lastFailedChunk
    );
  }

  const start = chunkIndex * QUESTIONS_PER_RUN;
  const end = start + QUESTIONS_PER_RUN;

  if (chunkIndex >= totalChunks) {
    return { halfIndex: -1, selected: [], totalChunks };
  }

  return {
    halfIndex: chunkIndex,
    selected: questions.slice(start, end),
    totalChunks,
    start,
    end
  };
}

function isQuestionAnswered(question) {
  if (!question) return false;

  if (question.type === "text") {
    return !!(question.input && normalizeText(question.input.value).length > 0);
  }

  if (!Array.isArray(question.options) || question.options.length === 0) return false;
  return question.options.some((opt) => opt.element && opt.element.getAttribute("aria-checked") === "true");
}

function isFormCompletelyUnanswered(questions) {
  return !(questions || []).some((q) => isQuestionAnswered(q));
}

function maybeResetProgressIfFormCleared(questions) {
  const formKey = getCurrentFormKey();
  const signature = buildQuestionsSignature(questions);
  const saved = readFormProgress(formKey);

  if (!saved || saved.signature !== signature) return;

  const hasStoredProgress = (saved.nextChunk > 0) || ((saved.completedChunks || []).length > 0);
  if (!hasStoredProgress) return;

  if (!isFormCompletelyUnanswered(questions)) return;

  console.log("[SpachBob] Form appears cleared. Resetting saved progress to chunk 1.");
  setRunState(formKey, signature, 0, [], null);
}

function buildGoogleFormPrompt(questions) {
  const lines = questions.map((q) => {
    const imageNote = Array.isArray(q.images) && q.images.length > 0
      ? `\n  [images attached: ${q.images.length}]`
      : "";

    if (q.type === "text") {
      return `${q.index}. [text] ${q.question}${imageNote}`;
    }

    const opts = q.options.map((opt, i) => `  ${i + 1}) ${opt.text}`).join("\n");
    const typeLabel = q.type === "single-choice" ? "single-choice" : "multi-choice";
    return `${q.index}. [${typeLabel}] ${q.question}${imageNote}\n${opts}`;
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
    "- If you add explanation, still include strict Q<number>:<answer> lines at the end.",
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
    String(aiText || "").matchAll(/(?:Question|Q)\s*(\d+)[\s\S]{0,1800}?(?:Correct\s*answer|Answer)\s*:\s*([^\n\r]+)/gi)
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

function parseAnswersFromQuestionBlocks(aiText, questions) {
  const src = String(aiText || "");
  const typeMap = new Map((questions || []).map((q) => [q.index, q.type]));
  const out = [];
  const qMatches = Array.from(src.matchAll(/(?:^|\n)\s*[*-]?\s*Q\s*(\d+)\s*:/gi));

  for (let i = 0; i < qMatches.length; i += 1) {
    const start = qMatches[i].index;
    const end = i + 1 < qMatches.length ? qMatches[i + 1].index : src.length;
    const block = src.slice(start, end);
    const qNum = Number(qMatches[i][1]);
    if (!Number.isInteger(qNum) || qNum <= 0) continue;

    const qType = typeMap.get(qNum) || "single-choice";
    const answerLine = block.match(/(?:Correct\s*answer|Answer)\s*:\s*([^\n\r]+)/i);
    if (!answerLine) continue;

    const parsedToken = parseLooseAnswerToken(answerLine[1], qType);
    out.push({ question: qNum, type: qType, answer: parsedToken });
  }

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
  const fromQuestionBlocks = parseAnswersFromQuestionBlocks(aiText, questions);

  const normalized = normalizeAnswersForQuestions(
    [...compact, ...strict, ...fromObjects, ...fromNarrative, ...fromQuestionBlocks],
    questions
  );

  if (!normalized.length) {
    throw new Error("Could not parse valid answers from AI response");
  }

  return normalized;
}

function guessMimeTypeFromUrl(url) {
  const src = String(url || "").toLowerCase();
  if (src.includes(".png")) return "image/png";
  if (src.includes(".webp")) return "image/webp";
  if (src.includes(".gif")) return "image/gif";
  return "image/jpeg";
}

async function fetchImageAsInlinePart(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Image fetch failed: ${response.status}`);
  }

  const mimeType = response.headers.get("content-type") || guessMimeTypeFromUrl(url);
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("Image fetch returned empty body");
  }
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${buffer.byteLength} bytes)`);
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const data = btoa(binary);

  return {
    inlineData: {
      mimeType,
      data
    }
  };
}

async function buildPromptPartsWithImages(promptText, questions) {
  const parts = [{ text: promptText }];
  const tasks = [];

  (questions || []).forEach((q) => {
    if (!Array.isArray(q.images) || q.images.length === 0) return;
    q.images.slice(0, MAX_IMAGES_PER_QUESTION).forEach((img, idx) => {
      tasks.push({
        questionIndex: q.index,
        imageIndex: idx + 1,
        src: img.src,
        alt: img.alt || ""
      });
    });
  });

  const limitedTasks = tasks.slice(0, MAX_IMAGES_PER_REQUEST);
  for (const task of limitedTasks) {
    try {
      const imagePart = await fetchImageAsInlinePart(task.src);
      parts.push({ text: `Question ${task.questionIndex} image ${task.imageIndex}${task.alt ? ` alt: ${task.alt}` : ""}` });
      parts.push(imagePart);
    } catch (error) {
      console.warn(
        `[SpachBob] Skipping image for Q${task.questionIndex} (${task.src}): ${error.message}`
      );
    }
  }

  return parts;
}

async function fetchWithBackoff(url, options, maxRetries = 3, baseDelay = 1000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      attempt += 1;
      if (attempt >= maxRetries) throw error;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
      attempt += 1;
      if (attempt >= maxRetries) return response;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    return response;
  }
}

async function getGoogleFormAnswersFromAI(questions) {
  console.log("getting response...");
  const prompt = buildGoogleFormPrompt(questions);
  const promptParts = await buildPromptPartsWithImages(prompt, questions);
  const payload = {
    contents: [
      {
        parts: promptParts
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "text/plain"
    }
  };

  if (!GOOGLE_FORM_MODELS.length) {
    throw new Error("No configured models available");
  }
  if (!GOOGLE_FORM_KEYS.length) {
    throw new Error("No configured API keys available");
  }

  const errors = [];

  for (const model of GOOGLE_FORM_MODELS) {
    for (const key of GOOGLE_FORM_KEYS) {
      const url = buildGenerateContentUrl(model, key);
      let response;
      try {
        response = await fetchWithBackoff(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
      } catch (networkError) {
        errors.push(`[model=${model}] [key=***${key.slice(-4)}] network: ${networkError.message}`);
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyApiFailure(response.status, errorText);
        const shortError = `[model=${model}] [key=***${key.slice(-4)}] status=${response.status} rateLimit=${failure.isRateLimit} modelFailure=${failure.isModelFailure}`;
        errors.push(shortError);
        console.warn("[SpachBob] AI call failed:", shortError);

        if (failure.isRateLimit) {
          console.warn("[SpachBob] Detected rate limit/quota. Trying next API key/model.");
        } else if (failure.isModelFailure) {
          console.warn("[SpachBob] Detected model-level failure. Trying fallback model.");
        }
        continue;
      }

      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log(`raw response (model=${model}, key=***${key.slice(-4)}):`, text);

      if (!text) {
        errors.push(`[model=${model}] [key=***${key.slice(-4)}] empty text response`);
        continue;
      }

      try {
        return parseAnswersRobust(text, questions);
      } catch (parseError) {
        errors.push(`[model=${model}] [key=***${key.slice(-4)}] parse: ${parseError.message}`);
      }
    }
  }

  throw new Error(`All key/model attempts failed. Details: ${errors.join(" | ")}`);
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
      q.input.focus();
      q.input.value = value;
      q.input.dispatchEvent(new Event("input", { bubbles: true }));
      q.input.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (!Array.isArray(ans.answer) || ans.answer.length === 0) return;

    const optionIndices = [...new Set(ans.answer.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))];

    if (q.type === "single-choice") {
      const target = q.options[optionIndices[0] - 1];
      if (!target) return;
      clickChoiceElement(target.element);
      return;
    }

    if (q.type === "multi-choice") {
      const targetSet = new Set(optionIndices);
      q.options.forEach((option, idx) => {
        const optionNumber = idx + 1;
        const isChecked = option.element.getAttribute("aria-checked") === "true";
        const shouldBeChecked = targetSet.has(optionNumber);

        if (shouldBeChecked && !isChecked) {
          clickChoiceElement(option.element);
        } else if (!shouldBeChecked && isChecked) {
          clickChoiceElement(option.element);
        }
      });
      return;
    }

    optionIndices.forEach((n) => {
      const option = q.options[n - 1];
      if (!option) return;
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

  maybeResetProgressIfFormCleared(questions);

  const { halfIndex, selected, totalChunks, start } = pickQuestionsHalf(questions);
  if (halfIndex === -1) {
    console.log("[SpachBob] All question chunks already processed for this form.");
    return;
  }

  if (!selected.length) {
    console.log("[SpachBob] No questions found for this chunk.");
    const completed = [...new Set([...(googleFormRunState.completedChunks || []), halfIndex])];
    const nextPending = getNextPendingChunk(totalChunks, completed);
    setRunState(
      googleFormRunState.formKey || getCurrentFormKey(),
      googleFormRunState.signature || buildQuestionsSignature(questions),
      nextPending,
      completed,
      null
    );
    return;
  }

  const previousQuestions = questions.slice(0, start);
  const unansweredBacklog = previousQuestions.filter((q) => !isQuestionAnswered(q));
  const runQuestions = [
    ...selected,
    ...unansweredBacklog.filter((q) => !selected.some((s) => s.index === q.index))
  ];

  console.log(`[SpachBob] Processing chunk ${halfIndex + 1}/${totalChunks} with ${selected.length} questions.`);
  if (unansweredBacklog.length > 0) {
    console.log(`[SpachBob] Also retrying ${unansweredBacklog.length} unanswered question(s) from earlier chunks.`);
  }

  console.log("[SpachBob] Extracted questions:", runQuestions.map((q) => ({
    index: q.index,
    question: q.question,
    type: q.type,
    options: q.options ? q.options.map((o) => o.text) : []
  })));

  try {
    const answers = await getGoogleFormAnswersFromAI(runQuestions);
    console.log("[SpachBob] AI answers:", answers);
    fillGoogleFormAnswers(runQuestions, answers);

    const completed = [...new Set([...(googleFormRunState.completedChunks || []), halfIndex])];
    const nextPending = getNextPendingChunk(totalChunks, completed);

    setRunState(
      googleFormRunState.formKey || getCurrentFormKey(),
      googleFormRunState.signature || buildQuestionsSignature(questions),
      nextPending,
      completed,
      null
    );
    console.log("[SpachBob] Form fill completed.");
  } catch (error) {
    setRunState(
      googleFormRunState.formKey || getCurrentFormKey(),
      googleFormRunState.signature || buildQuestionsSignature(questions),
      halfIndex,
      googleFormRunState.completedChunks || [],
      halfIndex
    );
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
