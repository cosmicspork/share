declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      BUCKET: R2Bucket;
      /** Public content host, e.g. go.joshbowen.net */
      CONTENT_HOST: string;
      /** Access-protected admin host, e.g. go-admin.joshbowen.net */
      ADMIN_HOST: string;
      /** <team>.cloudflareaccess.com */
      ACCESS_TEAM_DOMAIN: string;
      /** Application Audience (AUD) tag of the Access application */
      ACCESS_AUD: string;
    }
  }
}

export type Env = Cloudflare.Env;
