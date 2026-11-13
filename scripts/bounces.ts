/**
 * Read hard bounces from the sending mailbox and mark those addresses invalid.
 * Prints counts only (Actions logs are public).
 *   pnpm bounces [days]
 */
import "dotenv/config";
import { fetchBounces } from "@tell/deliver";
import { markBounced } from "@tell/pipeline";

const days = Number(process.argv[2] ?? 3);
const r = await fetchBounces(days);
if (r.status === "skipped") {
  console.log(`bounces: skipped (${r.reason})`);
} else {
  let matched = 0;
  for (const a of r.addresses) if ((await markBounced(a)) > 0) matched++;
  console.log(`bounces: messages=${r.messages} hard_bounced=${r.addresses.length} marked_invalid=${matched} not_tracked=${r.addresses.length - matched} (last ${days}d)`);
}
