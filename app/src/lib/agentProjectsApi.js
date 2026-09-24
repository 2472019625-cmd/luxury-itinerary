const ROOT = "/api/agent-workspace/projects";

export function agentProjectHeaders(user, json = false) {
  const headers = {};
  if (!window.__sheyouServerUser && user?.id) headers["x-agent-local-user"] = user.id;
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function read(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "项目保存失败");
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export const agentProjectsApi = {
  list: (user) => fetch(ROOT, { cache: "no-store", headers: agentProjectHeaders(user) }).then(read),
  create: (user, project) => fetch(ROOT, { method: "POST", headers: agentProjectHeaders(user, true), body: JSON.stringify({ project }) }).then(read),
  update: (user, project, expectedRevision) => fetch(`${ROOT}/${encodeURIComponent(project.id)}`, { method: "PUT", headers: agentProjectHeaders(user, true), body: JSON.stringify({ project, expectedRevision }) }).then(read),
  trash: (user, id) => fetch(`${ROOT}/${encodeURIComponent(id)}/trash`, { method: "POST", headers: agentProjectHeaders(user) }).then(read),
  restore: (user, id) => fetch(`${ROOT}/${encodeURIComponent(id)}/restore`, { method: "POST", headers: agentProjectHeaders(user) }).then(read),
  remove: (user, id) => fetch(`${ROOT}/${encodeURIComponent(id)}`, { method: "DELETE", headers: agentProjectHeaders(user) }).then(read),
  uploadSource: (user, id, file) => fetch(`${ROOT}/${encodeURIComponent(id)}/source`, { method: "PUT", headers: { ...agentProjectHeaders(user), "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: file }).then(read),
};
