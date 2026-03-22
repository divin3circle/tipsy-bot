import {
  contributeToPool,
  getActivePools,
  getReadyAdminSignals,
  markPoolTriggered,
  markAdminSignalConsumed,
  getMonthlySpend,
  getTipHistory,
  logResolverDiagnostic,
  logTip,
} from "./mongodb.js";
import {
  executeWDKTip,
  generateSeedPhrase,
  getWalletStatus,
  initializeWallet,
  initializeWalletFromStorage,
  validateSeedPhrase,
} from "./wdk.js";

const GEMINI_API_KEY =
  globalThis.TIPSY_GEMINI_API_KEY ||
  import.meta?.env?.VITE_GEMINI_API_KEY ||
  "";

const SYSTEM_PROMPT = `You are the Tipsy tipping agent. Your job is to evaluate whether a tip should
be sent to a Rumble creator based on the user's configured rules, their tipping
history patterns, and the current viewing context.

PROFILE-AWARE DECISION MAKING:
If creator_profile exists, use it to make smarter decisions:
- favorite_creators: tip these creators more generously (up to 2x base)
- frequent creators: tip normally
- occasional/new: tip based on default rules

RULES YOU MUST FOLLOW:
1. Never tip if budget_used_this_month >= user_rules.monthly_cap.
2. Never fire the same trigger twice in a session (check already_tipped_* flags).
3. For "watch_time" trigger: tip at 50% if !already_tipped_at_50 and watch_percent >= 50.
   Tip at 100% if !already_tipped_at_100 and watch_percent >= 95.
4. For "like" trigger: tip if !already_tipped_for_like.
5. For "comment" trigger: tip if !already_tipped_for_comment.
6. For "milestone" trigger: tip the full pool_balance if pool_goal_met is true.
7. Amount must never exceed the remaining budget.

PERSONALISATION:
Write a short, warm, specific tip message (max 120 chars) referencing the
video content. Be natural, not corporate. For milestones, acknowledge the achievement.

RESPOND WITH VALID JSON ONLY. No markdown, no explanation outside JSON:
{
  "should_tip": true | false,
  "amount": 0.00,
  "token": "USDT | XAUT | BTC",
  "message": "string (max 120 chars)",
  "trigger_used": "watch_50 | watch_100 | like | comment | pool_release",
  "reasoning": "string (one sentence, for debug log only)"
}`;

const DEFAULT_RULES = {
  autoTipEnabled: true,
  watch_50_amount: 0.01,
  watch_100_amount: 0.01,
  like_amount: 0.01,
  comment_amount: 0.01,
  monthly_cap: 5,
  token: "USDT",
  network: "polygon",
  min_video_seconds: 60,
};

const sessionState = {
  tipped50: false,
  tipped100: false,
  tippedLike: false,
  tippedComment: false,
  tipsThisSession: 0,
  currentCreatorId: null,
  latestCreatorStats: {},
  recentFailedTips: {},
  recentUnresolvedToasts: {},
};

const FAILED_TIP_COOLDOWN_MS = 90_000;
const UNRESOLVED_TOAST_COOLDOWN_MS = 45_000;
const LOCAL_TIP_HISTORY_KEY = "localTipHistory";
const LOCAL_TIP_HISTORY_LIMIT = 120;

function buildFailedTipKey({ creatorId, token, network, triggerType }) {
  return [
    String(creatorId || "").trim(),
    normalizeToken(token),
    normalizeNetwork(network),
    String(triggerType || "").trim(),
  ].join("|");
}

function getRecentFailedTip({ creatorId, token, network, triggerType }) {
  const key = buildFailedTipKey({ creatorId, token, network, triggerType });
  const entry = sessionState.recentFailedTips[key];
  if (!entry) {
    return null;
  }

  const ageMs = Date.now() - Number(entry.at || 0);
  if (ageMs >= FAILED_TIP_COOLDOWN_MS) {
    delete sessionState.recentFailedTips[key];
    return null;
  }

  return {
    ...entry,
    ageMs,
    remainingMs: Math.max(0, FAILED_TIP_COOLDOWN_MS - ageMs),
  };
}

function markRecentFailedTip({
  creatorId,
  token,
  network,
  triggerType,
  error,
  recipientSource,
}) {
  const key = buildFailedTipKey({ creatorId, token, network, triggerType });
  sessionState.recentFailedTips[key] = {
    at: Date.now(),
    error: String(error || "unknown_wallet_error"),
    recipientSource: String(recipientSource || "unknown"),
  };
}

function buildUnresolvedToastKey({ creatorId, token, network, reason }) {
  return [
    String(creatorId || "").trim(),
    normalizeToken(token),
    normalizeNetwork(network),
    String(reason || "").trim(),
  ].join("|");
}

function shouldShowUnresolvedToast({ creatorId, token, network, reason }) {
  const key = buildUnresolvedToastKey({ creatorId, token, network, reason });
  const lastAt = Number(sessionState.recentUnresolvedToasts[key] || 0);
  const ageMs = Date.now() - lastAt;

  if (lastAt && ageMs < UNRESOLVED_TOAST_COOLDOWN_MS) {
    return false;
  }

  sessionState.recentUnresolvedToasts[key] = Date.now();
  return true;
}

function logRecipientTelemetry(event, details = {}) {
  try {
    console.log("[TIPSY][recipient]", event, details);
  } catch {
    // no-op
  }
}

async function persistLocalTipHistory(entry) {
  const amount = Number(entry?.amount || 0);
  const recipient = String(entry?.recipient || "").trim();
  if (!Number.isFinite(amount) || amount <= 0 || !recipient) {
    return;
  }

  const payload = {
    creatorId: String(entry?.creatorId || "").trim(),
    creatorName: String(entry?.creatorName || "Unknown creator").trim(),
    amount,
    token: String(entry?.token || "USDT")
      .trim()
      .toUpperCase(),
    network: String(entry?.network || "polygon")
      .trim()
      .toLowerCase(),
    recipient,
    txHash: String(entry?.txHash || "").trim(),
    tippedAt: String(entry?.tippedAt || new Date().toISOString()),
    triggerType: String(entry?.triggerType || "watch_50").trim(),
  };

  const stored = await chrome.storage.local.get([LOCAL_TIP_HISTORY_KEY]);
  const current = Array.isArray(stored?.[LOCAL_TIP_HISTORY_KEY])
    ? stored[LOCAL_TIP_HISTORY_KEY]
    : [];

  const next = [payload, ...current].slice(0, LOCAL_TIP_HISTORY_LIMIT);
  await chrome.storage.local.set({ [LOCAL_TIP_HISTORY_KEY]: next });
}

function sendAgentStatus(status, detail = "") {
  chrome.runtime
    .sendMessage({
      type: "AGENT_STATUS",
      payload: {
        status,
        detail,
        at: new Date().toISOString(),
      },
    })
    .catch(() => {});
}

function normalizeCreatorKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  let path = raw;

  try {
    const parsed = new URL(raw, "https://rumble.com");
    path = parsed.pathname || "";
  } catch {
    path = raw;
  }

  path = path.split("?")[0].split("#")[0].trim();
  path = path.replace(/^https?:\/\/[^/]+/i, "");
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");

  if (path.startsWith("@")) {
    path = path.slice(1);
  }

  if (path.toLowerCase().startsWith("c/")) {
    path = path.slice(2);
  } else if (path.toLowerCase().startsWith("user/")) {
    path = path.slice(5);
  }

  return decodeURIComponent(path).trim().toLowerCase();
}

function buildCreatorLookupKeys(creatorId, creatorUrl) {
  const keys = [
    normalizeCreatorKey(creatorId),
    normalizeCreatorKey(creatorUrl),
    String(creatorId || "").trim(),
    String(creatorUrl || "").trim(),
  ].filter(Boolean);

  return [...new Set(keys)];
}

async function persistResolverDiagnostic(event, details = {}) {
  logRecipientTelemetry(event, details);
  await logResolverDiagnostic({
    event,
    ...details,
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("pollPools", { periodInMinutes: 1 });
  await initializeWalletFromStorage().catch(() => null);

  const legacy = await chrome.storage.sync.get(["walletAddress"]);
  if (legacy?.walletAddress) {
    await chrome.storage.sync.remove(["walletAddress"]);
  }

  const existing = await chrome.storage.sync.get("rules");
  if (!existing.rules) {
    await chrome.storage.sync.set({ rules: DEFAULT_RULES });
    return;
  }

  if (!existing.rules.network) {
    await chrome.storage.sync.set({
      rules: { ...existing.rules, network: "polygon" },
    });
  }
});

initializeWalletFromStorage().catch(() => null);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "pollPools") {
    return;
  }

  const pools = await getActivePools();
  const readySignals = await getReadyAdminSignals();
  const readySignalByPool = new Map();
  const readySignalByCreator = new Map();

  for (const signal of readySignals) {
    const poolId = normalizePoolId(signal.pool_id);
    if (poolId) {
      readySignalByPool.set(poolId, signal);
    }

    const creatorId = String(signal.creator_id || "").trim();
    if (creatorId) {
      readySignalByCreator.set(creatorId, signal);
    }
  }

  for (const pool of pools) {
    const creatorStats = sessionState.latestCreatorStats[pool.creator_id] || {};
    const normalizedPoolId = normalizePoolId(pool._id);
    const readySignal =
      readySignalByPool.get(normalizedPoolId) ||
      readySignalByCreator.get(String(pool.creator_id || "").trim());
    const goalMet =
      pool.goal_type === "manual"
        ? Boolean(pool.manual_goal_met || readySignal)
        : Number(creatorStats.subscriberCount || 0) >=
          Number(pool.goal_value || 0);

    if (!goalMet) {
      continue;
    }

    await markPoolTriggered(pool._id);
    if (readySignal?._id) {
      await markAdminSignalConsumed(readySignal._id);
    }

    chrome.runtime
      .sendMessage({
        type: "POOL_MILESTONE_REACHED",
        payload: {
          poolId: normalizePoolId(pool._id),
          creatorId: pool.creator_id,
          creatorName: pool.creator_name,
          goalType: pool.goal_type,
          goalValue: pool.goal_value,
          balanceTracked: Number(pool.balance_usdt || 0),
        },
      })
      .catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message || {};

  if (type === "CONTENT_HEARTBEAT") {
    logRecipientTelemetry("content_heartbeat", {
      tabId: sender?.tab?.id,
      reason: payload?.reason,
      hasVideo: payload?.hasVideo,
      href: payload?.href,
      duration: payload?.duration,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (type === "WATCH_TICK" || type === "REACTION") {
    logRecipientTelemetry("trigger_received", {
      type,
      tabId: sender?.tab?.id,
      creatorId: payload?.creatorId,
      watchPercent: payload?.watchPercent,
      reactionType: payload?.reactionType,
      hasCreatorAddress: Boolean(payload?.creatorAddress),
      candidateCount: Array.isArray(payload?.creatorAddressCandidates)
        ? payload.creatorAddressCandidates.length
        : 0,
    });

    handleTipTrigger(type, payload, sender)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("[TIPSY] trigger handling failed", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (type === "CREATOR_STATS") {
    const creatorId = payload?.creatorId;
    if (creatorId) {
      sessionState.latestCreatorStats[creatorId] = {
        subscriberCount: payload.subscriberCount || 0,
        updatedAt: Date.now(),
      };
    }
    sendResponse({ ok: true });
    return true;
  }

  if (type === "OPEN_POPUP") {
    chrome.action.openPopup().catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (type === "GENERATE_SEED") {
    generateSeedPhrase()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "VALIDATE_SEED") {
    const result = validateSeedPhrase(payload?.seedPhrase || "");
    sendResponse({ ok: true, ...result });
    return true;
  }

  if (type === "INIT_WALLET") {
    initializeWallet(payload?.seedPhrase || "", payload?.networks)
      .then((result) =>
        sendResponse({ ok: Boolean(result?.success), ...result }),
      )
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "GET_WALLET_STATUS") {
    getWalletStatus()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "OPEN_TIP_MODAL") {
    openTipModalOnActiveTab()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "GET_POPUP_STATE") {
    getPopupState(payload?.wallet).then((state) =>
      sendResponse({ ok: true, state }),
    );
    return true;
  }

  if (type === "GET_AGENTIC_INSIGHTS") {
    getAgenticInsights(payload?.wallet)
      .then((result) => sendResponse({ ok: true, insights: result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (type === "CONTRIBUTE_POOL") {
    handlePoolContribution(payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("[TIPSY] contribute pool failed", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (type === "DEMO_MILESTONE") {
    handleDemoMilestone(payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("[TIPSY] demo milestone failed", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});

async function sendTipPageToast(sender, payload) {
  const message = {
    type: "TIP_PAGE_TOAST",
    payload,
  };

  const tabId = sender?.tab?.id;
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      logRecipientTelemetry("toast_sent_to_sender_tab", {
        tabId,
        status: payload?.status,
      });
      return;
    } catch (error) {
      logRecipientTelemetry("toast_sender_tab_failed", {
        tabId,
        status: payload?.status,
        error: String(error?.message || error),
      });
    }
  }

  try {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
      url: ["*://rumble.com/*", "*://*.rumble.com/*"],
    });

    if (!activeTab?.id) {
      logRecipientTelemetry("toast_no_target_tab", {
        status: payload?.status,
      });
      return;
    }

    await chrome.tabs.sendMessage(activeTab.id, message);
    logRecipientTelemetry("toast_sent_to_active_tab", {
      tabId: activeTab.id,
      status: payload?.status,
    });
  } catch (error) {
    logRecipientTelemetry("toast_active_tab_failed", {
      status: payload?.status,
      error: String(error?.message || error),
    });
  }
}

async function handleTipTrigger(type, payload, sender) {
  const creatorId = payload?.creatorId || "unknown_creator";
  logRecipientTelemetry("trigger_processing", {
    type,
    creatorId,
    watchPercent: payload?.watchPercent,
    reactionType: payload?.reactionType,
  });

  if (sessionState.currentCreatorId !== creatorId) {
    resetSessionForCreator(creatorId);
  }

  const existingSession = await chrome.storage.session.get("currentVideo");
  const existingLastTip = existingSession.currentVideo?.lastTip || null;
  await chrome.storage.session.set({
    currentVideo: {
      title: payload?.videoTitle || "",
      creatorName: payload?.creatorName || "",
      watchPercent: Math.round(payload?.watchPercent || 0),
      lastTip: existingLastTip,
      recipientStatus: "pending",
      recipientReason: "waiting_for_tip_decision",
    },
  });

  const { rules = DEFAULT_RULES } = await chrome.storage.sync.get(["rules"]);
  const walletStatus = await getWalletStatus().catch(() => ({}));
  const walletAddress =
    walletStatus?.addresses?.ethereum ||
    walletStatus?.addresses?.bitcoin ||
    "demo_wallet";

  const monthlySpend = await getMonthlySpend(walletAddress);
  const context = buildAgentContext(type, payload, rules, monthlySpend);
  const localFallbackDecision = localDecision(context);
  let decision = await callTipsyAgent(context);

  if (!decision?.should_tip && localFallbackDecision?.should_tip) {
    logRecipientTelemetry("decision_overridden_by_local_fallback", {
      creatorId,
      triggerType: context.trigger_type,
      watchPercent: context.watch_percent,
      localTrigger: localFallbackDecision.trigger_used,
      localAmount: localFallbackDecision.amount,
      localReasoning: localFallbackDecision.reasoning,
    });
    decision = localFallbackDecision;
  }

  logRecipientTelemetry("decision_result", {
    creatorId,
    shouldTip: Boolean(decision?.should_tip),
    triggerUsed: decision?.trigger_used,
    amount: decision?.amount,
    token: decision?.token,
    reasoning: decision?.reasoning,
    triggerType: context.trigger_type,
    watchPercent: context.watch_percent,
    minVideoSeconds: context.user_rules?.min_video_seconds,
    videoDurationSeconds: context.video_duration_seconds,
    already50: context.already_tipped_at_50,
    already100: context.already_tipped_at_100,
    alreadyLike: context.already_tipped_for_like,
    alreadyComment: context.already_tipped_for_comment,
    remainingBudget:
      Number(context.user_rules?.monthly_cap || 0) -
      Number(context.budget_used_this_month || 0),
    localFallbackWouldTip: Boolean(localFallbackDecision?.should_tip),
    localFallbackTrigger: localFallbackDecision?.trigger_used,
  });

  if (!decision?.should_tip) {
    return { ok: true, decision };
  }

  const tip = {
    user_wallet_address: walletAddress,
    creator_id: creatorId,
    amount_usdt: Number(decision.amount),
    token_type: decision.token,
    trigger_type: decision.trigger_used,
    message: decision.message,
    tx_hash: "",
    tipped_at: new Date().toISOString(),
    creator_name: payload?.creatorName || "Unknown creator",
    creator_key: normalizeCreatorKey(payload?.creatorUrl || creatorId),
  };

  const recentFailure = getRecentFailedTip({
    creatorId,
    token: tip.token_type,
    network: rules.network || "polygon",
    triggerType: tip.trigger_type,
  });

  if (recentFailure) {
    logRecipientTelemetry("tip_retry_cooldown_active", {
      creatorId,
      token: tip.token_type,
      triggerType: tip.trigger_type,
      remainingMs: recentFailure.remainingMs,
      lastError: recentFailure.error,
    });

    await chrome.storage.session.set({
      currentVideo: {
        title: payload?.videoTitle || "",
        creatorName: payload?.creatorName || "",
        watchPercent: Math.round(payload?.watchPercent || 0),
        lastTip: existingLastTip,
        recipientStatus: "failed",
        recipientReason: "wallet_transfer_cooldown",
      },
    });

    await sendTipPageToast(sender, {
      status: "cooldown",
      creator_name: tip.creator_name,
      token_type: tip.token_type,
      trigger_type: tip.trigger_type,
      error: recentFailure.error,
      reason: "wallet_transfer_cooldown",
    });

    return {
      ok: true,
      tipped: false,
      skipped: true,
      reason: "wallet_transfer_cooldown",
      lastError: recentFailure.error,
    };
  }

  const recipientResolution = await resolveRecipientForTip({
    creatorId,
    token: tip.token_type,
    network: rules.network || "polygon",
    directAddress: payload?.creatorAddress,
    addressCandidates: payload?.creatorAddressCandidates,
    creatorUrl: payload?.creatorUrl,
  });

  if (recipientResolution.status !== "resolved") {
    await persistResolverDiagnostic("skip_tip_unresolved", {
      creatorId,
      creatorKey: normalizeCreatorKey(payload?.creatorUrl || creatorId),
      token: tip.token_type,
      network: rules.network || "polygon",
      status: recipientResolution.status,
      reason: recipientResolution.reason,
      triggerType: tip.trigger_type,
      videoTitle: payload?.videoTitle || "",
    });

    await chrome.storage.session.set({
      currentVideo: {
        title: payload?.videoTitle || "",
        creatorName: payload?.creatorName || "",
        watchPercent: Math.round(payload?.watchPercent || 0),
        lastTip: existingLastTip,
        recipientStatus: recipientResolution.status,
        recipientReason: recipientResolution.reason,
      },
    });

    chrome.runtime
      .sendMessage({
        type: "TIP_RESULT",
        payload: {
          status: "skipped",
          reason: recipientResolution.reason,
          creator_id: creatorId,
          creator_name: payload?.creatorName || "Unknown creator",
          token_type: tip.token_type,
          trigger_type: tip.trigger_type,
        },
      })
      .catch(() => {});

    if (
      shouldShowUnresolvedToast({
        creatorId,
        token: tip.token_type,
        network: rules.network || "polygon",
        reason: recipientResolution.reason,
      })
    ) {
      await sendTipPageToast(sender, {
        status: "unresolved",
        reason: recipientResolution.reason,
        creator_name: payload?.creatorName || "Unknown creator",
        token_type: tip.token_type,
        trigger_type: tip.trigger_type,
        error:
          recipientResolution.reason === "no_valid_recipient"
            ? "Creator has no visible wallet address for this token/network yet."
            : `Recipient unresolved: ${recipientResolution.reason || "unknown"}`,
      });
    }

    return {
      ok: true,
      tipped: false,
      skipped: true,
      reason: recipientResolution.reason,
      resolution: recipientResolution,
    };
  }

  const tx = await executeWDKTip(
    recipientResolution.recipient,
    tip.amount_usdt,
    tip.token_type,
    tip.message,
    { network: rules.network || "polygon" },
  );
  if (!tx.success) {
    if (String(tx?.reason || "") === "tx_already_known") {
      const pendingMessage = String(
        tx?.error ||
          "Transaction already submitted to the network. Waiting for confirmation.",
      );

      logRecipientTelemetry("tip_transfer_pending_duplicate", {
        creatorId,
        token: tip.token_type,
        recipientSource: recipientResolution.source,
        network: rules.network || "polygon",
        triggerType: tip.trigger_type,
        reason: "tx_already_known",
      });

      await chrome.storage.session.set({
        currentVideo: {
          title: payload?.videoTitle || "",
          creatorName: payload?.creatorName || "",
          watchPercent: Math.round(payload?.watchPercent || 0),
          lastTip: existingLastTip,
          recipientStatus: "pending",
          recipientReason: "tx_already_known",
        },
      });

      chrome.runtime
        .sendMessage({
          type: "TIP_RESULT",
          payload: {
            status: "pending",
            reason: "tx_already_known",
            error: pendingMessage,
            creator_id: creatorId,
            creator_name: tip.creator_name,
            amount_usdt: tip.amount_usdt,
            token_type: tip.token_type,
            trigger_type: tip.trigger_type,
          },
        })
        .catch(() => {});

      await sendTipPageToast(sender, {
        status: "pending",
        creator_name: tip.creator_name,
        token_type: tip.token_type,
        trigger_type: tip.trigger_type,
        amount_usdt: tip.amount_usdt,
        error: pendingMessage,
        reason: "tx_already_known",
      });

      return {
        ok: true,
        tipped: false,
        pending: true,
        reason: "tx_already_known",
      };
    }

    const transferError = String(tx?.error || "WDK tip failed");

    logRecipientTelemetry("tip_transfer_failed", {
      creatorId,
      token: tip.token_type,
      recipientSource: recipientResolution.source,
      network: rules.network || "polygon",
      triggerType: tip.trigger_type,
      error: transferError,
    });

    markRecentFailedTip({
      creatorId,
      token: tip.token_type,
      network: rules.network || "polygon",
      triggerType: tip.trigger_type,
      error: transferError,
      recipientSource: recipientResolution.source,
    });

    await chrome.storage.session.set({
      currentVideo: {
        title: payload?.videoTitle || "",
        creatorName: payload?.creatorName || "",
        watchPercent: Math.round(payload?.watchPercent || 0),
        lastTip: existingLastTip,
        recipientStatus: "failed",
        recipientReason: "wallet_transfer_failed",
      },
    });

    chrome.runtime
      .sendMessage({
        type: "TIP_RESULT",
        payload: {
          status: "failed",
          reason: "wallet_transfer_failed",
          error: transferError,
          creator_id: creatorId,
          creator_name: tip.creator_name,
          amount_usdt: tip.amount_usdt,
          token_type: tip.token_type,
          trigger_type: tip.trigger_type,
        },
      })
      .catch(() => {});

    await sendTipPageToast(sender, {
      status: "failed",
      creator_name: tip.creator_name,
      token_type: tip.token_type,
      trigger_type: tip.trigger_type,
      amount_usdt: tip.amount_usdt,
      error: transferError,
      reason: "wallet_transfer_failed",
    });

    return { ok: false, error: transferError };
  }

  tip.tx_hash = tx.txHash;
  logRecipientTelemetry("tip_confirmed", {
    creatorId,
    token: tip.token_type,
    recipientSource: recipientResolution.source,
    txHash: tx.txHash,
  });

  await logTip(tip);
  await persistLocalTipHistory({
    creatorId,
    creatorName: tip.creator_name,
    amount: tip.amount_usdt,
    token: tip.token_type,
    network: rules.network || "polygon",
    recipient: recipientResolution.recipient,
    txHash: tip.tx_hash,
    tippedAt: tip.tipped_at,
    triggerType: tip.trigger_type,
  });
  updateFlagsFromTrigger(decision.trigger_used);

  await chrome.storage.session.set({
    currentVideo: {
      title: payload?.videoTitle || "",
      creatorName: payload?.creatorName || "",
      watchPercent: Math.round(payload?.watchPercent || 0),
      lastTip: {
        amount: tip.amount_usdt,
        token: tip.token_type,
        message: tip.message,
        trigger: tip.trigger_type,
        at: tip.tipped_at,
        recipient: recipientResolution.recipient,
        network: rules.network || "polygon",
      },
      recipientStatus: "resolved",
      recipientReason: `resolved_via_${recipientResolution.source}`,
    },
  });

  chrome.runtime
    .sendMessage({
      type: "TIP_RESULT",
      payload: {
        status: "confirmed",
        reason: "tip_confirmed",
        source: recipientResolution.source,
        creator_id: creatorId,
        creator_name: tip.creator_name,
        amount_usdt: tip.amount_usdt,
        token_type: tip.token_type,
        trigger_type: tip.trigger_type,
        tx_hash: tip.tx_hash,
      },
    })
    .catch(() => {});

  await sendTipPageToast(sender, {
    status: "confirmed",
    creator_name: tip.creator_name,
    token_type: tip.token_type,
    trigger_type: tip.trigger_type,
    amount_usdt: tip.amount_usdt,
    tx_hash: tip.tx_hash,
  });

  chrome.runtime
    .sendMessage({ type: "TIP_SENT", payload: tip })
    .catch(() => {});
  return { ok: true, tipped: true, tip };
}

async function openTipModalOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: "No active tab" };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "OPEN_TIP_MODAL",
    });
    if (!response?.ok) {
      return {
        ok: false,
        error: response?.error || "Unable to open tip modal",
      };
    }

    return { ok: true, opened: Boolean(response.opened) };
  } catch (error) {
    return { ok: false, error: error.message || "Unable to reach content" };
  }
}

function resetSessionForCreator(creatorId) {
  sessionState.currentCreatorId = creatorId;
  sessionState.tipped50 = false;
  sessionState.tipped100 = false;
  sessionState.tippedLike = false;
  sessionState.tippedComment = false;
  sessionState.tipsThisSession = 0;
  sessionState.recentFailedTips = {};
  sessionState.recentUnresolvedToasts = {};
}

function updateFlagsFromTrigger(trigger) {
  if (trigger === "watch_50") sessionState.tipped50 = true;
  if (trigger === "watch_100") sessionState.tipped100 = true;
  if (trigger === "like") sessionState.tippedLike = true;
  if (trigger === "comment") sessionState.tippedComment = true;
  sessionState.tipsThisSession += 1;
}

function buildAgentContext(type, payload, rules, monthlySpend) {
  return {
    trigger_type: type === "WATCH_TICK" ? "watch_time" : payload?.reactionType,
    watch_percent: Number(payload?.watchPercent || 0),
    video_title: payload?.videoTitle || "",
    video_category: payload?.videoCategory || "general",
    creator_name: payload?.creatorName || "",
    creator_id: payload?.creatorId || "",
    video_duration_seconds: Number(payload?.durationSeconds || 0),
    reactions_this_session: {
      likes: sessionState.tippedLike ? 1 : 0,
      comments: sessionState.tippedComment ? 1 : 0,
    },
    user_rules: {
      watch_50_amount: Number(rules.watch_50_amount),
      watch_100_amount: Number(rules.watch_100_amount),
      like_amount: Number(rules.like_amount),
      comment_amount: Number(rules.comment_amount),
      monthly_cap: Number(rules.monthly_cap),
      token: rules.token || "USDT",
      network: rules.network || "polygon",
      min_video_seconds: Number(rules.min_video_seconds || 60),
    },
    budget_used_this_month: Number(monthlySpend),
    tips_sent_this_session: sessionState.tipsThisSession,
    already_tipped_at_50: sessionState.tipped50,
    already_tipped_at_100: sessionState.tipped100,
    already_tipped_for_like: sessionState.tippedLike,
    already_tipped_for_comment: sessionState.tippedComment,
    pool_balance: 0,
    pool_goal_met: false,
    creator_milestone: null,
  };
}

function localDecision(context) {
  const remaining =
    context.user_rules.monthly_cap - context.budget_used_this_month;

  logRecipientTelemetry("local_decision_debug", {
    creatorId: context.creator_id,
    triggerType: context.trigger_type,
    remaining,
    budget: context.user_rules.monthly_cap,
    spent: context.budget_used_this_month,
    watchPercent: context.watch_percent,
    videoDuration: context.video_duration_seconds,
    minVideoDuration: context.user_rules.min_video_seconds,
    alreadyTipped50: context.already_tipped_at_50,
    alreadyTipped100: context.already_tipped_at_100,
    alreadyLike: context.already_tipped_for_like,
    alreadyComment: context.already_tipped_for_comment,
  });

  if (remaining <= 0 || !context.user_rules) {
    logRecipientTelemetry("local_decision_blocked", {
      reason: "no_budget_or_no_rules",
      remaining,
      hasRules: Boolean(context.user_rules),
    });
    return {
      should_tip: false,
      amount: 0,
      token: context.user_rules?.token,
      message: "",
      trigger_used: "",
      reasoning: "Budget reached or no rules",
    };
  }

  if (context.trigger_type === "watch_time") {
    // **TESTING MODE**: Temporarily removed video duration check to unblock testing
    // TODO: Re-enable after confirming basic tip flow works
    if (!context.already_tipped_at_50 && context.watch_percent >= 50) {
      logRecipientTelemetry("local_decision_approved", {
        trigger: "watch_50",
        watchPercent: context.watch_percent,
      });
      return {
        should_tip: true,
        amount: Math.min(context.user_rules.watch_50_amount, remaining),
        token: context.user_rules.token,
        message: `Halfway through \"${context.video_title}\" — loving this so far!`,
        trigger_used: "watch_50",
        reasoning: "Reached 50% watch threshold",
      };
    }

    if (!context.already_tipped_at_100 && context.watch_percent >= 95) {
      logRecipientTelemetry("local_decision_approved", {
        trigger: "watch_100",
        watchPercent: context.watch_percent,
      });
      return {
        should_tip: true,
        amount: Math.min(context.user_rules.watch_100_amount, remaining),
        token: context.user_rules.token,
        message: `Finished \"${context.video_title}\" — fantastic watch!`,
        trigger_used: "watch_100",
        reasoning: "Reached completion threshold",
      };
    }
  }

  if (context.trigger_type === "like" && !context.already_tipped_for_like) {
    return {
      should_tip: true,
      amount: Math.min(context.user_rules.like_amount, remaining),
      token: context.user_rules.token,
      message: `Had to like this one — great take from ${context.creator_name}.`,
      trigger_used: "like",
      reasoning: "Like trigger unused",
    };
  }

  if (
    context.trigger_type === "comment" &&
    !context.already_tipped_for_comment
  ) {
    return {
      should_tip: true,
      amount: Math.min(context.user_rules.comment_amount, remaining),
      token: context.user_rules.token,
      message: `Just commented on ${context.video_title} — super insightful content.`,
      trigger_used: "comment",
      reasoning: "Comment trigger unused",
    };
  }

  if (
    context.trigger_type === "milestone" &&
    context.pool_goal_met &&
    context.pool_balance > 0
  ) {
    return {
      should_tip: true,
      amount: context.pool_balance,
      token: "USDT",
      message: `Milestone unlocked for ${context.creator_name} — congrats on the achievement!`,
      trigger_used: "pool_release",
      reasoning: "Pool goal met",
    };
  }

  return {
    should_tip: false,
    amount: 0,
    token: context.user_rules.token,
    message: "",
    trigger_used: "",
    reasoning: "No eligible trigger",
  };
}

// Analyze tip history to build creator preference profile
async function buildCreatorProfile() {
  try {
    const stored = await chrome.storage.local.get([LOCAL_TIP_HISTORY_KEY]);
    const history = Array.isArray(stored?.[LOCAL_TIP_HISTORY_KEY])
      ? stored[LOCAL_TIP_HISTORY_KEY]
      : [];

    if (history.length === 0) {
      return {
        favorite_creators: [],
        average_tip_amount: 0.01,
        creator_tier_map: {},
        total_tips_sent: 0,
        top_categories: [],
        is_profile_empty: true,
      };
    }

    const creatorStats = {};
    let totalAmount = 0;

    for (const entry of history) {
      const creatorId = entry.creatorId || "unknown";
      const amount = Number(entry.amount || 0);

      if (!creatorStats[creatorId]) {
        creatorStats[creatorId] = {
          creatorId,
          creatorName: entry.creatorName || "Unknown",
          tipCount: 0,
          totalAmount: 0,
        };
      }

      creatorStats[creatorId].tipCount += 1;
      creatorStats[creatorId].totalAmount += amount;
      totalAmount += amount;
    }

    const rankedCreators = Object.values(creatorStats)
      .sort((a, b) => {
        const aScore = a.tipCount * 10 + a.totalAmount;
        const bScore = b.tipCount * 10 + b.totalAmount;
        return bScore - aScore;
      })
      .slice(0, 5);

    const avgTipAmount = totalAmount / history.length;
    const creatorTierMap = {};

    rankedCreators.forEach((creator, index) => {
      if (index === 0) creatorTierMap[creator.creatorId] = "favorite";
      else if (index <= 2) creatorTierMap[creator.creatorId] = "frequent";
      else creatorTierMap[creator.creatorId] = "occasional";
    });

    return {
      favorite_creators: rankedCreators.map((c) => ({
        name: c.creatorName,
        id: c.creatorId,
        tip_count: c.tipCount,
        total_amount: c.totalAmount.toFixed(2),
      })),
      average_tip_amount: avgTipAmount.toFixed(4),
      creator_tier_map: creatorTierMap,
      total_tips_sent: history.length,
      is_profile_empty: false,
    };
  } catch (err) {
    console.error("[TIPSY] buildCreatorProfile error:", err);
    return {
      favorite_creators: [],
      average_tip_amount: 0.01,
      creator_tier_map: {},
      total_tips_sent: 0,
      is_profile_empty: true,
    };
  }
}

async function callTipsyAgent(context) {
  if (!GEMINI_API_KEY) {
    sendAgentStatus("local_only", "missing_api_key");
    return localDecision(context);
  }

  const creatorProfile = await buildCreatorProfile();
  const enrichedContext = {
    ...context,
    creator_profile: creatorProfile,
  };
  logRecipientTelemetry("creator_profile_built", {
    creatorId: context.creator_id,
    profileSize: creatorProfile.total_tips_sent,
    hasFavorites: creatorProfile.favorite_creators.length > 0,
  });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify(enrichedContext) }],
            },
          ],
          generation_config: { temperature: 0.3 },
        }),
      });

      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        throw new Error("empty_agent_response");
      }

      const decision = JSON.parse(raw.replace(/```json|```/g, "").trim());
      console.log("[TIPSY] agent reasoning:", decision.reasoning);
      if (attempt > 0) {
        sendAgentStatus("recovered", "retry_success");
      }
      return decision;
    } catch (error) {
      if (attempt === 0) {
        sendAgentStatus("retrying", "gemini_retry_once");
        continue;
      }

      sendAgentStatus("fallback", "gemini_unavailable_local_rules");
      console.warn(
        "[TIPSY] Gemini unavailable, fallback local decision",
        error,
      );
      return localDecision(context);
    }
  }

  sendAgentStatus("fallback", "gemini_unavailable_local_rules");
  return localDecision(context);
}

async function getPopupState(wallet) {
  const [
    session,
    rulesData,
    walletData,
    localData,
    history,
    pools,
    walletStatus,
  ] = await Promise.all([
    chrome.storage.session.get("currentVideo"),
    chrome.storage.sync.get(["rules"]),
    chrome.storage.sync.get(["creatorPayoutMap"]),
    chrome.storage.local.get(["poolContributions", LOCAL_TIP_HISTORY_KEY]),
    getTipHistory(wallet || "demo_wallet"),
    getActivePools(),
    getWalletStatus().catch(() => ({ initialized: false, hasSeed: false })),
  ]);

  const derivedWalletAddress =
    walletStatus?.addresses?.ethereum ||
    walletStatus?.addresses?.bitcoin ||
    "demo_wallet";
  const walletAddress = wallet || derivedWalletAddress;
  const poolContributions = localData.poolContributions || {};
  const localTipHistory = Array.isArray(localData?.[LOCAL_TIP_HISTORY_KEY])
    ? localData[LOCAL_TIP_HISTORY_KEY]
    : [];
  const userContributions = {};

  for (const [key, value] of Object.entries(poolContributions)) {
    const [walletKey, poolId] = key.split(":");
    if (walletKey === walletAddress && poolId) {
      userContributions[poolId] = Number(value || 0);
    }
  }

  return {
    currentVideo: session.currentVideo || null,
    rules: rulesData.rules || DEFAULT_RULES,
    walletAddress,
    walletConfig: {
      creatorPayoutMap: walletData.creatorPayoutMap || {},
    },
    walletStatus,
    history,
    localTipHistory,
    pools,
    userContributions,
    sessionState,
  };
}

function normalizePoolId(poolId) {
  if (!poolId) {
    return "";
  }

  if (typeof poolId === "string") {
    return poolId;
  }

  if (typeof poolId === "object" && poolId.$oid) {
    return String(poolId.$oid);
  }

  return "";
}

async function handlePoolContribution(payload) {
  const poolId = normalizePoolId(payload?.poolId);
  const amount = Number(payload?.amount || 0);
  if (!poolId || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Invalid pool contribution payload" };
  }

  const [{ rules = DEFAULT_RULES }, pools, walletStatus] = await Promise.all([
    chrome.storage.sync.get(["rules"]),
    getActivePools(),
    getWalletStatus().catch(() => ({})),
  ]);

  const walletAddress =
    walletStatus?.addresses?.ethereum ||
    walletStatus?.addresses?.bitcoin ||
    "demo_wallet";

  const targetPool = pools.find((pool) => normalizePoolId(pool._id) === poolId);
  if (!targetPool) {
    return { ok: false, error: "Pool not found" };
  }

  const token = rules.token || "USDT";
  const recipientResolution = await resolveRecipientForTip({
    creatorId: targetPool.creator_id || "",
    creatorUrl: targetPool.creator_url || targetPool.channel_url || "",
    token,
    network: rules.network || "polygon",
    directAddress:
      targetPool.creator_address || targetPool.payout_address || "",
    addressCandidates: Array.isArray(targetPool.address_candidates)
      ? targetPool.address_candidates
      : [],
  });

  if (recipientResolution.status !== "resolved") {
    await persistResolverDiagnostic("pool_contribution_unresolved", {
      poolId,
      creatorId: targetPool.creator_id || "",
      token,
      network: rules.network || "polygon",
      status: recipientResolution.status,
      reason: recipientResolution.reason,
      triggerType: "pool_contribution",
    });

    return {
      ok: false,
      error: `Recipient unresolved: ${recipientResolution.reason || "unknown"}`,
    };
  }

  const transfer = await executeWDKTip(
    recipientResolution.recipient,
    amount,
    token,
    `Direct support tip for ${targetPool.creator_name || "creator"}`,
    { network: rules.network || "polygon" },
  );

  if (!transfer.success) {
    return { ok: false, error: "Wallet transfer failed" };
  }

  await persistLocalTipHistory({
    creatorId: targetPool.creator_id || "",
    creatorName: targetPool.creator_name || "Creator",
    amount,
    token,
    network: rules.network || "polygon",
    recipient: recipientResolution.recipient,
    txHash: transfer.txHash || "",
    tippedAt: new Date().toISOString(),
    triggerType: "pool_contribution",
  });

  const dbResult = await contributeToPool(poolId, walletAddress, amount);
  if (!dbResult.success) {
    return { ok: false, error: dbResult.error || "Database update failed" };
  }

  const key = `${walletAddress}:${poolId}`;
  const localData = await chrome.storage.local.get(["poolContributions"]);
  const poolContributions = localData.poolContributions || {};
  poolContributions[key] = Number(poolContributions[key] || 0) + amount;
  await chrome.storage.local.set({ poolContributions });

  await logTip({
    user_wallet_address: walletAddress,
    creator_id: targetPool.creator_id || "",
    creator_name: targetPool.creator_name || "Creator",
    creator_key: normalizeCreatorKey(
      targetPool.creator_url || targetPool.channel_url || targetPool.creator_id,
    ),
    amount_usdt: Number(amount),
    token_type: token,
    trigger_type: "pool_contribution",
    message: `Direct support tip for ${targetPool.creator_name || "creator"}`,
    tx_hash: transfer.txHash || "",
    tipped_at: new Date().toISOString(),
  });

  chrome.runtime
    .sendMessage({
      type: "POOL_CONTRIBUTED",
      payload: {
        poolId,
        amount,
        token,
        recipient: recipientResolution.recipient,
        recipientSource: recipientResolution.source,
        txHash: transfer.txHash,
        userContribution: poolContributions[key],
      },
    })
    .catch(() => {});

  return {
    ok: true,
    txHash: transfer.txHash,
    userContribution: poolContributions[key],
  };
}

function localAgenticInsights(history = []) {
  const typed = Array.isArray(history) ? history : [];
  const total = typed.reduce(
    (sum, row) => sum + Number(row.amount_usdt || row.amount || 0),
    0,
  );

  const byTrigger = {};
  for (const row of typed) {
    const key = row.trigger_type || row.triggerType || "unknown";
    byTrigger[key] =
      Number(byTrigger[key] || 0) + Number(row.amount_usdt || row.amount || 0);
  }

  const topTrigger = Object.entries(byTrigger).sort((a, b) => b[1] - a[1])[0];
  const avg = typed.length ? total / typed.length : 0;

  return {
    summary: `Tracked ${typed.length} tips totaling $${total.toFixed(2)}.`,
    prediction:
      avg > 0
        ? `At current pace (~$${avg.toFixed(2)} per tip), monthly spend should stay stable if trigger rates stay similar.`
        : "Insufficient history for spend prediction yet.",
    recommendations: [
      topTrigger
        ? `Largest spend driver is ${topTrigger[0]} at $${Number(topTrigger[1]).toFixed(2)}.`
        : "Collect more tip events to identify strongest trigger.",
      "If budget pressure increases, lower watch_100 or comment tip amount first.",
    ],
    trend: {
      total,
      count: typed.length,
      averagePerTip: Number(avg.toFixed(4)),
      byTrigger,
    },
  };
}

async function getAgenticInsights(wallet) {
  const walletAddress = String(wallet || "demo_wallet");
  const remoteHistory = await getTipHistory(walletAddress);
  const localData = await chrome.storage.local.get([LOCAL_TIP_HISTORY_KEY]);
  const localHistory = Array.isArray(localData?.[LOCAL_TIP_HISTORY_KEY])
    ? localData[LOCAL_TIP_HISTORY_KEY]
    : [];

  const history = localHistory.length ? localHistory : remoteHistory;
  const fallback = localAgenticInsights(history);

  if (!GEMINI_API_KEY) {
    return { ...fallback, source: "local" };
  }

  const prompt = {
    role: "user",
    parts: [
      {
        text: JSON.stringify({
          instruction:
            "Analyze this tipping history and return concise JSON with summary, prediction, recommendations (max 3), and trend object. No markdown.",
          history,
        }),
      },
    ],
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [prompt],
          generation_config: { temperature: 0.2 },
        }),
      },
    );

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      return { ...fallback, source: "local" };
    }

    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return {
      summary: String(parsed.summary || fallback.summary),
      prediction: String(parsed.prediction || fallback.prediction),
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 3)
        : fallback.recommendations,
      trend:
        parsed.trend && typeof parsed.trend === "object"
          ? parsed.trend
          : fallback.trend,
      source: localHistory.length ? "local+gemini" : "gemini",
    };
  } catch {
    return {
      ...fallback,
      source: localHistory.length ? "local" : "remote_local",
    };
  }
}

async function handleDemoMilestone(payload) {
  const creatorId = payload?.creatorId || "demo_creator";
  const creatorName = payload?.creatorName || "Demo Creator";

  chrome.runtime
    .sendMessage({
      type: "POOL_MILESTONE_REACHED",
      payload: {
        poolId: payload?.poolId || "demo_pool",
        creatorId,
        creatorName,
        goalType: "demo_mode",
        goalValue: "simulated",
        balanceTracked: Number(payload?.poolBalance || 0),
      },
    })
    .catch(() => {});

  chrome.runtime
    .sendMessage({
      type: "TIP_RESULT",
      payload: {
        status: "skipped",
        reason: "tracking_only_direct_mode",
        creator_id: creatorId,
        creator_name: creatorName,
        trigger_type: "pool_release",
      },
    })
    .catch(() => {});
  return {
    ok: true,
    tipped: false,
    skipped: true,
    reason: "tracking_only_direct_mode",
  };
}

function normalizeToken(token) {
  return String(token || "USDT")
    .trim()
    .toUpperCase();
}

function normalizeNetwork(network) {
  return String(network || "polygon")
    .trim()
    .toLowerCase();
}

function looksLikeEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || "").trim());
}

function looksLikeBtcAddress(value) {
  return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(
    String(value || "").trim(),
  );
}

function isAddressValidForToken(token, address) {
  const tokenUpper = normalizeToken(token);
  if (tokenUpper === "BTC") {
    return looksLikeBtcAddress(address);
  }

  return looksLikeEvmAddress(address);
}

function toAddressCandidate(candidate, defaultSource = "unknown") {
  if (!candidate) {
    return null;
  }

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return {
      address: trimmed,
      token: "",
      network: "",
      source: defaultSource,
    };
  }

  if (typeof candidate === "object") {
    const address = String(
      candidate.address || candidate.value || candidate.recipient || "",
    ).trim();
    if (!address) {
      return null;
    }

    return {
      address,
      token: normalizeToken(candidate.token || candidate.currency || ""),
      network: normalizeNetwork(
        candidate.network || candidate.blockchain || "",
      ),
      source: String(candidate.source || defaultSource),
    };
  }

  return null;
}

function pickBestCandidate(candidates, token, network) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      status: "unresolved",
      reason: "no_candidate_addresses",
    };
  }

  const validCandidates = candidates
    .map((item) => toAddressCandidate(item, "payload_candidate"))
    .filter(Boolean)
    .filter((item) => isAddressValidForToken(token, item.address));

  if (!validCandidates.length) {
    return {
      status: "unresolved",
      reason: "no_chain_compatible_candidates",
    };
  }

  const tokenUpper = normalizeToken(token);
  const polygonUsdt = validCandidates.find(
    (item) =>
      normalizeNetwork(item.network) === "polygon" &&
      normalizeToken(item.token) === "USDT",
  );
  if (polygonUsdt) {
    return {
      status: "resolved",
      recipient: polygonUsdt.address,
      source: polygonUsdt.source || "payload_candidates",
      score: 100,
    };
  }

  const polygonAny = validCandidates.find(
    (item) => normalizeNetwork(item.network) === "polygon",
  );
  if (polygonAny && tokenUpper !== "BTC") {
    return {
      status: "resolved",
      recipient: polygonAny.address,
      source: polygonAny.source || "payload_candidates",
      score: 90,
    };
  }

  if (tokenUpper === "BTC") {
    const bitcoinCandidate = validCandidates.find(
      (item) =>
        normalizeNetwork(item.network) === "bitcoin" ||
        normalizeToken(item.token) === "BTC",
    );
    if (bitcoinCandidate) {
      return {
        status: "resolved",
        recipient: bitcoinCandidate.address,
        source: bitcoinCandidate.source || "payload_candidates",
        score: 90,
      };
    }
  }

  return {
    status: "resolved",
    recipient: validCandidates[0].address,
    source: validCandidates[0].source || "payload_candidates",
    score: 80,
  };
}

function resolveMappedRecipient(mappedValue, token) {
  if (!mappedValue) {
    return "";
  }

  if (typeof mappedValue === "string") {
    return mappedValue.trim();
  }

  if (typeof mappedValue !== "object") {
    return "";
  }

  const tokenUpper = normalizeToken(token);
  const tokenLower = tokenUpper.toLowerCase();
  const networkKey = tokenUpper === "BTC" ? "bitcoin" : "polygon";

  const nested = mappedValue[networkKey];
  if (nested && typeof nested === "object") {
    const nestedValue = nested[tokenUpper] || nested[tokenLower];
    if (nestedValue) {
      return String(nestedValue).trim();
    }
  }

  const direct =
    mappedValue[tokenUpper] ||
    mappedValue[tokenLower] ||
    (tokenUpper === "BTC" ? mappedValue.btc : mappedValue.evm) ||
    mappedValue.address;

  return direct ? String(direct).trim() : "";
}

async function resolveRecipientForTip({
  creatorId,
  token,
  network,
  directAddress,
  addressCandidates,
  creatorUrl,
}) {
  const tokenUpper = normalizeToken(token);
  const networkLower = normalizeNetwork(network);

  if (directAddress && isAddressValidForToken(tokenUpper, directAddress)) {
    logRecipientTelemetry("resolved_from_payload_direct", {
      creatorId,
      token: tokenUpper,
      network: networkLower,
    });
    return {
      status: "resolved",
      recipient: directAddress,
      source: "payload_direct",
      score: 101,
    };
  }

  const payloadCandidates = [];
  if (Array.isArray(addressCandidates)) {
    payloadCandidates.push(...addressCandidates);
  }

  const candidatePick = pickBestCandidate(
    payloadCandidates,
    tokenUpper,
    networkLower,
  );
  if (candidatePick.status === "resolved") {
    logRecipientTelemetry("resolved_from_payload", {
      creatorId,
      token: tokenUpper,
      network: networkLower,
      source: candidatePick.source,
    });
    return candidatePick;
  }

  if (candidatePick.status === "ambiguous") {
    logRecipientTelemetry("ambiguous_payload_candidates", {
      creatorId,
      token: tokenUpper,
      network: networkLower,
      count: Number(candidatePick?.candidates?.length || 0),
    });
    return candidatePick;
  }

  if (isAddressValidForToken(tokenUpper, creatorId)) {
    logRecipientTelemetry("resolved_from_creator_id", {
      creatorId,
      token: tokenUpper,
    });
    return {
      status: "resolved",
      recipient: creatorId,
      source: "creator_id_as_address",
      score: 0,
    };
  }

  const {
    creatorPayoutMap = {},
    defaultPayoutAddress,
    defaultBtcPayoutAddress,
  } = await chrome.storage.sync.get([
    "creatorPayoutMap",
    "defaultPayoutAddress",
    "defaultBtcPayoutAddress",
  ]);

  const lookupKeys = buildCreatorLookupKeys(creatorId, creatorUrl);
  for (const key of lookupKeys) {
    const mappedAddress = resolveMappedRecipient(
      creatorPayoutMap?.[key],
      tokenUpper,
    );
    if (!mappedAddress || !isAddressValidForToken(tokenUpper, mappedAddress)) {
      continue;
    }

    logRecipientTelemetry("resolved_from_creator_map", {
      creatorId,
      creatorKey: key,
      token: tokenUpper,
    });
    return {
      status: "resolved",
      recipient: mappedAddress,
      source: "creator_payout_map",
      score: 0,
      creatorKey: key,
    };
  }

  const defaultAddress =
    tokenUpper === "BTC"
      ? defaultBtcPayoutAddress || globalThis.TIPSY_WDK_BTC_TO
      : defaultPayoutAddress || globalThis.TIPSY_WDK_EVM_DEFAULT_TO;

  if (defaultAddress && isAddressValidForToken(tokenUpper, defaultAddress)) {
    logRecipientTelemetry("resolved_from_default_wallet", {
      creatorId,
      token: tokenUpper,
    });
    return {
      status: "resolved",
      recipient: defaultAddress,
      source: "default_wallet",
      score: 0,
    };
  }

  logRecipientTelemetry("unresolved_no_valid_recipient", {
    creatorId,
    token: tokenUpper,
    network: networkLower,
  });

  return {
    status: "unresolved",
    reason: "no_valid_recipient",
  };
}
