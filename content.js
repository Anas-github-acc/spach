function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const configuredApiKeys = [];
if (typeof apiKeys !== 'undefined' && Array.isArray(apiKeys)) {
  configuredApiKeys.push(...apiKeys.filter(isNonEmptyString));
}
if (configuredApiKeys.length === 0 && typeof apiKey !== 'undefined' && isNonEmptyString(apiKey)) {
  configuredApiKeys.push(apiKey);
}

const configuredModels = [
  typeof googleFormModel !== 'undefined' ? googleFormModel : '',
  typeof googleFormFallbackModel1 !== 'undefined' ? googleFormFallbackModel1 : '',
  typeof googleFormFallbackModel2 !== 'undefined' ? googleFormFallbackModel2 : ''
].filter(isNonEmptyString);

function buildGenerateContentUrl(model, key) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
}

const requestTargets = [];
configuredModels.forEach((model, modelIndex) => {
  configuredApiKeys.forEach((key, keyIndex) => {
    requestTargets.push({
      model,
      key,
      modelIndex,
      keyIndex,
      url: buildGenerateContentUrl(model, key)
    });
  });
});

const primaryRequestTarget = requestTargets[0] || null;
const apiUrl_ANSWER = primaryRequestTarget ? primaryRequestTarget.url : '';
// `apiUrl` retained for backward compatibility with existing logs/help text.
const apiUrl = apiUrl_ANSWER;
const IS_MOODLE_PAGE =
  location.hostname.includes('betamoodle.iiitvadodara.ac.in')
  || location.hostname.includes('sandbox.moodledemo.net');

if (!primaryRequestTarget) {
  console.error("No API key/model configuration found. Please update config.js");
}

function normalizeText(text) {
  return (text || '').trim().replace(/\s+/g, ' ');
}

const MOODLE_MAX_IMAGES_PER_QUESTION = 4;
const MOODLE_MAX_IMAGE_BYTES = 1_500_000;

function extractImagesFromElement(element) {
  if (!element) return [];

  const seen = new Set();
  const out = [];
  const images = Array.from(element.querySelectorAll('img'));

  images.forEach((img) => {
    const src = (img.currentSrc || img.src || '').trim();
    if (!src || seen.has(src) || src.startsWith('data:')) return;
    seen.add(src);
    out.push({
      src,
      alt: normalizeText(img.getAttribute('alt') || '')
    });
  });

  return out;
}

function guessMimeTypeFromUrl(url) {
  const src = String(url || '').toLowerCase();
  if (src.includes('.png')) return 'image/png';
  if (src.includes('.webp')) return 'image/webp';
  if (src.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function isSameOriginUrl(url) {
  try {
    const resolved = new URL(url, location.href);
    return resolved.origin === location.origin;
  } catch (_err) {
    return false;
  }
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2]
  };
}

function fetchImageViaBackground(url) {
  return new Promise((resolve, reject) => {
    console.log(`[SpachBob][CS] Requesting background image fetch: ${url}`);

    chrome.runtime.sendMessage(
      { action: 'fetchImageAsDataUrl', url },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(`[SpachBob][CS] Background fetch runtime error: ${url}`, chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.success || !response.dataUrl) {
          console.error(`[SpachBob][CS] Background fetch failed response: ${url}`, response);
          reject(new Error((response && response.error) || 'Background image fetch failed'));
          return;
        }

        console.log(
          `[SpachBob][CS] Background fetch success: ${url} (mime=${response.mimeType || 'unknown'})`
        );
        resolve(response);
      }
    );
  });
}

async function fetchImageAsInlinePart(url) {
  if (isSameOriginUrl(url)) {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status}`);
    }

    const mimeType = response.headers.get('content-type') || guessMimeTypeFromUrl(url);
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength === 0) {
      throw new Error('Image fetch returned empty body');
    }
    if (buffer.byteLength > MOODLE_MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${buffer.byteLength} bytes)`);
    }

    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }

    return {
      inlineData: {
        mimeType,
        data: btoa(binary)
      }
    };
  }

  const fetched = await fetchImageViaBackground(url);
  const parsed = parseDataUrl(fetched.dataUrl);
  if (!parsed || !parsed.base64) {
    throw new Error('Background returned invalid data URL payload');
  }

  const estimatedBytes = Math.floor((parsed.base64.length * 3) / 4);
  if (estimatedBytes > MOODLE_MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${estimatedBytes} bytes)`);
  }

  return {
    inlineData: {
      mimeType: fetched.mimeType || parsed.mimeType || guessMimeTypeFromUrl(url),
      data: parsed.base64
    }
  };
}

async function buildMoodlePromptPartsWithImages(promptText, images) {
  const parts = [{ text: promptText }];
  const limited = Array.isArray(images) ? images.slice(0, MOODLE_MAX_IMAGES_PER_QUESTION) : [];

  for (let i = 0; i < limited.length; i += 1) {
    const img = limited[i];
    try {
      const imagePart = await fetchImageAsInlinePart(img.src);
      parts.push({ text: `Question image ${i + 1}${img.alt ? ` alt: ${img.alt}` : ''}` });
      parts.push(imagePart);
    } catch (error) {
      console.warn(`[SpachBob] Skipping Moodle image (${img.src}): ${error.message}`);
    }
  }

  return parts;
}

function buildMoodleQuestionPrompt(questionType, questionText, options = []) {
  const safeQuestion = normalizeText(questionText) || 'Question text unavailable';

  if (questionType === 'text') {
    return [
      'You are solving a Moodle question.',
      'Return ONLY one answer line in this exact compact format:',
      'Q1:"short text answer"',
      'Rules:',
      '- One line only.',
      '- Do not add analysis, markdown, labels, or extra words.',
      '- Keep the answer concise and quoted.',
      'Question:',
      `1. [text] ${safeQuestion}`
    ].join('\n');
  }

  const typeLabel = questionType === 'multi-choice' ? 'multi-choice' : 'single-choice';
  const optionLines = options.map((opt, i) => `  ${i + 1}) ${opt.text}`).join('\n');

  return [
    'You are solving a Moodle question.',
    'Return ONLY one answer line in this exact compact format:',
    'Q1:2',
    'Q1:1,3',
    'Rules:',
    '- One line only.',
    '- Use option number(s) only.',
    '- single-choice: one option number.',
    '- multi-choice: comma-separated option numbers.',
    '- Do not add analysis, markdown, labels, or extra words.',
    'Question:',
    `1. [${typeLabel}] ${safeQuestion}`,
    optionLines
  ].join('\n');
}

function parseShortAnswerFromAI(aiText) {
  if (!aiText || typeof aiText !== 'string') return '';

  const wrapInner = extractANASInner(aiText);
  if (wrapInner !== null) return wrapInner.trim();

  const compactLine = aiText.match(/Q\s*\d+\s*[:=-]\s*([^\n\r]+)/i);
  if (compactLine && compactLine[1]) {
    return compactLine[1].trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
  }

  return aiText.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function extractActiveMoodleQuestion() {
  const questionBlock = document.querySelector('.formulation.clearfix');
  if (!questionBlock) {
    console.log("No element found with selector '.formulation.clearfix'");
    return null;
  }

  const questionTextElement = questionBlock.querySelector('.qtext');
  const questionText = questionTextElement
    ? normalizeText(questionTextElement.textContent)
    : 'Could not find question text.';
  const questionImages = extractImagesFromElement(questionTextElement || questionBlock);

  const shortAnswerInput = questionBlock.querySelector('input[type="text"], textarea');
  if (shortAnswerInput) {
    return {
      type: 'short-answer',
      questionText,
      questionImages,
      inputEl: shortAnswerInput,
      answerOptions: []
    };
  }

  const answerOptions = [];
  const seenInputs = new WeakSet();
  const seenOptionKeys = new Set();
  const optionRows = questionBlock.querySelectorAll('.ablock .answer .d-flex, .ablock .answer div[class^="r"]');

  optionRows.forEach(optionEl => {
    const inputEl = optionEl.querySelector('input[type="radio"], input[type="checkbox"]')
      || optionEl.parentElement?.querySelector('input[type="radio"], input[type="checkbox"]');
    const optionTextElement = optionEl.querySelector('.flex-fill, .ms-1') || optionEl;

    if (!inputEl || !optionTextElement) return;

    // Same option can appear through multiple row selectors; keep it once.
    if (seenInputs.has(inputEl)) return;

    const text = normalizeText(optionTextElement.textContent);
    if (!text) return;

    const optionKey = `${inputEl.type || ''}|${inputEl.name || ''}|${inputEl.value || ''}|${text}`;
    if (seenOptionKeys.has(optionKey)) return;

    seenInputs.add(inputEl);
    seenOptionKeys.add(optionKey);

    answerOptions.push({
      text,
      value: inputEl.value,
      radioInput: inputEl
    });
  });

  if (answerOptions.length > 0) {
    const selectionType = answerOptions.some((opt) => opt.radioInput?.type === 'checkbox')
      ? 'multi-choice'
      : 'single-choice';

    return {
      type: 'choice',
      selectionType,
      questionText,
      questionImages,
      inputEl: null,
      answerOptions
    };
  }

  return null;
}

function logQuestionSection(questionText, questionImages = []) {
  console.log('--- Question ---');
  console.log(questionText);

  if (Array.isArray(questionImages) && questionImages.length > 0) {
    console.log('Question images:');
    questionImages.forEach((img, idx) => {
      const altPart = img.alt ? ` (alt: ${img.alt})` : '';
      console.log(`  [${idx + 1}] ${img.src}${altPart}`);
    });
  }
}

function applyChoiceAnswerFromAI(aiAnswerText, answerOptions) {
  if (!aiAnswerText) {
    console.log("Could not get a valid answer from the AI.");
    return;
  }

  console.log("AI says the correct answer is:", aiAnswerText);
  const wrapInner = extractANASInner(aiAnswerText);
  console.log("Debug: AI raw response:", aiAnswerText);
  console.log("Debug: ANAS wrapper inner:", wrapInner);

  if (wrapInner !== null) {
    const maybeNums = wrapInner.split(/[,;\s]+|and/gi).map(s => s.trim()).filter(Boolean);
    const nums = maybeNums.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
    if (nums.length > 0) {
      const indices = [...new Set(nums)];
      const selected = [];
      indices.forEach(idx => {
        const zeroBased = idx - 1;
        const opt = answerOptions[zeroBased];
        if (opt) {
          opt.radioInput.checked = true;
          selected.push(opt);
          console.log(`Debug: Matched ANAS_${idx} -> option text="${opt.text}", value=${opt.value}`);
        } else {
          console.log(`Debug: ANAS_${idx} has no corresponding option (out of range).`);
        }
      });
      if (selected.length > 0) {
        console.log(`Action: Selected ${selected.length} option(s):`, selected.map(s => s.text));
        return;
      }
    }
    const normalizedInner = wrapInner.toLowerCase().trim();
    const selectedOption = answerOptions.find(opt => opt.text.toLowerCase().trim() === normalizedInner);
    if (selectedOption) {
      selectedOption.radioInput.checked = true;
      console.log(`Action: Selected option with text "${selectedOption.text}" (value: ${selectedOption.value})`);
      return;
    }
  }

  const indices = parseAIResponseToIndices(aiAnswerText);
  console.log("Debug: Parsed ANAS indices (fallback):", indices);
  if (indices && indices.length > 0) {
    const selected = [];
    indices.forEach(idx => {
      const zeroBased = idx - 1;
      const opt = answerOptions[zeroBased];
      if (opt) {
        opt.radioInput.checked = true;
        selected.push(opt);
      }
    });
    if (selected.length > 0) {
      console.log(`Action: Selected ${selected.length} option(s):`, selected.map(s => s.text));
    } else {
      console.log("Action: Parsed ANAS tokens but none matched available options.");
    }
    return;
  }

  console.log("Debug: No ANAS tokens found, falling back to text matching.");

  const normalizedAiAnswer = aiAnswerText.toLowerCase().trim();
  const selectedOption = answerOptions.find(opt => opt.text.toLowerCase().trim() === normalizedAiAnswer);

  if (selectedOption) {
    selectedOption.radioInput.checked = true;
    console.log(`Action: Selected option with text "${selectedOption.text}" (value: ${selectedOption.value})`);
  } else {
    console.log(`Action: Could not find an option matching the AI's response: "${aiAnswerText}"`);
    console.log("AI Response (Normalized):", normalizedAiAnswer);
    console.log("Available Options (Normalized):", answerOptions.map(opt => opt.text.toLowerCase().trim()));
  }
}

async function handleActiveMoodleQuestionWithAI(thinkingBudget = 0) {
  const extracted = extractActiveMoodleQuestion();
  if (!extracted) {
    console.log('[SpachBob] No supported Moodle question detected.');
    return;
  }

  if (extracted.type === 'short-answer') {
    console.log('Found 1 question block (short-answer mode).');
    logQuestionSection(extracted.questionText, extracted.questionImages || []);
    const aiText = await getShortAnswerFromAI(extracted.questionText, extracted.questionImages || []);
    if (!aiText) {
      console.log('Could not get a valid short answer from the AI.');
      return;
    }

    console.log('AI short answer:', aiText);
    const finalAnswer = parseShortAnswerFromAI(aiText);
    extracted.inputEl.value = finalAnswer;
    extracted.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    extracted.inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`Action: Wrote short answer into input id=${extracted.inputEl.id || '(no-id)'} name=${extracted.inputEl.name || '(no-name)'} value="${finalAnswer}"`);
    return;
  }

  if (extracted.type === 'choice') {
    console.log('Found 1 question block (choice mode).');
    logQuestionSection(extracted.questionText, extracted.questionImages || []);
    console.log('--- Options ---');
    extracted.answerOptions.forEach((opt, i) => {
      console.log(`${i + 1}. ${opt.text} (value: ${opt.value})`);
    });

    const aiAnswerText = await getCorrectAnswerFromAI(
      extracted.questionText,
      extracted.answerOptions,
      extracted.selectionType,
      extracted.questionImages || [],
      thinkingBudget
    );
    applyChoiceAnswerFromAI(aiAnswerText, extracted.answerOptions);
    return;
  }

  console.log(`[SpachBob] Unsupported question type: ${extracted.type}`);
}


function handleMultipleChoiceQuestion(thinkingBudget) {
  const questionBlock = document.querySelector('.formulation.clearfix');
  if (!questionBlock) {
    console.log("No element found with selector '.formulation.clearfix'");
    return;
  }
  console.log("Found 1 question block (multi-choice mode).");

  const questionTextElement = questionBlock.querySelector('.qtext');
  let questionText = "Could not find question text.";

  if (questionTextElement) {
    questionText = questionTextElement.textContent.trim().replace(/\s+/g, ' ');
  }

  const answerOptions = [];
  const optionElements = questionBlock.querySelectorAll('.ablock .answer .d-flex');

  if (optionElements.length === 0) {
    console.log("Could not find any answer options with '.d-flex'.");
    return;
  }

  optionElements.forEach(optionEl => {
    const radioInput = optionEl.parentElement.querySelector('input[type="radio"]');
    const optionTextElement = optionEl.querySelector('.flex-fill');

    if (radioInput && optionTextElement) {
      const text = optionTextElement.textContent.trim().replace(/\s+/g, ' ');
      const value = radioInput.value;
      answerOptions.push({ text, value, radioInput });
    }
  });

  if (answerOptions.length === 0) {
    console.log("Failed to parse any answer options (multi-choice mode).");
    return;
  }

  processQuestion(questionText, answerOptions, thinkingBudget);
}

function handleTrueFalseQuestion(thinkingBudget) {
  const questionBlock = document.querySelector('.formulation.clearfix');
  if (!questionBlock) {
    console.log("No element found with selector '.formulation.clearfix'");
    return;
  }
  console.log("Found 1 question block (true/false mode).");

  const questionTextElement = questionBlock.querySelector('.qtext');
  let questionText = "Could not find question text.";

  if (questionTextElement) {
    questionText = questionTextElement.textContent.trim().replace(/\s+/g, ' ');
  }

  const answerOptions = [];
  // Select .r0 and .r1 divs
  const optionElements = questionBlock.querySelectorAll('.ablock .answer div[class^="r"]');

  if (optionElements.length === 0) {
    console.log("Could not find any answer options with 'div[class^=\"r\"]'.");
    return;
  }

  optionElements.forEach(optionEl => {
    const radioInput = optionEl.querySelector('input[type="radio"]');
    let optionTextElement = optionEl.querySelector('.ms-1');
    if (!optionTextElement) optionTextElement = optionEl.querySelector('.flex-fill');

    if (radioInput && optionTextElement) {
      const text = optionTextElement.textContent.trim().replace(/\s+/g, ' ');
      const value = radioInput.value;
      answerOptions.push({ text, value, radioInput });
    }
  });

  if (answerOptions.length === 0) {
    console.log("Failed to parse any answer options (true/false mode).");
    return;
  }

  processQuestion(questionText, answerOptions, thinkingBudget);
}

function processQuestion(questionText, answerOptions, thinkingBudget) {
  console.log("--- Question ---");
  console.log(questionText);
  console.log("--- Options ---");
  answerOptions.forEach((opt, i) => {
    console.log(`${i + 1}. ${opt.text} (value: ${opt.value})`);
  });

  const selectionType = answerOptions.some((opt) => opt.radioInput?.type === 'checkbox')
    ? 'multi-choice'
    : 'single-choice';

  getCorrectAnswerFromAI(questionText, answerOptions, selectionType, [], thinkingBudget)
    .then(aiAnswerText => {
      applyChoiceAnswerFromAI(aiAnswerText, answerOptions);
    })
    .catch(error => {
      console.error("Error during AI answer selection:", error);
    });
}

function parseAIResponseToIndices(aiText) {
  if (!aiText || typeof aiText !== 'string') return [];
  const normalized = aiText.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');

  const compactLine = normalized.match(/Q\s*\d+\s*[:=-]\s*([^\n\r]+)/i);
  if (compactLine && compactLine[1]) {
    const rawAnswer = compactLine[1].trim();
    const nums = (rawAnswer.match(/\d+/g) || []).map(p => parseInt(p, 10)).filter(n => !isNaN(n));
    if (nums.length > 0) return [...new Set(nums)];
  }

  const wrapInner = extractANASInner(aiText);
  if (wrapInner !== null) {
    const maybeNums = wrapInner.split(/[,;\s]+|and/gi).map(s => s.trim()).filter(Boolean);
    const nums = maybeNums.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
    if (nums.length > 0) return [...new Set(nums)];
  }
  const matches = Array.from(normalized.matchAll(/ANAS_?(\d+)/ig));
  if (matches && matches.length > 0) {
    const indices = matches.map(m => parseInt(m[1], 10)).filter(n => !isNaN(n));
    return [...new Set(indices)];
  }
  const numericListMatch = normalized.match(/^\s*(?:ANS?\:?\s*)?(\d+(?:[\s,;and]+\d+)*)\s*$/i);
  if (numericListMatch) {
    const parts = numericListMatch[1].split(/[,;\s]+|and/gi).map(s => s.trim()).filter(Boolean);
    const nums = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n));
    return [...new Set(nums)];
  }
  return [];
}

function extractANASInner(aiText) {
  if (!aiText || typeof aiText !== 'string') return null;
  const m = aiText.match(/ANAS_([\s\S]*?)_ANAS/i);
  if (m && m[1]) return m[1].trim();
  return null;
}

function isRateLimitError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('429')
    || msg.includes('too many requests')
    || msg.includes('resource_exhausted')
    || msg.includes('quota');
}

async function callGeminiWithFallback(payload, requestLabel) {
  if (requestTargets.length === 0) {
    throw new Error("No request targets configured. Please set apiKey and model values in config.js");
  }

  let lastError = null;
  for (const target of requestTargets) {
    try {
      console.log(`[${requestLabel}] Trying model=${target.model} key#${target.keyIndex + 1}`);

      const response = await fetchWithBackoff(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}: ${await response.text()}`);
      }

      const result = await response.json();
      return { result, target };
    } catch (error) {
      lastError = error;
      if (isRateLimitError(error)) {
        console.warn(`[${requestLabel}] Rate-limited model=${target.model} key#${target.keyIndex + 1}: ${error.message || error}`);
      } else {
        console.warn(`[${requestLabel}] Failed model=${target.model} key#${target.keyIndex + 1}:`, error);
      }
    }
  }

  throw lastError || new Error('All configured model/key combinations failed.');
}

async function getCorrectAnswerFromAI(question, options, selectionType = 'single-choice', questionImages = [], thinkingBudget = 0) {
  const userPrompt = buildMoodleQuestionPrompt(selectionType, question, options);
  const promptParts = await buildMoodlePromptPartsWithImages(userPrompt, questionImages);

  console.log("Sending prompt to Gemini API:", userPrompt);

  const payload = {
    contents: [{
      parts: promptParts
    }],
    // safetySettings: [
    //   { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    // ],
    // generationConfig: {
    //   thinkingConfig: {
    //     thinkingBudget
    //   }
    // }
  };

  try {
    const { result, target } = await callGeminiWithFallback(payload, 'MCQ');
    const candidate = result.candidates?.[0];

    console.log(`MCQ answer received from model=${target.model}`);
    console.log("Received response from Gemini API:", JSON.stringify(result, null, 2));

    if (candidate && candidate.content?.parts?.[0]?.text) {
      const aiText = candidate.content.parts[0].text.trim().replace(/^"|"$/g, '');
      return aiText;
    } else {
      console.log("No valid content found in AI response:", JSON.stringify(result, null, 2));
      return null;
    }
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn("Gemini API rate-limited (MCQ).", error.message || error);
    } else {
      console.warn("Gemini API call failed (MCQ).", error);
    }
    return null;
  }
}

async function fetchWithBackoff(url, options, maxRetries = 3, baseDelay = 1000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
        throw new Error(`Retryable error: Status ${response.status}`);
      }
      return response;
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        if (isRateLimitError(error)) {
          console.warn(`Max retries (${maxRetries}) reached due to rate limit: ${error.message}`);
        } else {
          console.warn(`Max retries (${maxRetries}) reached. Error: ${error.message}`);
        }
        console.log(`[Spach Error]: ${error}`);
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function handleShortAnswerQuestion() {
  const questionBlock = document.querySelector('.formulation.clearfix');
  if (!questionBlock) {
    console.log("No element found with selector '.formulation.clearfix'");
    return;
  }
  console.log("Found 1 question block (short-answer mode).");

  const questionTextElement = questionBlock.querySelector('.qtext');
  let questionText = "Could not find question text.";

  if (questionTextElement) {
    questionText = questionTextElement.textContent.trim().replace(/\s+/g, ' ');
  }

  const inputEl = questionBlock.querySelector('input[type="text"]');
  if (!inputEl) {
    console.log("No text input found for short-answer question.");
    return;
  }

  getShortAnswerFromAI(questionText, extractImagesFromElement(questionTextElement || questionBlock))
    .then(aiText => {
      if (!aiText) {
        console.log("Could not get a valid short answer from the AI.");
        return;
      }

      console.log("AI short answer:", aiText);
      const finalAnswer = parseShortAnswerFromAI(aiText);
      inputEl.value = finalAnswer;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`Action: Wrote short answer into input id=${inputEl.id || '(no-id)'} name=${inputEl.name || '(no-name)'} value="${finalAnswer}"`);
    })
    .catch(error => {
      console.error("Error during short-answer AI call:", error);
    });
}

async function getShortAnswerFromAI(question, questionImages = []) {
  const userPrompt = buildMoodleQuestionPrompt('text', question);
  const promptParts = await buildMoodlePromptPartsWithImages(userPrompt, questionImages);

  const payload = {
    contents: [{
      parts: promptParts
    }],  
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: 1024
      }
    }
  };

  try {
    const { result, target } = await callGeminiWithFallback(payload, 'ShortAnswer');
    const candidate = result.candidates?.[0];

    console.log(`Short answer received from model=${target.model}`);
    console.log("Received response from Gemini API (short answer):", JSON.stringify(result, null, 2));

    if (candidate && candidate.content?.parts?.[0]?.text) {
      const aiText = candidate.content.parts[0].text.trim().replace(/^"|"$/g, '');
      return aiText;
    } else {
      console.log("No valid content found in AI response (short answer):", JSON.stringify(result, null, 2));
      return null;
    }
  } catch (error) {
    if (isRateLimitError(error)) {
      console.warn("Gemini API rate-limited (short answer).", error.message || error);
    } else {
      console.warn("Gemini API call failed (short answer).", error);
    }
    return null;
  }
}

// Global help function - callable from browser console
window.spachBobHelp = function() {
  const helpMessage = `
╔════════════════════════════════════════════════════════════╗
║           SpachBob Extension - Keyboard Shortcuts          ║
╠════════════════════════════════════════════════════════════╣
║  Key  │  Action                                            ║
╠═══════╪════════════════════════════════════════════════════╣
║ Alt+g │  Solve Current Moodle Question                     ║
║       │  - Detects question type automatically             ║
║       │  - Gets answer from AI                             ║
║       │  - Fills selected option or short answer           ║
╚═══════╧════════════════════════════════════════════════════╝

📌 Usage:
  - Press Alt+g on a Moodle quiz question page
   - Check browser console for detailed logs
   - Call spachBobHelp() in console to see this help again

🔧 Functions available in console:
   - spachBobHelp()          : Show this help message
   - testModelConnection()   : Test API connection manually

⚙️  Current model: ${primaryRequestTarget ? primaryRequestTarget.model : 'Not configured'}
🔑 API keys configured: ${configuredApiKeys.length}
📡 Model URL: ${apiUrl_ANSWER || 'Not configured'}
  `;
  
  console.log(helpMessage);
  return "Help displayed in console ✓";
};

// Make testModelConnection globally accessible
window.testModelConnection = testModelConnection;

async function testModelConnection() {
  console.log("=== Testing Model Connection ===");
  const testPrompt = "Say 'ANAS_OK_ANAS' if you receive this message.";
  
  const payload = {
    contents: [{
      parts: [{
        text: testPrompt
      }]
    }]
  };

  try {
    console.log(`Testing connection to: ${apiUrl_ANSWER || 'no configured endpoint'}`);
    const startTime = Date.now();

    const { result, target } = await callGeminiWithFallback(payload, 'ConnectionTest');

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    console.log(`Response received in ${responseTime}ms`);
    console.log(`Using model: ${target.model}`);
    console.log("API Response:", JSON.stringify(result, null, 2));

    const candidate = result.candidates?.[0];
    if (candidate && candidate.content?.parts?.[0]?.text) {
      const aiText = candidate.content.parts[0].text.trim();
      console.log(`✅ TEST PASSED - Model responded: "${aiText}"`);
      console.log(`Response time: ${responseTime}ms`);
      alert(`✅ Model Test SUCCESSFUL\nResponse: "${aiText}"\nResponse time: ${responseTime}ms`);
      return true;
    } else {
      console.error("❌ TEST FAILED - No valid content in response");
      alert(`❌ Model Test FAILED\nNo valid content in response\nResponse time: ${responseTime}ms`);
      return false;
    }
  } catch (error) {
    console.error("❌ TEST FAILED - Error:", error);
    alert(`❌ Model Test FAILED\nError: ${error.message}\nCheck console for details.`);
    return false;
  }
}

if (IS_MOODLE_PAGE) {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'h' || event.key === 'H') {
      console.log("Key 'h/H' pressed. Showing help...");
      spachBobHelp();
      return;
    }

    if (!((event.altKey || event.metaKey) && event.code === "KeyG")) return;

    console.log("Alt+g pressed. Processing current Moodle question with AI...");
    handleActiveMoodleQuestionWithAI(0).catch(error => {
      console.error('Error in unified Moodle handler:', error);
    });
  });

  console.log("[SpachBob] Moodle helper loaded. Press Alt+g to solve the current Moodle question using AI.");
}

// Log welcome message on load
// console.log("%c🎓 SpachBob Extension Loaded!", "color: #4CAF50; font-size: 16px; font-weight: bold;");
// console.log("%cType spachBobHelp() for available keyboard shortcuts", "color: #2196F3; font-size: 12px;");