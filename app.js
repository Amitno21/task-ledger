(function(){
"use strict";

/* ============ model ============ */
var LEVELS = ["low","med","high","critical"];
var LABEL  = {low:"Low", med:"Medium", high:"High", critical:"Critical"};
/* what each level is called in the lists, where you're scanning rather than configuring */
var BAND   = {low:"No rush", med:"When you can", high:"Important", critical:"Needs attention"};
var PRAISE = ["Nice — {t} sorted.", "Done. {t} is off the list.",
              "That's {t} handled.", "Good one — {t} done.", "{t}, finished."];

var DEFAULT_SETTINGS = {
  categories:[
    {id:"w-deadline", list:"work",     name:"Deadline / delivery",   priority:"critical"},
    {id:"w-blocking", list:"work",     name:"Blocking someone else", priority:"critical"},
    {id:"w-design",   list:"work",     name:"Design & modeling",     priority:"high"},
    {id:"w-review",   list:"work",     name:"Reviews & approvals",   priority:"high"},
    {id:"w-meeting",  list:"work",     name:"Meetings",              priority:"med"},
    {id:"w-admin",    list:"work",     name:"Admin & email",         priority:"low"},
    {id:"w-learning", list:"work",     name:"Learning",              priority:"low"},
    {id:"p-health",   list:"personal", name:"Health & appointments", priority:"critical"},
    {id:"p-money",    list:"personal", name:"Bills & money",         priority:"high"},
    {id:"p-family",   list:"personal", name:"Family",                priority:"high"},
    {id:"p-home",     list:"personal", name:"Home & errands",        priority:"med"},
    {id:"p-side",     list:"personal", name:"Side projects",         priority:"med"},
    {id:"p-rest",     list:"personal", name:"Fun & rest",            priority:"low"}
  ],
  escalateDueToday:true,
  escalateOverdue:true,
  name:"Amit"
};

var settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
var tasks = [];
var cloud = null;
var ready = false;
var ui = {list:"work", view:"open", filter:"all", pendingRender:false};

/* Public half of this app's VAPID keypair. Safe to publish — it only lets the
   browser verify that a push really came from us. The private half lives in
   the repo's Actions secrets. */
var VAPID_PUBLIC = "BBS7H1wjuCQyibP10EB57ww0Y2eNd57Hh86b6G-L--4_eHVcyPKvsns1GkCyCyScjW42iWxg_RyaaeWX9KFJu10";
var pushSettings = null;   /* mirrors users/{uid}/meta/push */

/* ============ dates ============ */
function pad(n){ return String(n).length < 2 ? "0" + n : String(n); }
function iso(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }
function todayISO(){ return iso(new Date()); }
function parseISO(s){ var p = String(s).split("-"); return new Date(+p[0], +p[1]-1, +p[2]); }
function dueState(due){
  if(!due) return "none";
  var t = todayISO();
  if(due < t) return "overdue";
  if(due === t) return "today";
  return "future";
}
function fmtDate(s){
  return parseISO(s).toLocaleDateString(undefined,{day:"numeric",month:"short"});
}
function dayHeading(s){
  if(s === todayISO()) return "Today";
  var y = new Date(); y.setDate(y.getDate()-1);
  if(s === iso(y)) return "Yesterday";
  return parseISO(s).toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long"});
}

/* ============ priority ============ */
function catOf(id){
  for(var i=0;i<settings.categories.length;i++){ if(settings.categories[i].id === id) return settings.categories[i]; }
  return null;
}
function priorityOf(t){
  var cat = catOf(t.categoryId);
  var base = t.manualPriority || (cat ? cat.priority : "med");
  var i = LEVELS.indexOf(base); if(i < 0){ i = 1; base = "med"; }
  var ds = dueState(t.due);
  var bump = 0;
  if(ds === "overdue" && settings.escalateOverdue) bump = 2;
  else if(ds === "today" && settings.escalateDueToday) bump = 1;
  var level = LEVELS[Math.min(i + bump, LEVELS.length - 1)];
  return {level:level, base:base, escalated:level !== base, dueState:ds};
}

/* ============ storage ============ */
function localLoad(){
  try{
    var s = localStorage.getItem("dtl.settings");
    if(s){ var parsed = JSON.parse(s); if(parsed && parsed.categories) settings = parsed; }
    var t = localStorage.getItem("dtl.tasks");
    tasks = t ? JSON.parse(t) : [];
  }catch(e){ tasks = []; }
}
function localSave(){
  try{
    localStorage.setItem("dtl.settings", JSON.stringify(settings));
    localStorage.setItem("dtl.tasks", JSON.stringify(tasks));
  }catch(e){}
}
function newId(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function bodyOf(t){
  return {title:t.title, list:t.list, categoryId:t.categoryId || null,
          manualPriority:t.manualPriority || null, due:t.due || null,
          done:!!t.done, createdAt:t.createdAt || null, doneAt:t.doneAt || null};
}
function warn(e){
  var code = e && e.code ? e.code : "unavailable";
  if(code === "quota_exceeded") toast("Storage is full — clear old entries in the Log.");
  else toast("Could not save that. Try again.");
}
function persistTask(t){
  if(cloud) return cloud.setTask(t)["catch"](warn);
  localSave();
  return Promise.resolve();
}
function removeTask(id){
  tasks = tasks.filter(function(x){ return x.id !== id; });
  var p = cloud ? cloud.deleteTask(id)["catch"](warn) : (localSave(), Promise.resolve());
  render();
  return p;
}
function persistSettings(){
  var p = cloud ? cloud.setSettings()["catch"](warn) : (localSave(), Promise.resolve());
  render();
  return p;
}

var SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

function setPill(text, state, title){
  var pill = document.getElementById("syncPill");
  pill.textContent = text;
  pill.setAttribute("data-state", state);
  pill.title = title;
}

/* No backend configured, or we couldn't reach it: the app still works, it just
   keeps everything on this device. */
function startLocal(reason){
  localLoad();
  cloud = null; ready = true;
  setPill("this device", "local", reason);
  showAuth(false);
  render();
}

function initStore(){
  var cfg = window.LEDGER_FIREBASE_CONFIG;
  if(!cfg || !cfg.apiKey || cfg.apiKey.indexOf("PASTE") === 0){
    startLocal("Sync isn't set up yet — tasks stay in this browser.");
    return;
  }
  setPill("connecting", "wait", "Reaching your sync backend…");

  Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]).then(function(mods){
    var appMod = mods[0], authMod = mods[1], fsMod = mods[2];
    var app = appMod.initializeApp(cfg);

    /* Offline-first: Firestore keeps a copy in IndexedDB, serves reads from it
       when the network is gone, and replays writes when it returns. */
    var fdb;
    try{
      fdb = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
      });
    }catch(e){ fdb = fsMod.getFirestore(app); }

    var auth = authMod.getAuth(app);
    wireAuthForm(authMod, auth);

    authMod.onAuthStateChanged(auth, function(user){
      detachCloud();
      if(!user){
        cloud = null; ready = true;
        setPill("signed out", "local", "Sign in to sync across your devices.");
        showAuth(true);
        render();
        return;
      }
      showAuth(false);
      attachCloud(fsMod, authMod, auth, fdb, user.uid);
    });
  })["catch"](function(){
    startLocal("Couldn't load the sync library — working offline on this device.");
  });
}

var unsubTasks = null, unsubSettings = null, unsubPush = null;
function detachCloud(){
  if(unsubTasks){ unsubTasks(); unsubTasks = null; }
  if(unsubSettings){ unsubSettings(); unsubSettings = null; }
  if(unsubPush){ unsubPush(); unsubPush = null; }
  pushSettings = null;
}

/* ============ daily reminder ============ */
function pushSupported(){
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function isIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isInstalled(){
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
         window.navigator.standalone === true;
}
/* Why reminders can't be offered right now, or null if they can */
function pushBlockedReason(){
  if(!cloud) return "Sign in first — reminders need somewhere to keep your subscription.";
  if(!pushSupported()) return "This browser can't do notifications.";
  if(isIOS() && !isInstalled()) return "On iPhone, add the app to your Home Screen first — iOS only sends notifications to installed apps.";
  if(Notification.permission === "denied") return "Notifications are blocked for this site. Turn them back on in your browser or iOS settings, then reload.";
  return null;
}
function vapidKeyBytes(base64){
  var pad = "=".repeat((4 - base64.length % 4) % 4);
  var raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  var out = new Uint8Array(raw.length);
  for(var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function enableReminder(hour){
  return Notification.requestPermission().then(function(perm){
    if(perm !== "granted") throw new Error("permission-" + perm);
    return navigator.serviceWorker.ready;
  }).then(function(reg){
    return reg.pushManager.getSubscription().then(function(existing){
      return existing || reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyBytes(VAPID_PUBLIC)
      });
    });
  }).then(function(sub){
    return cloud.setPush({
      enabled: true,
      hour: hour,
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC",
      subscription: JSON.parse(JSON.stringify(sub)),
      updatedAt: new Date().toISOString()
    });
  });
}

function disableReminder(){
  return navigator.serviceWorker.ready.then(function(reg){
    return reg.pushManager.getSubscription();
  }).then(function(sub){
    return sub ? sub.unsubscribe() : null;
  }).then(function(){
    return cloud.setPush({enabled:false, subscription:null, updatedAt:new Date().toISOString()});
  });
}

function attachCloud(fs, authMod, auth, fdb, uid){
  var root = "users/" + uid;
  var tasksCol   = fs.collection(fdb, root + "/tasks");
  var settingsRef = fs.doc(fdb, root + "/meta/settings");

  cloud = {
    uid: uid,
    signOut: function(){ return authMod.signOut(auth); },
    setTask: function(t){ return fs.setDoc(fs.doc(fdb, root + "/tasks/" + t.id), bodyOf(t)); },
    deleteTask: function(id){ return fs.deleteDoc(fs.doc(fdb, root + "/tasks/" + id)); },
    setSettings: function(){ return fs.setDoc(settingsRef, JSON.parse(JSON.stringify(settings))); },
    setPush: function(data){ return fs.setDoc(fs.doc(fdb, root + "/meta/push"), data, {merge:true}); }
  };

  unsubPush = fs.onSnapshot(fs.doc(fdb, root + "/meta/push"), function(snap){
    pushSettings = snap.exists() ? snap.data() : null;
    if(ui.view === "rules") render();
  }, function(){});

  setPill("synced", "on", "Signed in — the same list on every device.");

  unsubSettings = fs.onSnapshot(settingsRef, function(snap){
    if(snap.exists()){
      var d = snap.data();
      if(d && Array.isArray(d.categories)) settings = d;
    } else {
      fs.setDoc(settingsRef, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))["catch"](function(){});
    }
    render();
  }, function(){});

  unsubTasks = fs.onSnapshot(tasksCol, function(snap){
    var out = [];
    snap.forEach(function(d){ var o = d.data() || {}; o.id = d.id; out.push(o); });
    tasks = out; ready = true;
    setPill(snap.metadata.fromCache ? "offline" : "synced",
            snap.metadata.fromCache ? "local" : "on",
            snap.metadata.fromCache
              ? "Working from the copy on this device — changes will sync when you're back online."
              : "Signed in — the same list on every device.");
    render();
  }, function(){
    toast("Sync stopped. Your changes are saved here and will catch up.");
  });

  ready = true; render();
}

/* ---------- sign in ---------- */
function showAuth(on){
  var el = document.getElementById("authScreen");
  if(el) el.hidden = !on;
  var app = document.querySelector(".app");
  if(app) app.style.display = on ? "none" : "";
}

function wireAuthForm(authMod, auth){
  var emailEl = document.getElementById("authEmail");
  var passEl  = document.getElementById("authPass");
  var errEl   = document.getElementById("authError");
  var inBtn   = document.getElementById("authSignIn");
  var upBtn   = document.getElementById("authSignUp");
  if(!inBtn) return;

  function attempt(fn){
    var email = (emailEl.value || "").trim();
    var pass  = passEl.value || "";
    if(!email || !pass){ errEl.textContent = "Enter an email address and a password."; return; }
    errEl.textContent = "";
    inBtn.disabled = upBtn.disabled = true;
    fn(auth, email, pass)["catch"](function(e){
      errEl.textContent = authMessage(e && e.code);
    }).then(function(){ inBtn.disabled = upBtn.disabled = false; });
  }
  inBtn.addEventListener("click", function(){ attempt(authMod.signInWithEmailAndPassword); });
  upBtn.addEventListener("click", function(){ attempt(authMod.createUserWithEmailAndPassword); });
  passEl.addEventListener("keydown", function(e){
    if(e.key === "Enter"){ e.preventDefault(); inBtn.click(); }
  });
}

function authMessage(code){
  switch(code){
    case "auth/invalid-email":        return "That doesn't look like an email address.";
    case "auth/missing-password":     return "Enter your password.";
    case "auth/weak-password":        return "Pick a password of at least 6 characters.";
    case "auth/email-already-in-use": return "That email already has an account — use Sign in instead.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":       return "Email or password doesn't match. If this is your first time, use Create account.";
    case "auth/network-request-failed": return "No connection. Try again once you're online.";
    case "auth/too-many-requests":    return "Too many attempts. Wait a minute and try again.";
    default: return "Couldn't sign you in. Try again.";
  }
}

/* ============ shorthand parsing ============ */
var WEEKDAYS = {sun:0,sunday:0,mon:1,monday:1,tue:2,tues:2,tuesday:2,wed:3,weds:3,wednesday:3,
                thu:4,thur:4,thurs:4,thursday:4,fri:5,friday:5,sat:6,saturday:6};
function norm(s){ return String(s).toLowerCase().replace(/[^a-z0-9]/g,""); }
function findCategory(token, list){
  var q = norm(token); if(!q) return null;
  var pool = settings.categories.filter(function(c){ return c.list === list; });
  for(var i=0;i<pool.length;i++){ if(norm(pool[i].name).indexOf(q) === 0) return pool[i]; }
  for(var j=0;j<pool.length;j++){
    var words = pool[j].name.toLowerCase().split(/[^a-z0-9]+/);
    for(var k=0;k<words.length;k++){ if(words[k] && words[k].indexOf(q) === 0) return pool[j]; }
  }
  return null;
}
function parseInput(raw, list){
  var out = {title:raw, categoryId:null, level:null, due:null, hits:[]};
  var text = raw;

  text = text.replace(/(^|\s)!(critical|crit|high|medium|med|low)\b/gi, function(m, sp, w){
    var t = w.toLowerCase();
    out.level = t.indexOf("crit") === 0 ? "critical"
              : t.indexOf("high") === 0 ? "high"
              : t.indexOf("med")  === 0 ? "med" : "low";
    out.hits.push(LABEL[out.level]);
    return sp ? " " : "";
  });

  text = text.replace(/(^|\s)#([A-Za-z0-9_-]+)/g, function(m, sp, w){
    var c = findCategory(w, list);
    if(!c) return m;
    out.categoryId = c.id; out.hits.push(c.name);
    return sp ? " " : "";
  });

  text = text.replace(/(^|\s)(today|tod|tomorrow|tmr|tmw|\+\d{1,3}d|sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/gi,
  function(m, sp, w){
    if(out.due) return m;
    var t = w.toLowerCase(), d = new Date();
    if(t === "today" || t === "tod"){ /* today */ }
    else if(t === "tomorrow" || t === "tmr" || t === "tmw"){ d.setDate(d.getDate() + 1); }
    else if(t.charAt(0) === "+"){ d.setDate(d.getDate() + parseInt(t.slice(1), 10)); }
    else {
      var delta = (WEEKDAYS[t] - d.getDay() + 7) % 7;
      if(delta === 0) delta = 7;
      d.setDate(d.getDate() + delta);
    }
    out.due = iso(d); out.hits.push("due " + fmtDate(out.due));
    return sp ? " " : "";
  });

  out.title = text.replace(/\s{2,}/g, " ").trim();
  return out;
}

/* ============ composer ============ */
var titleInput = document.getElementById("titleInput");
var catInput   = document.getElementById("catInput");
var dueInput   = document.getElementById("dueInput");
var hintEl     = document.getElementById("hint");
var manualLevel = null;

function fillCategorySelect(){
  var pool = settings.categories.filter(function(c){ return c.list === ui.list; });
  var keep = catInput.value;
  catInput.innerHTML = "";
  pool.forEach(function(c){
    var o = document.createElement("option");
    o.value = c.id;
    o.textContent = c.name + "  ·  " + LABEL[c.priority];
    catInput.appendChild(o);
  });
  if(pool.some(function(c){ return c.id === keep; })) catInput.value = keep;
}

function updateHint(){
  var p = parseInput(titleInput.value, ui.list);
  if(p.categoryId) catInput.value = p.categoryId;
  if(p.due) dueInput.value = p.due;
  manualLevel = p.level;

  if(p.hits.length){
    hintEl.innerHTML = '<span class="parsed">&rarr; ' + esc(p.title || "…") + "  ·  " +
      p.hits.map(esc).join("  ·  ") + "</span>";
  } else {
    hintEl.innerHTML = 'Shortcuts: <code>#category</code> <code>!high</code> <code>today</code> <code>fri</code> <code>+3d</code>';
  }
}
titleInput.addEventListener("input", updateHint);

function addTask(){
  var p = parseInput(titleInput.value, ui.list);
  if(!p.title){ titleInput.focus(); return; }
  var t = {
    id:newId(), title:p.title, list:ui.list,
    categoryId: catInput.value || null,
    manualPriority: manualLevel,
    due: dueInput.value || null,
    done:false, createdAt:new Date().toISOString(), doneAt:null
  };
  tasks.push(t);
  titleInput.value = ""; dueInput.value = ""; manualLevel = null;
  updateHint(); render();
  persistTask(t);
  titleInput.focus();
}

document.getElementById("logBtn").addEventListener("click", addTask);
titleInput.addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); addTask(); }
});

document.addEventListener("keydown", function(e){
  var tag = (e.target.tagName || "").toLowerCase();
  var typing = tag === "input" || tag === "textarea";
  /* Ctrl/Cmd+Z undoes the last completion or deletion — but never while you're
     typing, where it belongs to the text field */
  if((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && undoAction && !typing){
    e.preventDefault(); runUndo(); return;
  }
  if(e.key === "/" && tag !== "input" && tag !== "select" && tag !== "textarea"){
    e.preventDefault(); titleInput.focus();
  }
  if(e.key === "Escape" && e.target === titleInput){
    titleInput.value = ""; dueInput.value = ""; manualLevel = null; updateHint();
  }
});

/* ============ tabs ============ */
Array.prototype.forEach.call(document.querySelectorAll(".seg"), function(b){
  b.addEventListener("click", function(){
    ui.list = b.getAttribute("data-list");
    Array.prototype.forEach.call(document.querySelectorAll(".seg"), function(x){
      x.setAttribute("aria-selected", String(x === b));
    });
    fillCategorySelect(); updateHint(); render();
  });
});
Array.prototype.forEach.call(document.querySelectorAll(".views button"), function(b){
  b.addEventListener("click", function(){
    ui.view = b.getAttribute("data-view");
    Array.prototype.forEach.call(document.querySelectorAll(".views button"), function(x){
      x.setAttribute("aria-selected", String(x === b));
    });
    render();
  });
});

/* ============ render ============ */
var main = document.getElementById("main");
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

function render(){
  var ae = document.activeElement;
  if(ae && ae.classList && ae.classList.contains("title")){ ui.pendingRender = true; return; }
  ui.pendingRender = false;

  document.getElementById("todayLabel").textContent =
    new Date().toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"});
  fillCategorySelect();
  renderHeader();

  if(!ready){ main.innerHTML = '<div class="empty">Getting your list…</div>'; return; }
  if(ui.view === "open") renderOpen();
  else if(ui.view === "log") renderLog();
  else renderRules();
}

function greetingWord(h){
  if(h < 5)  return "Still up";
  if(h < 12) return "Good morning";
  if(h < 17) return "Good afternoon";
  if(h < 22) return "Good evening";
  return "Winding down";
}
function plural(n, one, many){ return n + " " + (n === 1 ? one : many); }

function subheadFor(open, overdue, dueToday, doneToday){
  if(!open.length && doneToday) return "That's everything for now — the list is clear.";
  if(!open.length) return "Nothing on this list yet. Add the first thing below.";
  if(overdue)  return plural(overdue, "thing has", "things have") + " slipped past the date you set.";
  if(dueToday) return plural(dueToday, "thing needs", "things need") + " you today.";
  return plural(open.length, "thing is", "things are") + " waiting, none due yet.";
}

function renderHeader(){
  var mine = tasks.filter(function(t){ return t.list === ui.list; });
  var open = mine.filter(function(t){ return !t.done; });
  var overdue  = open.filter(function(t){ return dueState(t.due) === "overdue"; }).length;
  var dueToday = open.filter(function(t){ return dueState(t.due) === "today"; }).length;
  var doneToday = mine.filter(function(t){
    return t.done && t.doneAt && t.doneAt.slice(0,10) === todayISO();
  }).length;

  var who = (settings.name || "").trim();
  document.getElementById("greetingLine").textContent =
    greetingWord(new Date().getHours()) + (who ? ", " + who : "");
  document.getElementById("subheadLine").textContent =
    ready ? subheadFor(open, overdue, dueToday, doneToday) : "Getting your list…";

  var total = open.length + doneToday;
  var meter = document.getElementById("dayMeter");
  meter.hidden = total === 0;
  if(total){
    var C = 2 * Math.PI * 19;
    var fill = document.getElementById("ringFill");
    fill.style.strokeDasharray = C.toFixed(1);
    fill.style.strokeDashoffset = (C * (1 - doneToday / total)).toFixed(1);
    document.getElementById("ringCount").textContent = doneToday + " of " + total;
  }
}

function renderOpen(){
  var list = tasks.filter(function(t){ return t.list === ui.list && !t.done; });
  var filters = [["all","All"],["today","Due today"],["overdue","Overdue"],["undated","No date"]];
  if(ui.filter === "today")   list = list.filter(function(t){ return dueState(t.due) === "today"; });
  if(ui.filter === "overdue") list = list.filter(function(t){ return dueState(t.due) === "overdue"; });
  if(ui.filter === "undated") list = list.filter(function(t){ return !t.due; });

  var html = '<div class="filters" style="margin-top:14px">' +
    filters.map(function(f){
      return '<button class="chip" data-filter="' + f[0] + '" aria-pressed="' +
        (ui.filter === f[0]) + '">' + f[1] + "</button>";
    }).join("") + "</div>";

  if(!list.length){
    html += '<div class="empty" style="margin-top:18px"><strong>' +
      (ui.filter === "all" ? "All clear here" : "Nothing matches that filter") + "</strong>" +
      (ui.filter === "all" ? "Add the first thing in the box above." : "Try another filter.") +
      "</div>";
    main.innerHTML = html; bindOpen(); return;
  }

  var buckets = {critical:[], high:[], med:[], low:[]};
  list.forEach(function(t){ buckets[priorityOf(t).level].push(t); });

  ["critical","high","med","low"].forEach(function(lv){
    var group = buckets[lv];
    if(!group.length) return;
    group.sort(function(a,b){
      var da = a.due || "9999-99-99", dbb = b.due || "9999-99-99";
      if(da !== dbb) return da < dbb ? -1 : 1;
      return (a.createdAt || "") < (b.createdAt || "") ? -1 : 1;
    });
    html += '<section class="group"><div class="group-head" style="color:var(--p-' + lv + ')">' +
      '<span class="dot" style="background:var(--p-' + lv + ')"></span>' + BAND[lv] +
      '<span class="n">' + group.length + '</span></div><ul class="tasks">' +
      group.map(taskRow).join("") + "</ul></section>";
  });

  main.innerHTML = html; bindOpen();
}

function taskRow(t){
  var p = priorityOf(t);
  var cat = catOf(t.categoryId);
  var dueHtml = "";
  if(t.due){
    var cls = p.dueState === "overdue" ? "due-overdue" : p.dueState === "today" ? "due-today" : "";
    var txt = p.dueState === "overdue" ? "overdue · " + fmtDate(t.due)
            : p.dueState === "today"   ? "due today"
            : "due " + fmtDate(t.due);
    dueHtml = '<span class="sep">/</span><span class="' + cls + '">' + txt + "</span>";
  }
  var bump = p.escalated
    ? '<span class="bump" style="color:var(--p-' + p.level + ')">' + LABEL[p.base] + " &rarr; " + LABEL[p.level] + "</span>"
    : "";
  var opts = ["auto"].concat(LEVELS).map(function(v){
    var on = v === "auto" ? !t.manualPriority : t.manualPriority === v;
    return '<option value="' + v + '"' + (on ? " selected" : "") + ">" +
           (v === "auto" ? "Auto" : LABEL[v]) + "</option>";
  }).join("");

  return '<li class="task' + (t.done ? " done" : "") + '" data-id="' + t.id + '">' +
    '<span class="stripe" style="background:var(--p-' + p.level + ')"></span>' +
    '<button class="check" data-act="toggle" aria-label="' + (t.done ? "Reopen task" : "Mark complete") + '">' +
      '<svg viewBox="0 0 12 12" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M1.5 6.2 4.4 9.2 10.5 2.8"/></svg></button>' +
    '<div class="body">' +
      '<input class="title" value="' + esc(t.title) + '" aria-label="Task title">' +
      '<div class="meta"><span class="cat">' + esc(cat ? cat.name : "Uncategorised") + "</span>" +
        dueHtml + bump + "</div>" +
    "</div>" +
    '<div class="rowactions">' +
      '<select data-act="level" aria-label="Priority override">' + opts + "</select>" +
      '<button class="icon-btn" data-act="delete" aria-label="Delete task">&times;</button>' +
    "</div></li>";
}

function bindOpen(){
  Array.prototype.forEach.call(main.querySelectorAll(".chip[data-filter]"), function(b){
    b.addEventListener("click", function(){ ui.filter = b.getAttribute("data-filter"); render(); });
  });
  bindTaskRows();
}

function bindTaskRows(){
  Array.prototype.forEach.call(main.querySelectorAll(".task"), function(li){
    var id = li.getAttribute("data-id");
    var t = null;
    for(var i=0;i<tasks.length;i++){ if(tasks[i].id === id){ t = tasks[i]; break; } }
    if(!t) return;

    var chk = li.querySelector('[data-act="toggle"]');
    if(chk) chk.addEventListener("click", function(){
      if(t.done){
        t.done = false; t.doneAt = null;
        render(); persistTask(t);
        return;
      }
      t.done = true; t.doneAt = new Date().toISOString();
      persistTask(t);
      toast(praiseFor(t.title), "good", function(){ restoreTask(id); });
      if(prefersReducedMotion()){ render(); }
      else {
        li.classList.add("completing");
        setTimeout(render, 300);
      }
    });

    var del = li.querySelector('[data-act="delete"]');
    if(del) del.addEventListener("click", function(){
      var saved = JSON.parse(JSON.stringify(t));   /* keep a copy to put back */
      removeTask(id);
      toast("Deleted “" + shortTitle(saved.title, 28) + "”.", null, function(){
        tasks.push(saved);
        render(); persistTask(saved);
        toast("Put back.");
      });
    });

    var sel = li.querySelector('[data-act="level"]');
    if(sel) sel.addEventListener("change", function(){
      t.manualPriority = sel.value === "auto" ? null : sel.value;
      render(); persistTask(t);
    });

    var title = li.querySelector(".title");
    if(title){
      title.addEventListener("keydown", function(e){
        if(e.key === "Enter"){ e.preventDefault(); title.blur(); }
      });
      title.addEventListener("blur", function(){
        var v = title.value.trim();
        if(v && v !== t.title){ t.title = v; persistTask(t); }
        else { title.value = t.title; }
        if(ui.pendingRender) render();
      });
    }
  });
}

function renderLog(){
  var done = tasks.filter(function(t){ return t.list === ui.list && t.done && t.doneAt; })
                  .sort(function(a,b){ return a.doneAt < b.doneAt ? 1 : -1; });

  var html = '<div class="logbar" style="margin-top:14px">' +
    '<div class="stats"><span><b>' + done.length + "</b> completed " + ui.list + " tasks recorded</span></div>" +
    '<div style="display:flex;gap:8px">' +
      '<button class="btn" id="exportBtn">Export CSV</button>' +
      '<button class="btn btn-quiet" id="pruneBtn">Clear older than 30 days</button>' +
    "</div></div>";

  if(!done.length){
    html += '<div class="empty" style="margin-top:18px"><strong>Nothing recorded yet</strong>' +
      "Completed tasks land here, grouped by the day you finished them.</div>";
    main.innerHTML = html; bindLog(); return;
  }

  var order = [], byDay = {};
  done.forEach(function(t){
    var k = t.doneAt.slice(0,10);
    if(!byDay[k]){ byDay[k] = []; order.push(k); }
    byDay[k].push(t);
  });
  order.forEach(function(k){
    html += '<section class="day"><div class="day-head"><h3>' + esc(dayHeading(k)) + "</h3>" +
      '<span class="n">' + byDay[k].length + " done</span></div>" +
      '<ul class="tasks">' + byDay[k].map(taskRow).join("") + "</ul></section>";
  });

  main.innerHTML = html; bindLog();
}

function bindLog(){
  bindTaskRows();
  var ex = document.getElementById("exportBtn");
  if(ex) ex.addEventListener("click", exportCsv);
  var pr = document.getElementById("pruneBtn");
  if(pr) pr.addEventListener("click", pruneOld);
}

function exportCsv(){
  var rows = [["List","Category","Task","Priority","Due","Status","Created","Completed"]];
  tasks.filter(function(t){ return t.list === ui.list; }).forEach(function(t){
    var cat = catOf(t.categoryId);
    rows.push([t.list, cat ? cat.name : "", t.title, LABEL[priorityOf(t).level],
               t.due || "", t.done ? "done" : "open", t.createdAt || "", t.doneAt || ""]);
  });
  var csv = rows.map(function(r){
    return r.map(function(v){ return '"' + String(v).replace(/"/g,'""') + '"'; }).join(",");
  }).join("\r\n");

  var name = "task-ledger-" + ui.list + "-" + todayISO() + ".csv";
  try{
    var blob = new Blob(["﻿" + csv], {type:"text/csv;charset=utf-8"});
    var url  = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    toast("Exported " + name);
  }catch(e){
    toast("Couldn't export here. Try from a browser tab rather than the installed app.");
  }
}

function pruneOld(){
  var cut = new Date(); cut.setDate(cut.getDate() - 30);
  var cutISO = cut.toISOString();
  var old = tasks.filter(function(t){ return t.done && t.doneAt && t.doneAt < cutISO; });
  if(!old.length){ toast("Nothing older than 30 days."); return; }
  var chain = Promise.resolve();
  old.forEach(function(t){ chain = chain.then(function(){ return removeTask(t.id); }); });
  chain.then(function(){
    toast("Cleared " + old.length + " old " + (old.length === 1 ? "entry" : "entries"));
  });
}

function renderRules(){
  var pool = settings.categories.filter(function(c){ return c.list === ui.list; });

  var html = '<div class="card" style="margin-top:14px">' +
    "<h3>What should I call you?</h3>" +
    '<p class="note">Used for the greeting at the top of the page. Leave it empty for a plain greeting.</p>' +
    '<div class="addrow" style="margin-top:0"><input type="text" id="nameInput" value="' +
      esc(settings.name || "") + '" placeholder="Your name" aria-label="Your name"></div></div>';

  html += '<div class="card">' +
    "<h3>How a priority gets decided</h3>" +
    '<p class="note">Every task inherits its level from the category you file it under, so you set the judgement ' +
    "once here instead of arguing with yourself over every task. The due date can then push a task up the ladder. " +
    "In your lists these show as friendlier names:</p>" +
    '<div class="ladder">' +
      LEVELS.slice().reverse().map(function(lv){
        return '<span style="background:var(--p-' + lv + '-bg);color:var(--p-' + lv + ')">' +
               BAND[lv] + " &nbsp;·&nbsp; " + LABEL[lv] + "</span>";
      }).join("") +
    "</div>" +
    '<div class="toggle" style="margin-top:14px"><input type="checkbox" id="escToday"' +
      (settings.escalateDueToday ? " checked" : "") + ">" +
      '<span><label for="escToday">Due today moves a task up one level</label>' +
      "<small>A Medium task due today shows as High.</small></span></div>" +
    '<div class="toggle"><input type="checkbox" id="escOver"' +
      (settings.escalateOverdue ? " checked" : "") + ">" +
      '<span><label for="escOver">Overdue moves a task up two levels</label>' +
      "<small>An overdue Medium task jumps to Critical.</small></span></div>" +
    "</div>";

  html += '<div class="card"><h3>' + (ui.list === "work" ? "Work" : "Personal") + " categories</h3>" +
    '<p class="note">Rename a category in place or change the level it assigns — every task filed under it re-sorts straight away.</p>' +
    '<table class="rules-table"><thead><tr><th>Category</th><th style="width:150px">Assigns</th><th style="width:44px"></th></tr></thead><tbody>' +
    pool.map(function(c){
      return '<tr data-cat="' + c.id + '"><td><input type="text" value="' + esc(c.name) + '" aria-label="Category name"></td>' +
        '<td><select aria-label="Priority">' +
        LEVELS.slice().reverse().map(function(lv){
          return '<option value="' + lv + '"' + (c.priority === lv ? " selected" : "") + ">" + LABEL[lv] + "</option>";
        }).join("") + "</select></td>" +
        '<td><button class="icon-btn" data-act="delcat" aria-label="Delete category">&times;</button></td></tr>';
    }).join("") +
    "</tbody></table>" +
    '<div class="addrow"><input type="text" id="newCatName" placeholder="New category name">' +
      '<select id="newCatLevel">' +
      LEVELS.slice().reverse().map(function(lv){
        return '<option value="' + lv + '"' + (lv === "med" ? " selected" : "") + ">" + LABEL[lv] + "</option>";
      }).join("") + "</select>" +
      '<button class="btn btn-primary" id="addCatBtn">Add category</button></div></div>';

  html += '<div class="card"><h3>Faster logging</h3><p class="note" style="margin-bottom:0">' +
    "Type straight into the box and let it read the details: <code>#</code> picks a category from the first few letters, " +
    "<code>!</code> overrides the level for one task, and a date word sets the due date. So " +
    "<code>Fix the jig drawing #design fri !high</code> files itself. Press <code>/</code> anywhere to jump to the box." +
    "</p></div>";

  var blocked = pushBlockedReason();
  var on = !!(pushSettings && pushSettings.enabled);
  var atHour = (pushSettings && typeof pushSettings.hour === "number") ? pushSettings.hour : 8;
  html += '<div class="card"><h3>Morning reminder</h3>' +
    '<p class="note">One notification a day with what\'s waiting — "3 things today, 1 slipped past its date." ' +
    "Nothing else is ever sent.</p>";
  if(blocked){
    html += '<p class="blocked">' + esc(blocked) + "</p>";
  } else {
    html += '<div class="toggle" style="border-top:0;padding-top:0"><input type="checkbox" id="pushOn"' +
      (on ? " checked" : "") + ">" +
      '<span><label for="pushOn">Send me a morning digest</label>' +
      "<small>Arrives within about half an hour of the time you pick.</small></span></div>" +
      '<div class="addrow" style="margin-top:4px;align-items:center">' +
        '<label for="pushHour" style="font-size:13.5px;color:var(--ink-2)">Around</label>' +
        '<select id="pushHour" aria-label="Reminder hour">' +
        (function(){
          var o = "";
          for(var h = 4; h <= 12; h++){
            o += '<option value="' + h + '"' + (h === atHour ? " selected" : "") + ">" +
                 (h < 10 ? "0" + h : h) + ":00</option>";
          }
          return o;
        })() +
        "</select>" +
        '<span style="font-size:12.5px;color:var(--ink-3)">' +
          esc((Intl.DateTimeFormat().resolvedOptions().timeZone) || "local time") + "</span>" +
      "</div>";
  }
  html += "</div>";

  if(cloud){
    html += '<div class="card"><h3>Your account</h3>' +
      '<p class="note">Signed in, so this list is the same on every device you sign in from. ' +
      "Signing out leaves the data safely on the server — it comes back when you sign in again.</p>" +
      '<button class="btn" id="signOutBtn">Sign out</button></div>';
  }

  main.innerHTML = html;

  var so = document.getElementById("signOutBtn");
  if(so) so.addEventListener("click", function(){ cloud.signOut(); });

  var pushOn = document.getElementById("pushOn");
  var pushHour = document.getElementById("pushHour");
  if(pushOn){
    pushOn.addEventListener("change", function(){
      var want = pushOn.checked;
      pushOn.disabled = true;
      var job = want ? enableReminder(parseInt(pushHour.value, 10)) : disableReminder();
      job.then(function(){
        toast(want ? "Reminder on — first one arrives tomorrow morning." : "Reminder off.");
      })["catch"](function(e){
        pushOn.checked = !want;
        var m = String(e && e.message || "");
        if(m.indexOf("permission-denied") === 0)
          toast("You'll need to allow notifications for this to work.");
        else if(m.indexOf("permission-") === 0)
          toast("Notifications weren't allowed, so the reminder stays off.");
        else
          toast("Couldn't set that up. Check you're online and try again.");
      }).then(function(){ pushOn.disabled = false; });
    });
  }
  if(pushHour){
    pushHour.addEventListener("change", function(){
      if(!pushOn || !pushOn.checked) return;
      cloud.setPush({hour: parseInt(pushHour.value, 10)})
        .then(function(){ toast("Reminder moved to " + pushHour.value + ":00."); })
        ["catch"](function(){ toast("Couldn't save that time."); });
    });
  }

  document.getElementById("nameInput").addEventListener("change", function(e){
    settings.name = e.target.value.trim(); persistSettings();
  });
  document.getElementById("escToday").addEventListener("change", function(e){
    settings.escalateDueToday = e.target.checked; persistSettings();
  });
  document.getElementById("escOver").addEventListener("change", function(e){
    settings.escalateOverdue = e.target.checked; persistSettings();
  });

  Array.prototype.forEach.call(main.querySelectorAll("tr[data-cat]"), function(tr){
    var c = catOf(tr.getAttribute("data-cat"));
    if(!c) return;
    tr.querySelector('input[type="text"]').addEventListener("change", function(e){
      var v = e.target.value.trim();
      if(!v){ e.target.value = c.name; return; }
      c.name = v; persistSettings();
    });
    tr.querySelector("select").addEventListener("change", function(e){
      c.priority = e.target.value; persistSettings();
    });
    tr.querySelector('[data-act="delcat"]').addEventListener("click", function(){
      var used = tasks.filter(function(t){ return t.categoryId === c.id; }).length;
      if(used){ toast(used + " task" + (used === 1 ? "" : "s") + " still filed under this category."); return; }
      settings.categories = settings.categories.filter(function(x){ return x.id !== c.id; });
      persistSettings();
    });
  });

  document.getElementById("addCatBtn").addEventListener("click", function(){
    var nameEl = document.getElementById("newCatName");
    var v = nameEl.value.trim();
    if(!v){ nameEl.focus(); return; }
    settings.categories.push({
      id:newId(), list:ui.list, name:v,
      priority:document.getElementById("newCatLevel").value
    });
    nameEl.value = ""; persistSettings();
  });
}

/* ============ the completion moment ============ */
function prefersReducedMotion(){
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function shortTitle(title, n){
  var t = String(title || "").trim();
  var max = n || 34;
  return t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : t;
}
function praiseFor(title){
  return PRAISE[Math.floor(Math.random() * PRAISE.length)].replace("{t}", shortTitle(title));
}

/* ============ toast, with undo ============ */
var toastTimer = null;
var undoAction = null;   /* what Ctrl+Z and the Undo button will do, while a toast is up */

function toast(msg, kind, onUndo){
  var el  = document.getElementById("toast");
  var txt = document.getElementById("toastText");
  var btn = document.getElementById("toastAction");
  txt.textContent = msg;
  undoAction = onUndo || null;
  btn.hidden = !undoAction;
  el.className = "toast show" + (kind === "good" ? " good" : "");
  clearTimeout(toastTimer);
  /* an undoable toast stays up long enough to actually react to */
  toastTimer = setTimeout(hideToast, undoAction ? 8000 : 2600);
}
function hideToast(){
  document.getElementById("toast").className = "toast";
  document.getElementById("toastAction").hidden = true;
  undoAction = null;
}
function runUndo(){
  if(!undoAction) return;
  var fn = undoAction;
  hideToast();
  fn();
}
document.getElementById("toastAction").addEventListener("click", runUndo);

/* put a completed task back, looked up fresh so a live update can't leave us
   holding a stale copy */
function restoreTask(id){
  for(var i = 0; i < tasks.length; i++){
    if(tasks[i].id === id){
      tasks[i].done = false; tasks[i].doneAt = null;
      render(); persistTask(tasks[i]);
      toast("Back on the list.");
      return;
    }
  }
}

/* ============ boot ============ */
updateHint();
render();
initStore();
})();
