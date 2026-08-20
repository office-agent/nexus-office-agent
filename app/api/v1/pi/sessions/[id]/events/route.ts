import { getPiAgentService } from "@/src/modules/pi-agent/runtime";
import { resolveRequestContext } from "@/src/platform/context/resolve-request-context";
import { applicationErrorResponse } from "@/src/platform/http/api-response";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const context = await resolveRequestContext(request);
    const { id } = await params;
    await getPiAgentService().getSession(context, id);
    const url = new URL(request.url);
    const requested = Number(url.searchParams.get("after") || request.headers.get("last-event-id") || 0);
    let cursor = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
    const encoder = new TextEncoder();
    const service = getPiAgentService();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const timers: { poll?: ReturnType<typeof setTimeout>; keepAlive?: ReturnType<typeof setInterval>; close?: ReturnType<typeof setTimeout> } = {};
        const close = () => {
          if (closed) return;
          closed = true;
          if (timers.poll) clearTimeout(timers.poll);
          if (timers.keepAlive) clearInterval(timers.keepAlive);
          if (timers.close) clearTimeout(timers.close);
          try { controller.close(); } catch { /* already closed */ }
        };
        const send = (value: string) => { if (!closed) controller.enqueue(encoder.encode(value)); };
        const poll = async () => {
          if (closed) return;
          try {
            const events = await service.events(context, id, cursor, 100);
            for (const event of events) {
              cursor = event.sequence;
              send(`id: ${event.sequence}\nevent: pi-event\ndata: ${JSON.stringify(event)}\n\n`);
            }
          } catch {
            send("event: stream-error\ndata: {\"code\":\"PI_EVENT_STREAM_READ_FAILED\"}\n\n");
            close();
            return;
          }
          timers.poll = setTimeout(poll, 1_000);
        };
        send(`event: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
        timers.keepAlive = setInterval(() => send(`: keep-alive ${Date.now()}\n\n`), 15_000);
        timers.close = setTimeout(close, 55_000);
        request.signal.addEventListener("abort", close, { once: true });
        void poll();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" } });
  } catch (error) {
    return applicationErrorResponse(error);
  }
}
