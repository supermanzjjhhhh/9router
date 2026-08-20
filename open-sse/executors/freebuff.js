import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { randomBytes, createHash } from "crypto";

const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_SDK_UA = "ai-sdk/openai-compatible/0.0.141/codebuff";
const CANONICAL_BUFFY = "You are Buffy, the strategic coding assistant.";

const MODEL_AGENTS = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "moonshotai/kimi-k2.6": "base2-free-kimi",
  "minimax/minimax-m2.7": "base2-free",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.5-pro": "base2-free-mimo-pro",
};

// In-memory cache for sessions & runs (keyed by token:model)
const sessCache = new Map(); // key -> { instanceId, model, expiresAt }
const runCache = new Map();  // key -> { runId, ts }

function getAgentForModel(model) {
  return MODEL_AGENTS[model] || "base2-free-deepseek-flash";
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

function isUsableSession(session, now = Date.now()) {
  if (!session?.instanceId || !session?.expiresAt) return false;
  const expiryMs = new Date(session.expiresAt).getTime();
  return Number.isFinite(expiryMs) && expiryMs > now + 60000;
}

function ensureBuffySystemPrompt(body) {
  if (!body || typeof body !== "object") return body;
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const sysIdx = messages.findIndex((m) => m?.role === "system");

  if (sysIdx >= 0) {
    const content = messages[sysIdx]?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map(c => c?.text || "").join("\n") : "";
    if (!text.includes(CANONICAL_BUFFY)) {
      messages[sysIdx] = {
        ...messages[sysIdx],
        content: `${CANONICAL_BUFFY}\n\n${text}`,
      };
    }
  } else {
    messages.unshift({
      role: "system",
      content: `${CANONICAL_BUFFY}\n\nYou are the AI agent behind Freebuff.`,
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
    const uid = credentials?.providerSpecificData?.userId;
    if (uid) {
      headers["x-freebuff-acting-user-id"] = uid;
    }
    return headers;
  }

  async getOrCreateSession(token, model, proxyOptions, signal) {
    const cacheKey = `${token}:${model}`;
    const cached = sessCache.get(cacheKey);
    if (isUsableSession(cached)) {
      return cached;
    }

    // Try creating a new session via POST /api/v1/freebuff/session
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
          },
          signal,
        },
        proxyOptions
      );

      if (res.ok) {
        const data = await res.json();
        if (data?.status === "active" && data?.instanceId) {
          const sess = {
            instanceId: data.instanceId,
            model: data.model || model,
            expiresAt: data.expiresAt || new Date(Date.now() + 3600000).toISOString(),
          };
          sessCache.set(cacheKey, sess);
          return sess;
        }
      }
    } catch {
      // fallback to synthetic session instance if network/upstream refuses session management
    }

    return {
      instanceId: `fb-inst-${randomBytes(6).toString("hex")}`,
      model,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
  }

  async startAgentRun(token, agentId, proxyOptions, signal) {
    try {
      const res = await proxyAwareFetch(
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

      if (res.ok) {
        const data = await res.json();
        if (data?.runId) {
          return data.runId;
        }
      }
    } catch {
      // fallback
    }
    return `run-${randomBytes(6).toString("hex")}`;
  }

  async finishAgentRun(token, runId, proxyOptions) {
    if (!runId || !runId.startsWith("run-")) return;
    try {
      await proxyAwareFetch(
        `${CODEBUFF_API}/api/v1/agent-runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "User-Agent": DEFAULT_SDK_UA,
          },
          body: JSON.stringify({
            action: "FINISH",
            runId,
          }),
        },
        proxyOptions
      );
    } catch {
      // silent
    }
  }

  transformRequest(model, body, stream, credentials, session, runId) {
    const payload = ensureBuffySystemPrompt({ ...body });
    const targetModel = String(model || "").replace(/^freebuff\//, "");
    payload.model = targetModel;
    payload.stream = stream;
    if (!payload.stop) {
      payload.stop = ['"cb_easp"'];
    }
    payload.provider = { data_collection: "deny" };

    payload.codebuff_metadata = {
      freebuff_instance_id: session?.instanceId || `fb-${randomBytes(6).toString("hex")}`,
      trace_session_id: randomBytes(16).toString("hex"),
      run_id: runId || `run-${randomBytes(6).toString("hex")}`,
      client_id: stableFingerprint(runId || "session"),
      cost_mode: "free",
    };

    return payload;
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const token = credentials?.apiKey || credentials?.accessToken;
    const targetModel = String(model || "").replace(/^freebuff\//, "");
    const agentId = getAgentForModel(targetModel);

    // 1. Session acquisition
    const session = await this.getOrCreateSession(token, targetModel, proxyOptions, signal);

    // 2. Agent run start
    const runId = await this.startAgentRun(token, agentId, proxyOptions, signal);

    // 3. Build headers and body
    const headers = this.buildHeaders(credentials, stream);
    if (session?.instanceId) {
      headers["x-freebuff-instance-id"] = session.instanceId;
    }

    const transformedBody = this.transformRequest(model, body, stream, credentials, session, runId);
    const url = this.buildUrl();

    const bodyStr = JSON.stringify(transformedBody);
    log?.debug?.("FETCH", `FREEBUFF → ${url} | model=${targetModel} | runId=${runId}`);

    try {
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

      // Async finish run without blocking response stream
      this.finishAgentRun(token, runId, proxyOptions).catch(() => {});

      return { response, url, headers, transformedBody };
    } catch (error) {
      this.finishAgentRun(token, runId, proxyOptions).catch(() => {});
      throw error;
    }
  }
}

export default FreebuffExecutor;
