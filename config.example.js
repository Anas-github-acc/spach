// OpenCode server settings (native opencode server API).
const openCodeBaseUrl = "http://127.0.0.1:4096";
const openCodeApiKey = "";
const openCodeApiKeys = [openCodeApiKey].filter((k) => typeof k === "string");
const MODEL_PREFERENCES = [
	"opencode/nemotron-3-ultra-free", // Model 1
	"opencode/mimo-v2.5-free", // Model 2
	"opencode/nemotron-3.5-lightning-free" // Model 3
];
