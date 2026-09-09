export default {
  async fetch(request, env) {
    // Static Sites preview has no generation backend; keep its existing local UI.
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/auth/session') {
      return Response.json({enabled:false}, {headers:{'cache-control':'no-store'}});
    }
    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
