import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';

const validDigest = (value, length) => new RegExp(`^[a-f0-9]{${length}}$`).test(String(value || ''));
const publicUser = user => ({ id:user.id, name:user.name, login:user.login, active:user.active !== false });
const passwordMatches = (password, user) => {
  if (typeof password !== 'string' || password.length > 256 || !validDigest(user.salt, 32) || !validDigest(user.hash, 128)) return false;
  return timingSafeEqual(scryptSync(password, user.salt, 64), Buffer.from(user.hash, 'hex'));
};

export function createDemoAuth({
  enabled = process.env.NODE_ENV === 'production',
  file = process.env.SHEYOU_AUTH_FILE,
  usersFile = process.env.SHEYOU_USERS_FILE,
  inviteCode = process.env.SHEYOU_INVITE_CODE,
  origin = process.env.SHEYOU_PUBLIC_ORIGIN,
  now = Date.now,
  secure = true,
} = {}) {
  if (!enabled) return async (req, res, url) => {
    req.authDisabled = true;
    if (url.pathname !== '/api/auth/session') return false;
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); res.end('{"enabled":false}'); return true;
  };
  if (!file || !origin || new URL(origin).origin !== origin) throw Error('Authentication requires credential file and exact public origin');
  const legacy = JSON.parse(readFileSync(file, 'utf8'));
  if (!legacy.login || !validDigest(legacy.salt, 32) || !validDigest(legacy.hash, 128)) throw Error('Invalid credential file');
  const registryFile = path.resolve(usersFile || `${file}.users.json`);
  const legacyUser = { id:'shared-demo', name:String(legacy.name || legacy.login || 'dsy'), login:String(legacy.login), salt:legacy.salt, hash:legacy.hash, active:true };
  const readUsers = () => {
    if (!existsSync(registryFile)) return [legacyUser];
    const stored = JSON.parse(readFileSync(registryFile, 'utf8'));
    const users = Array.isArray(stored?.users) ? stored.users.filter(user => user?.id && user?.login && validDigest(user.salt, 32) && validDigest(user.hash, 128)) : [];
    return [legacyUser, ...users.filter(user => user.id !== legacyUser.id && user.login !== legacyUser.login)];
  };
  const writeUsers = users => {
    mkdirSync(path.dirname(registryFile), { recursive:true });
    const temporary = `${registryFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version:1, users:users.filter(user => user.id !== legacyUser.id) }, null, 2)}\n`, { encoding:'utf8', mode:0o600 });
    renameSync(temporary, registryFile);
  };
  const sessions = new Map();
  let attempts = 0, windowEnd = 0;
  const ttl = 8 * 3600 * 1000;
  const cookieName = secure ? '__Host-sheyou_session' : 'sheyou_session';
  const cookie = value => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? ttl / 1000 : 0}${secure ? '; Secure' : ''}`;
  const issueSession = (res, user, reply) => {
    if (sessions.size >= 1000) return reply(429, {error:'会话数量已达上限'});
    const fresh = randomBytes(32).toString('hex');
    sessions.set(createHash('sha256').update(fresh).digest('hex'), { userId:user.id, expiresAt:now()+ttl });
    res.setHeader('set-cookie', cookie(fresh));
    return reply(200, {user:publicUser(user)});
  };
  const readJsonBody = async req => {
    if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('需要 JSON 请求'), { status:415 });
    let body = '';
    for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) throw Object.assign(new Error('请求过大'), { status:413 }); }
    return JSON.parse(body || '{}');
  };
  return async (req, res, url) => {
    const reply = (status, data) => {res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));return true;};
    const internal = ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && /^127\.0\.0\.1:\d+$/.test(req.headers.host || '') && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
    if (internal && ['GET','HEAD'].includes(req.method)) {
      req.authInternal = true;
      if (url.pathname === '/api/auth/session') return reply(200,{enabled:false});
      if (!url.pathname.startsWith('/api/')) return false;
    }
    for (const [key, session] of sessions) if (session.expiresAt <= now()) sessions.delete(key);
    const token = (req.headers.cookie || '').split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const key = token ? createHash('sha256').update(token).digest('hex') : '';
    const session = sessions.get(key);
    const user = session ? readUsers().find(item => item.id === session.userId && item.active !== false) : null;
    if (user) req.authUser = publicUser(user);
    if (req.method === 'GET' && url.pathname === '/api/auth/session') return reply(200,{enabled:true,user:user ? publicUser(user) : null,registrationEnabled:Boolean(inviteCode)});
    const mutation = !['GET','HEAD'].includes(req.method);
    if (mutation && req.headers.origin !== origin) return reply(403,{error:'请求来源不可信'});
    if (req.method === 'POST' && ['/api/auth/login','/api/auth/register'].includes(url.pathname)) {
      if (now() >= windowEnd) { attempts=0; windowEnd=now()+60000; }
      if (++attempts > 10) return reply(429,{error:'尝试次数过多，请一分钟后再试'});
      try {
        const data = await readJsonBody(req);
        if (url.pathname === '/api/auth/register') {
          if (!inviteCode || data.invite !== inviteCode) return reply(403,{error:'公司邀请码不正确'});
          const name = String(data.name || '').trim();
          const login = String(data.login || '').trim();
          const password = String(data.password || '');
          if (!name || login.length < 3 || password.length < 6 || password.length > 256) return reply(400,{error:'请完整填写姓名、登录账号和至少6位密码'});
          const users = readUsers();
          if (users.some(item => item.login.toLowerCase() === login.toLowerCase())) return reply(409,{error:'该登录账号已被使用'});
          const salt = randomBytes(16).toString('hex');
          const created = { id:`user-${randomBytes(12).toString('hex')}`, name, login, salt, hash:scryptSync(password,salt,64).toString('hex'), active:true, createdAt:new Date(now()).toISOString() };
          writeUsers([...users, created]);
          return issueSession(res, created, reply);
        }
        const login = String(data.login || '').trim();
        const matched = readUsers().find(item => item.login === login && item.active !== false);
        if (!matched || !passwordMatches(data.password, matched)) return reply(401,{error:'账号或密码不正确'});
        return issueSession(res, matched, reply);
      } catch (error) { return reply(error.status || 400,{error:error.message || '登录请求无效'}); }
    }
    if (req.method==='POST' && url.pathname==='/api/auth/logout') { if (key) sessions.delete(key); res.setHeader('set-cookie',cookie('')); return reply(200,{ok:true}); }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/image-assets/')) {
      if (!user) return reply(401,{error:'请先登录',code:'AUTH_REQUIRED'});
    }
    return false;
  };
}
