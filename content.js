const apiKey = ""
const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
const apiUrl_ANSWER = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;


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

  getCorrectAnswerFromAI(questionText, answerOptions, thinkingBudget)
    .then(aiAnswerText => {
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

      // Fallback: the AI returned answer text instead of ANAS_# token. Try to match option text.
      const normalizedAiAnswer = aiAnswerText.toLowerCase().trim();
      const selectedOption = answerOptions.find(opt =>
        opt.text.toLowerCase().trim() === normalizedAiAnswer
      );

      if (selectedOption) {
        selectedOption.radioInput.checked = true;
        console.log(`Action: Selected option with text "${selectedOption.text}" (value: ${selectedOption.value})`);
      } else {
        console.log(`Action: Could not find an option matching the AI's response: "${aiAnswerText}"`);
        console.log("AI Response (Normalized):", normalizedAiAnswer);
        console.log("Available Options (Normalized):", answerOptions.map(opt => opt.text.toLowerCase().trim()));
      }
    })
    .catch(error => {
      console.error("Error during AI answer selection:", error);
    });
}

function parseAIResponseToIndices(aiText) {
  if (!aiText || typeof aiText !== 'string') return [];
  const normalized = aiText.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
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

async function getCorrectAnswerFromAI(question, options, thinkingBudget = 0) {
  const optionList = options.map((opt, index) => `ANAS_${index + 1}. ${opt.text}`).join('\n');
  const userPrompt = `
Here is a multiple-choice question:
---
Question: ${question}
---
Options: 
${optionList}
---
Please provide only the correct option ANAS_1, ANAS_2, ANAS_3 etc., without any additional explanation. This is important: your answer must exactly match one of the provided options (i.e., ANAS_1, ANAS_2, ANAS_3, etc.).
`;

  console.log("Sending prompt to Gemini API:", userPrompt);

  const payload = {
    contents: [{
      parts: [{
        text: userPrompt
      }]
    }],
    // safetySettings: [
    //   { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
    //   { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    // ],
    // generationConfig: {
    //   thinkingConfig: {
    //     thinkingBudget: 518
    //   }
    // }
  };

  try {
    console.log(`running... ${apiUrl_ANSWER}`)
    const response = await fetchWithBackoff(apiUrl_ANSWER, {
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
    const candidate = result.candidates?.[0];

    console.log("Received response from Gemini API:", JSON.stringify(result, null, 2));

    if (candidate && candidate.content?.parts?.[0]?.text) {
      const aiText = candidate.content.parts[0].text.trim().replace(/^"|"$/g, '');
      return aiText;
    } else {
      console.log("No valid content found in AI response:", JSON.stringify(result, null, 2));
      return null;
    }
  } catch (error) {
    console.error("Error calling Gemini API:", error);
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
        console.error(`Max retries (${maxRetries}) reached. Error: ${error.message}`);
        throw error;
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

  getShortAnswerFromAI(questionText)
    .then(aiText => {
      if (!aiText) {
        console.log("Could not get a valid short answer from the AI.");
        return;
      }

      console.log("AI short answer:", aiText);
      const inner = extractANASInner(aiText);
      const finalAnswer = inner !== null ? inner : aiText.trim();
      inputEl.value = finalAnswer;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      console.log(`Action: Wrote short answer into input id=${inputEl.id || '(no-id)'} name=${inputEl.name || '(no-name)'} value="${finalAnswer}"`);
    })
    .catch(error => {
      console.error("Error during short-answer AI call:", error);
    });
}

async function getShortAnswerFromAI(question) {
  const userPrompt = `Here is a short-answer question:
---
Question: ${question}
---
Provide a concise short answer (one sentence or less). Return only the answer text no labels or extra explanations and wrapped the answer by ANAS_<answer>_ANAS exmaple: 'ANAS_Paris_ANAS' so 'paris' is the answer here.`;

  const payload = {
    contents: [{
      parts: [{
        text: userPrompt
      }]
    }],  
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: 1024
      }
    }
  };

  try {
    console.log(`running.. ${apiUrl_ANSWER}`)
    const response = await fetchWithBackoff(apiUrl_ANSWER, {
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
    const candidate = result.candidates?.[0];

    console.log("Received response from Gemini API (short answer):", JSON.stringify(result, null, 2));

    if (candidate && candidate.content?.parts?.[0]?.text) {
      const aiText = candidate.content.parts[0].text.trim().replace(/^"|"$/g, '');
      return aiText;
    } else {
      console.log("No valid content found in AI response (short answer):", JSON.stringify(result, null, 2));
      return null;
    }
  } catch (error) {
    console.error("Error calling Gemini API (short answer):", error);
    return null;
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'k') {
    console.log("Key 'k' pressed. Handling as multiple choice...");
    handleMultipleChoiceQuestion();
  } else if (event.key === 't') {
    console.log("Key 't' pressed. Handling as true/false...");
    handleTrueFalseQuestion(0);
  } else if (event.key === 'a') {
    console.log("Key 'a' pressed. Handling as short answer...");
    handleShortAnswerQuestion();
  }
});