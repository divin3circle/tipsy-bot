const ATLAS_APP_ID =
  globalThis.TIPSY_ATLAS_APP_ID || import.meta?.env?.VITE_ATLAS_APP_ID || "";
const ATLAS_API_KEY =
  globalThis.TIPSY_ATLAS_API_KEY || import.meta?.env?.VITE_ATLAS_API_KEY || "";

const DATA_SOURCE =
  globalThis.TIPSY_ATLAS_DATA_SOURCE ||
  import.meta?.env?.VITE_ATLAS_DATA_SOURCE ||
  "brewtip";
const DATABASE =
  globalThis.TIPSY_ATLAS_DATABASE ||
  import.meta?.env?.VITE_ATLAS_DATABASE ||
  "tipsy";

function hasAtlasConfig() {
  return Boolean(ATLAS_APP_ID && ATLAS_API_KEY);
}

function normalizeObjectId(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value.$oid) {
    return String(value.$oid);
  }

  return "";
}

async function atlasAction(action, collection, payload = {}) {
  if (!hasAtlasConfig()) {
    return null;
  }

  const url = `https://data.mongodb-api.com/app/${ATLAS_APP_ID}/endpoint/data/v1/action/${action}`;
  const body = {
    dataSource: DATA_SOURCE,
    database: DATABASE,
    collection,
    ...payload,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": ATLAS_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Atlas request failed (${res.status})`);
  }

  return res.json();
}

export async function getActivePools() {
  try {
    const data = await atlasAction("find", "pools", {
      filter: { status: "active" },
    });
    return data?.documents || [];
  } catch (error) {
    console.warn("[TIPSY] getActivePools failed", error);
    return [];
  }
}

export async function contributeToPool(poolId, userWallet, amount) {
  const normalizedPoolId = normalizeObjectId(poolId);
  if (!normalizedPoolId) {
    return { success: false };
  }

  try {
    await atlasAction("insertOne", "contributions", {
      document: {
        pool_id: normalizedPoolId,
        user_wallet_address: userWallet,
        amount_usdt: Number(amount),
        contributed_at: new Date().toISOString(),
      },
    });

    await atlasAction("updateOne", "pools", {
      filter: { _id: { $oid: normalizedPoolId } },
      update: { $inc: { balance_usdt: Number(amount) } },
    });

    return { success: true };
  } catch (error) {
    console.warn("[TIPSY] contributeToPool failed", error);
    return { success: false, error: error.message };
  }
}

export async function markPoolPaid(poolId) {
  const normalizedPoolId = normalizeObjectId(poolId);
  if (!normalizedPoolId) {
    return { success: false };
  }

  try {
    await atlasAction("updateOne", "pools", {
      filter: { _id: { $oid: normalizedPoolId } },
      update: { $set: { status: "paid" } },
    });
    return { success: true };
  } catch (error) {
    console.warn("[TIPSY] markPoolPaid failed", error);
    return { success: false, error: error.message };
  }
}

export async function markPoolTriggered(poolId) {
  const normalizedPoolId = normalizeObjectId(poolId);
  if (!normalizedPoolId) {
    return { success: false };
  }

  try {
    await atlasAction("updateOne", "pools", {
      filter: { _id: { $oid: normalizedPoolId } },
      update: {
        $set: {
          status: "triggered",
          triggered_at: new Date().toISOString(),
        },
      },
    });
    return { success: true };
  } catch (error) {
    console.warn("[TIPSY] markPoolTriggered failed", error);
    return { success: false, error: error.message };
  }
}

export async function logTip(tipObject) {
  try {
    const data = await atlasAction("insertOne", "tip_log", {
      document: tipObject,
    });
    return { success: true, insertedId: data?.insertedId || null };
  } catch (error) {
    console.warn("[TIPSY] logTip failed", error);
    return { success: false, error: error.message };
  }
}

export async function logResolverDiagnostic(diagnostic) {
  try {
    const data = await atlasAction("insertOne", "resolver_log", {
      document: {
        ...diagnostic,
        recorded_at: new Date().toISOString(),
      },
    });

    return { success: true, insertedId: data?.insertedId || null };
  } catch (error) {
    console.warn("[TIPSY] logResolverDiagnostic failed", error);
    return { success: false, error: error.message };
  }
}

export async function getTipHistory(userWallet) {
  if (!userWallet) {
    return [];
  }

  try {
    const data = await atlasAction("find", "tip_log", {
      filter: { user_wallet_address: userWallet },
      sort: { tipped_at: -1 },
      limit: 50,
    });
    return data?.documents || [];
  } catch (error) {
    console.warn("[TIPSY] getTipHistory failed", error);
    return [];
  }
}

export async function getMonthlySpend(userWallet) {
  if (!userWallet) {
    return 0;
  }

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  try {
    const data = await atlasAction("aggregate", "tip_log", {
      pipeline: [
        {
          $match: {
            user_wallet_address: userWallet,
            tipped_at: { $gte: monthStart.toISOString() },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount_usdt" },
          },
        },
      ],
    });

    return Number(data?.documents?.[0]?.total || 0);
  } catch (error) {
    console.warn("[TIPSY] getMonthlySpend failed", error);
    return 0;
  }
}

export async function getReadyAdminSignals() {
  try {
    const data = await atlasAction("find", "admin_signals", {
      filter: {
        status: "ready",
        consumed: { $ne: true },
      },
      sort: { signaled_at: -1 },
      limit: 100,
    });

    return data?.documents || [];
  } catch (error) {
    console.warn("[TIPSY] getReadyAdminSignals failed", error);
    return [];
  }
}

export async function markAdminSignalConsumed(signalId) {
  const normalizedSignalId = normalizeObjectId(signalId);
  if (!normalizedSignalId) {
    return { success: false, error: "Invalid signal id" };
  }

  try {
    await atlasAction("updateOne", "admin_signals", {
      filter: { _id: { $oid: normalizedSignalId } },
      update: {
        $set: {
          consumed: true,
          consumed_at: new Date().toISOString(),
        },
      },
    });

    return { success: true };
  } catch (error) {
    console.warn("[TIPSY] markAdminSignalConsumed failed", error);
    return { success: false, error: error.message };
  }
}
