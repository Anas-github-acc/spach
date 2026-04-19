;(function initSpachBobService(global) {
	const CURR_API_KEY_STORAGE_KEY = "currApiKey";
	const KEY_STATE_STORAGE_KEY = "keyState";
	const RPM_COOLDOWN_MS = 2 * 60 * 1000;
	const IST_OFFSET_MINUTES = 330;
	const inMemorySelectionState = {
		currApiKey: 0,
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

	async function getStoredSelectionState() {
		if (!canUseChromeStorage()) {
			return cloneSelectionState(inMemorySelectionState);
		}

		const result = await readStorageLocal([CURR_API_KEY_STORAGE_KEY, KEY_STATE_STORAGE_KEY]);
		const currApiKey = getCurrentApiKeyIndexFromStorageValue(result[CURR_API_KEY_STORAGE_KEY]);
		const normalized = normalizeKeyState({ keyState: result[KEY_STATE_STORAGE_KEY] });

		return {
			currApiKey,
			keyState: normalized.keyState,
			updatedAt: Date.now()
		};
	}

	async function saveStoredSelectionState(state) {
		const safeState = cloneSelectionState({
			currApiKey: Number(state?.currApiKey) || 0,
			keyState: normalizeKeyState({ keyState: state?.keyState || {} }).keyState,
			updatedAt: Date.now()
		});

		if (!canUseChromeStorage()) {
			Object.assign(inMemorySelectionState, safeState);
			return;
		}

		await writeStorageLocal({
			[CURR_API_KEY_STORAGE_KEY]: safeState.currApiKey,
			[KEY_STATE_STORAGE_KEY]: safeState.keyState
		});
	}

	function getApiKeyId(apiKey) {
		const key = String(apiKey || "");
		if (!key) return "key-empty";
		return `k${key.length}_${key.slice(-6)}`;
	}

	function getTargetKeyId(target) {
		return getApiKeyId(target?.key || "");
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

	function getConfiguredApiKeys(apiKeysList, fallbackApiKey) {
		const keys = [];
		if (Array.isArray(apiKeysList)) {
			keys.push(...apiKeysList.filter(isNonEmptyString));
		}
		if (keys.length === 0 && isNonEmptyString(fallbackApiKey)) {
			keys.push(fallbackApiKey);
		}
		return keys;
	}

	function getConfiguredModels(models) {
		if (!Array.isArray(models)) return [];
		return models.filter(isNonEmptyString);
	}

	function buildGenerateContentUrl(modelName, key) {
		return `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
	}

	function buildRequestTargets(models, keys) {
		const out = [];
		(models || []).forEach((model, modelIndex) => {
			(keys || []).forEach((key, keyIndex) => {
				out.push({
					model,
					key,
					modelIndex,
					keyIndex,
					url: buildGenerateContentUrl(model, key)
				});
			});
		});
		return out;
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

	async function callGeminiWithFallback({
		payload,
		requestTargets,
		requestLabel = "AI",
		maxRetries = 3,
		baseDelay = 1000,
		transformResult,
		onAttemptFailed
	}) {
		if (!Array.isArray(requestTargets) || requestTargets.length === 0) {
			throw new Error("No request targets configured. Please set apiKey and model values in config.js");
		}

		const stateNow = Date.now();
		const storedState = pruneExpiredCooldowns(await getStoredSelectionState(), stateNow);
		await saveStoredSelectionState(storedState);

		const orderedTargets = prioritizeTargetsByPreferredKey(requestTargets, storedState.currApiKey);
		const { available, blocked } = splitTargetsByCooldown(orderedTargets, storedState.keyState, stateNow);
		let targetsToTry = available;

		if (targetsToTry.length === 0 && blocked.length > 0) {
			// If all keys are cooling down, try the one that becomes available first.
			targetsToTry = [blocked[0].target];
			const waitMs = Math.max(0, blocked[0].expiresAt - stateNow);
			console.warn(`[${requestLabel}] All keys are on cooldown. Trying earliest key after ${waitMs}ms window.`);
		} else if (blocked.length > 0) {
			console.log(`[${requestLabel}] Skipping ${blocked.length} cooled-down key/model target(s).`);
		}

		if (Number.isInteger(targetsToTry[0]?.keyIndex) && targetsToTry[0].keyIndex >= 0) {
			storedState.currApiKey = targetsToTry[0].keyIndex;
			await saveStoredSelectionState(storedState);
		}

		let lastError = null;
		const runtimeBlockedKeyIds = new Set();

		for (const target of targetsToTry) {
			try {
				const targetKeyId = getTargetKeyId(target);
				if (runtimeBlockedKeyIds.has(targetKeyId)) {
					continue;
				}

				console.log(`[${requestLabel}] Trying model=${target.model} key#${target.keyIndex + 1}`);

				const response = await fetchWithBackoff(
					target.url,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload)
					},
					maxRetries,
					baseDelay
				);

				if (!response.ok) {
					const errorText = await response.text();
					const errorPayload = parseApiErrorPayload(errorText);
					const failure = classifyApiFailure(response.status, errorText, errorPayload);
					const error = new Error(`API request failed with status ${response.status}: ${errorText}`);
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

				if (isExtensionContextInvalidatedError(error)) {
					logServiceContextDebug("callGeminiWithFallback.loop", error, {
						requestLabel,
						targetModel: target?.model || "",
						targetKeyIndex: Number(target?.keyIndex),
						targetsToTryCount: targetsToTry.length,
						runtimeBlockedCount: runtimeBlockedKeyIds.size
					});
				}

				if (error?.failure?.isRateLimit || isRateLimitError(error)) {
					runtimeBlockedKeyIds.add(getTargetKeyId(target));
					await markTargetRateLimited(target, error.failure, requestTargets);
				}

				if (typeof onAttemptFailed === "function") {
					onAttemptFailed(error, target);
				}

				if (isRateLimitError(error)) {
					const quotaPart = error?.failure?.quotaId ? ` quotaId=${error.failure.quotaId}` : "";
					console.warn(`[${requestLabel}] Rate-limited model=${target.model} key#${target.keyIndex + 1}${quotaPart}: ${error.message || error}`);
				} else {
					console.warn(`[${requestLabel}] Failed model=${target.model} key#${target.keyIndex + 1}:`, error);
				}
			}
		}

		throw lastError || new Error("All configured model/key combinations failed.");
	}

	global.SpachBobService = {
		isNonEmptyString,
		getConfiguredApiKeys,
		getConfiguredModels,
		buildGenerateContentUrl,
		buildRequestTargets,
		extractQuotaId,
		getRateLimitExpiryEndIns,
		classifyApiFailure,
		isRateLimitError,
		fetchWithBackoff,
		callGeminiWithFallback
	};
})(window);
