import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";

async function request(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作失败");
  return result;
}

export function SharedApiSettings({ onClose }) {
  const [services, setServices] = useState([]);
  const [mode, setMode] = useState("legacy");
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState({});
  const [error, setError] = useState("");
  const [pins, setPins] = useState({ currentPin:"", newPin:"" });
  useEffect(() => {
    let active = true;
    request("/api/admin/api-keys").then((result) => { if (active) { setServices(result.services || []); setMode(result.mode || "legacy"); } }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  const perform = async (id, action) => {
    setBusy(id); setError("");
    try {
      if (action === "save") {
        const result = await request(`/api/admin/api-keys/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey: values[id] || "" }) });
        setServices(result.services || []);
        setValues((current) => ({ ...current, [id]: "" }));
        setFeedback((current) => ({ ...current, [id]: "已保存。新开始的任务会使用这把 Key。" }));
      } else if (action === "test") {
        const result = await request(`/api/admin/api-keys/${id}/test`, { method: "POST" });
        setFeedback((current) => ({ ...current, [id]: result.message }));
      } else if (action === "remove" && window.confirm("确定移除这项共用 Key？移除后员工将无法开始需要该服务的新任务。")) {
        const result = await request(`/api/admin/api-keys/${id}`, { method: "DELETE" });
        setServices(result.services || []);
        setFeedback((current) => ({ ...current, [id]: "已移除" }));
      }
    } catch (failure) { setFeedback((current) => ({ ...current, [id]: failure.message })); }
    finally { setBusy(""); }
  };
  const switchMode = async (nextMode) => {
    const message = nextMode === "shared" ? "确定启用共用 Key？此后所有员工新开始的任务都会使用这里配置的 Key；正在运行的任务不受影响。" : "确定回退旧 Key？此后新任务将使用原有服务端配置；已经开始的任务不受影响。";
    if (!window.confirm(message)) return;
    setBusy("mode"); setError("");
    try {
      const result = await request("/api/admin/api-keys/mode", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ mode:nextMode }) });
      setMode(result.mode);
      setServices(result.services || []);
      setFeedback((current) => ({ ...current, mode:nextMode === "shared" ? "共用 Key 已启用，仅影响新任务。" : "已回退旧 Key，仅影响新任务。" }));
    } catch (failure) { setFeedback((current) => ({ ...current, mode:failure.message })); }
    finally { setBusy(""); }
  };
  const changePin = async (event) => {
    event.preventDefault(); setBusy("pin"); setError("");
    try {
      await request("/api/auth/change-pin", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(pins) });
      setPins({ currentPin:"", newPin:"" });
      setFeedback((current) => ({ ...current, pin:"PIN已更新，其他设备上的登录已失效。" }));
    } catch (failure) { setFeedback((current) => ({ ...current, pin:failure.message })); }
    finally { setBusy(""); }
  };
  return createPortal(<div className="shared-api-settings-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="shared-api-settings" role="dialog" aria-modal="true" aria-labelledby="shared-api-settings-title">
      <header><div><small>奢游内部共用</small><h2 id="shared-api-settings-title">接口设置</h2><p>模型和用途由系统预设。负责人只需为各服务填写一次 Key，员工无需重复设置。</p></div><button type="button" onClick={onClose} aria-label="关闭接口设置">×</button></header>
      {error && <p role="alert" className="shared-api-settings-error">{error}</p>}
      <div className="shared-api-settings-mode"><div><strong>{mode === "shared" ? "共用 Key 已启用" : "当前仍使用旧 Key"}</strong><p>{mode === "shared" ? "全员新任务使用下方已保存的共用 Key。" : "现有账号继续按原方式生成；下方 Key 可以先配置和测试，不会自动切换。"}</p>{feedback.mode && <p role="status">{feedback.mode}</p>}</div><button type="button" disabled={Boolean(busy) || (mode === "legacy" && services.some((service) => !service.configured))} onClick={() => switchMode(mode === "shared" ? "legacy" : "shared")}>{mode === "shared" ? "回退旧 Key" : "启用共用 Key"}</button></div>
      <div className="shared-api-settings-list">{services.map((service) => <article key={service.id}>
        <div className="shared-api-settings-service"><div><strong>{service.label}</strong><small>{service.provider}{service.models?.length ? ` · ${service.models.join("、")}` : ""}</small></div><span className={service.configured ? "configured" : "missing"}>{service.configured ? "已配置" : "未配置"}</span></div>
        <label htmlFor={`shared-key-${service.id}`}>接口 Key</label>
        <input id={`shared-key-${service.id}`} type="password" autoComplete="new-password" placeholder={service.configured ? "填写新 Key 可替换；原 Key 不会显示" : "请输入接口 Key"} value={values[service.id] || ""} onChange={(event) => setValues((current) => ({ ...current, [service.id]: event.target.value }))} />
        <div className="shared-api-settings-actions"><button type="button" disabled={Boolean(busy) || !values[service.id]?.trim()} onClick={() => perform(service.id, "save")}>保存 Key</button><button type="button" disabled={Boolean(busy) || !service.configured} onClick={() => perform(service.id, "test")}>测试连接</button>{service.configured && mode !== "shared" && <button type="button" disabled={Boolean(busy)} onClick={() => perform(service.id, "remove")}>移除</button>}</div>
        {feedback[service.id] && <p role="status">{feedback[service.id]}</p>}
      </article>)}<form className="shared-api-settings-pin" onSubmit={changePin}><h3>管理账号 PIN</h3><p>初始账号交付后，请负责人在这里修改 PIN。</p><label htmlFor="shared-current-pin">当前 PIN</label><input id="shared-current-pin" type="password" inputMode="numeric" maxLength="6" value={pins.currentPin} onChange={(event) => setPins((current) => ({ ...current, currentPin:event.target.value }))} /><label htmlFor="shared-new-pin">新 PIN</label><input id="shared-new-pin" type="password" inputMode="numeric" maxLength="6" value={pins.newPin} onChange={(event) => setPins((current) => ({ ...current, newPin:event.target.value }))} /><button type="submit" disabled={Boolean(busy) || !/^\d{6}$/.test(pins.currentPin) || !/^\d{6}$/.test(pins.newPin)}>修改 PIN</button>{feedback.pin && <p role="status">{feedback.pin}</p>}</form></div>
      <footer>测试连接可能产生少量接口调用。Key 仅在服务端保存，页面不会回显原文。</footer>
    </section>
  </div>, document.body);
}
