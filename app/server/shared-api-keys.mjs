import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";

export const SHARED_API_SERVICES = Object.freeze([
  { id: "text", label: "文案与行程规划", provider: "当前文字模型服务" },
  { id: "search", label: "联网核验与图片搜索", provider: "当前搜索模型服务" },
  { id: "vision", label: "图片视觉检查", provider: "当前视觉模型服务" },
  { id: "you", label: "酒店与餐饮资料搜索", provider: "You.com" },
]);

const serviceIds = new Set(SHARED_API_SERVICES.map((service) => service.id));

function atomicWrite(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

export class SharedApiKeyStore {
  constructor({ file, masterFile = `${file}.master` } = {}) {
    if (!file) throw new Error("共用接口配置缺少服务端存储位置");
    this.file = path.resolve(file);
    this.masterFile = path.resolve(masterFile);
    this.master = null;
  }

  masterKey() {
    if (this.master) return this.master;
    if (!existsSync(this.masterFile)) {
      if (existsSync(this.file)) throw new Error("共用接口加密密钥文件缺失，不能读取已保存的 Key");
      atomicWrite(this.masterFile, `${randomBytes(32).toString("hex")}\n`);
    }
    const value = readFileSync(this.masterFile, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("共用接口加密密钥文件无效");
    this.master = Buffer.from(value, "hex");
    return this.master;
  }

  readDocument() {
    if (!existsSync(this.file)) return { version: 1, mode: "legacy", keys: {} };
    const saved = JSON.parse(readFileSync(this.file, "utf8"));
    if (saved.version !== 1 || ![undefined, "legacy", "shared"].includes(saved.mode) || typeof saved.keys !== "object" || !saved.keys || Array.isArray(saved.keys)) throw new Error("共用接口配置文件无效");
    return { ...saved, mode: saved.mode || "legacy" };
  }

  mode() {
    return this.readDocument().mode;
  }

  get(serviceId) {
    if (!serviceIds.has(serviceId)) throw new Error("未知接口服务");
    const entry = this.readDocument().keys[serviceId];
    if (!entry) return "";
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey(), Buffer.from(entry.iv, "hex"));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "hex")), decipher.final()]).toString("utf8");
  }

  status() {
    const entries = this.readDocument().keys;
    return SHARED_API_SERVICES.map((service) => ({ ...service, configured: Boolean(entries[service.id]), updatedAt: entries[service.id]?.updatedAt || null }));
  }

  set(serviceId, apiKey) {
    if (!serviceIds.has(serviceId)) throw new Error("未知接口服务");
    if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 2048 || /[\r\n]/.test(apiKey)) throw new Error("请输入有效的接口 Key");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(apiKey.trim(), "utf8"), cipher.final()]);
    const document = this.readDocument();
    document.keys[serviceId] = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex"), updatedAt: new Date().toISOString() };
    atomicWrite(this.file, `${JSON.stringify(document, null, 2)}\n`);
    return this.status();
  }

  delete(serviceId) {
    if (!serviceIds.has(serviceId)) throw new Error("未知接口服务");
    const document = this.readDocument();
    if (document.mode === "shared") throw new Error("共用 Key 已启用，请先回退旧配置再移除");
    delete document.keys[serviceId];
    atomicWrite(this.file, `${JSON.stringify(document, null, 2)}\n`);
    return this.status();
  }

  activate() {
    const document = this.readDocument();
    const missing = SHARED_API_SERVICES.filter((service) => !document.keys[service.id]).map((service) => service.label);
    if (missing.length) throw new Error(`请先配置全部接口 Key：${missing.join("、")}`);
    for (const service of SHARED_API_SERVICES) this.get(service.id);
    atomicWrite(this.file, `${JSON.stringify({ ...document, mode: "shared" }, null, 2)}\n`);
  }

  useLegacy() {
    const document = this.readDocument();
    atomicWrite(this.file, `${JSON.stringify({ ...document, mode: "legacy" }, null, 2)}\n`);
  }
}

export async function testSharedApiService(serviceId, { apiKey, modelConfig, searchModelConfig, visionModelConfig, fetchImpl = fetch } = {}) {
  if (!serviceIds.has(serviceId)) throw new Error("未知接口服务");
  if (!apiKey) throw new Error("请先保存接口 Key");
  const signal = AbortSignal.timeout(20000);
  try {
    const response = serviceId === "you"
      ? await fetchImpl("https://ydc-index.io/v1/search", { method: "POST", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query: "Kenya", count: 1 }), signal })
      : await (() => {
        const config = serviceId === "text" ? modelConfig : serviceId === "search" ? searchModelConfig : visionModelConfig;
        return fetchImpl(`${String(config?.baseUrl || "").replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config?.model, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 8, stream: false }), signal });
      })();
    return { connected: response.ok, message: response.ok ? "连接成功" : `连接失败（HTTP ${response.status}），请核对 Key 和该服务的额度。` };
  } catch {
    return { connected: false, message: "暂时无法连接服务，请稍后重试或检查服务状态。" };
  }
}
