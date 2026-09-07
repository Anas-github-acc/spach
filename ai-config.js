;(function initSpachAiConfig(global) {
  const service = global.SpachBobService;
  const models = typeof MODEL_PREFERENCES !== 'undefined' && Array.isArray(MODEL_PREFERENCES)
    ? MODEL_PREFERENCES.filter((model) => typeof model === 'string' && model.trim())
    : [];
  const keys = typeof openCodeApiKeys !== 'undefined' && Array.isArray(openCodeApiKeys)
    ? openCodeApiKeys.filter((key) => typeof key === 'string')
    : [typeof openCodeApiKey !== 'undefined' ? openCodeApiKey : ''];

  global.SpachAiConfig = {
    provider: 'opencode',
    baseUrl: typeof openCodeBaseUrl !== 'undefined' ? openCodeBaseUrl : 'http://127.0.0.1:4096',
    models: service.getConfiguredModels(models),
    keys,
    requestTargets: service.buildOpenCodeRequestTargets(models, keys, typeof openCodeBaseUrl !== 'undefined' ? openCodeBaseUrl : '')
  };

  global.handleSpachModelShortcut = function handleSpachModelShortcut(event) {
    if (!event?.altKey) return false;
    const shortcutIndex = { Digit1: 0, Digit2: 1, Digit3: 2 }[event.code];
    if (shortcutIndex === undefined || shortcutIndex >= global.SpachAiConfig.models.length) return false;

    event.preventDefault();
    global.SpachAiConfig.selectedModelIndex = shortcutIndex;
    service.setSelectedModelIndex(shortcutIndex, global.SpachAiConfig.models.length)
      .then(() => console.log(`[SpachBob] Selected Model ${shortcutIndex + 1}: ${global.SpachAiConfig.models[shortcutIndex]}`))
      .catch((error) => console.warn('[SpachBob] Could not persist selected model:', error));
    return true;
  };
})(window);
