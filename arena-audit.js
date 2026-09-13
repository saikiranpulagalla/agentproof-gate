const SHAREDOS_AUDIT_URL = "https://www.sharedos.ai/v1/audit/events";

export async function createAuditSink() {
  const key = process.env.SHAREDOS_KEY?.trim();

  if (!key) {
    throw new Error("SHAREDOS_KEY is required for SharedOS Cloud audit delivery");
  }

  return {
    async record(event, { signal } = {}) {
      const response = await fetch(SHAREDOS_AUDIT_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ events: [event] }),
        signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `SharedOS Cloud audit failed: HTTP ${response.status}${body ? ` - ${body.slice(0, 300)}` : ""}`,
        );
      }
    },
  };
}
