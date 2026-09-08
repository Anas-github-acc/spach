;(function initSpachBobService(global) {
	const SPACH_ANSWER_SYSTEM_PROMPT = [
		"Just tell me the correct answer."
	].join(" ");
	const CURR_API_KEY_STORAGE_KEY = "currApiKey";
	const CURR_MODEL_STORAGE_KEY = "currModel_v2";
	const KEY_STATE_STORAGE_KEY = "keyState";
	const RPM_COOLDOWN_MS = 2 * 60 * 1000;
	const IST_OFFSET_MINUTES = 330;
	const inMemorySelectionState = {
		currApiKey: 0,
		currModel: 1,
		keyState: {},
		updatedAt: 0
	};

	function isNonEmptyString(value) {
		return typeof value === "string" && value.trim().length > 0;
	}

	function isExtensionContextInvalidatedError(error) {
		const msg = String(error?.message || error || "").toLowerCase();
		return msg.includes("extension context invalidated");
	}

	function getServiceRuntimeDebugSnapshot() {
		try {
			return {
				hasChrome: typeof chrome !== "undefined",
				hasRuntime: !!chrome?.runtime,
				runtimeIdPresent: !!chrome?.runtime?.id,
				hasStorage: !!chrome?.storage?.local
			};
		} catch (error) {
			return {
				snapshotError: error?.message || String(error)
			};
		}
	}

	function logServiceContextDebug(scope, error, extra = {}) {
		console.error("[SpachBob][ServiceDebug] Extension context diagnostic", {
			scope,
			errorMessage: error?.message || String(error),
			errorName: error?.name || "",
			stack: error?.stack || "",
			runtime: getServiceRuntimeDebugSnapshot(),
			...extra
		});
	}

	function canUseChromeStorage() {
		try {
			return typeof chrome !== "undefined"
				&& !!chrome.storage
				&& !!chrome.storage.local
				&& typeof chrome.storage.local.get === "function"
				&& typeof chrome.storage.local.set === "function";
		} catch (_err) {
			return false;
		}
	}

	function canUseChromeRuntimeMessaging() {
		try {
			return typeof chrome !== "undefined"
				&& !!chrome.runtime
				&& !!chrome.runtime.id
				&& typeof chrome.runtime.sendMessage === "function";
		} catch (_err) {
			return false;
		}
	}

	function isLoopbackUrl(url) {
		try {
			const parsed = new URL(String(url || ""), location.href);
			const host = String(parsed.hostname || "").toLowerCase();
			return host === "127.0.0.1" || host === "localhost" || host === "::1";
		} catch (_err) {
			return false;
		}
	}

	function normalizeKeyState(raw) {
		const out = {
			keyState: {},
			updatedAt: Date.now()
		};

		if (!raw || typeof raw !== "object") return out;

		if (raw.keyState && typeof raw.keyState === "object") {
			Object.keys(raw.keyState).forEach((keyId) => {
				const entry = raw.keyState[keyId];
				const expiry = Number(
					typeof entry === "object" && entry !== null
						? entry.expiryEndIns
						: entry
				);
				if (Number.isFinite(expiry) && expiry > 0) {
					out.keyState[keyId] = { expiryEndIns: expiry };
				}
			});
		}

		const updatedAt = Number(raw.updatedAt);
		if (Number.isFinite(updatedAt) && updatedAt > 0) {
			out.updatedAt = updatedAt;
		}

		return out;
	}

	function cloneSelectionState(state) {
		return {
			currApiKey: Number(state?.currApiKey) || 0,
			currModel: Number.isInteger(Number(state?.currModel)) && Number(state?.currModel) >= 0
				? Number(state.currModel)
				: 1,
			keyState: { ...(state?.keyState || {}) },
			updatedAt: Number(state?.updatedAt) || Date.now()
		};
	}

	function readStorageLocal(keys) {
		return new Promise((resolve) => {
			try {
				const safeKeys = Array.isArray(keys) ? keys : [keys];
				chrome.storage.local.get(safeKeys, (result) => {
					if (chrome.runtime?.lastError) {
						const runtimeError = new Error(chrome.runtime.lastError.message || "chrome.runtime.lastError in storage.get");
						if (isExtensionContextInvalidatedError(runtimeError)) {
							logServiceContextDebug("readStorageLocal.callback", runtimeError, { keys: safeKeys });
						}
						resolve({});
						return;
					}
					resolve(result || {});
				});
			} catch (error) {
				if (isExtensionContextInvalidatedError(error)) {
					logServiceContextDebug("readStorageLocal.tryCatch", error, { keys });
				}
				resolve({});
			}
		});
	}

	function writeStorageLocal(data) {
		return new Promise((resolve) => {
			try {
				chrome.storage.local.set(data, () => {
					if (chrome.runtime?.lastError) {
						const runtimeError = new Error(chrome.runtime.lastError.message || "chrome.runtime.lastError in storage.set");
						if (isExtensionContextInvalidatedError(runtimeError)) {
							logServiceContextDebug("writeStorageLocal.callback", runtimeError, { keys: Object.keys(data || {}) });
						}
					}
					resolve();
				});
			} catch (error) {
				if (isExtensionContextInvalidatedError(error)) {
					logServiceContextDebug("writeStorageLocal.tryCatch", error, { keys: Object.keys(data || {}) });
				}
				resolve();
			}
		});
	}

	function getCurrentApiKeyIndexFromStorageValue(raw) {
		if (Number.isInteger(raw) && raw >= 0) return raw;
		if (isNonEmptyString(raw)) {
			const asNum = Number(raw);
			if (Number.isInteger(asNum) && asNum >= 0) return asNum;
		}
		return 0;
	}

	function getCurrentModelIndexFromStorageValue(raw, modelCount = 5) {
		const index = Number(raw);
		if (!Number.isInteger(index) || index < 0) return modelCount > 1 ? 1 : 0;
		return modelCount > 0 ? index % modelCount : index;
	}

	async function getStoredSelectionState() {
		if (!canUseChromeStorage()) {
			return cloneSelectionState(inMemorySelectionState);
		}

		const result = await readStorageLocal([CURR_API_KEY_STORAGE_KEY, CURR_MODEL_STORAGE_KEY, KEY_STATE_STORAGE_KEY]);
		const currApiKey = getCurrentApiKeyIndexFromStorageValue(result[CURR_API_KEY_STORAGE_KEY]);
		const currModel = getCurrentModelIndexFromStorageValue(result[CURR_MODEL_STORAGE_KEY]);
		const normalized = normalizeKeyState({ keyState: result[KEY_STATE_STORAGE_KEY] });

		return {
			currApiKey,
			currModel,
			keyState: normalized.keyState,
			updatedAt: Date.now()
		};
	}

	async function saveStoredSelectionState(state) {
		const safeState = cloneSelectionState({
			currApiKey: Number(state?.currApiKey) || 0,
			currModel: Number.isInteger(Number(state?.currModel)) && Number(state?.currModel) >= 0
				? Number(state.currModel)
				: 1,
			keyState: normalizeKeyState({ keyState: state?.keyState || {} }).keyState,
			updatedAt: Date.now()
		});

		if (!canUseChromeStorage()) {
			Object.assign(inMemorySelectionState, safeState);
			return;
		}

		await writeStorageLocal({
			[CURR_API_KEY_STORAGE_KEY]: safeState.currApiKey,
			[CURR_MODEL_STORAGE_KEY]: safeState.currModel,
			[KEY_STATE_STORAGE_KEY]: safeState.keyState
		});
	}

	async function setSelectedModelIndex(modelIndex, modelCount) {
		const safeIndex = getCurrentModelIndexFromStorageValue(modelIndex, modelCount);
		inMemorySelectionState.currModel = safeIndex;
		const state = await getStoredSelectionState();
		state.currModel = safeIndex;
		await saveStoredSelectionState(state);
		return safeIndex;
	}

	function getAuthKeyId(authKey) {
		const key = String(authKey || "");
		if (!key) return "key-empty";
		return `k${key.length}_${key.slice(-6)}`;
	}

	function getTargetKeyId(target) {
		return getAuthKeyId(target?.key || "");
	}

	function pruneExpiredCooldowns(state, now = Date.now()) {
		const safe = cloneSelectionState(state);
		Object.keys(safe.keyState).forEach((keyId) => {
			const expiry = Number(safe.keyState[keyId]?.expiryEndIns);
			if (!Number.isFinite(expiry) || expiry <= now) {
				delete safe.keyState[keyId];
			}
		});
		return safe;
	}

	function getUniqueKeyIndices(requestTargets) {
		const unique = [...new Set((requestTargets || [])
			.map((target) => Number(target?.keyIndex))
			.filter((idx) => Number.isInteger(idx) && idx >= 0))];
		unique.sort((a, b) => a - b);
		return unique;
	}

	function buildPreferredKeyOrder(uniqueKeyIndices, preferredKeyIndex) {
		if (!Array.isArray(uniqueKeyIndices) || uniqueKeyIndices.length === 0) return [];
		const startPos = uniqueKeyIndices.indexOf(Number(preferredKeyIndex));
		if (startPos < 0) return [...uniqueKeyIndices];
		return [
			...uniqueKeyIndices.slice(startPos),
			...uniqueKeyIndices.slice(0, startPos)
		];
	}

	function prioritizeTargetsByPreferredKey(requestTargets, preferredKeyIndex) {
		const byModel = new Map();
		(requestTargets || []).forEach((target) => {
			const modelIndex = Number(target?.modelIndex);
			const keyIndex = Number(target?.keyIndex);
			if (!Number.isInteger(modelIndex) || modelIndex < 0) return;
			if (!Number.isInteger(keyIndex) || keyIndex < 0) return;

			if (!byModel.has(modelIndex)) byModel.set(modelIndex, new Map());
			byModel.get(modelIndex).set(keyIndex, target);
		});

		const uniqueKeyIndices = getUniqueKeyIndices(requestTargets);
		const keyOrder = buildPreferredKeyOrder(uniqueKeyIndices, preferredKeyIndex);
		const modelOrder = [...byModel.keys()].sort((a, b) => a - b);
		const ordered = [];

		modelOrder.forEach((modelIndex) => {
			const modelTargetsByKey = byModel.get(modelIndex);
			keyOrder.forEach((keyIndex) => {
				const target = modelTargetsByKey.get(keyIndex);
				if (target) ordered.push(target);
			});
		});

		return ordered;
	}

	function splitTargetsByCooldown(targets, keyState, now = Date.now()) {
		const available = [];
		const blocked = [];

		(targets || []).forEach((target) => {
			const keyId = getTargetKeyId(target);
			const expiresAt = Number((keyState || {})[keyId]?.expiryEndIns || 0);
			if (expiresAt > now) {
				blocked.push({ target, expiresAt });
				return;
			}
			available.push(target);
		});

		blocked.sort((a, b) => a.expiresAt - b.expiresAt);
		return { available, blocked };
	}

	function parseRetryAfterMs(response) {
		if (!response || !response.headers) return 0;
		const retryAfter = response.headers.get("retry-after");
		if (!retryAfter) return 0;

		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds > 0) {
			return Math.round(seconds * 1000);
		}

		const when = Date.parse(retryAfter);
		if (Number.isFinite(when)) {
			const diff = when - Date.now();
			return diff > 0 ? diff : 0;
		}

		return 0;
	}

	function parseApiErrorPayload(errorText) {
		const text = String(errorText || "").trim();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch (_err) {
			return null;
		}
	}

	function getApiErrorRoot(errorPayload) {
		if (!errorPayload || typeof errorPayload !== "object") return null;
		if (errorPayload.error && typeof errorPayload.error === "object") {
			return errorPayload.error;
		}
		return errorPayload;
	}

	function extractQuotaId(errorPayload) {
		const errorRoot = getApiErrorRoot(errorPayload);
		if (!errorRoot || !Array.isArray(errorRoot.details)) return "";

		for (const detail of errorRoot.details) {
			if (!detail || typeof detail !== "object") continue;
			const violations = Array.isArray(detail.violations) ? detail.violations : [];
			for (const violation of violations) {
				if (isNonEmptyString(violation?.quotaId)) {
					return violation.quotaId.trim();
				}
			}
		}

		return "";
	}

	function getNext1230PmIstTimestamp(nowMs = Date.now()) {
		const istMs = nowMs + (IST_OFFSET_MINUTES * 60 * 1000);
		const istNow = new Date(istMs);
		const year = istNow.getUTCFullYear();
		const month = istNow.getUTCMonth();
		const day = istNow.getUTCDate();

		let targetIstMs = Date.UTC(year, month, day, 12, 30, 0, 0);
		if (istMs >= targetIstMs) {
			targetIstMs = Date.UTC(year, month, day + 1, 12, 30, 0, 0);
		}

		return targetIstMs - (IST_OFFSET_MINUTES * 60 * 1000);
	}

	function isRpdQuotaId(quotaId) {
		const id = String(quotaId || "").toLowerCase();
		return id.includes("perday") || id.includes("requests_per_day");
	}

	function getRateLimitExpiryEndIns(quotaId, now = Date.now()) {
		if (isRpdQuotaId(quotaId)) {
			return getNext1230PmIstTimestamp(now);
		}

		return now + RPM_COOLDOWN_MS;
	}

	async function markTargetRateLimited(target, failure, requestTargets) {
		const now = Date.now();
		const state = pruneExpiredCooldowns(await getStoredSelectionState(), now);
		const keyId = getTargetKeyId(target);
		const expiryEndIns = getRateLimitExpiryEndIns(failure?.quotaId, now);
		state.keyState[keyId] = { expiryEndIns };

		const orderedTargets = prioritizeTargetsByPreferredKey(requestTargets || [], (Number(target?.keyIndex) || 0) + 1);
		const { available, blocked } = splitTargetsByCooldown(orderedTargets, state.keyState, now);
		const nextTarget = available[0] || blocked[0]?.target || null;
		if (Number.isInteger(nextTarget?.keyIndex) && nextTarget.keyIndex >= 0) {
			state.currApiKey = nextTarget.keyIndex;
		}

		await saveStoredSelectionState(state);
	}

	async function markTargetSuccess(target) {
		const now = Date.now();
		const state = pruneExpiredCooldowns(await getStoredSelectionState(), now);
		const keyId = getTargetKeyId(target);
		delete state.keyState[keyId];
		if (Number.isInteger(target?.keyIndex) && target.keyIndex >= 0) {
			state.currApiKey = target.keyIndex;
		}
		await saveStoredSelectionState(state);
	}

	function getConfiguredModels(models) {
		if (!Array.isArray(models)) return [];
		return models.filter(isNonEmptyString);
	}

	function buildOpenCodeChatCompletionsUrl(baseUrl) {
		const fallback = "http://127.0.0.1:4096/v1";
		const safeBase = isNonEmptyString(baseUrl) ? baseUrl.trim() : fallback;
		if (/\/chat\/completions\/?$/i.test(safeBase)) {
			return safeBase.replace(/\/+$/, "");
		}
		return `${safeBase.replace(/\/+$/, "")}/chat/completions`;
	}

	function buildOpenCodeServerBaseUrl(baseUrl) {
		const fallback = "http://127.0.0.1:4096";
		const safeBase = isNonEmptyString(baseUrl) ? baseUrl.trim() : fallback;
		const noTrailing = safeBase.replace(/\/+$/, "");
		if (/\/v1\/chat\/completions$/i.test(noTrailing)) {
			return noTrailing.replace(/\/v1\/chat\/completions$/i, "");
		}
		if (/\/chat\/completions$/i.test(noTrailing)) {
			return noTrailing.replace(/\/chat\/completions$/i, "");
		}
		if (/\/v1$/i.test(noTrailing)) {
			return noTrailing.replace(/\/v1$/i, "");
		}
		return noTrailing;
	}

	function buildOpenCodeRequestTargets(models, keys, baseUrl, variants = []) {
		const out = [];
		const serverBaseUrl = buildOpenCodeServerBaseUrl(baseUrl);
		const url = `${serverBaseUrl}/session`;
		const safeKeys = Array.isArray(keys) && keys.length > 0 ? keys : [""];

		(models || []).forEach((model, modelIndex) => {
			safeKeys.forEach((key, keyIndex) => {
				out.push({
					model,
					variant: isNonEmptyString(variants[modelIndex]) ? variants[modelIndex].trim() : "",
					key: isNonEmptyString(key) ? key : "",
					modelIndex,
					keyIndex,
						serverBaseUrl,
					url
				});
			});
		});

		return out;
	}

	function prioritizeTargetsBySelectedModel(requestTargets, selectedModelIndex, preferredKeyIndex) {
		const byModel = new Map();
		(requestTargets || []).forEach((target) => {
			const modelIndex = Number(target?.modelIndex);
			if (!Number.isInteger(modelIndex) || modelIndex < 0) return;
			if (!byModel.has(modelIndex)) byModel.set(modelIndex, []);
			byModel.get(modelIndex).push(target);
		});

		const modelIndices = [...byModel.keys()].sort((a, b) => a - b);
		if (!modelIndices.length) return [];
		const start = modelIndices.indexOf(Number(selectedModelIndex));
		const orderedModelIndices = start < 0
			? modelIndices
			: [...modelIndices.slice(start), ...modelIndices.slice(0, start)];
		const ordered = [];

		orderedModelIndices.forEach((modelIndex) => {
			const targets = byModel.get(modelIndex) || [];
			const preferred = targets.find((target) => Number(target.keyIndex) === Number(preferredKeyIndex));
			ordered.push(preferred || targets[0]);
		});

		return ordered;
	}

	function mapPromptPartsToOpenCodeContent(promptParts) {
		const content = [];

		(promptParts || []).forEach((part) => {
			if (isNonEmptyString(part?.text)) {
				content.push({ type: "text", text: part.text });
				return;
			}

			if (isNonEmptyString(part?.inlineData?.data)) {
				const mimeType = isNonEmptyString(part?.inlineData?.mimeType)
					? part.inlineData.mimeType
					: "image/jpeg";
				content.push({
					type: "image_url",
					image_url: {
						url: `data:${mimeType};base64,${part.inlineData.data}`
					}
				});
			}
		});

		if (content.length === 1 && content[0]?.type === "text") {
			return content[0].text;
		}

		return content;
	}

	function buildOpenCodePayload(promptParts, options = {}) {
		return {
			messages: [{ role: "user", content: mapPromptPartsToOpenCodeContent(promptParts) }],
			temperature: Number.isFinite(options.temperature) ? options.temperature : 0,
			useModelInstruction: options.useModelInstruction !== false
		};
	}

	function getAnswerSystemPrompt() {
		return SPACH_ANSWER_SYSTEM_PROMPT;
	}

	function getModelInstruction(target) {
		return SPACH_ANSWER_SYSTEM_PROMPT;
	}

	function extractOpenCodeResponseParts(result) {
		const parts = Array.isArray(result?.parts)
			? result.parts
			: (Array.isArray(result?.data?.parts) ? result.data.parts : []);
		const reasoning = parts
			.filter((part) => part?.type === "reasoning" && isNonEmptyString(part.text))
			.map((part) => part.text.trim())
			.join("\n")
			.trim();
		const text = parts
			.filter((part) => part?.type === "text" && isNonEmptyString(part.text))
			.map((part) => part.text.trim())
			.join("\n")
			.trim();

		if (reasoning || text) return { reasoning, text };

		const content = result?.choices?.[0]?.message?.content;
		if (typeof content === "string") return { reasoning: "", text: content.trim() };
		if (Array.isArray(content)) {
			return {
				reasoning: content.filter((part) => part?.type === "reasoning").map((part) => part.text || "").join("\n").trim(),
				text: content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n").trim()
			};
		}

		return { reasoning: "", text: "" };
	}

	function extractTextFromOpenCodeResult(result) {
		return extractOpenCodeResponseParts(result).text;
	}

	function splitOpenCodeModelId(model) {
		const raw = String(model || "").trim();
		const idx = raw.indexOf("/");
		if (idx <= 0) {
			return {
				providerID: "opencode",
				modelID: raw || "gpt-5.1-codex"
			};
		}

		return {
			providerID: raw.slice(0, idx),
			modelID: raw.slice(idx + 1)
		};
	}

	function buildOpenCodePromptTextFromPayload(payload) {
		const lines = [];
		const messages = Array.isArray(payload?.messages) ? payload.messages : [];

		messages.forEach((message) => {
			const content = message?.content;
			if (typeof content === "string") {
				if (isNonEmptyString(content)) lines.push(content.trim());
				return;
			}

			if (!Array.isArray(content)) return;

			content.forEach((part) => {
				if (part?.type === "text" && isNonEmptyString(part?.text)) {
					lines.push(part.text.trim());
					return;
				}

				if (part?.type === "image_url" && isNonEmptyString(part?.image_url?.url)) {
					lines.push(`[image] ${part.image_url.url}`);
				}
			});
		});

		return lines.join("\n\n").trim();
	}

	function classifyApiFailure(status, errorText, errorPayload) {
		const text = String(errorText || "").toLowerCase();
		const errorRoot = getApiErrorRoot(errorPayload);
		const errorCode = Number(errorRoot?.code);
		const errorStatus = String(errorRoot?.status || "").toUpperCase();
		const quotaId = extractQuotaId(errorPayload);
		const is429ResourceExhausted = (status === 429 || errorCode === 429) && errorStatus === "RESOURCE_EXHAUSTED";
		const isRateLimit = is429ResourceExhausted
			|| status === 429
			|| text.includes("rate")
			|| text.includes("quota")
			|| text.includes("resource_exhausted");
		const isModelFailure = status === 404 || status === 400 || status === 501 || text.includes("model") || text.includes("not found");
		const isRetryable = status >= 500 || status === 429;
		return {
			isRateLimit,
			isModelFailure,
			isRetryable,
			quotaId,
			errorCode,
			errorStatus
		};
	}

	function isRateLimitError(error) {
		const msg = String(error?.message || error || "").toLowerCase();
		return msg.includes("429")
			|| msg.includes("too many requests")
			|| msg.includes("resource_exhausted")
			|| msg.includes("quota");
	}

	async function fetchWithBackoff(url, options, maxRetries = 3, baseDelay = 1000) {
		const fetchImpl = typeof options?.fetchImpl === "function"
			? options.fetchImpl
			: (canUseChromeRuntimeMessaging() && isLoopbackUrl(url) ? fetchViaBackground : fetch);
		const requestOptions = { ...(options || {}) };
		delete requestOptions.fetchImpl;

		let attempt = 0;
		while (attempt < maxRetries) {
			let response;
			try {
				response = await fetchImpl(url, requestOptions);
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

	function createResponseLikeFromBackgroundPayload(payload) {
		const status = Number(payload?.status) || 0;
		const headersMap = {};
		const rawHeaders = payload?.headers && typeof payload.headers === "object"
			? payload.headers
			: {};

		Object.keys(rawHeaders).forEach((key) => {
			headersMap[String(key || "").toLowerCase()] = String(rawHeaders[key] || "");
		});

		const bodyText = String(payload?.bodyText || "");

		return {
			ok: status >= 200 && status < 300,
			status,
			statusText: String(payload?.statusText || ""),
			headers: {
				get(name) {
					return headersMap[String(name || "").toLowerCase()] || null;
				}
			},
			async text() {
				return bodyText;
			},
			async json() {
				if (!bodyText) return {};
				return JSON.parse(bodyText);
			}
		};
	}

	function fetchViaBackground(url, options = {}) {
		return new Promise((resolve, reject) => {
			if (!canUseChromeRuntimeMessaging()) {
				reject(new Error("Extension context unavailable for background HTTP proxy"));
				return;
			}

			const timeoutMs = (() => {
				const n = Number(options?.timeoutMs);
				if (!Number.isFinite(n) || n <= 0) return 45000;
				return Math.max(1000, Math.floor(n));
			})();

			let payloadBody = undefined;
			if (typeof options?.body === "string") payloadBody = options.body;
			else if (options?.body != null) payloadBody = String(options.body);

			const message = {
				action: "proxyHttpRequest",
				url,
				method: String(options?.method || "GET").toUpperCase(),
				headers: options?.headers && typeof options.headers === "object" ? options.headers : {},
				body: payloadBody,
				timeoutMs
			};

			try {
				let settled = false;
				const callbackTimeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(new Error(`Background proxy callback timed out after ${timeoutMs}ms for ${message.method} ${url}`));
				}, timeoutMs + 1500);

				chrome.runtime.sendMessage(message, (response) => {
					if (settled) return;
					settled = true;
					clearTimeout(callbackTimeout);

					if (chrome.runtime?.lastError) {
						reject(new Error(chrome.runtime.lastError.message || "Background proxy runtime error"));
						return;
					}

					if (!response || !response.success) {
						reject(new Error(response?.error || "Background proxy request failed"));
						return;
					}

					resolve(createResponseLikeFromBackgroundPayload(response));
				});
			} catch (error) {
				reject(error);
			}
		});
	}

	async function callOpenCodeWithFallback({
		payload,
		requestTargets,
		requestLabel = "AI",
		maxRetries = 3,
		baseDelay = 1000,
		transformResult,
		onAttemptFailed
	}) {
		if (!Array.isArray(requestTargets) || requestTargets.length === 0) {
			throw new Error("No OpenCode request targets configured. Please set opencode model/server values in config.js");
		}

		const stateNow = Date.now();
		const storedState = pruneExpiredCooldowns(await getStoredSelectionState(), stateNow);
		await saveStoredSelectionState(storedState);

		const orderedTargets = prioritizeTargetsBySelectedModel(
			requestTargets,
			storedState.currModel,
			storedState.currApiKey
		);
		const { available, blocked } = splitTargetsByCooldown(orderedTargets, storedState.keyState, stateNow);
		let targetsToTry = available;

		if (targetsToTry.length === 0 && blocked.length > 0) {
			targetsToTry = [blocked[0].target];
		} else if (blocked.length > 0) {
			console.log(`[${requestLabel}] Skipping ${blocked.length} cooled-down OpenCode target(s).`);
		}

		if (Number.isInteger(targetsToTry[0]?.keyIndex) && targetsToTry[0].keyIndex >= 0) {
			storedState.currApiKey = targetsToTry[0].keyIndex;
			await saveStoredSelectionState(storedState);
		}

		let lastError = null;
		const runtimeBlockedKeyIds = new Set();

		for (const target of targetsToTry) {
			try {
				const targetModelIndex = Number(target?.modelIndex);
				if (runtimeBlockedKeyIds.has(targetModelIndex)) continue;

				console.log(`[${requestLabel}] Trying OpenCode model=${target.model} key#${target.keyIndex + 1}`);

				const headers = { "Content-Type": "application/json" };
				if (isNonEmptyString(target.key)) {
					headers.Authorization = `Bearer ${target.key}`;
				}

				const serverBaseUrl = buildOpenCodeServerBaseUrl(target?.serverBaseUrl || target?.url || "");
				console.log(`[${requestLabel}] Creating OpenCode session at ${serverBaseUrl}/session`);
				const createSessionResponse = await fetchWithBackoff(
					`${serverBaseUrl}/session`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({}),
						timeoutMs: 45000,
						fetchImpl: fetchViaBackground
					},
					maxRetries,
					baseDelay
				);
				console.log(`[${requestLabel}] OpenCode session create status=${createSessionResponse.status}`);

				if (!createSessionResponse.ok) {
					const createSessionErrorText = await createSessionResponse.text();
					const createSessionPayload = parseApiErrorPayload(createSessionErrorText);
					const createSessionFailure = classifyApiFailure(createSessionResponse.status, createSessionErrorText, createSessionPayload);
					const createSessionError = new Error(`OpenCode session create failed with status ${createSessionResponse.status}: ${createSessionErrorText}`);
					createSessionError.status = createSessionResponse.status;
					createSessionError.errorText = createSessionErrorText;
					createSessionError.errorPayload = createSessionPayload;
					createSessionError.target = target;
					createSessionError.failure = createSessionFailure;
					createSessionError.quotaId = createSessionFailure.quotaId || "";
					throw createSessionError;
				}

				const createdSession = await createSessionResponse.json();
				const sessionId = String(createdSession?.id || "").trim();
				if (!sessionId) {
					throw new Error("OpenCode server returned an invalid session id");
				}

				const model = splitOpenCodeModelId(target.model);
				const promptText = buildOpenCodePromptTextFromPayload(payload);
				const modelInstruction = payload?.useModelInstruction === false
					? ""
					: getModelInstruction(target);
				const sessionPromptBody = {
					model,
					...(isNonEmptyString(target.variant) ? { variant: target.variant } : {}),
					parts: [{
						type: "text",
						text: [modelInstruction, promptText || "Respond with plain text."].filter(Boolean).join("\n\n")
					}]
				};
				console.log(`[${requestLabel}] Sending OpenCode message session=${sessionId} provider=${model.providerID} model=${model.modelID}`);

				const response = await fetchWithBackoff(
					`${serverBaseUrl}/session/${encodeURIComponent(sessionId)}/message`,
					{
						method: "POST",
						headers,
						body: JSON.stringify(sessionPromptBody),
						timeoutMs: 120000,
						fetchImpl: fetchViaBackground
					},
					maxRetries,
					baseDelay
				);
				console.log(`[${requestLabel}] OpenCode message status=${response.status}`);

				if (!response.ok) {
					const errorText = await response.text();
					const errorPayload = parseApiErrorPayload(errorText);
					const failure = classifyApiFailure(response.status, errorText, errorPayload);
					const error = new Error(`OpenCode request failed with status ${response.status}: ${errorText}`);
					error.status = response.status;
					error.errorText = errorText;
					error.errorPayload = errorPayload;
					error.target = target;
					error.failure = failure;
					error.quotaId = failure.quotaId || "";
					throw error;
				}

				const result = await response.json();
				await markTargetSuccess(target);

				if (typeof transformResult === "function") {
					const value = await transformResult(result, target);
					return { result, target, value };
				}

				return { result, target };
			} catch (error) {
				lastError = error;

				if (error?.failure?.isRateLimit || isRateLimitError(error)) {
					runtimeBlockedKeyIds.add(Number(target?.modelIndex));
					await markTargetRateLimited(target, error.failure, requestTargets);
				}
				if (!error?.failure?.isRateLimit && !isRateLimitError(error)) {
					runtimeBlockedKeyIds.add(Number(target?.modelIndex));
				}

				if (typeof onAttemptFailed === "function") {
					onAttemptFailed(error, target);
				}

				if (isRateLimitError(error)) {
					console.warn(`[${requestLabel}] OpenCode rate-limited model=${target.model} key#${target.keyIndex + 1}: ${error.message || error}`);
				} else {
					console.warn(`[${requestLabel}] OpenCode failed model=${target.model} key#${target.keyIndex + 1}:`, error);
				}
			}
		}

		throw lastError || new Error("All configured OpenCode model/key combinations failed.");
	}

	async function callOpenCode({
		payload,
		requestTargets,
		requestLabel = "AI",
		maxRetries = 3,
		baseDelay = 1000,
		transformResult,
		onAttemptFailed
	}) {
		return callOpenCodeWithFallback({
			payload,
			requestTargets,
			requestLabel,
			maxRetries,
			baseDelay,
			transformResult,
			onAttemptFailed
		});
	}

	global.SpachBobService = {
		isNonEmptyString,
		getConfiguredModels,
		buildOpenCodeServerBaseUrl,
		buildOpenCodeChatCompletionsUrl,
		buildOpenCodeRequestTargets,
		buildOpenCodePayload,
		getAnswerSystemPrompt,
		getModelInstruction,
		extractOpenCodeResponseParts,
		extractTextFromOpenCodeResult,
		extractQuotaId,
		getRateLimitExpiryEndIns,
		classifyApiFailure,
		isRateLimitError,
		fetchWithBackoff,
		callOpenCodeWithFallback,
		callOpenCode
		,
		setSelectedModelIndex
	};
})(window);
