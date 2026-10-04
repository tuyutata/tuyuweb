const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const embeddedIndexHtml = "__TUYU_INDEX_HTML_PLACEHOLDER__";
const hasEmbeddedIndex = !embeddedIndexHtml.startsWith("__TUYU_INDEX_HTML_");

function secure(response) {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders)) {
    secured.headers.set(name, value);
  }
  return secured;
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return secure(response);
    }

    if (hasEmbeddedIndex) {
      return secure(new Response(request.method === "HEAD" ? null : embeddedIndexHtml, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }));
    }

    const rootUrl = new URL(request.url);
    rootUrl.pathname = "/";
    rootUrl.search = "";
    return secure(await env.ASSETS.fetch(new Request(rootUrl, request)));
  },
};
