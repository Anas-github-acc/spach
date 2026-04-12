const apiKey = "";
const apiKeyFallback1 = "";
const apiKeyFallback2 = "";

const apiKeys = [apiKey, apiKeyFallback1, apiKeyFallback2].filter((k) => typeof k === "string" && k.trim().length > 0);

const googleFormModel = "gemini-2.5-flash";
const googleFormFallbackModel1 = "gemini-2.5-flash";
const googleFormFallbackModel2 = "gemma-4-31b-it";
