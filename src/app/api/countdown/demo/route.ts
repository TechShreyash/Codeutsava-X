import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { COUNTDOWN_DURATION, createStartPayload, MultipleCountersError, parseCounter, type Counter } from "@/lib/countdown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const file = path.join(process.cwd(), ".next", "countdown-demo.json");
type DemoState = { counters: Counter[]; outage: boolean };
let queue: Promise<unknown> = Promise.resolve();
const initial = (): DemoState => ({ counters: [], outage: false });

async function readState(): Promise<DemoState> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as DemoState & { counter?: Counter };
    // Preserve an active rehearsal saved by the earlier singleton mock.
    return { counters: state.counters ?? (state.counter?.flag ? [state.counter] : []), outage: state.outage };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial();
    throw error;
  }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  if (process.env.NODE_ENV !== "development") return json({ error: "Demo is only available in local development." }, 404);
  await queue;
  const state = await readState();
  if (state.outage) return json({ error: "Demo connection lost. Restore connection to resume syncing." }, 503);
  try {
    const counter = parseCounter({ data: state.counters.length ? state.counters : { flag: false, startTime: 0, endTime: 0 } });
    return json({ counter, serverTime: Date.now() });
  } catch (error) {
    if (error instanceof MultipleCountersError) return json({ error: error.message }, 409);
    throw error;
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") return json({ error: "Demo is only available in local development." }, 404);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Invalid origin." }, 403);
  let action: unknown;
  try { action = (await request.json()).action; } catch { return json({ error: "Invalid demo action." }, 400); }
  if (!["start", "reset", "finish", "disconnect", "reconnect"].includes(String(action))) return json({ error: "Invalid demo action." }, 400);
  const operation = queue.then(async () => {
    const state = await readState();
    if (action === "start") {
      if (state.outage) return json({ error: "Restore connection before starting." }, 503);
      // Match Django's legacy POST: every call inserts another record.
      state.counters.push(createStartPayload(Date.now()));
    } else if (action === "reset") Object.assign(state, initial());
    else if (action === "finish") { const now = Date.now(); state.counters = [{ flag: true, startTime: now - COUNTDOWN_DURATION, endTime: now }]; }
    else state.outage = action === "disconnect";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(state));
    await rename(`${file}.tmp`, file);
    return json({});
  });
  queue = operation.catch(() => undefined);
  return operation;
}
