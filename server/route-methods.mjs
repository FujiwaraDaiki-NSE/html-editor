const ROUTE_METHODS = [
  [/^\/healthz$/, ["GET"]],
  [/^\/api\/(?:state|variations|variations\/compare|codex\/events|codex\/threads)$/, ["GET"]],
  [/^\/api\/skills$/, ["GET", "POST"]],
  [/^\/api\/skills\/upload$/, ["POST"]],
  [/^\/api\/skills\/(?:promote|demote)$/, ["POST"]],
  [/^\/api\/skills\/(?:project|common)\/[^/]+$/, ["PATCH", "DELETE"]],
  [/^\/api\/skills\/(?:project|common)\/[^/]+\/(?:promote|demote)$/, ["POST"]],
  [/^\/api\/folders$/, ["GET"]],
  [/^\/api\/(?:assets|projects\/[^/]+\/assets)\//, ["GET"]],
  [/^\/api\/projects$/, ["GET", "POST"]],
  [/^\/api\/projects\/current$/, ["POST"]],
  [/^\/api\/projects\/[^/]+$/, ["PATCH"]],
  [/^\/api\/projects\/[^/]+\/(?:duplicate|archive)$/, ["POST"]],
  [/^\/api\/(?:assets|references|references\/remove|references\/folder|references\/folder\/sync|save|draft|milestones|history\/checkout|history\/main|variations\/(?:checkout|generate|accept|archive|pause|resume|import))$/, ["POST"]],
  [/^\/api\/codex\/(?:thread\/(?:start|read|resume|fork|action)|turn\/(?:start|steer|interrupt)|request\/(?:resolve|reject)|catalog\/refresh|skill\/config|account\/(?:login|logout)|mcp\/(?:oauth|resource\/read|tool\/call))$/, ["POST"]],
];

export function routeMethodDecision(pathname, method) {
  const allowedMethods = ROUTE_METHODS.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
  return {
    allowed: allowedMethods === null || allowedMethods.includes(method),
    allow: allowedMethods?.join(", ") ?? null,
  };
}
