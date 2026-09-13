/**
 * Commit-safe SharedNet organizer adapter.
 *
 * Replace the marked section with the exact registration/call API supplied in
 * #arena-support. Keep credentials/tokens in environment variables. This file
 * SHOULD be committed so judges can reproduce the actual SharedNet integration.
 *
 * Contract expected by AgentProof:
 *   registerService({ nodeId, service, handler, signal }) -> { ok: true, ... }
 *   callService({ nodeId, serviceName, input, callerId, signal }) -> proof receipt
 *
 * The organizer callback must authenticate/resolve its real transport caller
 * and invoke handler({ input, trustedCallerId }, signal). Never copy a caller ID
 * from the user payload into trustedCallerId. If the host has independently
 * observed a real authorization denial, it may additionally pass
 * trustedAuthorityGap: { verified: true, reason, revision? }. That object must
 * come from host-owned authorization state, never from the service payload.
 */
export const sharedNetAdapter = {
  async registerService(_args) {
    // ORGANIZER SHAREDNET INTEGRATION START
    // Register verify_before_commit on the organizer-issued node and wrap the
    // real callback so it calls:
    //   args.handler({ input: organizerPayload, trustedCallerId: authenticatedTransportCaller }, signal)
    // If and only if host authorization state proves a denial, the adapter may
    // also attach trustedAuthorityGap to that trusted envelope.
    // ORGANIZER SHAREDNET INTEGRATION END
    throw new Error("sharednet-arena.js is still a template; replace it with the exact organizer-provided SharedNet registration integration");
  },

  async callService(_args) {
    // ORGANIZER SHAREDNET INTEGRATION START
    // Invoke verify_before_commit through the real SharedNet client/transport.
    // Return the service proof receipt returned by the remote call.
    // ORGANIZER SHAREDNET INTEGRATION END
    throw new Error("sharednet-arena.js is still a template; replace it with the exact organizer-provided SharedNet call integration");
  },
};
