declare module "cloudflare:workers" {
  const env: {
    DB?: import("drizzle-orm/d1").AnyD1Database;
  };
  export { env };
}
