/**
 * Internal SharedNet boundary.
 *
 * IMPORTANT: this handler does not guess organizer transport fields. The
 * organizer-specific adapter must construct a trusted envelope with
 * `trustedCallerId` after authenticating/parsing the real callback schema.
 */
function normalizeTrustedAuthorityGap(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.verified !== true) {
    const error = new Error("trustedAuthorityGap must be a host-authenticated verified authority-gap object");
    error.code = "SHAREDNET_AUTHORITY_GAP_INVALID";
    throw error;
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    const error = new Error("trustedAuthorityGap.reason is required");
    error.code = "SHAREDNET_AUTHORITY_GAP_INVALID";
    throw error;
  }
  const reason = value.reason.trim().slice(0, 400);
  const revision = typeof value.revision === "string" && value.revision.trim() ? value.revision.trim().slice(0, 128) : undefined;
  return Object.freeze({ verified: true, reason, ...(revision ? { revision } : {}) });
}

export function createSharedNetHandler(service, {
  requireCallerIdentity = true,
  getCallerIdentity = (call) => call?.trustedCallerId,
  getPayload = (call) => call?.input,
  getTrustedAuthorityGap = (call) => call?.trustedAuthorityGap,
} = {}) {
  return async function handleSharedNetServiceCall(call, signal) {
    const payload = getPayload(call);
    const callerAgentId = getCallerIdentity(call);
    if ((callerAgentId == null || String(callerAgentId).trim() === "") && requireCallerIdentity) {
      const error = new Error("SharedNet organizer adapter did not provide a trusted caller identity");
      error.code = "SHAREDNET_CALLER_REQUIRED";
      throw error;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const error = new Error("SharedNet organizer adapter did not provide a valid input payload");
      error.code = "SHAREDNET_PAYLOAD_REQUIRED";
      throw error;
    }
    const trustedAuthorityGap = normalizeTrustedAuthorityGap(getTrustedAuthorityGap(call));
    return service.verify(payload, signal, {
      callerAgentId: String(callerAgentId ?? "sharednet-local"),
      ...(trustedAuthorityGap ? { trustedAuthorityGap } : {}),
    });
  };
}
