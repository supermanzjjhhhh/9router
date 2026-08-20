import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { randomBytes, createHash } from "crypto";

const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_SDK_UA = "ai-sdk/openai-compatible/0.0.141/codebuff";
const CLI_UA = "Freebuff-CLI/0.0.138";
const CANONICAL_BUFFY = "You are Buffy, the strategic coding assistant.";
const CONTEXT_PRUNER_AGENT = "context-pruner";

// Canonical root agents matching Freebuff official catalog
const MODEL_AGENTS = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "minimax/minimax-m2.7": "base2-free",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

// In-memory cache for sessions & runs (keyed by token:model)
const sessCache = new Map(); // key -> { instanceId, model, expiresAt }
const runCache = new Map();  // key -> { runId, childRunId, ts }
const behaviorCache = new Map(); // key -> ts
const BEHAVIOR_CACHE_TTL_MS = 30 * 60 * 1000;
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function behaviorDue(key) {
  const ts = behaviorCache.get(key) || 0;
  if (Date.now() - ts > BEHAVIOR_CACHE_TTL_MS) {
    behaviorCache.set(key, Date.now());
    return true;
  }
  return false;
}

function getAgentForModel(model) {
  if (MODEL_AGENTS[model]) return MODEL_AGENTS[model];
  const lower = String(model || "").toLowerCase();
  for (const [k, v] of Object.entries(MODEL_AGENTS)) {
    if (lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)) {
      return v;
    }
  }
  return "base2-free";
}

function stableFingerprint(seed) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = `freebuff-fp-v2:${seed}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `enhanced-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

async function runClientActivitySimulation(token, clientFingerprint, proxyOptions) {
  // 1) Ads fetch + impression report (Required by upstream free mode anti-bot)
  if (behaviorDue(`ads:${token}`)) {
    try {
      const adRes = await proxyAwareFetch(
        `${CODEBUFF_API}/api/v1/ads`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": CLI_UA,
          },
          body: JSON.stringify({
            provider: "gravity",
            sessionId: crypto.randomUUID(),
            surface: "waiting_room",
            device: { os: "macos", timezone: "Asia/Shanghai", locale: "zh-CN" },
            userAgent: CLI_UA,
          }),
        },
        proxyOptions
      );

      if (adRes.ok) {
        const adData = await adRes.json();
        const impUrl = adData?.ads?.[0]?.impUrl;
        if (impUrl) {
          await proxyAwareFetch(
            `${CODEBUFF_API}/api/v1/ads/impression`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "User-Agent": CLI_UA,
              },
              body: JSON.stringify({ impUrl, mode: "free" }),
            },
            proxyOptions
          );
        }
      }
    } catch {}
  }

  // 2) Normal usage touch
  if (behaviorDue(`usage:${token}`)) {
    try {
      await proxyAwareFetch(
        `${CODEBUFF_API}/api/v1/usage`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ fingerprintId: clientFingerprint }),
        },
        proxyOptions
      );
    } catch {}
  }
}

function isUsableSession(session, now = Date.now()) {
  if (!session?.instanceId || !session?.expiresAt) return false;
  const expiryMs = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiryMs) && expiryMs > now + 60000;
}

function ensureBuffySystemPrompt(body) {
  if (!body || typeof body !== "object") return body;
  const messages = Array.isArray(body.messages) ? body.messages.map(m => ({ ...m })) : [];
  let hasSystem = false;

  for (let i = 0; i < messages.length; i++) {
    const item = messages[i];
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      hasSystem = true;
      item.cache_control = { type: "ephemeral" };
      if (typeof item.content === "string") {
        if (!item.content.startsWith(CANONICAL_BUFFY)) {
          item.content = `${CANONICAL_BUFFY}\n\n${item.content}`;
        }
      } else if (Array.isArray(item.content)) {
        const firstText = item.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (firstText && !firstText.text.startsWith(CANONICAL_BUFFY)) {
          firstText.text = `${CANONICAL_BUFFY}\n\n${firstText.text}`;
        }
      }
    }
  }

  if (!hasSystem) {
    messages.unshift({
      role: "system",
      content: `${CANONICAL_BUFFY}\n\nYou are the AI agent behind Freebuff.`,
      cache_control: { type: "ephemeral" },
    });
  }

  return { ...body, messages };
}

export class FreebuffExecutor extends BaseExecutor {
  constructor() {
    super("freebuff", PROVIDERS["freebuff"] || {
      baseUrl: `${CODEBUFF_API}/api/v1/chat/completions`,
      headers: { "User-Agent": DEFAULT_SDK_UA },
    });
  }

  buildUrl() {
    return `${CODEBUFF_API}/api/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const token = credentials?.apiKey || credentials?.accessToken;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_SDK_UA,
      Accept: stream ? "text/event-stream" : "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async deleteSession(token, instanceId, proxyOptions) {
    if (!token || !instanceId) return;
    try {
      await proxyAwareFetch(`${CODEBUFF_API}/api/v1/freebuff/session`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-freebuff-instance-id": instanceId,
          "User-Agent": DEFAULT_SDK_UA,
        },
      }, proxyOptions);
    } catch {
      // silent
    }
  }

  async getOrCreateSession(token, model, proxyOptions, signal, forceRecreate = false) {
    const cacheKey = `${token}:${model}`;

    // Periodic client behavior simulation (ads + usage)
    runClientActivitySimulation(token, stableFingerprint(token), proxyOptions).catch(() => {});

    if (!forceRecreate) {
      const cached = sessCache.get(cacheKey);
      if (isUsableSession(cached)) {
        return cached;
      }
      sessCache.delete(cacheKey);

      // Step 1: Query existing active session from upstream (GET /session)
      try {
        const curRes = await proxyAwareFetch(
          `${CODEBUFF_API}/api/v1/freebuff/session`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": DEFAULT_SDK_UA,
              "x-freebuff-include-unused-rate-limits": "1",
            },
            signal,
          },
          proxyOptions
        );

        if (curRes.ok) {
          const curData = await curRes.json();
          if (curData?.status === "active" && curData?.instanceId) {
            if (!curData.model || curData.model === model) {
              const sess = {
                instanceId: curData.instanceId,
                model,
                expiresAt: curData.expiresAt || new Date(Date.now() + (curData.remainingMs || 3600000)).toISOString(),
              };
              sessCache.set(cacheKey, sess);
              return sess;
            }
            // Model mismatch on existing active session -> delete
            await this.deleteSession(token, curData.instanceId, proxyOptions);
          }
        }
      } catch {
        // continue to POST creation
      }
    }

    // Step 2: Create new session via POST
    const instId = crypto.randomUUID();
    try {
      const res = await proxyAwareFetch(
        `${CODEBUFF_API}/api/v1/freebuff/session`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": DEFAULT_SDK_UA,
            "x-freebuff-model": model,
            "x-freebuff-instance-id": instId,
          },
          signal,
        },
        proxyOptions
      );

      if (res.ok) {
        const data = await res.json();
        // 2.1 Direct active
        if (data?.status === "active" && data?.instanceId) {
          const sess = {
            instanceId: data.instanceId,
            model,
            expiresAt: data.expiresAt || new Date(Date.now() + (data.remainingMs || 3600000)).toISOString(),
          };
          sessCache.set(cacheKey, sess);
          return sess;
        }

        // 2.2 Queued waiting room (polling)
        if (data?.status === "queued" && data?.instanceId) {
          const inst = data.instanceId;
          for (let i = 0; i < 10; i++) {
            await sleep(1500);
            const qRes = await proxyAwareFetch(
              `${CODEBUFF_API}/api/v1/freebuff/session`,
              {
                method: "GET",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "User-Agent": DEFAULT_SDK_UA,
                  "x-freebuff-instance-id": inst,
                },
                signal,
              },
              proxyOptions
            );
            if (qRes.ok) {
              const qData = await qRes.json();
              if (qData?.status === "active") {
                const sess = {
                  instanceId: qData.instanceId || inst,
                  model,
                  expiresAt: qData.expiresAt || new Date(Date.now() + (qData.remainingMs || 3600000)).toISOString(),
                };
                sessCache.set(cacheKey, sess);
                return sess;
              }
            }
          }
        }
      }
    } catch {
      // fallback
    }

    const fallbackSess = {
      instanceId: instId,
      model,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    sessCache.set(cacheKey, fallbackSess);
    return fallbackSess;
  }

  async startRunChain(token, agentId, proxyOptions, signal, forceRecreate = false) {
    const key = `${token}:${agentId}`;
    if (!forceRecreate) {
      const hit = runCache.get(key);
      if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) {
        return { runId: hit.runId, childRunId: hit.childRunId };
      }
    }

    try {
      const res1 = await proxyAwareFetch(
        `${CODEBUFF_API}/api/v1/agent-runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": DEFAULT_SDK_UA,
          },
          body: JSON.stringify({
            action: "START",
            agentId,
            ancestorRunIds: [],
          }),
          signal,
        },
        proxyOptions
      );

      if (res1.ok) {
        const d1 = await res1.json();
        const runId = d1?.runId;
        if (runId) {
          let childRunId = null;
          try {
            const res2 = await proxyAwareFetch(
              `${CODEBUFF_API}/api/v1/agent-runs`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                  "User-Agent": DEFAULT_SDK_UA,
                },
                body: JSON.stringify({
                  action: "START",
                  agentId: CONTEXT_PRUNER_AGENT,
                  ancestorRunIds: [runId],
                }),
                signal,
              },
              proxyOptions
            );
            if (res2.ok) {
              const d2 = await res2.json();
              childRunId = d2?.runId;
            }
          } catch {}

          runCache.set(key, { runId, childRunId, ts: Date.now() });
          return { runId, childRunId };
        }
      }
    } catch {}

    const fallbackRunId = `run-${randomBytes(6).toString("hex")}`;
    return { runId: fallbackRunId, childRunId: null };
  }

  transformRequest(model, body, stream, credentials, session, runId, clientSessionId) {
    const payload = ensureBuffySystemPrompt({ ...body });
    const targetModel = String(model || "").replace(/^freebuff\//, "");
    payload.model = targetModel;
    payload.stream = stream;
    if (!payload.stop) {
      payload.stop = ['"cb_easp"'];
    }
    payload.provider = { data_collection: "deny" };

    const stableClient = clientSessionId || stableFingerprint(runId || "session");
    payload.codebuff_metadata = {
      freebuff_instance_id: session?.instanceId,
      trace_session_id: crypto.randomUUID(),
      run_id: runId,
      client_id: stableClient,
      cost_mode: "free",
    };

    return payload;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.apiKey || credentials?.accessToken;
    const targetModel = String(model || "").replace(/^freebuff\//, "");
    const agentId = getAgentForModel(targetModel);

    // Resolve unified conversation-stable session ID from client context
    const clientSessionId = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId: credentials?.connectionId || token,
      scope: "freebuff",
    });

    const url = this.buildUrl();

    // 1. Session acquisition & Run Chain startup
    let session = await this.getOrCreateSession(token, targetModel, proxyOptions, signal, false);
    let run = await this.startRunChain(token, agentId, proxyOptions, signal, false);

    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = this.buildHeaders(credentials, stream);
      if (session?.instanceId) {
        headers["x-freebuff-instance-id"] = session.instanceId;
      }

      const transformedBody = this.transformRequest(
        model,
        body,
        stream,
        credentials,
        session,
        run.runId,
        clientSessionId
      );
      const bodyStr = JSON.stringify(transformedBody);
      log?.debug?.("FETCH", `FREEBUFF → ${url} | model=${targetModel} | agent=${agentId} | runId=${run.runId} | inst=${session?.instanceId} (att ${attempt + 1})`);

      const response = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: bodyStr,
          signal,
        },
        proxyOptions
      );

      // Handle 409 session_superseded, 428 waiting_room_required, 410 session_expired or 403 free_mode_invalid_agent_model
      if ((response.status === 409 || response.status === 428 || response.status === 410 || response.status === 403) && attempt === 0) {
        const errText = await response.clone().text();
        if (
          errText.includes("waiting_room_required") ||
          errText.includes("session_superseded") ||
          errText.includes("session_expired") ||
          errText.includes("free_mode_invalid_agent_model") ||
          response.status === 428 ||
          response.status === 410
        ) {
          log?.debug?.("FREEBUFF", `Session/Waiting-room stale (${response.status}: ${errText.slice(0, 100)}), acquiring fresh session...`);
          sessCache.delete(`${token}:${targetModel}`);
          runCache.delete(`${token}:${agentId}`);
          await this.deleteSession(token, session?.instanceId, proxyOptions);
          session = await this.getOrCreateSession(token, targetModel, proxyOptions, signal, true);
          run = await this.startRunChain(token, agentId, proxyOptions, signal, true);
          continue;
        }
      }

      return { response, url, headers, transformedBody };
    }
  }
}

export default FreebuffExecutor;
