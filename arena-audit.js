/**
 * Arena audit adapter template.
 *
 * Replace ONLY the marked organizer section with the exact SharedOS Cloud
 * audit code/snippet supplied in #arena-support. This file SHOULD be committed.
 * Keep credentials in environment variables; never hard-code them here.
 */

export async function createAuditSink() {
  // ORGANIZER INTEGRATION START
  // Example shape only:
  // const client = ... organizer-provided client/config ...;
  // return {
  //   async record(event) {
  //     await client.record(event);
  //   },
  // };
  // ORGANIZER INTEGRATION END

  throw new Error(
    "arena-audit.js is still a template; replace it with the exact organizer-provided SharedOS Cloud audit integration",
  );
}
