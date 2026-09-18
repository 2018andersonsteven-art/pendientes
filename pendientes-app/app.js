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
    bitacora: [], procsExtra: [], bitacoraTitulo: "Extras La Misión",
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
/* Procedimientos que salen como botones al registrar un extra.
   Los que el usuario teclee se guardan en db.procsExtra y se suman a estos. */
var PROCS_BASE = ["INGRESO","HEMATOLOGÍA","ORINA","FT","DENGUE","EMERGENCIA",
                  "AYUDANTÍA EN SALA","SUTURAS","RETIRO DE YESO"];

function normalize(d){
  if(!d || !Object.prototype.toString.call(d.sections).match(/Array/)) return null;
  if(!d.marks) d.marks = {};
  if(!d.updatedAt) d.updatedAt = 0;
  // Campos nuevos: los respaldos viejos no los traen y se crean vacíos.
  if(!d.bitacora) d.bitacora = [];
  if(!d.procsExtra) d.procsExtra = [];
  if(!d.bitacoraTitulo) d.bitacoraTitulo = "Extras La Misión";
  return d;
}
function listaProcs(){
  return PROCS_BASE.concat((db && db.procsExtra) || []);
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
    /* Primera vez que ESTE dispositivo se conecta a ESTA cuenta:
       manda lo que ya está en la nube. Lo local aquí es solo el
       arranque de fábrica y no debe pisar lo que ya tenías. */
    var primeraVez = db.cloudUserId !== session.user.id;
    if(primeraVez){
      if(remote){
        db = remote;
        db.cloudUserId = session.user.id;
        saveLocal(); render();
        return;
      }
      db.cloudUserId = session.user.id;
      saveLocal();
      return pushRemote();
    }
    if(remote && (remote.updatedAt || 0) > (db.updatedAt || 0)){
      db = remote; saveLocal(); render();
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
var MES_CORTO = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
/* "2026-09-24" -> Date local, sin que el navegador lo interprete como UTC */
function fechaDe(txt){
  var p = String(txt).split("-");
  return new Date(parseInt(p[0],10), parseInt(p[1],10)-1, parseInt(p[2],10));
}
function horaLegible(hhmm){
  var p = String(hhmm).split(":");
  var h = parseInt(p[0],10), m = p[1];
  var suf = h >= 12 ? "PM" : "AM";
  var h12 = h % 12; if(h12 === 0) h12 = 12;
  return h12 + ":" + m + " " + suf;
}
function etiquetaFecha(item){
  var d = fechaDe(item.date);
  var txt = d.getDate() + " " + MES_CORTO[d.getMonth()];
  if(d.getFullYear() !== today.getFullYear()) txt += " " + d.getFullYear();
  if(item.time) txt += " · " + horaLegible(item.time);
  return txt;
}
function dueInfo(item, st){
  if(st === 1) return null;
  var diff;
  if(item.date){
    // Los de fecha exacta se miden contra hoy, sin importar qué mes estés viendo.
    var hoy = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    diff = Math.round((fechaDe(item.date) - hoy) / 86400000);
  } else if(item.day){
    // Los mensuales solo tienen sentido en el mes actual.
    if(view.y !== today.getFullYear() || view.m !== today.getMonth()) return null;
    diff = item.day - today.getDate();
  } else return null;

  if(diff < 0) return {cls:"late", txt:"ya venció"};
  if(diff === 0) return {cls:"late", txt:"es hoy"};
  if(diff <= 3) return {cls:"soon", txt:"faltan " + diff + " día" + (diff>1?"s":"")};
  return null;
}

function fillMeta(meta, item, st){
  if(!meta) return;
  meta.innerHTML = "";
  if(item.date) meta.appendChild(mk("span","pill", etiquetaFecha(item)));
  else if(item.day) meta.appendChild(mk("span","pill","antes del " + item.day));
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
  renderBitacora();
}

/* ============ bitácora de extras ============
   Es un registro, no una lista de pendientes: no se marca como hecho,
   no cuenta en la barra de progreso y NO entra al calendario —
   construirIcs solo recorre db.sections, y la bitácora vive aparte. */
function extrasDelMes(){
  var clave = mkey();
  return (db.bitacora || [])
    .filter(function(e){ return (e.fecha || "").slice(0,7) === clave; })
    .sort(function(a,b){ return a.fecha.localeCompare(b.fecha); });
}
function renderBitacora(){
  var cont = document.getElementById("bitacora");
  cont.innerHTML = "";
  if(!db) return;

  var card = mk("div","card");
  var head = mk("div","sechead");
  if(editMode){
    var nombreIn = mk("input","secname");
    nombreIn.value = db.bitacoraTitulo;
    nombreIn.addEventListener("input", function(){ db.bitacoraTitulo = nombreIn.value; save(); });
    head.appendChild(nombreIn);
  } else {
    head.appendChild(mk("h2","secname", db.bitacoraTitulo));
  }
  var lista = extrasDelMes();
  head.appendChild(mk("div","seccount", String(lista.length)));
  card.appendChild(head);

  if(lista.length === 0){
    card.appendChild(mk("div","vacio","Sin extras registrados en " + MESES[view.m] + "."));
  }
  lista.forEach(function(e){
    var fila = mk("div","extra");
    var p = e.fecha.split("-");
    var caja = mk("div","fecha-caja");
    caja.appendChild(mk("b", null, String(parseInt(p[2],10))));
    caja.appendChild(mk("span", null, MES_CORTO[parseInt(p[1],10)-1]));
    fila.appendChild(caja);

    var quien = mk("div","quien");
    quien.appendChild(mk("div","nombre", e.nombre));
    if(e.nota) quien.appendChild(mk("div","nota-extra", e.nota));
    var procs = mk("div","procs");
    (e.procs || []).forEach(function(x){ procs.appendChild(mk("span","pill", x)); });
    quien.appendChild(procs);
    fila.appendChild(quien);

    if(editMode){
      var rt = mk("div","rowtools");
      rt.appendChild(delBtn("ex-"+e.id, function(){
        db.bitacora = db.bitacora.filter(function(x){ return x.id !== e.id; });
        save(); render();
      }));
      fila.appendChild(rt);
    } else {
      fila.addEventListener("click", function(){ abrirExtra(e); });
    }
    card.appendChild(fila);
  });

  var add = mk("div","addrow","+ Agregar extra");
  add.addEventListener("click", function(){ abrirExtra(null); });
  card.appendChild(add);
  cont.appendChild(card);
}

var hojaExtra = document.getElementById("extra");
var exEditando = null, exSeleccion = [];

function pintarChips(){
  var cont = document.getElementById("exChips");
  cont.innerHTML = "";
  listaProcs().forEach(function(p){
    var b = mk("button","chip" + (exSeleccion.indexOf(p) >= 0 ? " on" : ""), p);
    b.addEventListener("click", function(){
      var i = exSeleccion.indexOf(p);
      if(i >= 0) exSeleccion.splice(i,1); else exSeleccion.push(p);
      pintarChips();
    });
    cont.appendChild(b);
  });
}
function hoyTexto(){
  var n = new Date();
  return n.getFullYear() + "-" + String(n.getMonth()+1).padStart(2,"0") + "-" + String(n.getDate()).padStart(2,"0");
}
function abrirExtra(entrada){
  exEditando = entrada;
  exSeleccion = entrada ? (entrada.procs || []).slice() : [];
  document.getElementById("exTitulo").textContent = entrada ? "Editar extra" : "Nuevo extra";
  document.getElementById("exMsg").className = "ok-msg";
  document.getElementById("exMsg").textContent = "";
  document.getElementById("exNombre").value = entrada ? entrada.nombre : "";
  // Si estás viendo otro mes, la fecha arranca en el día 1 de ese mes;
  // si estás en el mes actual, arranca hoy. Evita registrar en el mes equivocado.
  var porDefecto = (view.y === today.getFullYear() && view.m === today.getMonth())
    ? hoyTexto()
    : view.y + "-" + String(view.m+1).padStart(2,"0") + "-01";
  document.getElementById("exFecha").value = entrada ? entrada.fecha : porDefecto;
  document.getElementById("exNota").value = entrada ? (entrada.nota || "") : "";
  document.getElementById("exOtro").value = "";
  document.getElementById("exBorrarWrap").style.display = entrada ? "flex" : "none";
  pintarChips();
  hojaExtra.classList.add("open");
  setTimeout(function(){ document.getElementById("exNombre").focus(); }, 60);
}
function cerrarExtra(){ hojaExtra.classList.remove("open"); exEditando = null; }
document.getElementById("exCancel").addEventListener("click", cerrarExtra);
hojaExtra.addEventListener("click", function(e){ if(e.target === hojaExtra) cerrarExtra(); });

document.getElementById("exAddOtro").addEventListener("click", function(){
  var v = document.getElementById("exOtro").value.trim().toUpperCase();
  if(!v) return;
  if(listaProcs().indexOf(v) < 0){ db.procsExtra.push(v); save(); }
  if(exSeleccion.indexOf(v) < 0) exSeleccion.push(v);
  document.getElementById("exOtro").value = "";
  pintarChips();
});
document.getElementById("exOtro").addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); document.getElementById("exAddOtro").click(); }
});

document.getElementById("exSave").addEventListener("click", function(){
  var msg = document.getElementById("exMsg");
  var nombre = document.getElementById("exNombre").value.trim();
  var fecha = document.getElementById("exFecha").value;
  if(!nombre){ msg.className = "ok-msg show"; msg.textContent = "Falta el nombre."; return; }
  if(!fecha){ msg.className = "ok-msg show"; msg.textContent = "Falta la fecha."; return; }
  if(exSeleccion.length === 0){ msg.className = "ok-msg show"; msg.textContent = "Marca al menos un procedimiento."; return; }

  if(exEditando){
    exEditando.nombre = nombre;
    exEditando.fecha = fecha;
    exEditando.procs = exSeleccion.slice();
    exEditando.nota = document.getElementById("exNota").value.trim();
  } else {
    db.bitacora.push({
      id: uid(), nombre: nombre, fecha: fecha,
      procs: exSeleccion.slice(),
      nota: document.getElementById("exNota").value.trim()
    });
    buzz(12);
  }
  cerrarExtra();
  save();
  // Si registraste en otro mes, salta a ese mes para que lo veas.
  var p = fecha.split("-");
  view.y = parseInt(p[0],10); view.m = parseInt(p[1],10) - 1;
  render();
});
document.getElementById("exBorrar").addEventListener("click", function(){
  if(!exEditando) return;
  var id = exEditando.id;
  db.bitacora = db.bitacora.filter(function(x){ return x.id !== id; });
  cerrarExtra(); save(); render();
});

/* ============ editor ============ */
var editor = document.getElementById("editor");
var edMode = "item", edSec = null, edItem = null;
function openEditor(){ editor.classList.add("open"); setTimeout(function(){ document.getElementById("edName").focus(); }, 60); }
function closeEditor(){ editor.classList.remove("open"); edSec = null; edItem = null; }
/* Un pendiente puede ser: sin fecha, mensual (día fijo) o de fecha exacta.
   Nunca los dos últimos a la vez: al guardar se limpia el que no aplica. */
function tipoDe(item){
  if(!item) return "ninguno";
  if(item.date) return "fecha";
  if(item.day) return "mensual";
  return "ninguno";
}
function pintarCamposFecha(){
  var t = document.getElementById("edTipo").value;
  document.getElementById("edDayWrap").style.display  = (t === "mensual") ? "block" : "none";
  document.getElementById("edDateWrap").style.display = (t === "fecha")   ? "block" : "none";
  document.getElementById("edTimeWrap").style.display = (t === "fecha")   ? "block" : "none";
}
document.getElementById("edTipo").addEventListener("change", pintarCamposFecha);

function openItemEditor(sec, item){
  edMode = "item"; edSec = sec; edItem = item;
  document.getElementById("edTitle").textContent = item ? "Editar pendiente" : "Nuevo pendiente";
  document.getElementById("edNameLbl").textContent = "Nombre";
  document.getElementById("edItemFields").style.display = "block";
  document.getElementById("edKindWrap").style.display = "none";
  document.getElementById("edName").value = item ? item.title : "";
  document.getElementById("edNote").value = item ? (item.note || "") : "";
  document.getElementById("edTipo").value = tipoDe(item);
  document.getElementById("edDay").value  = (item && item.day)  ? item.day  : "";
  document.getElementById("edDate").value = (item && item.date) ? item.date : "";
  document.getElementById("edTime").value = (item && item.time) ? item.time : "";
  pintarCamposFecha();
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
    var tipo = document.getElementById("edTipo").value;
    var dayRaw = parseInt(document.getElementById("edDay").value,10);
    var day  = (tipo === "mensual" && dayRaw >= 1 && dayRaw <= 31) ? dayRaw : null;
    var date = (tipo === "fecha") ? (document.getElementById("edDate").value || null) : null;
    var time = (tipo === "fecha") ? (document.getElementById("edTime").value || null) : null;
    if(edItem){
      edItem.title = name; edItem.note = note;
      edItem.day = day; edItem.date = date; edItem.time = time;
      flashId = edItem.id;
    } else {
      var nuevo = {id:uid(), title:name, note:note, day:day, date:date, time:time};
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

/* Los dos botones de mando manual: piden confirmación tocando dos veces. */
function dosToques(id, etiqueta, accion){
  var b = document.getElementById(id);
  var original = b.textContent;
  var armado = false, t = null;
  b.addEventListener("click", function(){
    if(!cloudReady){ closeMenu(); openAuth(); return; }
    if(!armado){
      armado = true;
      b.textContent = etiqueta;
      b.style.color = "var(--late)";
      t = setTimeout(function(){
        armado = false; b.textContent = original; b.style.color = "";
      }, 4000);
      return;
    }
    clearTimeout(t);
    armado = false; b.textContent = original; b.style.color = "";
    closeMenu();
    accion();
  });
}
dosToques("mPull", "Toca otra vez para confirmar", function(){
  setPill("busy","bajando…");
  pullRemote().then(function(remote){
    if(!remote){
      setPill("bad","nada en la nube","Todavía no hay nada guardado en la nube con esta cuenta.");
      return;
    }
    db = remote;
    db.cloudUserId = session.user.id;
    saveLocal(); render(); idlePill();
  })["catch"](function(){
    setPill("bad","sin conexión","No se pudo leer la nube. Intenta de nuevo cuando haya señal.");
  });
});
dosToques("mPush", "Toca otra vez para confirmar", function(){
  db.updatedAt = Date.now();
  db.cloudUserId = session.user.id;
  saveLocal();
  setPill("busy","subiendo…");
  pushRemote().then(function(){ idlePill(); })["catch"](function(){
    setPill("bad","sin subir","No se pudo subir. Tus datos siguen aquí; intenta otra vez con señal.");
  });
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
/* ============ calendario (.ics) ============
   Reglas acordadas:
   - Solo se generan eventos del mes actual y del siguiente. Nada de series
     infinitas: el calendario se rehace cada vez que se lee, así no se satura.
   - Mensual (día fijo): un evento por cada mes de esa ventana.
   - Fecha exacta: un solo evento, sin repetición. Cuando pasa, ya no vuelve.
   - Lo que ya marcaste como hecho ese mes NO genera evento.
   - Avisos: el día anterior 8:00 PM, el mismo día 8:00 AM y —si tiene hora—
     una hora antes.
   Guatemala es UTC-6 todo el año (no hay horario de verano), por eso las
   alarmas se calculan sumando 6 horas para expresarlas en UTC. */
var TZ_OFFSET_HORAS = 6;

function icsEscape(t){
  return String(t).replace(/\\/g,"\\\\").replace(/;/g,"\;").replace(/,/g,"\\,").replace(/\n/g,"\\n");
}
function icsFold(linea){
  // El formato iCalendar exige cortar las líneas largas a 75 caracteres.
  if(linea.length <= 74) return linea;
  var out = linea.slice(0,74), resto = linea.slice(74);
  while(resto.length > 73){ out += "\r\n " + resto.slice(0,73); resto = resto.slice(73); }
  return out + "\r\n " + resto;
}
function dosDigitos(n){ return String(n).padStart(2,"0"); }
function icsFecha(d){ return d.getFullYear() + dosDigitos(d.getMonth()+1) + dosDigitos(d.getDate()); }
function icsLocal(d){
  return icsFecha(d) + "T" + dosDigitos(d.getHours()) + dosDigitos(d.getMinutes()) + "00";
}
/* Convierte un instante local de Guatemala a la cadena UTC que pide el formato. */
function icsUtcDesdeLocal(d){
  var u = new Date(d.getTime() + TZ_OFFSET_HORAS*3600000);
  return u.getUTCFullYear() + dosDigitos(u.getUTCMonth()+1) + dosDigitos(u.getUTCDate()) +
    "T" + dosDigitos(u.getUTCHours()) + dosDigitos(u.getUTCMinutes()) + "00Z";
}
function ultimoDiaMes(y, m){ return new Date(y, m+1, 0).getDate(); }

/* Devuelve las líneas VALARM de un evento.
   inicio = instante local en que arranca (medianoche si es de día completo). */
function alarmas(inicio, titulo, tieneHora){
  var L = [];
  function alarma(cuando, texto){
    L.push("BEGIN:VALARM","ACTION:DISPLAY",
           "TRIGGER;VALUE=DATE-TIME:" + icsUtcDesdeLocal(cuando),
           "DESCRIPTION:" + icsEscape(texto), "END:VALARM");
  }
  var diaAnterior = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate()-1, 20, 0, 0);
  var mismoDia    = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate(), 8, 0, 0);
  alarma(diaAnterior, "Mañana: " + titulo);
  if(!tieneHora || inicio.getHours() > 9) alarma(mismoDia, "Hoy: " + titulo);
  if(tieneHora) alarma(new Date(inicio.getTime() - 3600000), "En 1 hora: " + titulo);
  return L;
}

/* Arma el calendario completo. Recibe el estado y la fecha de referencia
   (parámetro aparte para poder probarlo con fechas fijas). */
function construirIcs(estado, ahora){
  estado = estado || db;
  ahora = ahora || new Date();
  var hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  var desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  var hasta = new Date(ahora.getFullYear(), ahora.getMonth()+2, 0); // último día del mes siguiente

  var sello = icsUtcDesdeLocal(ahora);
  var L = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Pendientes//ES","CALSCALE:GREGORIAN","METHOD:PUBLISH",
           "X-WR-CALNAME:Pendientes","X-WR-TIMEZONE:America/Guatemala",
           "X-PUBLISHED-TTL:PT1H","REFRESH-INTERVAL;VALUE=DURATION:PT1H",
           "BEGIN:VTIMEZONE","TZID:America/Guatemala","BEGIN:STANDARD",
           "DTSTART:19700101T000000","TZOFFSETFROM:-0600","TZOFFSETTO:-0600","TZNAME:CST",
           "END:STANDARD","END:VTIMEZONE"];
  var cuantos = 0;

  function marcado(idItem, y, m){
    var clave = y + "-" + dosDigitos(m+1);
    var mm = estado.marks && estado.marks[clave];
    return !!(mm && mm[idItem] === 1);
  }

  function evento(item, sec, inicioLocal, uid){
    var tieneHora = !!item.time;
    var titulo = item.title + (sec.kind === "cobro" ? " (cobrar)" : "");
    var detalle = "Lista: " + sec.name + (item.note ? " — " + item.note : "");
    L.push("BEGIN:VEVENT");
    L.push("UID:" + uid + "@pendientes");
    L.push("DTSTAMP:" + sello);
    if(tieneHora){
      var fin = new Date(inicioLocal.getTime() + 3600000);
      L.push("DTSTART;TZID=America/Guatemala:" + icsLocal(inicioLocal));
      L.push("DTEND;TZID=America/Guatemala:" + icsLocal(fin));
    } else {
      var finDia = new Date(inicioLocal.getFullYear(), inicioLocal.getMonth(), inicioLocal.getDate()+1);
      L.push("DTSTART;VALUE=DATE:" + icsFecha(inicioLocal));
      L.push("DTEND;VALUE=DATE:" + icsFecha(finDia));
    }
    L.push("SUMMARY:" + icsEscape(titulo));
    L.push("DESCRIPTION:" + icsEscape(detalle));
    L.push("TRANSP:TRANSPARENT");
    alarmas(inicioLocal, titulo, tieneHora).forEach(function(x){ L.push(x); });
    L.push("END:VEVENT");
    cuantos++;
  }

  (estado.sections || []).forEach(function(sec){
    (sec.items || []).forEach(function(item){

      if(item.date){
        var f = fechaDe(item.date);
        if(f < desde || f > hasta) return;               // fuera de la ventana
        if(marcado(item.id, f.getFullYear(), f.getMonth())) return;  // ya lo hiciste
        var ini = item.time
          ? new Date(f.getFullYear(), f.getMonth(), f.getDate(),
                     parseInt(item.time.split(":")[0],10), parseInt(item.time.split(":")[1],10))
          : f;
        evento(item, sec, ini, item.id + "-" + icsFecha(f));
        return;
      }

      if(item.day){
        for(var k = 0; k < 2; k++){
          var y = ahora.getFullYear(), m = ahora.getMonth() + k;
          if(m > 11){ m -= 12; y++; }
          if(marcado(item.id, y, m)) continue;
          var d = new Date(y, m, Math.min(item.day, ultimoDiaMes(y, m)));
          if(d < hoy) continue;                          // ya pasó este mes
          evento(item, sec, d, item.id + "-" + y + dosDigitos(m+1));
        }
      }
    });
  });

  L.push("END:VCALENDAR");
  return { texto: L.map(icsFold).join("\r\n") + "\r\n", cuantos: cuantos };
}

/* Expuesto a propósito: permite auditar el calendario con fechas fijas
   desde las pruebas, sin depender de qué día se corran. */
window.__construirIcs = construirIcs;

document.getElementById("mIcs").addEventListener("click", function(){
  closeMenu();
  var r = construirIcs(db, new Date());
  if(r.cuantos === 0){
    var w = document.getElementById("warnbar");
    w.style.display = "block";
    w.textContent = "No hay nada con fecha pendiente en este mes ni en el siguiente. Ponles fecha con ✎ y vuelve a intentar.";
    return;
  }
  var blob = new Blob([r.texto], {type:"text/calendar;charset=utf-8"});
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pendientes-recordatorios.ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
});

/* ============ suscripción: dirección privada del calendario ============ */
var cal = document.getElementById("cal");
function closeCal(){ cal.classList.remove("open"); }
document.getElementById("calCancel").addEventListener("click", closeCal);
cal.addEventListener("click", function(e){ if(e.target === cal) closeCal(); });

function urlFuncion(token){
  // https://ref.supabase.co  ->  https://ref.supabase.co/functions/v1/calendario
  return cfg().SUPABASE_URL.replace(/\/+$/,"") + "/functions/v1/calendario?t=" + token;
}
function mostrarEnlace(token){
  document.getElementById("calLink").value = urlFuncion(token);
  document.getElementById("calLinkWrap").style.display = "block";
  document.getElementById("calAcciones").style.display = "flex";
  document.getElementById("calAviso").style.display = "block";
  document.getElementById("calGen").textContent = "Generar otra (anula la anterior)";
}
document.getElementById("mCal").addEventListener("click", function(){
  closeMenu();
  var msg = document.getElementById("calMsg");
  msg.className = "ok-msg"; msg.textContent = "";
  document.getElementById("calLinkWrap").style.display = "none";
  document.getElementById("calAcciones").style.display = "none";
  document.getElementById("calAviso").style.display = "none";
  document.getElementById("calGen").textContent = "Generar mi dirección";

  if(!cloudReady){
    msg.className = "ok-msg show";
    msg.textContent = "Primero activa la sincronización: el calendario lee tus pendientes desde la nube.";
    cal.classList.add("open");
    return;
  }
  // Si ya hay una dirección creada, la mostramos en vez de crear otra.
  sb.from("calendario_tokens").select("token").eq("user_id", session.user.id).maybeSingle()
    .then(function(r){
      if(r && r.data && r.data.token) mostrarEnlace(r.data.token);
    })["catch"](function(){});
  cal.classList.add("open");
});
document.getElementById("calGen").addEventListener("click", function(){
  var msg = document.getElementById("calMsg");
  if(!cloudReady){ closeCal(); openAuth(); return; }
  var token = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) +
               Date.now().toString(36)).replace(/[^a-z0-9]/g,"");
  msg.className = "ok-msg show"; msg.textContent = "Creando…";
  sb.from("calendario_tokens").upsert(
    { user_id: session.user.id, token: token }, { onConflict: "user_id" }
  ).select().then(function(r){
    if(r && r.error) throw r.error;
    // Si la regla de seguridad bloquea la escritura, no llega ninguna fila.
    if(!r.data || r.data.length === 0){
      msg.textContent = "La base no aceptó guardar la dirección (0 filas). Falta correr el SQL de calendario_tokens.";
      return;
    }
    msg.textContent = "Lista. Cópiala o toca Suscribirme.";
    mostrarEnlace(token);
  })["catch"](function(err){
    msg.textContent = "No se pudo crear: " + ((err && err.message) || "revisa tu conexión");
  });
});
document.getElementById("calCopy").addEventListener("click", function(){
  var campo = document.getElementById("calLink");
  var msg = document.getElementById("calMsg");
  campo.select();
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(campo.value).then(function(){
      msg.className = "ok-msg show"; msg.textContent = "Copiada.";
    }, function(){
      msg.className = "ok-msg show"; msg.textContent = "Selecciónala y cópiala a mano.";
    });
  } else {
    msg.className = "ok-msg show"; msg.textContent = "Selecciónala y cópiala a mano.";
  }
});
document.getElementById("calOpen").addEventListener("click", function(){
  // webcal:// hace que el sistema la abra como suscripción, no como descarga.
  var url = document.getElementById("calLink").value.replace(/^https?:/, "webcal:");
  location.href = url;
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
function openAuth(){
  var msg = document.getElementById("authMsg");
  msg.className = "ok-msg"; msg.textContent = "";
  var emailWrap = document.getElementById("authEmailWrap");
  var passWrap = document.getElementById("authPassWrap");
  var go = document.getElementById("authGo");
  var signupWrap = document.getElementById("authSignupWrap");
  var outWrap = document.getElementById("authOutWrap");
  var note = document.getElementById("authNote");

  if(!cloudConfigured()){
    document.getElementById("authTitle").textContent = "Sincronización no configurada";
    note.textContent = "Esta copia guarda todo en el dispositivo donde la abres. Para que el celular y la computadora vean lo mismo, hay que pegar los datos de un proyecto gratuito de Supabase en el archivo config.js.";
    emailWrap.style.display = "none"; passWrap.style.display = "none";
    go.style.display = "none"; signupWrap.style.display = "none"; outWrap.style.display = "none";
  } else if(session && session.user){
    document.getElementById("authTitle").textContent = "Tu cuenta";
    note.textContent = "Estás dentro como " + session.user.email + ". Tus listas se sincronizan solas entre tus dispositivos.";
    emailWrap.style.display = "none"; passWrap.style.display = "none";
    go.style.display = "none"; signupWrap.style.display = "none"; outWrap.style.display = "flex";
  } else {
    document.getElementById("authTitle").textContent = "Activar sincronización";
    note.textContent = "Usa el mismo correo y la misma contraseña en el celular y en la computadora: así los dos ven las mismas listas. La primera vez toca “crear cuenta”.";
    emailWrap.style.display = "block"; passWrap.style.display = "block";
    go.style.display = "block"; signupWrap.style.display = "flex"; outWrap.style.display = "none";
  }
  auth.classList.add("open");
}
function closeAuth(){ auth.classList.remove("open"); }
document.getElementById("btnAuth").addEventListener("click", openAuth);
document.getElementById("authCancel").addEventListener("click", closeAuth);
auth.addEventListener("click", function(e){ if(e.target === auth) closeAuth(); });

function credenciales(){
  var msg = document.getElementById("authMsg");
  var email = document.getElementById("authEmail").value.trim();
  var pass = document.getElementById("authPass").value;
  if(!email || email.indexOf("@") < 0){
    msg.className = "ok-msg show"; msg.textContent = "Escribe un correo válido."; return null;
  }
  if(pass.length < 6){
    msg.className = "ok-msg show"; msg.textContent = "La contraseña necesita al menos 6 caracteres."; return null;
  }
  if(!sb){ msg.className = "ok-msg show"; msg.textContent = "La nube no está configurada todavía."; return null; }
  return {email:email, pass:pass, msg:msg};
}
function entrarOk(r, msg){
  if(r && r.error) throw r.error;
  session = (r && r.data && r.data.session) || session;
  cloudReady = !!session;
  if(!cloudReady){
    msg.textContent = "Cuenta creada. Revisa tu correo para confirmarla y vuelve a entrar.";
    return;
  }
  msg.textContent = "¡Listo! Sincronización activada.";
  paintAuth();
  syncNow();
  setTimeout(closeAuth, 900);
}
function traducirError(err){
  var m = (err && err.message) || "";
  if(/Invalid login credentials/i.test(m)) return "Correo o contraseña incorrectos. Si es tu primera vez, toca “crear cuenta”.";
  if(/User already registered/i.test(m)) return "Ese correo ya tiene cuenta. Toca “Entrar” con tu contraseña.";
  if(/Password should be/i.test(m)) return "La contraseña necesita al menos 6 caracteres.";
  if(/Email .*invalid|invalid format/i.test(m)) return "Ese correo no es válido.";
  if(/rate limit|too many/i.test(m)) return "Demasiados intentos seguidos. Espera un momento.";
  return m || "No se pudo conectar.";
}
document.getElementById("authGo").addEventListener("click", function(){
  var c = credenciales();
  if(!c) return;
  c.msg.className = "ok-msg show"; c.msg.textContent = "Entrando…";
  sb.auth.signInWithPassword({ email:c.email, password:c.pass })
    .then(function(r){ entrarOk(r, c.msg); })
    ["catch"](function(err){ c.msg.textContent = traducirError(err); });
});
document.getElementById("authSignup").addEventListener("click", function(){
  var c = credenciales();
  if(!c) return;
  c.msg.className = "ok-msg show"; c.msg.textContent = "Creando cuenta…";
  sb.auth.signUp({ email:c.email, password:c.pass })
    .then(function(r){ entrarOk(r, c.msg); })
    ["catch"](function(err){ c.msg.textContent = traducirError(err); });
});
document.getElementById("authPass").addEventListener("keydown", function(e){
  if(e.key === "Enter"){ e.preventDefault(); document.getElementById("authGo").click(); }
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
