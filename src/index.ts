import { handleAdmin } from "./admin";
import { handleContent } from "./content";
import type { Env } from "./env";
import { sweep } from "./shared/cleanup";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Two hosts, two separate code paths, chosen before anything else runs.
    const host = new URL(req.url).hostname;
    if (host === env.CONTENT_HOST) return handleContent(req, env);
    if (host === env.ADMIN_HOST) return handleAdmin(req, env);
    return new Response("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env));
  },
} satisfies ExportedHandler<Env>;
