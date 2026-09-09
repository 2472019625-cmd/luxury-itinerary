import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function createDemoAuth({ enabled = process.env.NODE_ENV === 'production', file = process.env.SHEYOU_AUTH_FILE, origin = process.env.SHEYOU_PUBLIC_ORIGIN, now = Date.now, secure = true } = {}) {
  if (!enabled) return async (req, res, url) => {
    if (url.pathname !== '/api/auth/session') return false;
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); res.end('{"enabled":false}'); return true;
  };
  if (!file || !origin || new URL(origin).origin !== origin) throw Error('Demo authentication requires credential file and exact public origin');
  const account = JSON.parse(readFileSync(file, 'utf8'));
  if (!account.login || !/^[a-f0-9]{32}$/.test(account.salt) || !/^[a-f0-9]{128}$/.test(account.hash)) throw Error('Invalid Demo credential file');
  const sessions = new Map();
  let attempts = 0, windowEnd = 0;
  const ttl = 8 * 3600 * 1000;
  const cookieName = secure ? '__Host-sheyou_session' : 'sheyou_session';
  const cookie = value => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? ttl / 1000 : 0}${secure ? '; Secure' : ''}`;
  const user = {id:'shared-demo',name:'奢游 Demo',login:account.login,isAdmin:false,active:true};
  return async (req, res, url) => {
    const reply = (status, data) => {res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));return true;};
    // Only direct, same-machine render traffic. The public proxy MUST overwrite Host
    // and X-Forwarded-For; forwarded requests never receive this exemption.
    const internal = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^127\.0\.0\.1:\d+$/.test(req.headers.host || '') && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
    if (internal && ['GET','HEAD'].includes(req.method)) {
      if(url.pathname === '/api/auth/session') return reply(200,{enabled:false});
      if(!url.pathname.startsWith('/api/')) return false;
    }
    for (const [key, expires] of sessions) if(expires <= now()) sessions.delete(key);
    const token = (req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const key = token ? createHash('sha256').update(token).digest('hex') : '';
    const authenticated = sessions.has(key);
    if(req.method === 'GET' && url.pathname === '/api/auth/session') return reply(200,{enabled:true,user:authenticated ? user : null});
    const mutation = !['GET','HEAD'].includes(req.method);
    if(mutation && req.headers.origin !== origin) return reply(403,{error:'请求来源不可信'});
    if(req.method === 'POST' && url.pathname === '/api/auth/login') {
      if(now() >= windowEnd){attempts=0;windowEnd=now()+60000;}
      if(++attempts > 10) return reply(429,{error:'登录尝试过多，请一分钟后再试'});
      let body = '';
      try {
        if(!String(req.headers['content-type']).startsWith('application/json')) return reply(415,{error:'需要 JSON 请求'});
        for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>4096)return reply(413,{error:'请求过大'});}
        const data=JSON.parse(body);
        if(typeof data.password !== 'string' || data.password.length>256) return reply(401,{error:'账号或密码不正确'});
        const actual=scryptSync(data.password,account.salt,64);
        if(!timingSafeEqual(actual,Buffer.from(account.hash,'hex')) || data.login !== account.login) return reply(401,{error:'账号或密码不正确'});
        if(sessions.size>=1000) return reply(429,{error:'会话数量已达上限'});
        const fresh=randomBytes(32).toString('hex');
        sessions.set(createHash('sha256').update(fresh).digest('hex'),now()+ttl);
        res.setHeader('set-cookie',cookie(fresh));return reply(200,{user});
      } catch { return reply(400,{error:'登录请求无效'}); }
    }
    if(req.method==='POST' && url.pathname==='/api/auth/logout'){sessions.delete(key);res.setHeader('set-cookie',cookie(''));return reply(200,{ok:true});}
    if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/image-assets/')) {
      if(!authenticated)return reply(401,{error:'请先登录',code:'AUTH_REQUIRED'});
    }
    return false;
  };
}
