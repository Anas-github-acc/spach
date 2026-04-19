const apiKeys = [
	"",
	"",
	""
].filter((k) => typeof k === "string" && k.trim().length > 0);

// Backward compatibility for code paths that still read `apiKey`.
const apiKey = apiKeys[0] || "";

const googleFormModel = "gemini-2.5-flash";
const googleFormFallbackModel1 = "gemini-2.5-flash-lite";
const googleFormFallbackModel2 = "gemma-4-31b-it";
