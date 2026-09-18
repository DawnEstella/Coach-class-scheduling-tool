'use strict';
/* =========================================================
 * 健身教练排课 - 单页应用
 * 数据保存在 IndexedDB（旧 localStorage 数据自动迁移）；支持 JSON 导出/导入
 * ========================================================= */

/* ---------------- DOM 工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* ---------------- 日期工具 ---------------- */
const DAY_MS = 86400000;
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const pad = n => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function dateToStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function strToDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayStr() { return dateToStr(new Date()); }
function addDaysStr(s, n) { const d = strToDate(s); d.setDate(d.getDate() + n); return dateToStr(d); }
function hm(mins) { return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; }
function cnDate(s) { const d = strToDate(s); return `${d.getMonth() + 1}月${d.getDate()}日`; }
function weekdayCN(s) { return '周' + WEEK_CN[strToDate(s).getDay()]; }
function relLabel(s) {
  const diff = Math.round((strToDate(s) - strToDate(todayStr())) / DAY_MS);
  return { 0: '今天', 1: '明天', 2: '后天' }[diff] || '';
}
function lessonRange(l) { return `${hm(l.start)} - ${hm(l.end)}`; }

/* ---------------- 数据层（IndexedDB，附 localStorage 一次性迁移） ---------------- */
const STORE_KEY = 'fitcoach_data_v1';   // 旧 localStorage 键：仅用于迁移
const IDB_NAME = 'fitcoach';
const IDB_STORE = 'kv';
const IDB_KEY = 'state';

function defaultDB() { return { members: [], lessons: [], settings: { defaultDuration: 60 } }; }
function normalizeDB(d) {
  const def = defaultDB();
  if (!d || !Array.isArray(d.members) || !Array.isArray(d.lessons)) return def;
  return {
    members: d.members, lessons: d.lessons,
    settings: Object.assign({ defaultDuration: 60 }, d.settings || {})
  };
}

let db = defaultDB();   // 异步加载真实数据后替换，见底部 init()

/** 打开（或创建）IndexedDB */
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
/** 简单封装：读取 */
async function idbGet(key) {
  const conn = await openIDB();
  try {
    return await new Promise((resolve, reject) => {
      const rq = conn.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  } finally { conn.close(); }
}
/** 简单封装：写入 */
async function idbSet(key, val) {
  const conn = await openIDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = conn.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { conn.close(); }
}

async function loadDB() {
  // 1) 优先读 IndexedDB
  try {
    const stored = await idbGet(IDB_KEY);
    if (stored) return normalizeDB(stored);
  } catch (e) { console.warn('IndexedDB 读取失败，尝试旧数据迁移', e); }
  // 2) 首次升级：从旧 localStorage 一次性迁移，成功后移除旧键
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const migrated = normalizeDB(JSON.parse(raw));
      await idbSet(IDB_KEY, migrated);
      localStorage.removeItem(STORE_KEY);
      console.info('已从 localStorage 迁移到 IndexedDB');
      return migrated;
    }
  } catch (e) { console.warn('旧数据迁移失败', e); }
  return defaultDB();
}

let saveTimer = null;
function save() {   // 调用方式与旧版一致：异步落盘，无需 await
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    idbSet(IDB_KEY, db).catch(err => {
      console.error('保存失败', err);
      toast('数据保存失败：' + (err && err.message ? err.message : err));
    });
  }, 50);
}
function getMember(id) { return db.members.find(m => m.id === id) || null; }
function memberName(l) { return (l && l.memberName) || '已删除会员'; }
function lessonsOn(dateStr) {
  return db.lessons
    .filter(l => l.date === dateStr)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/* ---------------- 课程操作（含课时扣减/退还、冲突检测） ---------------- */
function findConflict(date, start, end, ignoreId) {
  return db.lessons.find(l =>
    l.id !== ignoreId && l.date === date && l.status !== 'canceled' &&
    l.start < end && start < l.end) || null;
}
function createLesson({ memberId, date, start, duration, cost, type, note }) {
  const member = memberId ? getMember(memberId) : null;
  const lesson = {
    id: uid(), memberId: member ? member.id : null,
    memberName: member ? member.name : '未知会员',
    date, start, end: start + duration, duration,
    cost: cost || 1, type: type || '私教', note: note || '',
    status: 'booked', createdAt: Date.now()
  };
  db.lessons.push(lesson); save();
  return lesson;
}
/** booked -> done：扣课时；其它状态的转换自动处理退还 */
function setLessonStatus(lesson, status) {
  const member = lesson.memberId ? getMember(lesson.memberId) : null;
  const refund = () => { if (member) { member.hours += lesson.cost; } };
  const deduct = () => { if (member) { member.hours -= lesson.cost; } };

  if (status === 'done' && lesson.status === 'booked') deduct();
  else if (status === 'booked') {
    if (lesson.status === 'done') refund();           // 撤销完成
    // canceled -> booked：预约阶段未扣过，无需处理
  } else if (status === 'canceled') {
    if (lesson.status === 'done') refund();           // 已上完的课被取消：退还
  }
  lesson.status = status;
  save();
}
function deleteLesson(lesson) {
  if (lesson.status === 'done') setLessonStatus(lesson, 'canceled'); // 删除已完成记录：退还课时
  db.lessons = db.lessons.filter(l => l.id !== lesson.id);
  save();
}

/* =========================================================
 * 中文对话解析
 * 支持：今天/明天/后天、周X、9月18日、下午3点半、15:00、
 *       一个半小时、60分钟、2课时，私教/体验课...
 * ========================================================= */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function convNum(s) {
  if (s == null) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (s === '十') return 10;
  let m = s.match(/^十([一二两三四五六七八九])$/);
  if (m) return 10 + CN_NUM[m[1]];
  m = s.match(/^([一二两三四五六七八九])十([一二两三四五六七八九])?$/);
  if (m) return CN_NUM[m[1]] * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  if (CN_NUM[s] !== undefined) return CN_NUM[s];
  return null;
}
const N = '(?:[0-9]{1,2}(?:\\.[05])?|[一二两三四五六七八九十]{1,3})'; // 数字 token

function fw2half(s) {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function parseChinese(raw, now = new Date()) {
  const res = { date: null, start: null, duration: null, cost: null, type: null };
  let work = fw2half(raw).replace(/\s+/g, '').replace(/[。！？!?，、,.]/g, '');

  /* ---------- 时间 ---------- */
  let period = null;
  const pm = work.match(/上午|早上|早晨|中午|下午|傍晚|晚上/);
  if (pm) period = pm[0];

  if (/现在|此刻/.test(work)) {
    res.start = now.getHours() * 60 + now.getMinutes();
    work = work.replace(/现在|此刻/, '');
  } else {
    let m = work.match(/(\d{1,2})[:：](\d{1,2})/);
    if (m) {
      let hh = +m[1], mm = +m[2];
      if (hh <= 23 && mm <= 59) {
        if ((period === '下午' || period === '傍晚' || period === '晚上') && hh < 12) hh += 12;
        res.start = hh * 60 + mm;
        work = work.replace(m[0], '');
      }
    } else {
      m = work.match(new RegExp(
        `(上午|早上|早晨|中午|下午|傍晚|晚上)?(${N})[点時时](?:(半|一刻|三刻)|(${N})分?)?`));
      if (m) {
        let hh = convNum(m[2]);
        let mm = 0;
        if (m[3] === '半') mm = 30;
        else if (m[3] === '一刻') mm = 15;
        else if (m[3] === '三刻') mm = 45;
        else if (m[4] != null) mm = convNum(m[4]) ?? -1;
        const per = m[1] || period;
        if (hh != null && mm >= 0 && mm <= 59 && hh <= 12) {
          if ((per === '下午' || per === '傍晚' || per === '晚上') && hh < 12) hh += 12;
          else if (per === '中午' && hh < 11) hh += 12;
          else if ((per === '上午' || per === '早上' || per === '早晨') && hh === 12) hh = 0;
          if (hh <= 23) { res.start = hh * 60 + mm; work = work.replace(m[0], ''); }
        }
      }
    }
  }

  /* ---------- 日期 ---------- */
  const cur = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const setD = (y, mo, da) => {
    const d = new Date(y, mo - 1, da);
    if (d.getFullYear() === y && d.getMonth() === mo - 1 && d.getDate() === da) {
      res.date = dateToStr(d);
    }
  };
  let m;
  if ((m = work.match(/大后天/))) { res.date = dateToStr(new Date(+cur + 3 * DAY_MS)); work = work.replace(m[0], ''); }
  else if ((m = work.match(/后天/))) { res.date = dateToStr(new Date(+cur + 2 * DAY_MS)); work = work.replace(m[0], ''); }
  else if ((m = work.match(/明天|明日/))) { res.date = dateToStr(new Date(+cur + DAY_MS)); work = work.replace(m[0], ''); }
  else if ((m = work.match(/今天|今日|今晚|今早/))) { res.date = dateToStr(cur); work = work.replace(m[0], ''); }
  else if ((m = work.match(/(下|这|本)?(?:周|星期|礼拜)([日天七一二三四五六])/))) {
    const map = { 日: 0, 天: 0, 七: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    let off = (map[m[2]] - cur.getDay() + 7) % 7;
    if (m[1] === '下') off += 7;
    res.date = dateToStr(new Date(+cur + off * DAY_MS));
    work = work.replace(m[0], '');
  }
  else if ((m = work.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})[号日]?/))) {
    setD(+m[1], +m[2], +m[3]); work = work.replace(m[0], '');
  }
  else if ((m = work.match(/(\d{1,2})月(\d{1,2})[号日]?/))) {
    let y = cur.getFullYear();
    if (+m[1] < cur.getMonth() + 1 || (+m[1] === cur.getMonth() + 1 && +m[2] < cur.getDate())) y++;
    setD(y, +m[1], +m[2]); work = work.replace(m[0], '');
  }
  else if ((m = work.match(/(\d{1,2})\/(\d{1,2})(?!\d)/))) {
    let y = cur.getFullYear();
    if (+m[1] < cur.getMonth() + 1 || (+m[1] === cur.getMonth() + 1 && +m[2] < cur.getDate())) y++;
    setD(y, +m[1], +m[2]); work = work.replace(m[0], '');
  }

  /* ---------- 时长 ---------- */
  const readDur = () => {
    let mm;
    if ((mm = work.match(new RegExp(`(${N})个半?小时`)))) {
      const n = convNum(mm[1]);
      const half = mm[0].includes('个半');
      if (n != null) { res.duration = Math.round((half ? n + 0.5 : n) * 60); work = work.replace(mm[0], ''); return; }
    }
    if ((mm = work.match(new RegExp(`(${N})小时半`)))) {
      const n = convNum(mm[1]);
      if (n != null) { res.duration = Math.round((n + 0.5) * 60); work = work.replace(mm[0], ''); return; }
    }
    if (work.includes('半小时')) { res.duration = 30; work = work.replace('半小时', ''); return; }
    if ((mm = work.match(new RegExp(`(${N})小时`)))) {
      const n = convNum(mm[1]);
      if (n != null) { res.duration = Math.round(n * 60); work = work.replace(mm[0], ''); return; }
    }
    if (work.includes('一刻钟')) { res.duration = 15; work = work.replace('一刻钟', ''); return; }
    if ((mm = work.match(/([0-9]{1,3}|[一二两三四五六七八九十]{1,3})分钟?/))) {
      const n = convNum(mm[1]);
      if (n != null && n >= 5 && n <= 300) { res.duration = n; work = work.replace(mm[0], ''); }
    }
  };
  readDur();

  /* ---------- 扣几课时 ---------- */
  const cm = work.match(new RegExp(`(${N})(?:个)?(?:课时|节课|次课)`));
  if (cm) {
    const n = convNum(cm[1]);
    if (n != null && n > 0 && n <= 10) res.cost = n;
  }

  /* ---------- 课程类型 ---------- */
  const types = ['私教', '体验课', '拉伸', '拳击', '搏击', '瑜伽', '普拉提', '有氧', '团课', '康复', '体能', '动感单车', '游泳'];
  for (const t of types) {
    if (work.includes(t)) { res.type = t === '体验' ? '体验课' : t; break; }
  }
  if (!res.type && work.includes('体验')) res.type = '体验课';

  return res;
}

/** 在文本中查找会员（姓名包含 / 手机尾号） */
function findMemberCandidates(text) {
  const t = fw2half(text).replace(/\s+/g, '');
  const cands = [];
  for (const m of db.members) {
    if (m.name && t.includes(m.name)) cands.push(m);
    else if (m.phone && m.phone.length >= 4 && t.includes(m.phone.slice(-4))) cands.push(m);
  }
  // 去重
  return cands.filter((m, i) => cands.findIndex(x => x.id === m.id) === i);
}

/* =========================================================
 * UI：通用（Toast / 底部弹窗 / 确认框）
 * ========================================================= */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function openSheet(contentNodes) {
  closeModal();
  const mask = h('div', { class: 'mask', onclick: e => { if (e.target === mask) closeModal(); } });
  const sheet = h('div', { class: 'sheet' }, contentNodes);
  mask.appendChild(sheet);
  $('#modal-root').appendChild(mask);
  return sheet;
}
function confirmSheet({ title, desc, okText = '确定', okClass = 'primary-btn', onOk }) {
  openSheet([
    h('h3', {}, title),
    desc ? h('p', { class: 'setting-desc' }, desc) : null,
    h('div', { class: 'sheet-actions' }, [
      h('button', { class: 'secondary-btn cancel-sheet', onclick: closeModal }, '取消'),
      h('button', { class: okClass, onclick: () => { closeModal(); onOk(); } }, okText)
    ])
  ]);
}

/* =========================================================
 * 对话排课引擎
 * ========================================================= */
const chatLog = $('#chat-log');
let pendingCombine = null; // 多轮追问时，把回答拼回原句

function botMsg(lines, buttons = []) {
  const frag = document.createDocumentFragment();
  const msg = h('div', { class: 'msg bot' });
  for (const ln of [].concat(lines)) msg.appendChild(h('div', {}, ln));
  frag.appendChild(msg);
  if (buttons.length) {
    const wrap = h('div', { class: 'msg bot', style: 'background:transparent;box-shadow:none;padding:4px 2px 0;' },
      [h('div', { class: 'msg-actions' }, buttons.map(b =>
        h('button', { class: b.cls || '', onclick: b.run }, b.label)))]);
    frag.appendChild(wrap);
  }
  chatLog.appendChild(frag);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function userMsg(text) {
  chatLog.appendChild(h('div', { class: 'msg user' }, text));
  chatLog.scrollTop = chatLog.scrollHeight;
}

function lessonLine(l, prefix = '') {
  const mem = getMember(l.memberId);
  const name = mem ? mem.name : l.memberName;
  const stMap = { booked: '待上课', done: '已完成', canceled: '已取消' };
  return `${prefix}${hm(l.start)}-${hm(l.end)} ${name} · ${l.type}（${stMap[l.status]}，${l.cost}课时）`;
}
function gotoSchedule(date) {
  if (date) { selectedDate = date; calCursor = strToDate(date); }
  switchTab('schedule');
}
const btnViewSchedule = (date = todayStr()) => ({
  label: '查看当天课表', run: () => gotoSchedule(date)
});

/* ---------- 意图处理 ---------- */
function handleText(rawText) {
  const text0 = fw2half(rawText).trim();
  if (!text0) return;

  // 多轮追问：回答不是新的指令时，拼回原句
  const isCommand = /约|排|取消|删|上完|完成|下课|课表|有什么课|有课吗|课时|帮助|会员|你好/.test(text0);
  let text = text0;
  if (pendingCombine && !isCommand) {
    text = `${pendingCombine} ${text0}`;
    pendingCombine = null;
  } else {
    pendingCombine = null;
  }
  userMsg(text0);

  const p = parseChinese(text);
  const cands = findMemberCandidates(text);
  const t = text.replace(/\s+/g, '');

  const isCancel = /取消|不去了|删掉|删除|退课/.test(t);
  const isDone = /上完了?|已经上|已上|完成|打卡|下课了?|标记完成/.test(t);
  const isHoursQ = /(多少|几|剩余|还剩|余额|查).{0,4}课时|课时.{0,4}(多少|几|余额|剩余)/.test(t);
  const isScheduleQ = /课表|有什么课|有哪些课|什么安排|安排了什么|有课吗|几节课|上什么课/.test(t);
  const isHelp = /帮助|怎么用|你会什么|help|功能/.test(t);
  const isAddMember = /(新增|添加|建).{0,3}会员/.test(t);
  const isBookVerb = /约|排课|安排|预订|预定|订一|定一|加一节|加课|来练|来上课|带他/.test(t);

  if (isAddMember) return openMemberModal(null);
  if (isHelp) return replyHelp();
  if (isCancel) return handleCancel(p, cands, text);
  if (isDone) return handleDone(p, cands, text);
  if (isHoursQ) return replyHours(cands);
  if (isScheduleQ) return replySchedule(p, cands);

  // 排课：有明确动词，或同时具备日期/时间/会员
  if (isBookVerb || (cands.length === 1 && p.date && p.start) || (cands.length === 1 && isBookVerb)) {
    return handleBook(p, cands, text);
  }
  // "明天张三" 这类：当作查某天某会员的课
  if (cands.length === 1 && p.date) return replySchedule(p, cands);
  // 只提到会员：回复会员概况
  if (cands.length === 1) return replyMemberCard(cands[0]);
  if (/^你好|^嗨|^hi/i.test(t)) return replyHelp();

  botMsg(['没太理解这句话，可以试试这样说 👇',
    '· 明天下午3点给张三排一节私教',
    '· 周六上午10点 李四 90分钟 2课时',
    '· 今天有什么课',
    '· 取消明天张三的课',
    '· 张三还剩多少课时'],
    [{ label: '帮助', run: replyHelp }]);
}

function replyHelp() {
  botMsg(['我是你的排课助手，直接用中文告诉我就行：',
    '',
    '📅 排课："明天下午3点半 张三 私教"',
    '   支持 今天/明天/后天/周X/9月18日',
    '   时长可说"90分钟""一个半小时"，默认' + db.settings.defaultDuration + '分钟',
    '🔍 查课："今天有什么课""周五李四的课"',
    '✅ 完成："完成今天3点张三的课"（自动扣课时）',
    '❌ 取消："取消明天张三的课"',
    '⏱ 课时："张三还剩多少课时"',
    '',
    '时间冲突会自动拦截；课时不足会提醒你确认。']);
}

/* ---------- 查询 ---------- */
function replySchedule(p, cands) {
  const date = p.date || todayStr();
  let list = lessonsOn(date).filter(l => l.status !== 'canceled');
  if (cands.length === 1) list = list.filter(l => l.memberId === cands[0].id);
  const head = `${cnDate(date)} ${weekdayCN(date)}${relLabel(date) ? '（' + relLabel(date) + '）' : ''}` +
    (cands.length === 1 ? ` ${cands[0].name}` : '');
  if (!list.length) {
    botMsg([`${head} 没有排课。`],
      cands.length === 1
        ? [{ label: `给${cands[0].name}约课`, run: () => { switchTab('chat'); prefillChat(cands[0].name + ' '); } }]
        : [{ label: '去排课', run: () => switchTab('chat') }, { label: '查看课表', run: () => gotoSchedule(date) }]);
    return;
  }
  const totalDone = list.filter(l => l.status === 'done').length;
  botMsg([`${head} 共 ${list.length} 节（已完成 ${totalDone} 节）：`,
    '', ...list.map(l => lessonLine(l, '· '))],
    [{ label: '查看课表', run: () => gotoSchedule(date) }]);
}

function replyHours(cands) {
  if (!db.members.length) {
    botMsg(['还没有会员，先添加一位会员吧。'], [{ label: '＋ 新增会员', run: () => openMemberModal(null) }]);
    return;
  }
  if (cands.length === 1) {
    const m = cands[0];
    const upcoming = db.lessons.filter(l =>
      l.memberId === m.id && l.status === 'booked' && l.date >= todayStr()).length;
    botMsg([`${m.name} 当前剩余 ${m.hours} 课时。`,
      upcoming ? `另有 ${upcoming} 节已预约未上的课。` : '目前没有待上的课。'],
      [{ label: `给${m.name}约课`, run: () => { switchTab('chat'); prefillChat(m.name + ' '); } }]);
    return;
  }
  const low = [...db.members].sort((a, b) => a.hours - b.hours).slice(0, 8);
  botMsg(['请告诉我哪位会员，或查看课时最少的会员：', '',
    ...low.map(m => `· ${m.name}：${m.hours} 课时`)]);
}

function replyMemberCard(m) {
  const upcoming = db.lessons
    .filter(l => l.memberId === m.id && l.status === 'booked' && l.date >= todayStr())
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const lines = [`${m.name}：剩余 ${m.hours} 课时`];
  if (upcoming.length) {
    lines.push('', '下一节课：');
    const l = upcoming[0];
    lines.push(`· ${cnDate(l.date)}（${weekdayCN(l.date)}${relLabel(l.date) ? '·' + relLabel(l.date) : ''}）${lessonRange(l)} ${l.type}`);
  }
  botMsg(lines, [
    { label: `给${m.name}约课`, run: () => { switchTab('chat'); prefillChat(m.name + ' '); } },
    { label: '编辑会员', run: () => openMemberModal(m) }
  ]);
}

/* ---------- 排课 ---------- */
function handleBook(p, cands, text) {
  // 会员不明确
  if (!cands.length) {
    if (!db.members.length) {
      botMsg(['还没有会员，排课前请先添加会员（至少填写姓名和剩余课时）。'],
        [{ label: '＋ 新增会员', run: () => openMemberModal(null) }]);
      return;
    }
    // 多轮：等用户回复会员名
    pendingCombine = text;
    botMsg(['要给哪位会员排课？'], db.members.slice(0, 8).map(m => ({
      label: m.name, run: () => handleText(`${text} ${m.name}`)
    })));
    return;
  }
  if (cands.length > 1) {
    pendingCombine = text;
    botMsg(['找到多位会员，请问是哪一位？'], cands.slice(0, 8).map(m => ({
      label: m.name, run: () => handleText(`${text} ${m.name}`)
    })));
    return;
  }
  const member = cands[0];

  // 日期/时间不明确 → 追问（下一轮把回答拼回来）
  if (!p.date && !p.start) {
    pendingCombine = text;
    botMsg(['安排在哪天、几点？', '例如：明天下午3点 / 周六上午10点 / 9月20日19:00']);
    return;
  }
  if (!p.start) {
    pendingCombine = text;
    botMsg(['几点开始？', '例如：下午3点半 / 18:00']);
    return;
  }
  const date = p.date || todayStr();
  const duration = p.duration || db.settings.defaultDuration || 60;
  const cost = p.cost || 1;
  const type = p.type || '私教';
  const start = p.start;
  const end = start + duration;

  const lessonDraft = { memberId: member.id, date, start, duration, cost, type };

  // 时间冲突检测
  const conflict = findConflict(date, start, end);
  if (conflict) {
    const cm = getMember(conflict.memberId);
    botMsg([`⚠️ 时间冲突，排课失败！`,
      `${cnDate(date)} ${lessonRange(conflict)} 已经有 ${cm ? cm.name : conflict.memberName} 的${conflict.type}课。`,
      '请换个时间再约。'],
      [{ label: '查看当天课表', run: () => gotoSchedule(date) }]);
    return;
  }

  const summary = [
    `确认排课信息：`,
    `· 会员：${member.name}（剩 ${member.hours} 课时）`,
    `· 时间：${cnDate(date)} ${weekdayCN(date)}${relLabel(date) ? '（' + relLabel(date) + '）' : ''} ${hm(start)}-${hm(end)}`,
    `· 类型：${type}　时长：${duration}分钟`,
    `· 完成后扣减：${cost} 课时`
  ];

  const doCreate = (warnPast) => {
    const now = new Date();
    const startDT = strToDate(date);
    startDT.setHours(Math.floor(start / 60), start % 60, 0, 0);
    if (warnPast === undefined && startDT < now) {
      botMsg([...summary, '', '⚠️ 这个时间已经过去了，仍要安排吗？'].slice(0),
        [{ label: '仍然安排', cls: 'warn', run: () => doCreate(true) },
         { label: '不安排了', cls: 'danger', run: () => {} }]);
      return;
    }
    if (member.hours < cost) {
      // 课时不足：需确认
      botMsg([...summary, '', `⚠️ ${member.name} 剩余 ${member.hours} 课时，不足 ${cost}，确认要安排吗？（完成后课时将为负数）`],
        [{ label: '确认安排', cls: 'warn', run: () => reallyCreate() },
         { label: '取消', cls: 'danger', run: () => {} }]);
      return;
    }
    reallyCreate();
  };
  const reallyCreate = () => {
    const l = createLesson(lessonDraft);
    renderSchedule(); renderMembers(); renderStats();
    botMsg([`✅ 已排好课：`, '', lessonLine(l, '· '), '',
      `上课并点击"完成"后，将扣减 ${cost} 课时。`],
      [{ label: '查看课表', run: () => gotoSchedule(date) },
       { label: '再约一节', run: () => switchTab('chat') }]);
  };
  doCreate();
}

/* ---------- 取消 / 完成 ---------- */
function locateLessons(p, cands, { includeDone = false } = {}) {
  let list = db.lessons.filter(l => l.status !== 'canceled');
  if (!includeDone) list = list.filter(l => l.status === 'booked');
  if (cands.length === 1) list = list.filter(l => l.memberId === cands[0].id);
  if (p.date) list = list.filter(l => l.date === p.date);
  list.sort((a, b) => (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));

  if (!p.date && !p.start) {
    // 没说时间：取现在或将来的最近一节
    const now = new Date();
    const today = todayStr();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const upcoming = list.filter(l => l.date > today || (l.date === today && l.end >= nowMin));
    if (upcoming.length) return [upcoming[0]];
    return list.length ? [list[list.length - 1]] : [];
  }
  if (p.date && p.start != null) {
    const sameDay = list.filter(l => l.date === p.date);
    if (sameDay.length) {
      sameDay.sort((a, b) => Math.abs(a.start - p.start) - Math.abs(b.start - p.start));
      return [sameDay[0]];
    }
    return [];
  }
  return list;
}

function handleCancel(p, cands, text) {
  if (!cands.length) {
    botMsg(['要取消哪位会员的课？可以说："取消明天下午3点张三的课"。']);
    return;
  }
  if (cands.length > 1) {
    botMsg(['找到多位会员，请说完整会员姓名。']);
    return;
  }
  const targets = locateLessons(p, cands, { includeDone: true });
  if (!targets.length) {
    botMsg([`没有找到${cands[0].name}可取消的课。`],
      [btnViewSchedule(p.date || todayStr())]);
    return;
  }
  if (targets.length > 1) {
    botMsg([`${cands[0].name} 有多节课，点击要取消的那节：`],
      targets.slice(0, 6).map(l => ({
        label: `${cnDate(l.date)} ${hm(l.start)} ${l.type}`,
        run: () => confirmCancel(l)
      })));
    return;
  }
  confirmCancel(targets[0]);
}
function confirmCancel(l) {
  const refundNote = l.status === 'done' ? `该课已标记完成，取消后会退还 ${l.cost} 课时。` : '预约课未扣课时，取消不影响余额。';
  botMsg([`确认取消这节课吗？`,
    `· ${cnDate(l.date)}（${weekdayCN(l.date)}）${lessonRange(l)} ${l.memberName} ${l.type}`,
    refundNote],
    [{ label: '确认取消', cls: 'warn', run: () => {
        setLessonStatus(l, 'canceled');
        renderSchedule(); renderMembers(); renderStats();
        botMsg(['已取消。']);
      } },
     { label: '保留', run: () => {} }]);
}

function handleDone(p, cands) {
  if (!cands.length) {
    botMsg(['要完成哪位会员的课？可以说："完成今天下午3点张三的课"。']);
    return;
  }
  if (cands.length > 1) { botMsg(['找到多位会员，请说完整会员姓名。']); return; }
  const targets = locateLessons(p, cands);
  if (!targets.length) {
    botMsg([`没有找到${cands[0].name}待完成的课。`], [btnViewSchedule(p.date || todayStr())]);
    return;
  }
  if (targets.length > 1) {
    botMsg([`点击要标记完成的课：`],
      targets.slice(0, 6).map(l => ({
        label: `${cnDate(l.date)} ${hm(l.start)} ${l.type}`,
        run: () => reallyComplete(l)
      })));
    return;
  }
  reallyComplete(targets[0]);
}
function reallyComplete(l) {
  const mem = getMember(l.memberId);
  setLessonStatus(l, 'done');
  renderSchedule(); renderMembers(); renderStats();
  botMsg([`✅ 已完成：`, lessonLine(l, '· '),
    mem ? `已扣减 ${l.cost} 课时，${mem.name} 剩余 ${mem.hours} 课时。`
        : '会员已删除，未扣减课时。']);
}

/* =========================================================
 * 视图切换
 * ========================================================= */
const TITLES = { schedule: '课表', chat: '对话排课', members: '会员', settings: '设置' };
let currentTab = 'schedule';
function switchTab(name) {
  currentTab = name;
  $$('.view').forEach(v => v.hidden = v.id !== `view-${name}`);
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $('#topbar-title').textContent = TITLES[name];
  $('#topbar-right').innerHTML = '';
  if (name === 'schedule') {
    $('#topbar-right').appendChild(h('button', {
      class: 'link-btn', onclick: () => { selectedDate = todayStr(); calCursor = strToDate(selectedDate); renderSchedule(); }
    }, '今天'));
    renderSchedule();
  }
  if (name === 'chat') {
    $('#chat-input').focus({ preventScroll: true });
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  if (name === 'members') renderMembers();
  if (name === 'settings') renderStats();
}
$$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.view)));

/* =========================================================
 * 课表视图：月历 + 当天列表
 * ========================================================= */
let calCursor = new Date();           // 月份游标
let selectedDate = todayStr();

function renderSchedule() {
  renderCalendar();
  renderDayStrip();
  renderDayLessons();
}

function renderCalendar() {
  const y = calCursor.getFullYear(), mo = calCursor.getMonth();
  $('#cal-title').textContent = `${y}年${mo + 1}月`;
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const first = new Date(y, mo, 1);
  const startOffset = first.getDay();
  const gridDate = new Date(y, mo, 1 - startOffset);
  const t = todayStr();
  for (let i = 0; i < 42; i++) {
    const ds = dateToStr(gridDate);
    const inMonth = gridDate.getMonth() === mo;
    const cell = h('div', { class: 'cal-cell' +
      (inMonth ? '' : ' other') +
      (ds === t ? ' today' : '') +
      (ds === selectedDate ? ' selected' : ''),
      onclick: () => { selectedDate = ds; renderSchedule(); } });
    cell.appendChild(h('span', { class: 'cal-num' }, String(gridDate.getDate())));
    const dots = lessonsOn(ds).filter(l => l.status !== 'canceled').slice(0, 3);
    if (dots.length) {
      cell.appendChild(h('div', { class: 'cal-dots' },
        dots.map(l => h('i', { class: l.status === 'done' ? 'done' : '' }))));
    }
    grid.appendChild(cell);
    gridDate.setDate(gridDate.getDate() + 1);
  }
}
$('#cal-prev').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() - 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calCursor.setMonth(calCursor.getMonth() + 1); renderCalendar(); });

function renderDayStrip() {
  const strip = $('#day-strip');
  strip.innerHTML = '';
  for (let i = 0; i < 10; i++) {
    const ds = addDaysStr(todayStr(), i);
    const d = strToDate(ds);
    const hasLesson = lessonsOn(ds).some(l => l.status !== 'canceled');
    strip.appendChild(h('div', {
      class: 'day-chip' + (ds === selectedDate ? ' active' : ''),
      onclick: () => { selectedDate = ds; calCursor = strToDate(ds); renderSchedule(); }
    }, [
      h('span', { class: 'dw' }, i === 0 ? '今天' : '周' + WEEK_CN[d.getDay()]),
      h('span', { class: 'dd' }, String(d.getDate())),
      hasLesson ? h('span', { class: 'pip' }) : null
    ]));
  }
  // 让选中项可见
  const active = $('.day-chip.active', strip);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function renderDayLessons() {
  const wrap = $('#day-lessons');
  wrap.innerHTML = '';
  $('#day-title').textContent =
    `${cnDate(selectedDate)} ${weekdayCN(selectedDate)}${relLabel(selectedDate) ? ' · ' + relLabel(selectedDate) : ''}`;

  const list = lessonsOn(selectedDate);
  if (!list.length) {
    wrap.appendChild(h('div', { class: 'empty-box' }, [
      h('div', { class: 'big' }, '🗓️'),
      h('div', { class: 'hint' }, '这一天还没有排课'),
      h('button', {
        class: 'primary-btn',
        onclick: () => {
          switchTab('chat');
          prefillChat(selectedDate === todayStr() ? '' : `${calCursor.getMonth() + 1}月${strToDate(selectedDate).getDate()}日 `);
        }
      }, '＋ 安排一节课')
    ]));
    return;
  }
  for (const l of list) wrap.appendChild(lessonCard(l));
}

function lessonCard(l) {
  const mem = getMember(l.memberId);
  const name = mem ? mem.name : l.memberName;
  const stTag = {
    booked: ['booked', '待上课'], done: ['done', '已完成'], canceled: ['canceled', '已取消']
  }[l.status];

  const body = h('div', { class: 'lesson-body' }, [
    h('div', { class: 'lesson-row1' }, [
      h('span', { class: 'lesson-name' }, name),
      h('span', { class: 'tag type' }, l.type),
      h('span', { class: 'tag ' + stTag[0] }, stTag[1])
    ]),
    h('div', { class: 'lesson-meta' },
      `${l.duration}分钟 · 扣${l.cost}课时${mem ? ` · 剩${mem.hours}` : ''}${l.note ? ' · ' + l.note : ''}`)
  ]);

  const actions = h('div', { class: 'lesson-actions' });
  if (l.status === 'booked') {
    actions.appendChild(h('button', {
      class: 'mini-btn done', onclick: () => reallyComplete(l)
    }, '✅ 完成上课'));
    actions.appendChild(h('button', {
      class: 'mini-btn cancel', onclick: () => confirmSheet({
        title: '取消这节课？',
        desc: `${cnDate(l.date)}（${weekdayCN(l.date)}）${lessonRange(l)} ${l.memberName}。预约课未扣课时，取消不影响余额。`,
        okText: '确认取消', okClass: 'danger-btn',
        onOk: () => {
          setLessonStatus(l, 'canceled');
          renderSchedule(); renderMembers(); renderStats();
          toast('已取消');
        }
      })
    }, '取消预约'));
  } else if (l.status === 'done') {
    actions.appendChild(h('button', {
      class: 'mini-btn restore', onclick: () => {
        setLessonStatus(l, 'booked'); renderSchedule(); renderMembers(); renderStats();
        toast('已撤销完成，课时已退回');
      }
    }, '↩️ 撤销完成'));
  } else if (l.status === 'canceled') {
    actions.appendChild(h('button', {
      class: 'mini-btn restore', onclick: () => {
        const c = findConflict(l.date, l.start, l.end, l.id);
        if (c) { toast('该时段已有其他课，无法恢复'); return; }
        setLessonStatus(l, 'booked'); renderSchedule(); renderMembers(); renderStats();
        toast('已恢复预约');
      }
    }, '恢复预约'));
    actions.appendChild(h('button', {
      class: 'mini-btn del', onclick: () => confirmSheet({
        title: '删除这条记录？',
        desc: '删除后不可恢复。',
        okText: '删除', okClass: 'danger-btn',
        onOk: () => { deleteLesson(l); renderSchedule(); renderMembers(); renderStats(); toast('已删除'); }
      })
    }, '🗑 删除'));
  }
  body.appendChild(actions);

  const time = h('div', { class: 'lesson-time' }, [
    h('span', { class: 'st' }, hm(l.start)),
    h('span', { class: 'du' }, `${l.duration}分`)
  ]);
  const card = h('div', { class: 'lesson-card is-' + l.status,
    onclick: (e) => { if (e.target.closest('button')) return; openLessonDetail(l); } },
    [time, body]);
  return card;
}

function openLessonDetail(l) {
  const mem = getMember(l.memberId);
  const stMap = { booked: '待上课', done: '已完成', canceled: '已取消' };
  const row = (k, v) => h('div', { class: 'detail-row' }, [
    h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)]);
  const sheet = openSheet([
    h('h3', {}, l.type + '课'),
    row('会员', mem ? mem.name : l.memberName + '（已删除）'),
    row('日期', `${cnDate(l.date)} ${weekdayCN(l.date)}`),
    row('时间', `${lessonRange(l)}（${l.duration}分钟）`),
    row('课时', `${l.cost} 课时`),
    row('状态', stMap[l.status]),
    l.note ? row('备注', l.note) : null,
    h('div', { class: 'sheet-actions', style: 'margin-top:16px;' },
      [h('button', { class: 'secondary-btn cancel-sheet', onclick: closeModal }, '关闭')])
  ]);
}

/* FAB 与聊天快捷 */
function prefillChat(v) {
  const inp = $('#chat-input');
  inp.value = v || '';
  inp.focus();
}
$('#fab-book').addEventListener('click', () => {
  switchTab('chat');
  prefillChat(selectedDate === todayStr() ? '' : `${calCursor.getMonth() + 1}月${strToDate(selectedDate).getDate()}日 `);
});

/* =========================================================
 * 会员视图
 * ========================================================= */
function renderMembers() {
  const kw = ($('#member-search').value || '').trim().toLowerCase();
  const list = $('#member-list');
  list.innerHTML = '';
  const data = db.members
    .filter(m => !kw || m.name.toLowerCase().includes(kw) || (m.phone || '').includes(kw))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  if (!data.length) {
    list.appendChild(h('div', { class: 'empty-box' }, [
      h('div', { class: 'big' }, db.members.length ? '🔍' : '👤'),
      h('div', { class: 'hint' }, db.members.length ? '没有匹配的会员' : '还没有会员，添加第一位吧'),
      h('button', { class: 'primary-btn', onclick: () => openMemberModal(null) }, '＋ 新增会员')
    ]));
    return;
  }
  for (const m of data) list.appendChild(memberCard(m));
}
function memberCard(m) {
  const cls = m.hours <= 0 ? 'zero' : m.hours <= 3 ? 'low' : '';
  const adjust = (delta) => {
    m.hours = Math.max(-999, Number((m.hours + delta).toFixed(1)));
    save(); renderMembers(); renderStats();
  };
  return h('div', { class: 'member-card' }, [
    h('div', { class: 'member-row' }, [
      h('div', {}, [
        h('div', { class: 'member-name' }, m.name),
        m.phone ? h('div', { class: 'member-phone' }, '📞 ' + m.phone) : null,
        m.note ? h('div', { class: 'member-note' }, m.note) : null
      ]),
      h('div', { class: 'hours-badge ' + cls }, [
        h('div', { class: 'num' }, String(m.hours)),
        h('div', { class: 'lbl' }, '剩余课时')
      ])
    ]),
    h('div', { class: 'member-card-actions' }, [
      h('button', { class: 'mini-btn', onclick: () => { switchTab('chat'); prefillChat(m.name + ' '); } }, '约课'),
      h('button', { class: 'mini-btn', onclick: () => adjust(-1) }, '−1 课时'),
      h('button', { class: 'mini-btn', onclick: () => adjust(1) }, '+1 课时'),
      h('button', { class: 'mini-btn', onclick: () => openMemberModal(m) }, '编辑'),
      h('button', {
        class: 'mini-btn', onclick: () => confirmSheet({
          title: `删除会员「${m.name}」？`,
          desc: '该会员的历史排课记录会保留，但不再与其关联。',
          okText: '删除', okClass: 'danger-btn',
          onOk: () => {
            db.members = db.members.filter(x => x.id !== m.id);
            for (const l of db.lessons) if (l.memberId === m.id) l.memberId = null;
            save(); renderMembers(); renderSchedule(); renderStats(); toast('已删除');
          }
        })
      }, '删除')
    ])
  ]);
}
$('#member-search').addEventListener('input', renderMembers);
$('#btn-add-member').addEventListener('click', () => openMemberModal(null));

function openMemberModal(m) {
  const isEdit = !!m;
  const nameInp = h('input', { type: 'text', placeholder: '必填，例如：张三', value: m?.name || '', maxlength: '20' });
  const phoneInp = h('input', { type: 'tel', placeholder: '选填', value: m?.phone || '', maxlength: '20' });
  const hoursInp = h('input', { type: 'number', step: '1', min: '-999', value: String(m?.hours ?? 10) });
  const noteInp = h('textarea', { placeholder: '选填：训练目标、伤病情况等', maxlength: '100' });
  if (m) noteInp.value = m.note || '';

  const saveMember = () => {
    const name = nameInp.value.trim();
    if (!name) { toast('请填写会员姓名'); return; }
    const hours = Number(hoursInp.value);
    if (Number.isNaN(hours)) { toast('课时数不正确'); return; }
    if (isEdit) {
      m.name = name; m.phone = phoneInp.value.trim(); m.hours = hours; m.note = noteInp.value.trim();
      for (const l of db.lessons) if (l.memberId === m.id) l.memberName = name;
    } else {
      db.members.push({ id: uid(), name, phone: phoneInp.value.trim(), hours, note: noteInp.value.trim(), createdAt: Date.now() });
    }
    save(); renderMembers(); renderStats(); closeModal();
    toast(isEdit ? '已保存' : '会员已添加');
  };

  openSheet([
    h('h3', {}, isEdit ? '编辑会员' : '新增会员'),
    h('div', { class: 'field' }, [h('label', {}, '姓名'), nameInp]),
    h('div', { class: 'field' }, [h('label', {}, '手机号'), phoneInp]),
    h('div', { class: 'field' }, [h('label', {}, '剩余课时'), hoursInp]),
    h('div', { class: 'field' }, [h('label', {}, '备注'), noteInp]),
    h('div', { class: 'sheet-actions' }, [
      h('button', { class: 'secondary-btn cancel-sheet', onclick: closeModal }, '取消'),
      h('button', { class: 'primary-btn', onclick: saveMember }, '保存')
    ])
  ]);
  setTimeout(() => nameInp.focus(), 100);
}

/* =========================================================
 * 设置：统计、默认时长、备份
 * ========================================================= */
function renderStats() {
  const members = db.members.length;
  const hours = db.members.reduce((s, m) => s + (Number(m.hours) || 0), 0);
  const start = todayStr();
  const end = addDaysStr(start, 7);
  const week = db.lessons.filter(l => l.status !== 'canceled' && l.date >= start && l.date < end).length;
  const done = db.lessons.filter(l => l.status === 'done').length;
  $('#stats-grid').innerHTML = '';
  const items = [
    [members, '会员人数'], [hours, '剩余总课时'], [week, '未来7天课程'], [done, '累计完成']
  ];
  for (const [n, l] of items) {
    $('#stats-grid').appendChild(h('div', { class: 'stat-card' }, [
      h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, l)
    ]));
  }
  $$('#seg-duration button').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.val) === (db.settings.defaultDuration || 60)));
}
$$('#seg-duration button').forEach(b => b.addEventListener('click', () => {
  db.settings.defaultDuration = Number(b.dataset.val);
  save(); renderStats(); toast('默认时长已设为 ' + b.dataset.val + ' 分钟');
}));

/* ---------- 导出 / 导入 ---------- */
$('#btn-export').addEventListener('click', () => {
  const payload = {
    app: 'fitcoach-schedule', version: 1,
    exportedAt: new Date().toISOString(), data: db
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = h('a', {
    href: URL.createObjectURL(blob),
    download: `backup-${dateToStr(new Date())}.json`
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('备份已导出');
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    const data = obj && obj.app === 'fitcoach-schedule' ? obj.data : obj;
    if (!data || !Array.isArray(data.members) || !Array.isArray(data.lessons)) throw new Error('bad');
    confirmSheet({
      title: '导入备份？',
      desc: `这会覆盖当前所有数据，确定吗？备份包含 ${data.members.length} 位会员、${data.lessons.length} 条排课，建议先导出当前数据。`,
      okText: '确认覆盖导入',
      onOk: () => {
        db = normalizeDB(data);
        save();
        calCursor = new Date(); selectedDate = todayStr();
        renderSchedule(); renderMembers(); renderStats();
        toast('导入成功');
      }
    });
  } catch {
    toast('文件格式不正确，请选择本工具导出的 JSON');
  }
});
$('#btn-clear').addEventListener('click', () => confirmSheet({
  title: '清空全部数据？',
  desc: '所有会员、排课记录都会被删除且无法恢复，请先导出备份。',
  okText: '全部清空', okClass: 'danger-btn',
  onOk: () => {
    db = defaultDB(); save();
    calCursor = new Date(); selectedDate = todayStr();
    renderSchedule(); renderMembers(); renderStats();
    toast('已清空');
  }
}));

/* =========================================================
 * 聊天交互
 * ========================================================= */
$('#chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const inp = $('#chat-input');
  const v = inp.value.trim();
  if (!v) return;
  inp.value = '';
  handleText(v);
});
$$('.chat-chips .chip').forEach(c => c.addEventListener('click', () => handleText(c.dataset.text)));

/* ---------- 欢迎语 ---------- */
function welcome() {
  if (!db.members.length) {
    botMsg(['你好，我是排课助手 👋', '开始之前，请先添加你的会员（姓名 + 购买的课时数）。'],
      [{ label: '＋ 添加第一位会员', run: () => openMemberModal(null) },
       { label: '先看看怎么用', run: replyHelp }]);
  } else {
    botMsg(['你好 👋 直接用中文告诉我怎么排课就行，例如：',
      '"明天下午3点给张三排一节私教"', '',
      '时间冲突会自动拦截，下课后说"完成"即可扣课时。'],
      [{ label: '今天课表', run: () => handleText('今天有什么课') },
       { label: '帮助', run: replyHelp }]);
  }
}

/* ---------- PWA Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ---------- 启动：先加载 IndexedDB 数据，再渲染 ---------- */
(async function init() {
  db = await loadDB();
  renderSchedule();
  renderStats();
  welcome();
})();
