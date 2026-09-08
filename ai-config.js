;(function initSpachAiConfig(global) {
  const service = global.SpachBobService;
  const models = typeof MODEL_PREFERENCES !== 'undefined' && Array.isArray(MODEL_PREFERENCES)
    ? MODEL_PREFERENCES.filter((model) => typeof model === 'string' && model.trim())
    : [];
  const keys = typeof openCodeApiKeys !== 'undefined' && Array.isArray(openCodeApiKeys)
    ? openCodeApiKeys.filter((key) => typeof key === 'string')
    : [typeof openCodeApiKey !== 'undefined' ? openCodeApiKey : ''];
  const variants = typeof MODEL_VARIANTS !== 'undefined' && Array.isArray(MODEL_VARIANTS)
    ? MODEL_VARIANTS
    : [];

  global.SpachAiConfig = {
    provider: 'opencode',
    baseUrl: typeof openCodeBaseUrl !== 'undefined' ? openCodeBaseUrl : 'http://127.0.0.1:4096',
    models: service.getConfiguredModels(models),
    keys,
    requestTargets: service.buildOpenCodeRequestTargets(models, keys, typeof openCodeBaseUrl !== 'undefined' ? openCodeBaseUrl : '', variants)
  };

  global.testModelConnection = async function testModelConnection() {
    console.log("=== Testing Model Connection ===");
    const testPrompt = prompt(
      "Enter a message to send to the active OpenCode model:",
      "Reply with exactly ANAS_OK_ANAS"
    );

    if (testPrompt === null) {
      console.log("Model connection test cancelled.");
      return false;
    }

    if (!testPrompt.trim()) {
      alert("Model Test cancelled: enter a message first.");
      return false;
    }

    const requestTargets = global.SpachAiConfig.requestTargets || [];
    const provider = global.SpachAiConfig.provider;

    try {
      const startTime = Date.now();
      const payload = service.buildOpenCodePayload([{ text: testPrompt }], {
        generationConfig: {
          temperature: 0,
          responseMimeType: 'text/plain'
        },
        temperature: 0,
        useModelInstruction: true
      });

      const { result, target } = await service.callOpenCode({
        payload,
        requestTargets,
        requestLabel: `ConnectionTest/${provider}`
      });

      const responseTime = Date.now() - startTime;
      const responseParts = service.extractOpenCodeResponseParts(result);
      const responseText = responseParts.text;
      if (!responseText) throw new Error("The model returned no text output.");

      const cleanText = responseText.trim();
      const reasoningText = responseParts.reasoning || "(none returned)";
      console.log(`Reasoning (separate): ${reasoningText}`);
      console.log(`Actual response (separate): ${cleanText}`);
      console.log(`✅ TEST PASSED - Model=${target.model}, time=${responseTime}ms`);
      alert(`✅ Model Test SUCCESSFUL\nModel: ${target.model}\nSent: "${testPrompt.trim()}"\n\nReasoning:\n${reasoningText}\n\nActual response:\n${cleanText}\n\nResponse time: ${responseTime}ms`);
      return true;
    } catch (error) {
      console.error("❌ TEST FAILED - Error:", error);
      alert(`❌ Model Test FAILED\nError: ${error.message || String(error)}\nCheck the console for details.`);
      return false;
    }
  };

  global.handleSpachModelShortcut = function handleSpachModelShortcut(event) {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    const isConnectionTestShortcut = event?.code === 'KeyT'
      && (isMac ? event.metaKey && event.altKey : event.altKey);

    if (isConnectionTestShortcut) {
      event.preventDefault();
      global.testModelConnection();
      return true;
    }

    if (!event?.altKey) return false;
    const shortcutIndex = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4 }[event.code];
    if (shortcutIndex === undefined || shortcutIndex >= global.SpachAiConfig.models.length) return false;

    event.preventDefault();
    global.SpachAiConfig.selectedModelIndex = shortcutIndex;
    service.setSelectedModelIndex(shortcutIndex, global.SpachAiConfig.models.length)
      .then(() => console.log(`[SpachBob] Selected Model ${shortcutIndex + 1}: ${global.SpachAiConfig.models[shortcutIndex]}`))
      .catch((error) => console.warn('[SpachBob] Could not persist selected model:', error));
    return true;
  };
})(window);
