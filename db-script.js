(() => {
  'use strict';

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function compassBearing(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return '';
    const toRad = (d) => (d * Math.PI) / 180;
    const toDeg = (r) => (r * 180) / Math.PI;
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    const brng = (toDeg(Math.atan2(y, x)) + 360) % 360;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(brng / 45) % 8];
  }

  function formatPinDistanceReadout(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return '';
    const meters = haversineMeters(Number(lat1), Number(lon1), Number(lat2), Number(lon2));
    if (!Number.isFinite(meters)) return '';
    const dir = compassBearing(Number(lat1), Number(lon1), Number(lat2), Number(lon2));
    const mi = meters / 1609.344;
    const distStr = mi < 0.15 ? `${Math.round(meters * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
    const walkMins = Math.max(1, Math.round(meters / 80));
    const walkStr = mi <= 2.5 ? ` • ~${walkMins} min walk` : '';
    return `${distStr} ${dir}${walkStr}`;
  }

  function formatRichTimeDiff(targetInput, nowMs = Date.now()) {
    if (!targetInput) {
      return {
        text: 'No Date Set',
        badge: '⏳ TIMER',
        formattedDate: '',
        isPast: false,
        isNow: false,
        years: 0,
        months: 0,
        days: 0,
        hours: 0,
        minutes: 0,
      };
    }
    const targetMs = typeof targetInput === 'number' ? targetInput : Date.parse(targetInput);
    if (!Number.isFinite(targetMs)) {
      return {
        text: String(targetInput),
        badge: '⏳ TIMER',
        formattedDate: String(targetInput),
        isPast: false,
        isNow: false,
        years: 0,
        months: 0,
        days: 0,
        hours: 0,
        minutes: 0,
      };
    }

    const formattedDate = new Date(targetMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    const rawDiffMs = targetMs - nowMs;
    if (Math.abs(rawDiffMs) < 60000) {
      return {
        text: 'Happening Now!',
        badge: '🟢 HAPPENING NOW',
        formattedDate,
        isPast: false,
        isNow: true,
        years: 0,
        months: 0,
        days: 0,
        hours: 0,
        minutes: 0,
      };
    }

    const isPast = rawDiffMs < 0;
    const d1 = new Date(isPast ? targetMs : nowMs);
    const d2 = new Date(isPast ? nowMs : targetMs);

    let years = d2.getFullYear() - d1.getFullYear();
    let months = d2.getMonth() - d1.getMonth();
    let days = d2.getDate() - d1.getDate();
    let hours = d2.getHours() - d1.getHours();
    let minutes = d2.getMinutes() - d1.getMinutes();

    if (minutes < 0) {
      minutes += 60;
      hours -= 1;
    }
    if (hours < 0) {
      hours += 24;
      days -= 1;
    }
    if (days < 0) {
      const prevMonthDays = new Date(d2.getFullYear(), d2.getMonth(), 0).getDate();
      days += prevMonthDays;
      months -= 1;
    }
    if (months < 0) {
      months += 12;
      years -= 1;
    }

    const parts = [];
    if (years > 0) parts.push(`${years}y`);
    if (months > 0) parts.push(`${months}mo`);
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0 && parts.length < 4) parts.push(`${hours}h`);
    if (minutes > 0 && parts.length < 4) parts.push(`${minutes}m`);
    if (!parts.length) parts.push('< 1m');

    const text = isPast ? `${parts.join(' ')} ago` : parts.join(' ');
    const badge = isPast ? '⏪ PAST EVENT • ELAPSED' : '⏳ UPCOMING • COUNTDOWN';
    return { text, badge, formattedDate, isPast, isNow: false, years, months, days, hours, minutes };
  }

  function synthesizeScriptForPreset(type, dataObj = {}) {
    if (type === 'countdown') {
      return {
        code: [
          `state target = ${JSON.stringify(dataObj.target || '2026-12-25T11:11')}`,
          `let t = timeDiff(state.target)`,
          `big t.text sub=t.formattedDate badge=t.badge`,
        ].join('\n'),
        data: { target: dataObj.target || '2026-12-25T11:11' },
      };
    }
    if (type === 'kv') {
      const pairs = Array.isArray(dataObj.pairs) && dataObj.pairs.length
        ? dataObj.pairs
        : [{ k: 'Gate Code', v: '#1725' }, { k: 'Office Wi-Fi', v: 'DunderMifflin_5G' }];
      return {
        code: [
          `for pair, i in state.pairs`,
          `  kv pair.k, pair.v copy=true`,
          `end`,
          `input draft, "Add Key : Value (e.g. Room : 304)..." btn="+ Pin" -> pushPairs(state.pairs, state.draft); set state.draft = ""`,
        ].join('\n'),
        data: { pairs, draft: '' },
      };
    }
    if (type === 'checklist') {
      const items = Array.isArray(dataObj.items) && dataObj.items.length
        ? dataObj.items
        : [{ text: 'Dundie Trophies', done: true }, { text: 'Brown & Grey Balloons', done: false }];
      return {
        code: [
          `let doneCount = 0`,
          `for item, i in state.items`,
          `  if item.done`,
          `    set doneCount = doneCount + 1`,
          `  end`,
          `  check item.text, item.done -> set state.items[i].done = !state.items[i].done`,
          `end`,
          `progress (doneCount / max(1, len(state.items))) * 100`,
          `input draft, "Add checklist item..." btn="+ Add" -> if state.draft then push(state.items, {"text":state.draft,"done":false}); set state.draft = "" end`,
        ].join('\n'),
        data: { items, draft: '' },
      };
    }
    if (type === 'poll') {
      const options = Array.isArray(dataObj.options) && dataObj.options.length
        ? dataObj.options
        : [{ label: "Alfredo's Pizza Cafe", votes: ['Michael', 'Jim'] }, { label: 'Pizza by Alfredo', votes: [] }];
      return {
        code: [
          `for opt, i in state.options`,
          `  let voted = includes(opt.votes, user)`,
          `  let tally = len(opt.votes) + (len(opt.votes) == 1 ? " vote" : " votes") + (len(opt.votes) > 0 ? " (" + join(opt.votes, ", ") + ")" : "")`,
          `  btn opt.label right=tally active=voted -> set state.options[i].votes = toggleIn(state.options[i].votes, user)`,
          `end`,
        ].join('\n'),
        data: { options },
      };
    }
    if (type === 'pins') {
      const pins = Array.isArray(dataObj.pins) && dataObj.pins.length
        ? dataObj.pins
        : [{ kind: '🅿️ Parking', label: 'Level 3 Blue Giraffe, Spot 42', lat: 41.4091, lon: -75.6628, by: 'Michael' }];
      return {
        code: [
          `for p, i in state.pins`,
          `  pin p.kind + ": " + p.label, p.lat, p.lon note=("Dropped by " + p.by) index=i`,
          `end`,
          `input draft, "Spot or Meetup label (e.g. Lot C Row 4)..." btn="📍 Drop Pin" -> dropPin(state.pins, state.draft, "🅿️ Pin"); set state.draft = ""`,
        ].join('\n'),
        data: { pins, draft: '' },
      };
    }
    if (type === 'rounds') {
      const counts = dataObj.counts || { Michael: 1, Dwight: 0, Jim: 1, Pam: 0 };
      return {
        code: [
          `state counts = {"Michael":1,"Dwight":0,"Jim":1,"Pam":0}`,
          `for person, i in crew`,
          `  let c = state.counts[person] ? state.counts[person] : 0`,
          `  btn ("🍻 " + person + " bought a round") right=(c + " rounds") active=(c > 0) -> set state.counts[person] = (state.counts[person] ? state.counts[person] : 0) + 1`,
          `end`,
        ].join('\n'),
        data: { counts },
      };
    }
    if (type === 'turing') {
      return {
        code: [
          `state n = 27`,
          `state steps = 0`,
          `state trail = [27]`,
          `big ("n = " + state.n) sub=("Steps: " + state.steps + " • Peak: " + maxIn(state.trail)) badge="TURING-COMPLETE VM"`,
          `text ("Trajectory: " + join(state.trail, " → ")) muted=true`,
          `row`,
          `  btn "Step (3n+1)" -> if state.n > 1 then set state.n = (state.n % 2 == 0 ? state.n / 2 : 3 * state.n + 1); set state.steps = state.steps + 1; push(state.trail, state.n) end`,
          `  btn "Run while n>1" -> while state.n > 1 do set state.n = (state.n % 2 == 0 ? state.n / 2 : 3 * state.n + 1); set state.steps = state.steps + 1; push(state.trail, state.n) end`,
          `  btn "Reset (n=27)" -> set state.n = 27; set state.steps = 0; set state.trail = [27]`,
          `end`,
        ].join('\n'),
        data: { n: 27, steps: 0, trail: [27] },
      };
    }
    return {
      code: dataObj.code || `state count = 0\nbig ("Count: " + state.count) badge="CUSTOM DB-SCRIPT"\nrow\n  btn "+1 Increment" -> set state.count = state.count + 1\n  btn "Reset" -> set state.count = 0\nend`,
      data: dataObj.data || { count: 0 },
    };
  }

  function ensureMicroModuleScript(mm) {
    if (!mm) return mm;
    if (!mm.data || typeof mm.data !== 'object') {
      mm.data = {};
    }
    if (mm.type === 'countdown' && mm.targetTime && !mm.data.target) {
      mm.data.target = mm.targetTime;
    }
    if (mm.type === 'kv' && Array.isArray(mm.pairs) && !mm.data.pairs) {
      mm.data.pairs = mm.pairs;
    }
    if (mm.type === 'checklist' && Array.isArray(mm.items) && !mm.data.items) {
      mm.data.items = mm.items;
    }
    if (mm.type === 'poll' && Array.isArray(mm.options) && !mm.data.options) {
      mm.data.options = mm.options;
    }
    if (!mm.code || !String(mm.code).trim()) {
      const synth = synthesizeScriptForPreset(mm.type || 'script', mm.data);
      mm.code = synth.code;
      mm.data = { ...synth.data, ...mm.data };
    }
    return mm;
  }

  function tokenizeDbExpr(src) {
    const tokens = [];
    const s = String(src || '');
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (/\s/.test(ch)) { i++; continue; }
      const two = s.slice(i, i + 2);
      if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
        tokens.push({ type: 'op', val: two });
        i += 2;
        continue;
      }
      if ('+-*/%<>!?(),:[].{}'.includes(ch)) {
        tokens.push({ type: 'punc', val: ch });
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        let str = '';
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\' && i + 1 < s.length) {
            const nxt = s[i + 1];
            str += nxt === 'n' ? '\n' : nxt;
            i += 2;
          } else {
            str += s[i++];
          }
        }
        i++;
        tokens.push({ type: 'str', val: str });
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
        let num = '';
        while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
        tokens.push({ type: 'num', val: Number(num) });
        continue;
      }
      if (/[a-zA-Z_$]/.test(ch)) {
        let id = '';
        while (i < s.length && /[a-zA-Z0-9_$]/.test(s[i])) id += s[i++];
        if (id === 'and') tokens.push({ type: 'op', val: '&&' });
        else if (id === 'or') tokens.push({ type: 'op', val: '||' });
        else if (id === 'not') tokens.push({ type: 'punc', val: '!' });
        else if (id === 'true') tokens.push({ type: 'bool', val: true });
        else if (id === 'false') tokens.push({ type: 'bool', val: false });
        else if (id === 'null') tokens.push({ type: 'null', val: null });
        else tokens.push({ type: 'id', val: id });
        continue;
      }
      i++;
    }
    return tokens;
  }

  function evalDbExpr(exprStr, env, vm) {
    const tokens = tokenizeDbExpr(exprStr);
    if (!tokens.length) return undefined;
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parseTernary() {
      const cond = parseOr();
      if (peek()?.val === '?') {
        next();
        const yes = parseTernary();
        if (peek()?.val === ':') next();
        const no = parseTernary();
        return cond ? yes : no;
      }
      return cond;
    }

    function parseOr() {
      let left = parseAnd();
      while (peek()?.val === '||') {
        next();
        const right = parseAnd();
        left = Boolean(left || right);
      }
      return left;
    }

    function parseAnd() {
      let left = parseEq();
      while (peek()?.val === '&&') {
        next();
        const right = parseEq();
        left = Boolean(left && right);
      }
      return left;
    }

    function parseEq() {
      let left = parseRel();
      while (peek()?.val === '==' || peek()?.val === '!=') {
        const op = next().val;
        const right = parseRel();
        left = op === '==' ? left == right : left != right;
      }
      return left;
    }

    function parseRel() {
      let left = parseAdd();
      while (['<', '<=', '>', '>='].includes(peek()?.val)) {
        const op = next().val;
        const right = parseAdd();
        if (op === '<') left = left < right;
        else if (op === '<=') left = left <= right;
        else if (op === '>') left = left > right;
        else left = left >= right;
      }
      return left;
    }

    function parseAdd() {
      let left = parseMul();
      while (peek()?.val === '+' || peek()?.val === '-') {
        const op = next().val;
        const right = parseMul();
        left = op === '+' ? left + right : Number(left) - Number(right);
      }
      return left;
    }

    function parseMul() {
      let left = parseUnary();
      while (['*', '/', '%'].includes(peek()?.val)) {
        const op = next().val;
        const right = parseUnary();
        if (op === '*') left = Number(left) * Number(right);
        else if (op === '/') left = Number(right) === 0 ? 0 : Number(left) / Number(right);
        else left = Number(left) % Number(right);
      }
      return left;
    }

    function parseUnary() {
      if (peek()?.val === '!') { next(); return !parseUnary(); }
      if (peek()?.val === '-') { next(); return -Number(parseUnary()); }
      if (peek()?.val === '+') { next(); return +Number(parseUnary()); }
      return parsePostfix();
    }

    function parsePostfix() {
      let val = parsePrimary();
      while (peek()) {
        if (peek().val === '.') {
          next();
          const propTok = next();
          if (propTok) val = val != null ? val[propTok.val] : undefined;
        } else if (peek().val === '[') {
          next();
          const idx = parseTernary();
          if (peek()?.val === ']') next();
          val = val != null ? val[idx] : undefined;
        } else if (peek().val === '(' && typeof val === 'function') {
          next();
          const args = [];
          while (peek() && peek().val !== ')') {
            args.push(parseTernary());
            if (peek()?.val === ',') next();
          }
          if (peek()?.val === ')') next();
          val = val(...args);
        } else {
          break;
        }
      }
      return val;
    }

    function parsePrimary() {
      const tok = peek();
      if (!tok) return undefined;
      if (tok.type === 'num' || tok.type === 'str' || tok.type === 'bool' || tok.type === 'null') {
        next();
        return tok.val;
      }
      if (tok.val === '(') {
        next();
        const v = parseTernary();
        if (peek()?.val === ')') next();
        return v;
      }
      if (tok.val === '[') {
        next();
        const arr = [];
        while (peek() && peek().val !== ']') {
          arr.push(parseTernary());
          if (peek()?.val === ',') next();
        }
        if (peek()?.val === ']') next();
        return arr;
      }
      if (tok.val === '{') {
        next();
        const obj = {};
        while (peek() && peek().val !== '}') {
          const kTok = next();
          const k = kTok ? String(kTok.val) : '';
          if (peek()?.val === ':') next();
          obj[k] = parseTernary();
          if (peek()?.val === ',') next();
        }
        if (peek()?.val === '}') next();
        return obj;
      }
      if (tok.type === 'id') {
        next();
        const name = tok.val;
        if (peek()?.val === '(') {
          next();
          const args = [];
          while (peek() && peek().val !== ')') {
            args.push(parseTernary());
            if (peek()?.val === ',') next();
          }
          if (peek()?.val === ')') next();
          return callDbFunction(name, args, env, vm);
        }
        if (name === 'state') return env.state;
        if (name === 'user') return vm.ctx.user;
        if (name === 'crew') return vm.ctx.crew;
        if (name === 'trip') return vm.ctx.trip;
        if (name in env.locals) return env.locals[name];
        if (name in env.state) return env.state[name];
        return undefined;
      }
      next();
      return undefined;
    }

    return parseTernary();
  }

  function callDbFunction(name, args, env, vm) {
    if (++vm.steps > vm.maxSteps) { vm.halted = true; return null; }
    switch (name) {
      case 'now': return Date.now();
      case 'timeDiff':
      case 'age': return formatRichTimeDiff(args[0]);
      case 'len': return Array.isArray(args[0]) || typeof args[0] === 'string' ? args[0].length : 0;
      case 'min': return Math.min(Number(args[0] || 0), Number(args[1] || 0));
      case 'max': return Math.max(Number(args[0] || 0), Number(args[1] || 0));
      case 'maxIn': return Array.isArray(args[0]) && args[0].length ? Math.max(...args[0].map(Number)) : 0;
      case 'round': {
        const d = Number(args[1] || 0);
        const f = 10 ** d;
        return Math.round(Number(args[0] || 0) * f) / f;
      }
      case 'floor': return Math.floor(Number(args[0] || 0));
      case 'abs': return Math.abs(Number(args[0] || 0));
      case 'sum': return Array.isArray(args[0]) ? args[0].reduce((a, b) => a + Number(b || 0), 0) : 0;
      case 'join': return Array.isArray(args[0]) ? args[0].join(String(args[1] ?? ', ')) : '';
      case 'includes': return Array.isArray(args[0]) ? args[0].includes(args[1]) : false;
      case 'toggleIn': {
        const arr = Array.isArray(args[0]) ? [...args[0]] : [];
        const val = args[1];
        return arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];
      }
      case 'push': {
        if (Array.isArray(args[0])) args[0].push(args[1]);
        return args[0];
      }
      case 'removeAt': {
        if (Array.isArray(args[0])) args[0].splice(Number(args[1] || 0), 1);
        return args[0];
      }
      case 'pushPairs': {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        const raw = String(args[1] || '').trim();
        if (!raw) return arr;
        const idx = raw.indexOf(':');
        if (idx !== -1) arr.push({ k: raw.slice(0, idx).trim(), v: raw.slice(idx + 1).trim() });
        else arr.push({ k: raw, v: '' });
        return arr;
      }
      case 'dropPin': {
        const arr = Array.isArray(args[0]) ? args[0] : [];
        const label = String(args[1] || '').trim() || 'Pinned Location';
        const kind = String(args[2] || '🅿️ Pin');
        const lat = vm.ctx.trip?.lat ?? 41.40897;
        const lon = vm.ctx.trip?.lon ?? -75.66241;
        arr.push({ kind, label, lat, lon, by: vm.ctx.user || 'Crew' });
        return arr;
      }
      case 'distMi': {
        const m = haversineMeters(Number(args[0] || 0), Number(args[1] || 0), Number(args[2] || 0), Number(args[3] || 0));
        return Math.round((m / 1609.344) * 10) / 10;
      }
      case 'compass': return compassBearing(Number(args[0] || 0), Number(args[1] || 0), Number(args[2] || 0), Number(args[3] || 0));
      default: {
        const fnDef = vm.functions[name];
        if (fnDef) {
          const childEnv = { state: env.state, locals: { ...env.locals } };
          fnDef.params.forEach((p, idx) => { childEnv.locals[p] = args[idx]; });
          const res = execDbBlock(fnDef.body, childEnv, vm);
          return res?.returned ? res.value : undefined;
        }
        return undefined;
      }
    }
  }

  function assignDbLhs(lhsStr, val, env, vm) {
    const clean = lhsStr.trim();
    if (!clean.includes('.') && !clean.includes('[')) {
      if (clean in env.locals) env.locals[clean] = val;
      else env.state[clean] = val;
      return;
    }
    const tokens = tokenizeDbExpr(clean);
    if (!tokens.length) return;
    let rootName = tokens[0].val;
    let obj = rootName === 'state' ? env.state : (rootName in env.locals ? env.locals[rootName] : env.state[rootName]);
    let i = 1;
    const path = [];
    while (i < tokens.length) {
      if (tokens[i].val === '.') {
        i++;
        if (tokens[i]) path.push(tokens[i].val);
        i++;
      } else if (tokens[i].val === '[') {
        i++;
        let sub = '';
        let depth = 1;
        while (i < tokens.length && depth > 0) {
          if (tokens[i].val === '[') depth++;
          else if (tokens[i].val === ']') { depth--; if (depth === 0) { i++; break; } }
          if (depth > 0) {
            sub += tokens[i].type === 'str' ? JSON.stringify(tokens[i].val) : String(tokens[i].val) + ' ';
            i++;
          }
        }
        path.push(evalDbExpr(sub, env, vm));
      } else {
        i++;
      }
    }
    if (!path.length) return;
    for (let k = 0; k < path.length - 1; k++) {
      if (obj == null) return;
      obj = obj[path[k]];
    }
    if (obj != null) obj[path[path.length - 1]] = val;
  }

  function expandInlineDbLines(rawCode) {
    const out = [];
    String(rawCode || '')
      .split(/\r?\n/)
      .forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) return;
        const inlineIf = line.match(/^if\s+(.+?)\s+then\s+(.+?)\s+end$/i);
        if (inlineIf) {
          out.push(`if ${inlineIf[1]}`);
          inlineIf[2].split(';').forEach((s) => { if (s.trim()) out.push(s.trim()); });
          out.push('end');
          return;
        }
        const inlineWhile = line.match(/^while\s+(.+?)\s+do\s+(.+?)\s+end$/i);
        if (inlineWhile) {
          out.push(`while ${inlineWhile[1]}`);
          inlineWhile[2].split(';').forEach((s) => { if (s.trim()) out.push(s.trim()); });
          out.push('end');
          return;
        }
        if (line.includes('->')) {
          out.push(line);
          return;
        }
        line.split(';').forEach((part) => {
          if (part.trim()) out.push(part.trim());
        });
      });
    return out;
  }

  function splitTopLevelCommas(str) {
    const parts = [];
    let cur = '';
    let depth = 0;
    let inQuote = null;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (inQuote) {
        cur += c;
        if (c === '\\' && i + 1 < str.length) cur += str[++i];
        else if (c === inQuote) inQuote = null;
      } else if (c === '"' || c === "'") {
        inQuote = c;
        cur += c;
      } else if (c === '(' || c === '[' || c === '{') {
        depth++;
        cur += c;
      } else if (c === ')' || c === ']' || c === '}') {
        depth = Math.max(0, depth - 1);
        cur += c;
      } else if (c === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  function extractNamedAttrs(restStr) {
    const attrs = {};
    let mainExpr = restStr;
    const attrRegex = /\s+([a-zA-Z_]+)=((?:"[^"]*"|'[^']*'|\([^)]*\)|[^\s])+)/g;
    let match;
    let firstIdx = -1;
    while ((match = attrRegex.exec(restStr)) !== null) {
      if (firstIdx === -1) firstIdx = match.index;
      attrs[match[1]] = match[2];
    }
    if (firstIdx !== -1) {
      mainExpr = restStr.slice(0, firstIdx).trim();
    }
    return { mainExpr, attrs };
  }

  function findMatchingEnd(lines, startIdx) {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^(if|while|for|fn|row)\b/i.test(l)) depth++;
      else if (/^end\b/i.test(l)) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return lines.length - 1;
  }

  function execDbBlock(lines, env, vm, targetNodes = vm.nodes) {
    let i = 0;
    while (i < lines.length) {
      if (++vm.steps > vm.maxSteps) {
        vm.halted = true;
        return { returned: false };
      }
      const line = lines[i];

      let m = line.match(/^state\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(.+)$/);
      if (m) {
        const k = m[1];
        if (env.state[k] === undefined) {
          env.state[k] = evalDbExpr(m[2], env, vm);
        }
        i++;
        continue;
      }

      m = line.match(/^let\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(.+)$/);
      if (m) {
        env.locals[m[1]] = evalDbExpr(m[2], env, vm);
        i++;
        continue;
      }

      m = line.match(/^set\s+(.+?)\s*=\s*(.+)$/);
      if (m) {
        const val = evalDbExpr(m[2], env, vm);
        assignDbLhs(m[1], val, env, vm);
        i++;
        continue;
      }

      m = line.match(/^return(?:\s+(.+))?$/);
      if (m) {
        return { returned: true, value: m[1] ? evalDbExpr(m[1], env, vm) : undefined };
      }

      m = line.match(/^fn\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)$/);
      if (m) {
        const endIdx = findMatchingEnd(lines, i);
        const params = m[2].split(',').map((s) => s.trim()).filter(Boolean);
        vm.functions[m[1]] = { params, body: lines.slice(i + 1, endIdx) };
        i = endIdx + 1;
        continue;
      }

      if (/^if\s+/i.test(line)) {
        const endIdx = findMatchingEnd(lines, i);
        const branches = [];
        let curCond = line.replace(/^if\s+/i, '').trim();
        let curStart = i + 1;
        let depth = 0;
        for (let k = i + 1; k <= endIdx; k++) {
          const l = lines[k];
          if (/^(if|while|for|fn|row)\b/i.test(l)) depth++;
          else if (/^end\b/i.test(l) && depth > 0) depth--;
          else if (depth === 0 && (/^elif\s+/i.test(l) || /^else$/i.test(l) || k === endIdx)) {
            branches.push({ cond: curCond, body: lines.slice(curStart, k) });
            if (/^elif\s+/i.test(l)) {
              curCond = l.replace(/^elif\s+/i, '').trim();
              curStart = k + 1;
            } else if (/^else$/i.test(l)) {
              curCond = 'true';
              curStart = k + 1;
            }
          }
        }
        for (const b of branches) {
          if (evalDbExpr(b.cond, env, vm)) {
            const res = execDbBlock(b.body, env, vm, targetNodes);
            if (res?.returned) return res;
            break;
          }
        }
        i = endIdx + 1;
        continue;
      }

      if (/^while\s+/i.test(line)) {
        const endIdx = findMatchingEnd(lines, i);
        const condExpr = line.replace(/^while\s+/i, '').trim();
        const body = lines.slice(i + 1, endIdx);
        while (evalDbExpr(condExpr, env, vm)) {
          if (++vm.steps > vm.maxSteps) { vm.halted = true; break; }
          const res = execDbBlock(body, env, vm, targetNodes);
          if (res?.returned) return res;
          if (vm.halted) break;
        }
        i = endIdx + 1;
        continue;
      }

      m = line.match(/^for\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*,\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?\s+in\s+(.+)$/i);
      if (m) {
        const endIdx = findMatchingEnd(lines, i);
        const itemVar = m[1];
        const idxVar = m[2];
        const listVal = evalDbExpr(m[3], env, vm);
        const body = lines.slice(i + 1, endIdx);
        if (Array.isArray(listVal)) {
          for (let idx = 0; idx < listVal.length; idx++) {
            env.locals[itemVar] = listVal[idx];
            if (idxVar) env.locals[idxVar] = idx;
            const res = execDbBlock(body, env, vm, targetNodes);
            if (res?.returned) return res;
            if (vm.halted) break;
          }
        }
        i = endIdx + 1;
        continue;
      }

      if (/^row$/i.test(line)) {
        const endIdx = findMatchingEnd(lines, i);
        const rowChildren = [];
        execDbBlock(lines.slice(i + 1, endIdx), env, vm, rowChildren);
        targetNodes.push({ kind: 'row', children: rowChildren });
        i = endIdx + 1;
        continue;
      }

      if (/^countdown\s+/i.test(line)) {
        const { mainExpr, attrs } = extractNamedAttrs(line.replace(/^countdown\s+/i, '').trim());
        const targetVal = evalDbExpr(mainExpr, env, vm);
        const info = formatRichTimeDiff(targetVal);
        const customSub = attrs.label ? evalDbExpr(attrs.label, env, vm) : null;
        targetNodes.push({
          kind: 'big',
          text: info.text,
          badge: info.badge,
          sub: customSub ? `${customSub} • ${info.formattedDate}` : info.formattedDate,
        });
        i++;
        continue;
      }

      if (/^big\s+/i.test(line)) {
        const { mainExpr, attrs } = extractNamedAttrs(line.replace(/^big\s+/i, '').trim());
        targetNodes.push({
          kind: 'big',
          text: String(evalDbExpr(mainExpr, env, vm) ?? ''),
          sub: attrs.sub ? String(evalDbExpr(attrs.sub, env, vm) ?? '') : '',
          badge: attrs.badge ? String(evalDbExpr(attrs.badge, env, vm) ?? '') : '',
        });
        i++;
        continue;
      }

      if (/^kv\s+/i.test(line)) {
        const { mainExpr, attrs } = extractNamedAttrs(line.replace(/^kv\s+/i, '').trim());
        const parts = splitTopLevelCommas(mainExpr);
        targetNodes.push({
          kind: 'kv',
          k: String(evalDbExpr(parts[0] || '""', env, vm) ?? ''),
          v: String(evalDbExpr(parts[1] || '""', env, vm) ?? ''),
          copy: attrs.copy ? Boolean(evalDbExpr(attrs.copy, env, vm)) : true,
        });
        i++;
        continue;
      }

      if (/^check\s+/i.test(line)) {
        const arrowIdx = line.indexOf('->');
        const leftPart = (arrowIdx !== -1 ? line.slice(0, arrowIdx) : line).replace(/^check\s+/i, '').trim();
        const actionCode = arrowIdx !== -1 ? line.slice(arrowIdx + 2).trim() : '';
        const parts = splitTopLevelCommas(leftPart);
        const snapshotLocals = { ...env.locals };
        targetNodes.push({
          kind: 'check',
          label: String(evalDbExpr(parts[0] || '""', env, vm) ?? ''),
          done: Boolean(evalDbExpr(parts[1] || 'false', env, vm)),
          actionCode,
          locals: snapshotLocals,
        });
        i++;
        continue;
      }

      if (/^btn\s+/i.test(line)) {
        const arrowIdx = line.indexOf('->');
        const leftPart = (arrowIdx !== -1 ? line.slice(0, arrowIdx) : line).replace(/^btn\s+/i, '').trim();
        const actionCode = arrowIdx !== -1 ? line.slice(arrowIdx + 2).trim() : '';
        const { mainExpr, attrs } = extractNamedAttrs(leftPart);
        const snapshotLocals = { ...env.locals };
        targetNodes.push({
          kind: 'btn',
          label: String(evalDbExpr(mainExpr, env, vm) ?? 'Action'),
          right: attrs.right ? String(evalDbExpr(attrs.right, env, vm) ?? '') : '',
          active: attrs.active ? Boolean(evalDbExpr(attrs.active, env, vm)) : false,
          actionCode,
          locals: snapshotLocals,
        });
        i++;
        continue;
      }

      if (/^input\s+/i.test(line)) {
        const arrowIdx = line.indexOf('->');
        const leftPart = (arrowIdx !== -1 ? line.slice(0, arrowIdx) : line).replace(/^input\s+/i, '').trim();
        const actionCode = arrowIdx !== -1 ? line.slice(arrowIdx + 2).trim() : '';
        const { mainExpr, attrs } = extractNamedAttrs(leftPart);
        const parts = splitTopLevelCommas(mainExpr);
        const stateKey = (parts[0] || 'draft').replace(/^state\./, '').trim();
        const placeholder = parts[1] ? String(evalDbExpr(parts[1], env, vm) ?? '') : 'Enter value...';
        const btnLabel = attrs.btn ? String(evalDbExpr(attrs.btn, env, vm) ?? 'Add') : 'Add';
        const snapshotLocals = { ...env.locals };
        targetNodes.push({
          kind: 'input',
          stateKey,
          placeholder,
          btnLabel,
          actionCode,
          locals: snapshotLocals,
        });
        i++;
        continue;
      }

      if (/^pin\s+/i.test(line)) {
        const { mainExpr, attrs } = extractNamedAttrs(line.replace(/^pin\s+/i, '').trim());
        const parts = splitTopLevelCommas(mainExpr);
        targetNodes.push({
          kind: 'pin',
          label: String(evalDbExpr(parts[0] || '""', env, vm) ?? 'Pinned Spot'),
          lat: Number(evalDbExpr(parts[1] || '41.40897', env, vm)),
          lon: Number(evalDbExpr(parts[2] || '-75.66241', env, vm)),
          note: attrs.note ? String(evalDbExpr(attrs.note, env, vm) ?? '') : '',
          index: attrs.index != null ? Number(evalDbExpr(attrs.index, env, vm)) : null,
        });
        i++;
        continue;
      }

      if (/^progress\s+/i.test(line)) {
        const pct = Number(evalDbExpr(line.replace(/^progress\s+/i, '').trim(), env, vm) || 0);
        targetNodes.push({ kind: 'progress', pct: Math.max(0, Math.min(100, pct)) });
        i++;
        continue;
      }

      if (/^text\s+/i.test(line)) {
        const { mainExpr, attrs } = extractNamedAttrs(line.replace(/^text\s+/i, '').trim());
        targetNodes.push({
          kind: 'text',
          text: String(evalDbExpr(mainExpr, env, vm) ?? ''),
          muted: attrs.muted ? Boolean(evalDbExpr(attrs.muted, env, vm)) : false,
        });
        i++;
        continue;
      }

      evalDbExpr(line, env, vm);
      i++;
    }
    return { returned: false };
  }

  function runDbScript(mm, ctx = {}) {
    ensureMicroModuleScript(mm);
    const fullCtx = {
      user: ctx.user || 'Michael',
      crew: ctx.crew || ['Michael', 'Dwight', 'Jim', 'Pam'],
      trip: ctx.trip || {
        title: 'Party at Dunder Mifflin',
        spent: 276,
        where: 'On I-81 N • Near Scranton, PA',
        lat: 41.40897,
        lon: -75.66241,
        speed: 62,
      },
    };
    const vm = { steps: 0, maxSteps: 25000, halted: false, nodes: [], functions: {}, ctx: fullCtx };
    const env = { state: mm.data, locals: {} };
    try {
      const lines = expandInlineDbLines(mm.code);
      execDbBlock(lines, env, vm, vm.nodes);
      if (vm.halted) {
        vm.nodes.push({ kind: 'text', text: '⚡ Halted: step limit (25,000 ops) reached.', muted: true });
      }
    } catch (err) {
      vm.nodes.push({ kind: 'text', text: `⚠️ Script error: ${err?.message || 'Invalid syntax'}`, muted: true });
    }
    return { vm, env };
  }

  function renderDbNodes(nodes, mm, env, vm, callbacks = {}) {
    const frag = document.createDocumentFragment();
    const onChange = callbacks.onChange || (() => {});
    const onToast = callbacks.onToast || (() => {});
    const getLoc = callbacks.getLocation || (() => ({ lat: vm.ctx?.trip?.lat, lon: vm.ctx?.trip?.lon }));

    nodes.forEach((node) => {
      if (node.kind === 'big') {
        const el = document.createElement('div');
        el.className = 'mm-big-box';
        el.innerHTML = `
          ${node.badge ? `<span class="share-enc-badge" style="margin-bottom:4px;">${esc(node.badge)}</span>` : ''}
          <div class="mm-big-val">${esc(node.text)}</div>
          ${node.sub ? `<div class="muted" style="margin-top:4px;">${esc(node.sub)}</div>` : ''}`;
        frag.appendChild(el);
      } else if (node.kind === 'kv') {
        const el = document.createElement('div');
        el.className = 'mm-kv-row';
        el.innerHTML = `
          <span class="muted" style="font-weight:700;">${esc(node.k)}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <strong style="font-size:0.95rem;">${esc(node.v)}</strong>
            ${node.copy ? `<button type="button" class="subtle-pill-btn copy-kv-btn" style="padding:2px 8px; font-size:0.7rem;">Copy</button>` : ''}
          </div>`;
        el.querySelector('.copy-kv-btn')?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(node.v);
            onToast(`Copied "${node.k}"!`);
          } catch {}
        });
        frag.appendChild(el);
      } else if (node.kind === 'check') {
        const el = document.createElement('div');
        el.className = `mm-check-row ${node.done ? 'done' : ''}`;
        el.innerHTML = `<span>${node.done ? '✅' : '⬜'}</span><span>${esc(node.label)}</span>`;
        el.addEventListener('click', async () => {
          if (node.actionCode) {
            const actLines = expandInlineDbLines(node.actionCode);
            execDbBlock(actLines, { state: mm.data, locals: { ...node.locals } }, vm, []);
            if (Array.isArray(mm.data.items)) mm.items = mm.data.items;
            await onChange(`Updated "${mm.title}"`);
          }
        });
        frag.appendChild(el);
      } else if (node.kind === 'btn') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `mm-poll-btn ${node.active ? 'voted' : ''}`;
        btn.innerHTML = `
          <span>${esc(node.label)}</span>
          ${node.right ? `<span class="muted" style="font-size:0.8rem;">${esc(node.right)}</span>` : ''}`;
        btn.addEventListener('click', async () => {
          if (node.actionCode) {
            const actLines = expandInlineDbLines(node.actionCode);
            execDbBlock(actLines, { state: mm.data, locals: { ...node.locals } }, vm, []);
            if (Array.isArray(mm.data.options)) mm.options = mm.data.options;
            await onChange(`Updated "${mm.title}"`);
          }
        });
        frag.appendChild(btn);
      } else if (node.kind === 'input') {
        const row = document.createElement('div');
        row.className = 'input-row';
        row.style.marginTop = '8px';
        row.innerHTML = `
          <input type="text" class="input" style="padding:9px 12px; font-size:0.9rem;" placeholder="${esc(node.placeholder)}" value="${esc(mm.data[node.stateKey] || '')}">
          <button type="button" class="btn btn-sm btn-lime">${esc(node.btnLabel)}</button>`;
        const inp = row.querySelector('input');
        const btn = row.querySelector('button');
        const trigger = async () => {
          mm.data[node.stateKey] = inp.value.trim();
          if (node.actionCode) {
            const actLines = expandInlineDbLines(node.actionCode);
            execDbBlock(actLines, { state: mm.data, locals: { ...node.locals } }, vm, []);
            if (Array.isArray(mm.data.items)) mm.items = mm.data.items;
            if (Array.isArray(mm.data.pairs)) mm.pairs = mm.data.pairs;
            await onChange(`Updated "${mm.title}"`);
          }
        };
        btn.addEventListener('click', trigger);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trigger(); } });
        frag.appendChild(row);
      } else if (node.kind === 'pin') {
        const loc = getLoc() || {};
        const distInfo = loc.lat != null && node.lat != null ? formatPinDistanceReadout(loc.lat, loc.lon, node.lat, node.lon) : '';
        const gmapsWalk = `https://www.google.com/maps/dir/?api=1&destination=${node.lat},${node.lon}&travelmode=walking`;
        const el = document.createElement('div');
        el.className = 'pin-card-row';
        el.innerHTML = `
          <div class="pin-card-top">
            <div>
              <div style="font-weight:800; font-size:0.95rem;">${esc(node.label)}</div>
              <div class="muted" style="font-size:0.78rem;">${esc(node.note)}${distInfo ? ` • <strong style="color:var(--accent-ink);">${esc(distInfo)}</strong>` : ''}</div>
            </div>
            <a href="${esc(gmapsWalk)}" target="_blank" rel="noopener" class="btn btn-sm btn-lime">🚶 Walk ↗</a>
          </div>`;
        frag.appendChild(el);
      } else if (node.kind === 'progress') {
        const tr = document.createElement('div');
        tr.className = 'progress-track';
        tr.style.margin = '8px 0';
        tr.innerHTML = `<div class="progress-fill" style="width:${node.pct.toFixed(0)}%;"></div>`;
        frag.appendChild(tr);
      } else if (node.kind === 'text') {
        const p = document.createElement('div');
        p.className = node.muted ? 'muted' : '';
        p.style.marginBottom = '6px';
        p.textContent = node.text;
        frag.appendChild(p);
      } else if (node.kind === 'row') {
        const r = document.createElement('div');
        r.className = 'mm-row-flex';
        r.appendChild(renderDbNodes(node.children || [], mm, env, vm, callbacks));
        frag.appendChild(r);
      }
    });
    return frag;
  }

  // =========================================================
  // 12-EXAMPLE MICRO-MODULE LIBRARY (A FULL DOZEN)
  // =========================================================
  const EXAMPLES = [
    {
      id: 'countdown_future_past',
      category: 'Timers',
      icon: '⏳',
      title: 'Christmas & Birthdays',
      summary: 'Years, months, days & hours for future countdowns and past milestones.',
      type: 'countdown',
      code: [
        `state future = "2026-12-25T11:11"`,
        `state past = "1983-03-11T11:11"`,
        `let f = timeDiff(state.future)`,
        `let p = timeDiff(state.past)`,
        `big f.text sub=("Christmas • " + f.formattedDate) badge=f.badge`,
        `big p.text sub=("Birthday • " + p.formattedDate) badge=p.badge`,
      ].join('\n'),
      data: { future: '2026-12-25T11:11', past: '1983-03-11T11:11' },
    },
    {
      id: 'airbnb_codes',
      category: 'Access & Info',
      icon: '🔑',
      title: 'Airbnb & Wi-Fi Codes',
      summary: 'Key-value board with 1-tap Copy buttons plus inline pin input.',
      type: 'kv',
      code: synthesizeScriptForPreset('kv', {
        pairs: [
          { k: 'Gate Code', v: '#1725' },
          { k: 'Wi-Fi', v: 'DunderMifflin_5G (Pass: BearsBeets)' },
          { k: 'Check-out', v: 'Sunday 11:00 AM' },
        ],
      }).code,
      data: {
        pairs: [
          { k: 'Gate Code', v: '#1725' },
          { k: 'Wi-Fi', v: 'DunderMifflin_5G (Pass: BearsBeets)' },
          { k: 'Check-out', v: 'Sunday 11:00 AM' },
        ],
        draft: '',
      },
    },
    {
      id: 'packing_checklist',
      category: 'Checklists',
      icon: '📦',
      title: 'Roadtrip Packing List',
      summary: 'Interactive checklist with live completion progress bar & add input.',
      type: 'checklist',
      code: synthesizeScriptForPreset('checklist').code,
      data: {
        items: [
          { text: 'Cooler & Ice', done: true },
          { text: 'Dundie Trophies', done: true },
          { text: 'Aux Cord & Power Bank', done: false },
          { text: 'Sunscreen & Towels', done: false },
        ],
        draft: '',
      },
    },
    {
      id: 'dinner_poll',
      category: 'Decisions',
      icon: '🍕',
      title: 'Crew Dinner Vote',
      summary: 'One-tap voting that tags your current crew identity & shows voter names.',
      type: 'poll',
      code: synthesizeScriptForPreset('poll').code,
      data: {
        options: [
          { label: "Alfredo's Pizza Cafe", votes: ['Michael', 'Jim'] },
          { label: "Poor Richard's Pub", votes: ['Dwight'] },
          { label: "Chili's", votes: ['Pam'] },
        ],
      },
    },
    {
      id: 'rounds_tracker',
      category: 'Social',
      icon: '🍻',
      title: "Who's Buying Next?",
      summary: 'Track coffee or drink rounds per crew member without itemizing receipts.',
      type: 'rounds',
      code: synthesizeScriptForPreset('rounds').code,
      data: { counts: { Michael: 2, Dwight: 1, Jim: 1, Pam: 0 } },
    },
    {
      id: 'fuel_estimator',
      category: 'Calculators',
      icon: '⛽',
      title: 'Gas & Mileage Estimator',
      summary: 'Interactive trip fuel cost calculator with +/- controls in DB-Script.',
      type: 'script',
      code: [
        `state miles = 320`,
        `state mpg = 28`,
        `state price = 3.45`,
        `let gallons = state.miles / max(1, state.mpg)`,
        `let cost = round(gallons * state.price, 2)`,
        `big ("$" + cost) sub=(round(gallons, 1) + " gal • " + state.miles + " mi @ " + state.mpg + " mpg") badge="FUEL ESTIMATE"`,
        `row`,
        `  btn "+50 mi" -> set state.miles = state.miles + 50`,
        `  btn "-50 mi" -> set state.miles = max(10, state.miles - 50)`,
        `  btn "+$0.25/gal" -> set state.price = round(state.price + 0.25, 2)`,
        `end`,
      ].join('\n'),
      data: { miles: 320, mpg: 28, price: 3.45 },
    },
    {
      id: 'parking_meetup_pins',
      category: 'Locations',
      icon: '🅿️',
      title: 'Parking & Rally Pins',
      summary: 'Remember exact parking spots & festival rally points with walk links.',
      type: 'pins',
      code: synthesizeScriptForPreset('pins', {
        pins: [
          { kind: '🅿️ Parking', label: 'Blue Giraffe Ramp — Level 3, Spot 42', lat: 41.4091, lon: -75.6628, by: 'Michael' },
          { kind: '🤝 Meetup', label: 'Main Gate Clocktower (5:30 PM)', lat: 41.4089, lon: -75.6624, by: 'Pam' },
        ],
      }).code,
      data: {
        pins: [
          { kind: '🅿️ Parking', label: 'Blue Giraffe Ramp — Level 3, Spot 42', lat: 41.4091, lon: -75.6628, by: 'Michael' },
          { kind: '🤝 Meetup', label: 'Main Gate Clocktower (5:30 PM)', lat: 41.4089, lon: -75.6624, by: 'Pam' },
        ],
        draft: '',
      },
    },
    {
      id: 'itinerary_confirmations',
      category: 'Travel',
      icon: '📅',
      title: 'Pocket Itinerary & Codes',
      summary: 'Keep flight, ferry, and dinner confirmation numbers pinned at the top.',
      type: 'kv',
      code: [
        `for item, i in state.pairs`,
        `  kv item.k, item.v copy=true`,
        `end`,
      ].join('\n'),
      data: {
        pairs: [
          { k: '5:30 PM • Dinner', v: 'Conf #DM-8841 (4 Guests)' },
          { k: '8:00 PM • Show', v: 'Row G, Seats 12-15' },
          { k: 'Hotel Check-In', v: 'Radisson Lackawanna #4092' },
        ],
      },
    },
    {
      id: 'ice_emergency',
      category: 'Safety',
      icon: '🚨',
      title: 'Offline ICE & Safety Card',
      summary: 'Critical hotel address, roadside number, and meetup plan cached offline.',
      type: 'script',
      code: [
        `text "If separated or zero signal, meet at:" muted=true`,
        `big "Hotel Lobby @ 11 PM" badge="OFFLINE RALLY PLAN"`,
        `kv "Roadside Assist", "1-800-555-0199" copy=true`,
        `kv "Hotel Address", "700 Lackawanna Ave, Scranton" copy=true`,
        `kv "Local Emergency", "911" copy=true`,
      ].join('\n'),
      data: {},
    },
    {
      id: 'roadtrip_bingo',
      category: 'Games',
      icon: '🎯',
      title: 'Roadtrip Bingo & Bounties',
      summary: 'Check off highway sightings & track crew bounty points.',
      type: 'checklist',
      code: synthesizeScriptForPreset('checklist').code,
      data: {
        items: [
          { text: 'Spot an Alaska or Hawaii plate (5 pts)', done: false },
          { text: 'Find a diner with homemade pie (5 pts)', done: true },
          { text: 'Everyone sings the same chorus (3 pts)', done: false },
          { text: 'Zero wrong turns for 100 miles (10 pts)', done: false },
        ],
        draft: '',
      },
    },
    {
      id: 'shotgun_rotation',
      category: 'Games',
      icon: '🚗',
      title: 'Shotgun & Driver Scoreboard',
      summary: 'Track miles driven or shotgun turns with 1-tap +1 buttons for the crew.',
      type: 'script',
      code: [
        `state turns = {"Michael":1,"Dwight":2,"Jim":1,"Pam":1}`,
        `for person, i in crew`,
        `  let t = state.turns[person] ? state.turns[person] : 0`,
        `  btn ("🛞 " + person + " drove a leg") right=(t + " leg" + (t == 1 ? "" : "s")) active=(t > 0) -> set state.turns[person] = (state.turns[person] ? state.turns[person] : 0) + 1`,
        `end`,
      ].join('\n'),
      data: { turns: { Michael: 1, Dwight: 2, Jim: 1, Pam: 1 } },
    },
    {
      id: 'collatz_turing',
      category: 'Computer Science',
      icon: '🧮',
      title: 'Collatz 3n+1 Turing VM',
      summary: 'Turing-complete loop demo computing 3n+1 trajectories inside the URL.',
      type: 'turing',
      code: synthesizeScriptForPreset('turing').code,
      data: { n: 27, steps: 0, trail: [27] },
    },
  ];

  window.DBScript = {
    esc,
    haversineMeters,
    compassBearing,
    formatPinDistanceReadout,
    formatRichTimeDiff,
    synthesizeScriptForPreset,
    ensureMicroModuleScript,
    runDbScript,
    renderDbNodes,
    EXAMPLES,
  };
})();
