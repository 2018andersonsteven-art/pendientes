# Pendientes — app instalable

Control mensual de pagos y cobros. Funciona sin internet, se instala como app
en el celular y en la computadora, y opcionalmente sincroniza entre dispositivos.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La pantalla de la app |
| `styles.css` | Los colores y el diseño |
| `app.js` | Toda la lógica |
| `config.js` | **El único archivo que editas** (datos de Supabase) |
| `sw.js` | Hace que abra sin internet |
| `manifest.webmanifest` | Nombre e ícono cuando se instala |
| `icons/` | Los íconos |
| `supabase.sql` | El código que se pega en Supabase una sola vez |

## Publicarla (GitHub Pages, gratis y permanente)

1. Crea una cuenta en <https://github.com> (gratis, sin tarjeta).
2. Botón **+** arriba a la derecha → **New repository**.
   - Name: `pendientes`
   - Visibility: **Public** (Pages gratis requiere repositorio público)
   - **Create repository**
3. En el repositorio vacío: **uploading an existing file** → arrastra
   TODOS los archivos de esta carpeta, incluida la carpeta `icons`
   → **Commit changes**.
4. **Settings** → **Pages** → en *Source* elige **Deploy from a branch**,
   rama `main`, carpeta `/ (root)` → **Save**.
5. Espera 1–2 minutos y recarga esa página: te aparece la dirección
   `https://TUUSUARIO.github.io/pendientes/`. Esa es tu app, para siempre.

Cada vez que quieras cambiar algo, editas el archivo en GitHub y en un
minuto la app se actualiza sola.

## Instalarla

- **iPhone / iPad:** abre la dirección en Safari → botón Compartir →
  **Añadir a pantalla de inicio**.
- **Mac / Windows (Chrome o Edge):** abre la dirección → ícono de instalar
  en la barra de direcciones, o menú → *Instalar Pendientes*.
- **Android:** Chrome te ofrece *Instalar* solo.

## Sincronizar entre dispositivos (opcional, gratis)

Sin esto la app ya funciona, pero cada dispositivo guarda lo suyo.

1. Crea un proyecto gratis en <https://supabase.com> (Sign in with GitHub).
2. **SQL Editor** → **New query** → pega todo `supabase.sql` → **Run**.
3. **Project Settings** → **API** → copia *Project URL* y la llave
   *anon public*.
4. Pégalas en `config.js` y sube el archivo actualizado a GitHub.
5. **Authentication** → **URL Configuration** → en *Site URL* y en
   *Redirect URLs* pon la dirección de tu app
   (`https://TUUSUARIO.github.io/pendientes/`).
6. Abre la app → **Activar sincronización** → escribe tu correo → te llega
   un enlace → lo tocas desde ese mismo dispositivo. Repite en el otro
   dispositivo con el mismo correo.

La llave *anon* es pública a propósito. Las reglas del archivo `supabase.sql`
hacen que cada usuario solo pueda leer y escribir sus propios datos, así que
no pasa nada si el repositorio es público.

## Si algún día la comparten otras personas

Ya está lista: cada quien entra con su correo y ve solo sus listas. No hay
que tocar nada más.

## Actualizar la app

Cuando cambies `app.js`, `styles.css` o `index.html`, sube también `sw.js`
con el número de versión cambiado (`pendientes-v1` → `pendientes-v2`).
Eso obliga a los dispositivos a bajar la versión nueva.
