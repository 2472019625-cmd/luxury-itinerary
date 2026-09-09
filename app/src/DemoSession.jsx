import React, {useEffect, useState} from 'react';
import {AuthScreen} from './Workspace.jsx';

export function DemoSession({children}) {
  const [state,setState]=useState(null);
  const [error,setError]=useState('');
  useEffect(()=>{
    let alive=true;
    const original=window.fetch;
    const clear=()=>{window.__sheyouServerUser=null;setState({enabled:true,user:null});};
    const logout=async()=>{
      try {const res=await original('/api/auth/logout',{method:'POST'});if(!res.ok)throw Error();clear();}
      catch{setError('退出失败，请检查连接后重试');}
    };
    window.fetch=async(...args)=>{
      const response=await original(...args);
      const target=new URL(typeof args[0]==='string' ? args[0] : args[0].url || String(args[0]),location.href);
      if(alive && target.origin===location.origin && target.pathname.startsWith('/api/') && response.status===401)clear();
      return response;
    };
    window.addEventListener('sheyou-logout',logout);
    original('/api/auth/session',{cache:'no-store',signal:AbortSignal.timeout(15000)}).then(async res=>{
      if(res.status===404 && ['localhost','127.0.0.1'].includes(location.hostname)) return {enabled:false};
      if(!res.ok)throw Error();return res.json();
    }).then(data=>{if(alive){window.__sheyouServerUser=data.user || null;setState(data);}}).catch(()=>{if(alive)setError('暂时无法验证登录状态，请刷新重试');});
    return()=>{alive=false;window.fetch=original;window.removeEventListener('sheyou-logout',logout);};
  },[]);
  if(error)return <main className="auth-screen"><p role="alert">{error}</p><button onClick={()=>location.reload()}>重新连接</button></main>;
  if(!state)return <main className="auth-screen">正在验证登录状态…</main>;
  if(state.enabled && !state.user)return <AuthScreen serverLogin={async(login,password)=>{
    const res=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({login,password})});
    const data=await res.json();if(!res.ok)throw Error(data.error || '登录失败');return data.user;
  }} onAuth={user=>{window.__sheyouServerUser=user;setState({enabled:true,user});}}/>;
  return children;
}
