import { FREEBUFF_CONFIG } from "../constants/oauth.js";
import { createHash, randomBytes } from "crypto";

function genFingerprint() {
  const rand = randomBytes(6).toString("base64url").replace(/=+$/, "").slice(0, 8);
  return `codebuff-cli-${rand}`;
}

const freebuff = {
  config: FREEBUFF_CONFIG,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const fingerprintId = genFingerprint();
    const initiateUrl = config.initiateUrl || "https://www.codebuff.com/api/auth/cli/code";

    const response = await fetch(initiateUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      },
      body: JSON.stringify({ fingerprintId }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Freebuff auth initiation failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    if (!data.loginUrl || !data.fingerprintHash) {
      throw new Error("Freebuff auth initiation returned invalid response (missing loginUrl/fingerprintHash)");
    }

    return {
      device_code: fingerprintId,
      user_code: fingerprintId.slice(-8).toUpperCase(),
      verification_uri: data.loginUrl,
      verification_uri_complete: data.loginUrl,
      expires_in: Math.floor((data.expiresInMs || 3600000) / 1000),
      interval: config.pollInterval ? config.pollInterval / 1000 : 5,
      _fingerprintId: fingerprintId,
      _fingerprintHash: data.fingerprintHash,
      _expiresAt: data.expiresAt,
    };
  },
  pollToken: async (config, deviceCode, _codeVerifier, extraData) => {
    const pollUrlBase = config.pollUrlBase || "https://www.codebuff.com/api/auth/cli/status";
    const fingerprintId = extraData?._fingerprintId || deviceCode;
    const fingerprintHash = extraData?._fingerprintHash;
    const expiresAt = extraData?._expiresAt;

    if (!fingerprintId || !fingerprintHash) {
      return { ok: false, data: { error: "invalid_request", error_description: "Missing fingerprint parameters" } };
    }

    const params = new URLSearchParams({
      fingerprintId,
      fingerprintHash,
      ...(expiresAt ? { expiresAt: String(expiresAt) } : {}),
    });

    const response = await fetch(`${pollUrlBase}?${params.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      },
    });

    if (response.status === 401) {
      return { ok: true, data: { error: "authorization_pending" } };
    }

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, data: { error: "poll_failed", error_description: `Poll failed (${response.status}): ${errText}` } };
    }

    const data = await response.json();
    if (data && data.user && data.user.authToken) {
      return {
        ok: true,
        data: {
          access_token: data.user.authToken,
          _freebuffUser: data.user,
        },
      };
    }

    return { ok: true, data: { error: "authorization_pending" } };
  },
  mapTokens: (tokens) => {
    const user = tokens._freebuffUser || {};
    const email = user.email || (user.id ? `freebuff-user-${user.id}` : null);
    return {
      accessToken: tokens.access_token,
      refreshToken: null,
      expiresIn: null, // long-lived session auth token
      email,
      displayName: user.name || user.username || null,
      providerSpecificData: {
        userId: user.id || null,
        credits: user.credits !== undefined ? user.credits : null,
      },
    };
  },
};

export default freebuff;
