// OpenCode server settings (native opencode server API).
const openCodeBaseUrl = "http://127.0.0.1:4096";
const openCodeApiKey = "";
const openCodeApiKeys = [openCodeApiKey].filter((k) => typeof k === "string");
const MODEL_PREFERENCES = [
	"opencode/muse-spark-1.2-contributor-free", // Model 1 - image support
	"opencode/mimo-v2.5-free", // Model 2 - recommended, image support
	"opencode/nemotron-3-ultra-free", // Model 3 - text only
	"opencode/ling-3.0-flash-fin-free", // Model 4 - fastest, text only
	"opencode/big-pickle" // Model 5 - text only
];
const MODEL_VARIANTS = ["medium", "", "", "medium", ""];
