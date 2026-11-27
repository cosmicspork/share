// HTTP client for the share admin API. It has no dependency on the CLI, the
// filesystem or the process environment, so other tools can import it as is:
//
//   const share = new ShareClient({ adminUrl, clientId, clientSecret });
//   const item = await share.createLink({ url: "https://example.com" });
//   console.log(item.url);

export type Kind = "bundle" | "paste" | "link";

export interface Item {
  slug: string;
  kind: Kind;
  /** Public URL on the content host. */
  url: string;
  title: string | null;
  target: string | null;
  version: string | null;
  content_type: string | null;
  sandbox: boolean | null;
  size: number;
  file_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  expired: boolean;
}

export interface CommonOptions {
  slug?: string;
  title?: string;
  /** Seconds, or a duration such as "7d". */
  expires_in?: string | number;
  /** ISO 8601 timestamp. */
  expires_at?: string;
  replace?: boolean;
}

export interface BundleFile {
  /** Path inside the bundle, forward slashes, e.g. "css/app.css". */
  path: string;
  body: Blob | ArrayBuffer | Uint8Array | string;
}

export interface Draft {
  slug: string;
  version: string;
}

export interface ClientOptions {
  /** e.g. https://go-admin.joshbowen.net */
  adminUrl: string;
  /** Access service token. */
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
}

export class ShareError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export class ShareClient {
  private readonly base: string;
  private readonly auth: Record<string, string>;
  private readonly fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.base = opts.adminUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.auth = { "X-Share-Client": "cli" };
    if (opts.clientId && opts.clientSecret) {
      this.auth["CF-Access-Client-Id"] = opts.clientId;
      this.auth["CF-Access-Client-Secret"] = opts.clientSecret;
    }
  }

  createLink(opts: CommonOptions & { url: string }): Promise<Item> {
    return this.json("POST", "/api/links", opts);
  }

  createPaste(opts: CommonOptions & { content: string; content_type?: string }): Promise<Item> {
    return this.json("POST", "/api/pastes", opts);
  }

  createDraft(opts: CommonOptions & { sandbox?: boolean } = {}): Promise<Draft> {
    return this.json("POST", "/api/bundles", opts);
  }

  async uploadFile(draft: Draft, file: BundleFile): Promise<void> {
    const path = file.path.split("/").map(encodeURIComponent).join("/");
    await this.request("PUT", `/api/bundles/${draft.slug}/${draft.version}/files/${path}`, {
      body: file.body as BodyInit,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  commit(draft: Draft): Promise<Item> {
    return this.json("POST", `/api/bundles/${draft.slug}/${draft.version}/commit`);
  }

  /** Draft, upload every file, commit. Nothing is visible until the commit. */
  async publishBundle(
    files: BundleFile[],
    opts: CommonOptions & { sandbox?: boolean } = {},
    concurrency = 6,
  ): Promise<Item> {
    const draft = await this.createDraft(opts);
    const queue = [...files];
    const worker = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) await this.uploadFile(draft, file);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    return this.commit(draft);
  }

  async list(opts: { kind?: Kind } = {}): Promise<Item[]> {
    const query = opts.kind ? `?kind=${opts.kind}` : "";
    return (await this.json<{ items: Item[] }>("GET", `/api/items${query}`)).items;
  }

  get(slug: string): Promise<Item> {
    return this.json("GET", `/api/items/${encodeURIComponent(slug)}`);
  }

  patch(
    slug: string,
    changes: { title?: string | null; sandbox?: boolean; expires_in?: string | number; expires_at?: string | null },
  ): Promise<Item> {
    return this.json("PATCH", `/api/items/${encodeURIComponent(slug)}`, changes);
  }

  async remove(slug: string): Promise<void> {
    await this.request("DELETE", `/api/items/${encodeURIComponent(slug)}`);
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(
      method,
      path,
      body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    );
    return (await res.json()) as T;
  }

  private async request(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const res = await this.fetch(this.base + path, {
      method,
      body: init.body,
      headers: { ...this.auth, ...init.headers },
      // An Access login redirect means the credentials were not accepted.
      redirect: "manual",
    });
    if (res.ok) return res;

    if (res.status >= 300 && res.status < 400) {
      throw new ShareError(res.status, "access_denied", "Cloudflare Access did not accept the service token (redirected to login)");
    }
    let code = "http_error";
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      if (data.error?.code) code = data.error.code;
      if (data.error?.message) message = data.error.message;
    } catch {
      // Not our JSON: most likely Access or Cloudflare answered instead of the Worker.
      if (res.status === 401 || res.status === 403) message = "rejected by Cloudflare Access; check the service token";
    }
    throw new ShareError(res.status, code, message);
  }
}
