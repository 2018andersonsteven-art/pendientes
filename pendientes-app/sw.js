/* Service worker: hace que la app abra aunque no haya internet.
   Sube el número de CACHE cada vez que cambies algo del código. */
var CACHE = "pendientes-v8";
var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return Promise.all(SHELL.map(function(u){
        return c.add(u)["catch"](function(){});
      }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;

  var url = new URL(req.url);

  // Nunca cachear las llamadas a la nube ni al login.
  if(url.pathname.indexOf("/auth/") >= 0 || url.pathname.indexOf("/rest/") >= 0) return;

  // La configuración siempre se busca fresca: si cambias config.js,
  // el cambio se ve en la siguiente apertura sin trucos de caché.
  if(/config\.js$/.test(url.pathname)){
    e.respondWith(
      fetch(req).then(function(res){
        if(res && res.status === 200){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy)["catch"](function(){}); });
        }
        return res;
      })["catch"](function(){ return caches.match(req); })
    );
    return;
  }

  // Navegación: intenta la red, si no hay, sirve la app guardada.
  if(req.mode === "navigate"){
    e.respondWith(
      fetch(req)["catch"](function(){
        return caches.match("./index.html").then(function(r){ return r || caches.match("./"); });
      })
    );
    return;
  }

  // Recursos: primero la copia guardada, y refresca en segundo plano.
  e.respondWith(
    caches.match(req).then(function(hit){
      var net = fetch(req).then(function(res){
        if(res && (res.status === 200 || res.type === "opaque")){
          var copy = res.clone();
          caches.open(CACHE).then(function(c){ c.put(req, copy)["catch"](function(){}); });
        }
        return res;
      })["catch"](function(){ return hit; });
      return hit || net;
    })
  );
});
