/* Pendientes — app instalable (PWA)
   Funciona sin internet. Si configuras Supabase en config.js,
   además sincroniza entre dispositivos con tu correo. */
(function(){
"use strict";

var KEY = "pendientes.estado";
var THEME_KEY = "pendientes.tema";
var MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
var LABELS = {
  pago:  ["Pendiente","Pagado","En proceso","Atrasado"],
  cobro: ["Pendiente","Cobrado","En proceso","Atrasado"],
  otro:  ["Pendiente","Hecho","En proceso","Atrasado"]
};
var GLYPH = ["","✓","»","!"];

var REDUCE = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
var refs = [], flashId = null;
function buzz(ms){ try{ if(navigator.vibrate && !REDUCE) navigator.vibrate(ms); }catch(e){} }
function replay(el, cls){
  if(REDUCE || !el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

var db = null;
var today = new Date();
var view = { y: today.getFullYear(), m: today.getMonth() };
var editMode = false, confirmDel = null;
var pushTimer = null, pushing = false, pendingPush = false;
var sb = null, session = null, cloudReady = false;

/* ============ almacenamiento local (2 capas) ============ */
var canLS = true;
try { localStorage.setItem("__t","1"); localStorage.removeItem("__t"); } catch(e){ canLS = false; }

var idb = null, idbOK = false;
function idbOpen(){
  return new Promise(function(res, rej){
    try{
      if(!window.indexedDB) return rej();
      var r = indexedDB.open("pendientes", 1);
      r.onupgradeneeded = function(){ try{ r.result.createObjectStore("kv"); }catch(e){} };
      r.onsuccess = function(){ idb = r.result; idbOK = true; res(); };
      r.onerror = function(){ rej(); };
      r.onblocked = function(){ rej(); };
    }catch(e){ rej(); }
  });
}
function idbPut(v){
  if(!idbOK) return;
  try{ idb.transaction("kv","readwrite").objectStore("kv").put(JSON.stringify(v), KEY); }catch(e){}
}
function idbGet(){
  return new Promise(function(res){
    if(!idbOK) return res(null);
    try{
      var rq = idb.transaction("kv","readonly").objectStore("kv").get(KEY);
      rq.onsuccess = function(){ try{ res(rq.result ? JSON.parse(rq.result) : null); }catch(e){ res(null); } };
      rq.onerror = function(){ res(null); };
    }catch(e){ res(null); }
  });
}
function saveLocal(){
  if(canLS){ try{ localStorage.setItem(KEY, JSON.stringify(db)); }catch(e){ canLS = false; } }
  idbPut(db);
}
function loadLocal(){
  if(canLS){
    try{ var raw = localStorage.getItem(KEY); if(raw) return JSON.parse(raw); }catch(e){}
  }
  return null;
}

/* ============ modelo ============ */
function uid(){ return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-3); }
function mkey(){ return view.y + "-" + String(view.m+1).padStart(2,"0"); }

function defaults(){
  function it(t,day,note){ return {id:uid(), title:t, day:day||null, note:note||""}; }
  return {
    v:5, updatedAt: Date.now(),
    sections:[
      {id:uid(), name:"Pagos del mes", kind:"pago", items:[
        it("Pago de cel", null, "Automático de tarjeta"),
        it("Pago de internet casa", 16),
        it("Pago de internet local Rosas", 10),
        it("Pago de luz local Rosas", 13),
        it("Pago de local Rosas", 3, "Primeros 3 días del mes"),
        it("Pago de parqueo BO", 7, "Primera semana"),
        it("Pago de tarjeta", 27)
      ]},
      {id:uid(), name:"Cada 6 meses", kind:"pago", items:[
        it("Pago de HBO Max", null, "Cada 6 meses"),
        it("Pago de Spotify", null, "Cada 6 meses")
      ]},
      {id:uid(), name:"Recientes", kind:"otro", items:[
        it("Pago de boleta residencia Q200"),
        it("Xbox Jask")
      ]},
      {id:uid(), name:"Me deben", kind:"cobro", items:[
        it("Jeni", null, "Laboratorios"),
        it("Jose", null, "Tablet"),
        it("Misión", null, "Extras julio"),
        it("Dr. Morales", null, "2 salas")
      ]}
    ],
    marks:{}
  };
}
function normalize(d){
  if(!d || !Object.prototype.toString.call(d.sections).match(/Array/)) return null;
  if(!d.marks) d.marks = {};
  if(!d.updatedAt) d.updatedAt = 0;
  return d;
}

/* ============ indicador de guardado ============ */
function setPill(kind, txt, warn){
  var pill = document.getElementById("saveDot");
  var w = document.getElementById("warnbar");
  pill.className = "savepill" + (kind ? " " + kind : "");
  pill.textContent = txt;
  if(warn){ w.style.display = "block"; w.textContent = warn; }
  else { w.style.display = "none"; }
}
function idlePill(){
  if(!cloudReady) setPill("ok", "guardado aquí");
  else if(!navigator.onLine) setPill("busy", "pendiente de subir");
  else setPill("ok", "sincronizado");
}

/* ============ nube (Supabase, opcional) ============ */
function cfg(){ return window.APP_CONFIG || {}; }
function cloudConfigured(){ return !!(cfg().SUPABASE_URL && cfg().SUPABASE_ANON_KEY); }

function initCloud(){
  if(!cloudConfigured() || !window.supabase) return Promise.resolve(null);
  try{
    sb = window.supabase.createClient(cfg().SUPABASE_URL, cfg().SUPABASE_ANON_KEY, {
      auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
    });
  }catch(e){ return Promise.resolve(null); }
  return sb.auth.getSession().then(function(r){
    session = (r && r.data && r.data.session) || null;
    cloudReady = !!session;
    sb.auth.onAuthStateChange(function(_e, s){
      session = s || null;
      cloudReady = !!session;
      paintAuth();
      if(cloudReady) syncNow();
    });
    return session;
  })["catch"](function(){ return null; });
}
function paintAuth(){
  var who = document.getElementById("who");
  var btn = document.getElementById("btnAuth");
  if(!cloudConfigured()){
    who.textContent = "Solo en este dispositivo";
    btn.textContent = "¿Cómo sincronizo?";
    return;
  }
  if(session && session.user){
    who.textContent = session.user.email;
    btn.textContent = "Cuenta";
  } else {
    who.textContent = "Solo en este dispositivo";
    btn.textContent = "Activar sincronización";
  }
  idlePill();
}
function pullRemote(){
  if(!cloudReady) return Promise.resolve(null);
  return sb.from("pendientes").select("data").eq("user_id", session.user.id).maybeSingle()
    .then(function(r){ return (r && r.data && r.data.data) ? normalize(r.data.data) : null; })
    ["catch"](function(){ return null; });
}
function pushRemote(){
  if(!cloudReady) return Promise.resolve(false);
  return sb.from("pendientes").upsert({
    user_id: session.user.id,
    data: db,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" }).then(function(r){
    if(r && r.error) throw r.error;
    return true;
  });
}
function syncNow(){
  if(!cloudReady){ idlePill(); return Promise.resolve(); }
  setPill("busy","sincronizando…");
  return pullRemote().then(function(remote){
    if(remote && (remote.updatedAt || 0) > (db.updatedAt || 0)){
      db = remote; saveLocal(); render();
      idlePill();
      return;
    }
    if(!remote || (db.updatedAt || 0) > (remote.updatedAt || 0)) return pushRemote();
  }).then(function(){ idlePill(); })
  ["catch"](function(){
    setPill("bad","sin subir","No se pudo conectar con la nube. Tus cambios están guardados en este dispositivo y se subirán solos cuando haya conexión.");
  });
}
function schedulePush(){
  if(!cloudReady) return;
  if(pushTimer) clearTimeout(pushTimer);
  setPill("busy","guardando…");
  pushTimer = setTimeout(flushPush, 1200);
}
function flushPush(){
  if(!cloudReady) return;
  if(pushing){ pendingPush = true; return; }
  pushing = true; pendingPush = false;
  pushRemote().then(function(){
    pushing = false;
    if(pendingPush) flushPush(); else idlePill();
  })["catch"](function(){
    pushing = false;
    setPill("bad","sin subir","No se pudo subir a la nube. Tus cambios están guardados en este dispositivo; se subirán cuando vuelva la conexión.");
  });
}

/* ============ guardar ============ */
function save(){
  if(!db) return;
  db.updatedAt = Date.now();
  saveLocal();
  if(cloudReady) schedulePush();
  else setPill("ok","guardado aquí");
}

/* ============ render ============ */
var app = document.getElementById("app");
function marksFor(k){ if(!db.marks[k]) db.marks[k] = {}; return db.marks[k]; }
function stateOf(id){ return marksFor(mkey())[id] || 0; }
function setState(id, v){
  var m = marksFor(mkey());
  if(v) m[id] = v; else delete m[id];
  save();
}
function mk(tag, cls, txt){
  var e = document.createElement(tag);
  if(cls) e.className = cls;
  if(txt != null) e.textContent = txt;
  return e;
}
function btn(txt, fn){ var b = mk("button","mini",txt); b.addEventListener("click", fn); return b; }
function delBtn(key, fn){
  var b = mk("button","mini danger","🗑");
  if(confirmDel === key){ b.className = "mini confirm"; b.textContent = "Borrar"; }
  b.addEventListener("click", function(e){
    e.stopPropagation();
    if(confirmDel === key){ confirmDel = null; fn(); } else { confirmDel = key; render(); }
  });
  return b;
}
function move(arr, i, d){
  var j = i + d;
  if(j < 0 || j >= arr.length) return;
  var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
}
function dueInfo(item, st){
  if(!item.day || st === 1) return null;
  if(view.y !== today.getFullYear() || view.m !== today.getMonth()) return null;
  var diff = item.day - today.getDate();
  if(diff < 0) return {cls:"late", txt:"ya venció"};
  if(diff === 0) return {cls:"late", txt:"vence hoy"};
  if(diff <= 3) return {cls:"soon", txt:"faltan " + diff + " día" + (diff>1?"s":"")};
  return null;
}

function fillMeta(meta, item, st){
  if(!meta) return;
  meta.innerHTML = "";
  if(item.day) meta.appendChild(mk("span","pill","antes del " + item.day));
  if(item.note) meta.appendChild(mk("span",null,item.note));
  var due = dueInfo(item, st);
  if(due) meta.appendChild(mk("span","pill " + due.cls, due.txt));
}
function updateRow(row, sec, item){
  var st = stateOf(item.id);
  row.className = "item st" + st;
  var box = row.querySelector(".box");
  box.textContent = GLYPH[st];
  replay(box, "pop");
  var status = row.querySelector(".status");
  if(status){
    status.textContent = (LABELS[sec.kind] || LABELS.otro)[st];
    replay(status, "swap");
  }
  fillMeta(row.querySelector(".it-meta"), item, st);
  buzz(st === 1 ? 14 : 8);
  refreshCounts();
}
function refreshCounts(){
  var total = 0, done = 0;
  refs.forEach(function(r){
    var d = r.sec.items.filter(function(i){ return stateOf(i.id) === 1; }).length;
    total += r.sec.items.length; done += d;
    if(r.countEl){
      var txt = d + "/" + r.sec.items.length;
      if(r.countEl.textContent !== txt){ r.countEl.textContent = txt; replay(r.countEl, "pulse"); }
      r.countEl.classList.toggle("full", r.sec.items.length > 0 && d === r.sec.items.length);
    }
  });
  var pct = total ? Math.round(done/total*100) : 0;
  document.getElementById("barFill").style.width = pct + "%";
  document.getElementById("barText").textContent = done + " de " + total + " listos";
  document.getElementById("barPct").textContent = pct + "%";
}
function swapMonth(dir){
  replay(document.getElementById("monthName"), "bump");
  if(REDUCE){ render(); return; }
  app.classList.add(dir < 0 ? "out-right" : "out-left");
  setTimeout(function(){
    app.classList.remove("out-left","out-right");
    render();
  }, 160);
}

function render(){
  if(!db) return;
  app.innerHTML = "";
  refs = [];
  document.getElementById("monthName").textContent = MESES[view.m] + " " + view.y;
  document.getElementById("btnEdit").classList.toggle("on", editMode);

  db.sections.forEach(function(sec, si){
    var card = mk("div","card");
    var head = mk("div","sechead");
    head.appendChild(mk("h2","secname", sec.name));
    if(editMode){
      var tools = mk("div","sectools");
      tools.appendChild(btn("✎", function(){ openSectionEditor(sec); }));
      tools.appendChild(btn("↑", function(){ move(db.sections, si, -1); save(); render(); }));
      tools.appendChild(btn("↓", function(){ move(db.sections, si, 1); save(); render(); }));
      tools.appendChild(delBtn("sec-"+sec.id, function(){ db.sections.splice(si,1); save(); render(); }));
      head.appendChild(tools);
      refs.push({sec:sec, countEl:null});
    } else {
      var d = sec.items.filter(function(i){ return stateOf(i.id) === 1; }).length;
      var countEl = mk("div","seccount", d + "/" + sec.items.length);
      if(sec.items.length && d === sec.items.length) countEl.classList.add("full");
      head.appendChild(countEl);
      refs.push({sec:sec, countEl:countEl});
    }
    card.appendChild(head);

    sec.items.forEach(function(item, ii){
      var st = stateOf(item.id);
      var row = mk("div","item st" + st);
      if(item.id === flashId) row.classList.add("enter");
      row.appendChild(mk("div","box", GLYPH[st]));
      var body = mk("div","it-body");
      body.appendChild(mk("div","it-title", item.title));
      var meta = mk("div","it-meta");
      fillMeta(meta, item, st);
      body.appendChild(meta);
      row.appendChild(body);

      if(editMode){
        var rt = mk("div","rowtools");
        rt.appendChild(btn("✎", function(e){ e.stopPropagation(); openItemEditor(sec, item); }));
        rt.appendChild(btn("↑", function(e){ e.stopPropagation(); move(sec.items, ii, -1); save(); render(); }));
        rt.appendChild(btn("↓", function(e){ e.stopPropagation(); move(sec.items, ii, 1); save(); render(); }));
        rt.appendChild(delBtn("it-"+item.id, function(){
          var doRemove = function(){
            sec.items.splice(ii,1);
            Object.keys(db.marks).forEach(function(k){ delete db.marks[k][item.id]; });
            save(); render();
          };
          if(REDUCE) return doRemove();
          row.classList.add("leave");
          setTimeout(doRemove, 240);
        }));
        row.appendChild(rt);
      } else {
        row.appendChild(mk("div","status", (LABELS[sec.kind] || LABELS.otro)[st]));
        row.addEventListener("click", function(){
          setState(item.id, (stateOf(item.id) + 1) % 4);
          updateRow(row, sec, item);
        });
      }
      card.appendChild(row);
    });

    var add = mk("div","addrow","+ Agregar pendiente");
    add.addEventListener("click", function(){ openItemEditor(sec, null); });
    card.appendChild(add);
    if(!REDUCE) card.style.animationDelay = Math.min(si * 45, 180) + "ms";
    app.appendChild(card);
  });

  flashId = null;
  refreshCounts();
}

/* ============ editor ============ */
var editor = document.getElementById("editor");
var edMode = "item", edSec = null, edItem = null;
function openEditor(){ editor.classList.add("open"); setTimeout(function(){ document.getElementById("edName").focus(); }, 60); }
function closeEditor(){ editor.classList.remove("open"); edSec = null; edItem = null; }
function openItemEditor(sec, item){
  edMode = "item"; edSec = sec; edItem = item;
  document.getElementById("edTitle").textContent = item ? "Editar pendiente" : "Nuevo pendiente";
  document.getElementById("edNameLbl").textContent = "Nombre";
  document.getElementById("edItemFields").style.display = "block";
  document.getElementById("edKindWrap").style.display = "none";
  document.getElementById("edName").value = item ? item.title : "";
  document.getElementById("edNote").value = item ? (item.note || "") : "";
  document.getElementById("edDay").value = item && item.day ? item.day : "";
  openEditor();
}
function openSectionEditor(sec){
  edMode = "section"; edSec = sec;
  document.getElementById("edTitle").textContent = sec ? "Editar lista" : "Nueva lista";
  document.getElementById("edNameLbl").textContent = "Nombre de la lista";
  document.getElementById("edItemFields").style.display = "none";
  document.getElementById("edKindWrap").style.display = "block";
  document.getElementById("edName").value = sec ? sec.name : "";
  document.getElementById("edKind").value = sec ? (sec.kind || "otro") : "otro";
  openEditor();
}
document.getElementById("edCancel").addEventListener("click", closeEditor);
editor.addEventListener("click", function(e){ if(e.target === editor) closeEditor(); });
document.getElementById("edName").addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); document.getElementById("edSave").click(); }
});
document.getElementById("edSave").addEventListener("click", function(){
  var name = document.getElementById("edName").value.trim();
  if(!name){ closeEditor(); return; }
  if(edMode === "item"){
    var note = document.getElementById("edNote").value.trim();
    var dayRaw = parseInt(document.getElementById("edDay").value,10);
    var day = (dayRaw >= 1 && dayRaw <= 31) ? dayRaw : null;
    if(edItem){ edItem.title = name; edItem.note = note; edItem.day = day; flashId = edItem.id; }
    else {
      var nuevo = {id:uid(), title:name, note:note, day:day};
      edSec.items.push(nuevo);
      flashId = nuevo.id;
      buzz(12);
    }
  } else {
    var kind = document.getElementById("edKind").value;
    if(edSec){ edSec.name = name; edSec.kind = kind; }
    else { db.sections.push({id:uid(), name:name, kind:kind, items:[]}); }
  }
  closeEditor(); save(); render();
});

/* ============ cabecera ============ */
document.getElementById("prev").addEventListener("click", function(){
  view.m--; if(view.m < 0){ view.m = 11; view.y--; } confirmDel = null; swapMonth(-1);
});
document.getElementById("next").addEventListener("click", function(){
  view.m++; if(view.m > 11){ view.m = 0; view.y++; } confirmDel = null; swapMonth(1);
});
document.getElementById("monthName").addEventListener("click", function(){
  var n = new Date();
  if(n.getFullYear() === view.y && n.getMonth() === view.m) return;
  var dir = (n.getFullYear() * 12 + n.getMonth()) < (view.y * 12 + view.m) ? -1 : 1;
  view.y = n.getFullYear(); view.m = n.getMonth();
  swapMonth(dir);
});

/* deslizar con el dedo para cambiar de mes */
(function swipe(){
  var x0 = null, y0 = null;
  app.addEventListener("touchstart", function(e){
    if(e.touches.length !== 1) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, {passive:true});
  app.addEventListener("touchend", function(e){
    if(x0 === null) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if(Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
    if(dx < 0){ view.m++; if(view.m > 11){ view.m = 0; view.y++; } swapMonth(1); }
    else { view.m--; if(view.m < 0){ view.m = 11; view.y--; } swapMonth(-1); }
    buzz(8);
  }, {passive:true});
})();

/* onda al tocar cualquier control */
document.addEventListener("pointerdown", function(e){
  if(REDUCE) return;
  var el = e.target.closest && e.target.closest(".item,.addrow,.btn,.iconbtn,.menuitem,.mini,.monthname");
  if(!el) return;
  var r = el.getBoundingClientRect();
  var d = Math.max(r.width, r.height);
  var s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = d + "px";
  s.style.left = (e.clientX - r.left - d/2) + "px";
  s.style.top = (e.clientY - r.top - d/2) + "px";
  el.appendChild(s);
  setTimeout(function(){ if(s.parentNode) s.parentNode.removeChild(s); }, 620);
  if(el.classList.contains("item")){
    el.classList.add("press");
    setTimeout(function(){ el.classList.remove("press"); }, 170);
  }
});
document.getElementById("btnEdit").addEventListener("click", function(){
  editMode = !editMode; confirmDel = null; render();
});
document.getElementById("btnTheme").addEventListener("click", function(){
  var cur = document.documentElement.getAttribute("data-theme");
  if(!cur) cur = (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  var next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try{ localStorage.setItem(THEME_KEY, next); }catch(e){}
});
document.getElementById("btnNewSec").addEventListener("click", function(){ openSectionEditor(null); });

/* ============ menú ============ */
var menu = document.getElementById("menu");
function closeMenu(){ menu.classList.remove("open"); }
document.getElementById("btnMenu").addEventListener("click", function(){ menu.classList.add("open"); });
document.getElementById("mClose").addEventListener("click", closeMenu);
menu.addEventListener("click", function(e){ if(e.target === menu) closeMenu(); });
document.getElementById("mClear").addEventListener("click", function(){
  db.marks[mkey()] = {}; save(); closeMenu(); render();
});
document.getElementById("mCopy").addEventListener("click", function(){
  var pm = view.m - 1, py = view.y;
  if(pm < 0){ pm = 11; py--; }
  var src = db.marks[py + "-" + String(pm+1).padStart(2,"0")] || {};
  var dst = marksFor(mkey());
  Object.keys(src).forEach(function(k){ dst[k] = src[k]; });
  save(); closeMenu(); render();
});
document.getElementById("mSync").addEventListener("click", function(){
  closeMenu();
  if(!cloudReady){ openAuth(); return; }
  syncNow();
});
document.getElementById("mExport").addEventListener("click", function(){
  var blob = new Blob([JSON.stringify(db, null, 2)], {type:"application/json"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pendientes-respaldo-" + mkey() + ".json";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
  closeMenu();
});
document.getElementById("mImport").addEventListener("click", function(){ document.getElementById("fileIn").click(); });
document.getElementById("fileIn").addEventListener("change", function(e){
  var f = e.target.files && e.target.files[0];
  if(!f) return;
  var r = new FileReader();
  r.onload = function(){
    try{
      var data = normalize(JSON.parse(r.result));
      if(!data) throw new Error("formato");
      db = data; closeMenu(); save(); render();
    }catch(err){
      var w = document.getElementById("warnbar");
      w.style.display = "block";
      w.textContent = "No se pudo leer ese archivo de respaldo.";
    }
  };
  r.readAsText(f);
  e.target.value = "";
});

/* ============ cuenta ============ */
var auth = document.getElementById("auth");
var pendingEmail = "";
function openAuth(){
  var msg = document.getElementById("authMsg");
  msg.className = "ok-msg"; msg.textContent = "";
  var emailWrap = document.getElementById("authEmailWrap");
  var go = document.getElementById("authGo");
  var outWrap = document.getElementById("authOutWrap");
  var note = document.getElementById("authNote");
  document.getElementById("authCodeWrap").style.display = "none";
  document.getElementById("authVerify").style.display = "none";

  if(!cloudConfigured()){
    document.getElementById("authTitle").textContent = "Sincronización no configurada";
    note.textContent = "Esta copia guarda todo en el dispositivo donde la abres. Para que el celular y la computadora vean lo mismo, hay que pegar los datos de un proyecto gratuito de Supabase en el archivo config.js. Está explicado paso a paso en el README.";
    emailWrap.style.display = "none"; go.style.display = "none"; outWrap.style.display = "none";
  } else if(session && session.user){
    document.getElementById("authTitle").textContent = "Tu cuenta";
    note.textContent = "Estás dentro como " + session.user.email + ". Tus listas se sincronizan solas entre tus dispositivos.";
    emailWrap.style.display = "none"; go.style.display = "none"; outWrap.style.display = "flex";
  } else {
    document.getElementById("authTitle").textContent = "Activar sincronización";
    note.textContent = "Escribe tu correo y te llega un código de 6 dígitos. No hay contraseña que recordar. Al entrar, tus listas se guardan en la nube y aparecen igual en el celular y en la computadora.";
    emailWrap.style.display = "block"; go.style.display = "block"; outWrap.style.display = "none";
    document.getElementById("authEmail").value = pendingEmail;
  }
  auth.classList.add("open");
}
function closeAuth(){ auth.classList.remove("open"); }
document.getElementById("btnAuth").addEventListener("click", openAuth);
document.getElementById("authCancel").addEventListener("click", closeAuth);
auth.addEventListener("click", function(e){ if(e.target === auth) closeAuth(); });
document.getElementById("authGo").addEventListener("click", function(){
  var email = document.getElementById("authEmail").value.trim();
  var msg = document.getElementById("authMsg");
  if(!email || email.indexOf("@") < 0){
    msg.className = "ok-msg show"; msg.textContent = "Escribe un correo válido.";
    return;
  }
  if(!sb){ msg.className = "ok-msg show"; msg.textContent = "La nube no está configurada todavía."; return; }
  msg.className = "ok-msg show"; msg.textContent = "Enviando…";
  pendingEmail = email;
  sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.href.split("#")[0] } })
    .then(function(r){
      if(r && r.error) throw r.error;
      msg.textContent = "Revisa tu correo: escribe aquí el código de 6 dígitos (o toca el enlace si abres desde el navegador).";
      document.getElementById("authCodeWrap").style.display = "block";
      document.getElementById("authVerify").style.display = "block";
      document.getElementById("authGo").textContent = "Reenviar";
      setTimeout(function(){ document.getElementById("authCode").focus(); }, 80);
    })["catch"](function(err){
      msg.textContent = "No se pudo enviar: " + ((err && err.message) || "revisa tu conexión");
    });
});
function verifyCode(){
  var msg = document.getElementById("authMsg");
  var code = document.getElementById("authCode").value.replace(/\D/g,"");
  if(code.length < 6){ msg.className = "ok-msg show"; msg.textContent = "El código son 6 dígitos."; return; }
  if(!sb) return;
  msg.className = "ok-msg show"; msg.textContent = "Entrando…";
  sb.auth.verifyOtp({ email: pendingEmail, token: code, type: "email" }).then(function(r){
    if(r && r.error) throw r.error;
    session = (r && r.data && r.data.session) || session;
    cloudReady = !!session;
    msg.textContent = "¡Listo! Sincronización activada.";
    paintAuth();
    syncNow();
    setTimeout(closeAuth, 900);
  })["catch"](function(err){
    msg.textContent = "Ese código no sirvió: " + ((err && err.message) || "vuelve a intentar");
  });
}
document.getElementById("authVerify").addEventListener("click", verifyCode);
document.getElementById("authCode").addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); verifyCode(); }
});
document.getElementById("authOut").addEventListener("click", function(){
  if(!sb) return;
  sb.auth.signOut().then(function(){
    session = null; cloudReady = false; paintAuth(); closeAuth();
  });
});

/* ============ conexión ============ */
function paintOnline(){
  document.getElementById("offlineBar").classList.toggle("show", !navigator.onLine);
}
window.addEventListener("online", function(){ paintOnline(); if(cloudReady) syncNow(); });
window.addEventListener("offline", paintOnline);

document.addEventListener("visibilitychange", function(){
  if(document.visibilityState === "visible"){
    var n = new Date();
    if(n.getDate() !== today.getDate()){ today = n; render(); }
    if(cloudReady && navigator.onLine) syncNow();
  }
});

/* ============ instalación ============ */
var deferredPrompt = null;
window.addEventListener("beforeinstallprompt", function(e){
  e.preventDefault(); deferredPrompt = e;
  var hint = document.getElementById("installHint");
  hint.innerHTML = "";
  var b = mk("button","linkbtn","Instalar esta app en el dispositivo");
  b.addEventListener("click", function(){
    deferredPrompt.prompt();
    deferredPrompt = null;
    hint.textContent = "";
  });
  hint.appendChild(b);
});
(function iosHint(){
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if(isIOS && !standalone){
    document.getElementById("installHint").textContent =
      "Para tenerla como app: toca Compartir (el cuadrito con la flecha) y luego “Añadir a pantalla de inicio”.";
  }
})();

/* ============ arranque ============ */
try{
  var t = localStorage.getItem(THEME_KEY);
  if(t) document.documentElement.setAttribute("data-theme", t);
}catch(e){}
paintOnline();

Promise.race([
  idbOpen()["catch"](function(){}),
  new Promise(function(r){ setTimeout(r, 1200); })
]).then(function(){
  var local = normalize(loadLocal());
  if(local){ return local; }
  return idbGet().then(function(d){ return normalize(d); });
}).then(function(local){
  db = local || defaults();
  render();
  paintAuth();
  idlePill();
  return initCloud();
}).then(function(){
  paintAuth();
  if(cloudReady && navigator.onLine) return syncNow();
  idlePill();
});

/* ============ service worker (para que abra sin internet) ============ */
if("serviceWorker" in navigator){
  window.addEventListener("load", function(){
    navigator.serviceWorker.register("sw.js")["catch"](function(){});
  });
}
})();
