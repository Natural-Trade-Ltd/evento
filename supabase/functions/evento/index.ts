// ============================================================
// EVENTO — Landing RSVP · Encuentro Privado NT + GF
// Martes 1 de septiembre de 2026 · 19:00–21:00 h
// Salón «Feria» · Hotel Presidente InterContinental Polanco, CDMX
//
// Rutas:
//   GET  /evento              → landing pública de confirmación
//   POST /evento/confirmar    → registra la confirmación (JSON)
//   POST /evento/alta         → alta MANUAL desde la lista (exige clave)
//   POST /evento/marcar       → edita asiste / check-in de una fila (exige clave)
//   POST /evento/editar       → corrige los DATOS de una fila (exige clave)
//   POST /evento/borrar       → elimina una fila (exige clave; para limpiar pruebas)
//   GET  /evento/lista?clave= → lista de confirmados (solo Jorge)
//
// v7 (28-ago-2026): /editar corrige nombre, empresa, puesto, correo, celular y notas
// desde la lista — un invitado se registra con el correo mal escrito o pone la razón
// social en vez del nombre, y hasta hoy solo se podía volver a capturar. /borrar quita
// los registros de prueba del padrón antes del evento.
// v5 (19-ago-2026): la lista es también la consola del día del evento —
// 'marcar' permite voltear asistirá (cancelaciones → lista final) y registrar
// el check-in en la puerta (sin QR: el invitado da su nombre y quien recibe
// le da check y le entrega su gafete). Decisión de Jorge: mantenerlo simple.
// v4 (19-ago-2026): /confirmar inserta SIEMPRE (correos duplicados permitidos;
// el upsert por email pisó 4 capturas reales el 19-ago).
//
// Tabla: public.evento_asistentes (RLS on, sin policies → solo service_role)
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// SHA-256 de la clave de administrador (la clave la tiene Jorge; no está en el código)
const ADMIN_KEY_HASH =
  "3adfa544713b9a4b4b6c0a988a1af874396c9d96d80e6698fa29a988f8a989e9";
const HASHES = [ADMIN_KEY_HASH];
async function autorizada(clave: string): Promise<boolean> {
  return HASHES.includes(await sha256hex(clave));
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("evento");
  const route = idx >= 0 ? parts.slice(idx + 1).join("/") : "";

  try {
    if (route === "" && req.method === "GET") return html(LANDING_HTML);
    if (route === "confirmar" && req.method === "POST") return await confirmar(req);
    if (route === "alta" && req.method === "POST") return await altaManual(req);
    if (route === "marcar" && req.method === "POST") return await marcar(req);
    if (route === "editar" && req.method === "POST") return await editar(req);
    if (route === "borrar" && req.method === "POST") return await borrar(req);
    if (route === "lista" && req.method === "GET") return await lista(url);
    return json({ error: "Ruta no encontrada" }, 404);
  } catch (e) {
    console.error("evento error:", e);
    return json({ error: "Error interno. Intenta de nuevo." }, 500);
  }
});

// ---------- validación compartida ----------
function leeDatos(body: Record<string, unknown>) {
  const nombre = str(body.nombre, 120);
  const empresa = str(body.empresa, 120);
  const puesto = str(body.puesto, 120);
  const email = str(body.email, 160).toLowerCase();
  const celular = str(body.celular, 40);
  const asistira = body.asistira !== false && body.asistira !== "no";
  if (!nombre || nombre.length < 3) return { error: "Escribe tu nombre completo." };
  if (!empresa || empresa.length < 2) return { error: "Escribe el nombre de tu empresa." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { error: "Escribe un correo electrónico válido." };
  }
  return { fila: { nombre, empresa, puesto: puesto || null, email, celular: celular || null, asistira } };
}

// ---------- POST /confirmar ----------
async function confirmar(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }

  // honeypot anti-bots: el campo "web" está oculto; si viene lleno, es un bot
  if (typeof body.web === "string" && body.web.trim() !== "") {
    return json({ ok: true }); // respuesta neutra, no se guarda nada
  }

  const d = leeDatos(body);
  if ("error" in d) return json({ error: d.error }, 400);

  // INSERT, nunca upsert: un correo repetido crea otra fila en vez de borrar la anterior.
  const { error } = await supabase
    .from("evento_asistentes")
    .insert({ ...d.fila, fuente: "landing" });

  if (error) {
    console.error("insert error:", error);
    return json({ error: "No se pudo guardar. Intenta de nuevo." }, 500);
  }

  return json({ ok: true, nombre: d.fila.nombre.split(" ")[0], asistira: d.fila.asistira });
}

// ---------- POST /alta (captura manual desde la lista; exige clave) ----------
async function altaManual(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  if (!(await autorizada(String(body.clave ?? "")))) return json({ error: "No autorizado" }, 401);

  const d = leeDatos(body);
  if ("error" in d) return json({ error: d.error }, 400);

  const notas = str(body.notas, 200);
  const { data, error } = await supabase
    .from("evento_asistentes")
    .insert({ ...d.fila, fuente: "manual", notas: notas || null })
    .select("id, nombre, empresa, email, creado_en");
  if (error) {
    console.error("alta error:", error);
    return json({ error: "No se pudo guardar: " + error.message }, 500);
  }
  return json({ ok: true, fila: data?.[0] ?? null });
}

// ---------- POST /marcar (asiste / check-in; exige clave) ----------
async function marcar(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  if (!(await autorizada(String(body.clave ?? "")))) return json({ error: "No autorizado" }, 401);

  const id = str(body.id, 60);
  if (!id) return json({ error: "Falta el id del registro" }, 400);

  const patch: Record<string, unknown> = {};
  if (typeof body.asistira === "boolean") patch.asistira = body.asistira;
  if (body.checkin === true) {
    patch.checkin_en = new Date().toISOString();
    patch.checkin_por = str(body.por, 60) || null;
  }
  if (body.checkin === false) {
    patch.checkin_en = null;
    patch.checkin_por = null;
  }
  if (!Object.keys(patch).length) return json({ error: "Nada que cambiar" }, 400);
  patch.actualizado_en = new Date().toISOString();

  const { data, error } = await supabase
    .from("evento_asistentes")
    .update(patch)
    .eq("id", id)
    .select("id, nombre, asistira, checkin_en, checkin_por");
  if (error) {
    console.error("marcar error:", error);
    return json({ error: "No se pudo guardar: " + error.message }, 500);
  }
  if (!data?.length) return json({ error: "No existe ese registro" }, 404);
  return json({ ok: true, fila: data[0] });
}

// ---------- POST /editar (corrige los datos de una fila; exige clave) ----------
// A diferencia de /marcar, aquí se tocan los datos del invitado. Es un patch PARCIAL:
// solo se escriben los campos que vengan en el cuerpo, para que dos personas editando
// filas distintas al mismo tiempo no se pisen. Nunca toca asistira ni el check-in.
async function editar(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  if (!(await autorizada(String(body.clave ?? "")))) return json({ error: "No autorizado" }, 401);

  const id = str(body.id, 60);
  if (!id) return json({ error: "Falta el id del registro" }, 400);

  const patch: Record<string, unknown> = {};

  if ("nombre" in body) {
    const v = str(body.nombre, 120);
    if (v.length < 3) return json({ error: "El nombre debe tener al menos 3 letras." }, 400);
    patch.nombre = v;
  }
  if ("empresa" in body) {
    const v = str(body.empresa, 120);
    if (v.length < 2) return json({ error: "Escribe el nombre de la empresa." }, 400);
    patch.empresa = v;
  }
  if ("email" in body) {
    const v = str(body.email, 160).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      return json({ error: "El correo no es válido." }, 400);
    }
    patch.email = v;
  }
  // opcionales: se pueden vaciar a propósito
  if ("puesto" in body) patch.puesto = str(body.puesto, 120) || null;
  if ("celular" in body) patch.celular = str(body.celular, 40) || null;
  if ("notas" in body) patch.notas = str(body.notas, 200) || null;

  if (!Object.keys(patch).length) return json({ error: "Nada que cambiar" }, 400);
  patch.actualizado_en = new Date().toISOString();

  const { data, error } = await supabase
    .from("evento_asistentes")
    .update(patch)
    .eq("id", id)
    .select("id, nombre, empresa, puesto, email, celular, notas, asistira, fuente, creado_en, actualizado_en, checkin_en, checkin_por");
  if (error) {
    console.error("editar error:", error);
    return json({ error: "No se pudo guardar: " + error.message }, 500);
  }
  if (!data?.length) return json({ error: "No existe ese registro" }, 404);
  return json({ ok: true, fila: data[0] });
}

// ---------- POST /borrar (elimina una fila; exige clave) ----------
// Para limpiar del padrón los registros de prueba antes del evento. Devuelve la fila
// borrada para que la consola pueda mostrar qué se fue.
async function borrar(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Cuerpo inválido" }, 400);
  }
  if (!(await autorizada(String(body.clave ?? "")))) return json({ error: "No autorizado" }, 401);

  const id = str(body.id, 60);
  if (!id) return json({ error: "Falta el id del registro" }, 400);

  const { data, error } = await supabase
    .from("evento_asistentes")
    .delete()
    .eq("id", id)
    .select("id, nombre, empresa, email");
  if (error) {
    console.error("borrar error:", error);
    return json({ error: "No se pudo borrar: " + error.message }, 500);
  }
  if (!data?.length) return json({ error: "No existe ese registro" }, 404);
  return json({ ok: true, fila: data[0] });
}

// ---------- GET /lista?clave= ----------
async function lista(url: URL): Promise<Response> {
  const clave = url.searchParams.get("clave") ?? "";
  if (!(await autorizada(clave))) {
    return json({ error: "No autorizado" }, 401);
  }

  const { data, error } = await supabase
    .from("evento_asistentes")
    .select("id, nombre, empresa, puesto, email, celular, asistira, fuente, notas, creado_en, actualizado_en, checkin_en, checkin_por")
    .order("creado_en", { ascending: false });

  if (error) return json({ error: error.message }, 500);

  // formato=json → para la página lista.html en GitHub Pages
  // (Supabase no renderiza HTML en *.supabase.co, así que la vista vive fuera)
  if (url.searchParams.get("formato") === "json") {
    return json({ ok: true, asistentes: data ?? [] });
  }

  const filas = (data ?? [])
    .map(
      (r) => `<tr class="${r.asistira ? "" : "no"}">
      <td>${esc(r.nombre)}</td><td>${esc(r.empresa)}</td><td>${esc(r.puesto ?? "")}</td>
      <td>${esc(r.email)}</td><td>${esc(r.celular ?? "")}</td>
      <td>${r.asistira ? "✅ Sí" : "❌ No"}</td>
      <td>${new Date(r.creado_en).toLocaleString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" })}</td>
      <td>${r.checkin_en ? "🎫 " + new Date(r.checkin_en).toLocaleTimeString("es-MX", { timeZone: "America/Mexico_City", timeStyle: "short" }) : ""}</td>
    </tr>`,
    )
    .join("");

  const si = (data ?? []).filter((r) => r.asistira).length;
  const no = (data ?? []).length - si;

  return html(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Confirmados · Encuentro NT+GF</title>
<style>
body{font-family:system-ui,sans-serif;background:#101a14;color:#f3ecdd;margin:0;padding:24px}
h1{font-size:20px;font-weight:600} .tot{color:#c8a45c;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:14px;background:#16221b;border-radius:8px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #24352b;white-space:nowrap}
th{background:#1c2b22;color:#c8a45c;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
tr.no td{opacity:.45} .wrap{overflow-x:auto}
</style></head><body>
<h1>Encuentro Privado NT + GF · 1 sep 2026</h1>
<div class="tot"><b>${si}</b> confirmados · <b>${no}</b> no asistirán · <b>${si + no}</b> respuestas</div>
<div class="wrap"><table>
<tr><th>Nombre</th><th>Empresa</th><th>Puesto</th><th>Email</th><th>Celular</th><th>Asiste</th><th>Registrado</th><th>Check-in</th></tr>
${filas || '<tr><td colspan="8">Sin registros todavía</td></tr>'}
</table></div></body></html>`);
}

// ---------- helpers ----------
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
function html(body: string): Response {
  return new Response(body, {
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------- landing ----------
const LANDING_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Encuentro Privado · Natural Trade + Global Forest</title>
<meta name="description" content="Confirma tu asistencia al encuentro privado de Natural Trade + Global Forest · 1 de septiembre de 2026 · Hotel Presidente InterContinental Polanco, CDMX">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#101a14">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#101a14; --panel:#16221b; --line:#2a3c30;
    --gold:#c8a45c; --gold-soft:#e0c384; --cream:#f3ecdd; --muted:#9fae9f;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:var(--bg); color:var(--cream);
    font-family:'Montserrat',system-ui,sans-serif;
    -webkit-font-smoothing:antialiased; min-height:100vh;
    background-image:radial-gradient(1200px 600px at 50% -10%, rgba(200,164,92,.14), transparent 60%);
  }
  .wrap{max-width:640px;margin:0 auto;padding:48px 22px 64px}
  .eyebrow{
    text-align:center;color:var(--gold);font-size:12px;font-weight:600;
    letter-spacing:.32em;text-transform:uppercase;margin-bottom:14px;
  }
  .subline{
    text-align:center;color:var(--muted);font-size:11.5px;font-weight:500;
    letter-spacing:.14em;text-transform:uppercase;line-height:1.7;margin-bottom:30px;
  }
  h1{
    font-family:'Cormorant Garamond',Georgia,serif;font-weight:600;
    font-size:clamp(38px,8vw,54px);line-height:1.08;text-align:center;margin-bottom:20px;
  }
  .intro{text-align:center;color:var(--muted);font-size:15px;line-height:1.75;margin-bottom:34px}
  .intro b{color:var(--cream);font-weight:600}
  .divider{display:flex;align-items:center;gap:14px;margin:34px 0}
  .divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
  .divider span{color:var(--gold);font-size:11px;letter-spacing:.28em;text-transform:uppercase;font-weight:600}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
  @media(max-width:520px){.meta{grid-template-columns:1fr}}
  .meta .box{
    background:var(--panel);border:1px solid var(--line);border-radius:14px;
    padding:20px 18px;text-align:center;
  }
  .meta .k{color:var(--gold);font-size:10.5px;letter-spacing:.26em;text-transform:uppercase;font-weight:600;margin-bottom:10px}
  .meta .v{font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:600;line-height:1.3}
  .meta .s{color:var(--muted);font-size:13px;margin-top:6px;line-height:1.5}
  .meta a{color:var(--gold-soft);text-decoration:none;border-bottom:1px dotted var(--gold)}
  .badge{
    text-align:center;background:rgba(200,164,92,.08);border:1px solid rgba(200,164,92,.35);
    border-radius:12px;padding:14px 16px;font-size:13px;line-height:1.65;color:var(--gold-soft);margin-bottom:34px;
  }
  form .field{margin-bottom:16px}
  label{display:block;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:7px}
  label em{color:var(--gold);font-style:normal}
  input[type=text],input[type=email],input[type=tel]{
    width:100%;background:var(--panel);border:1px solid var(--line);border-radius:10px;
    color:var(--cream);font-family:inherit;font-size:16px;padding:13px 14px;outline:none;
    transition:border-color .15s;
  }
  input:focus{border-color:var(--gold)}
  .radios{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:22px 0}
  .radios input{position:absolute;opacity:0;pointer-events:none}
  .radios label{
    display:block;text-align:center;cursor:pointer;margin:0;
    background:var(--panel);border:1px solid var(--line);border-radius:10px;
    padding:14px 10px;font-size:12px;letter-spacing:.1em;color:var(--cream);
    transition:all .15s;
  }
  .radios input:checked+label{background:rgba(200,164,92,.14);border-color:var(--gold);color:var(--gold-soft)}
  .hp{position:absolute;left:-9999px;opacity:0}
  button{
    width:100%;background:var(--gold);color:#17130a;border:0;border-radius:10px;
    font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;
    padding:17px;cursor:pointer;transition:background .15s;margin-top:6px;
  }
  button:hover{background:var(--gold-soft)}
  button:disabled{opacity:.55;cursor:wait}
  .err{display:none;background:rgba(180,60,60,.12);border:1px solid rgba(220,90,90,.4);color:#e8b0a8;border-radius:10px;padding:12px 14px;font-size:13.5px;margin-bottom:16px;line-height:1.5}
  .ok{display:none;text-align:center;padding:26px 6px}
  .ok .big{font-family:'Cormorant Garamond',Georgia,serif;font-size:34px;font-weight:600;margin-bottom:14px;color:var(--gold-soft)}
  .ok p{color:var(--muted);font-size:15px;line-height:1.75}
  .ok p b{color:var(--cream)}
  footer{text-align:center;color:var(--muted);font-size:12.5px;line-height:1.9;margin-top:44px}
  footer a{color:var(--gold-soft);text-decoration:none}
  .marcas{
    text-align:center;font-family:'Cormorant Garamond',Georgia,serif;
    font-size:19px;letter-spacing:.06em;color:var(--cream);margin-bottom:8px;
  }
  .marcas span{color:var(--gold)}
</style>
</head>
<body>
<div class="wrap">
  <div class="marcas">Natural Trade <span>+</span> Global Forest</div>
  <div class="eyebrow">Encuentro Privado · CDMX</div>
  <div class="subline">La noche previa a la Conferencia y Expo de la<br>Industria del Embalaje de Madera LATAM</div>

  <h1>Una nueva forma<br>de comprar madera</h1>

  <p class="intro">Te invitamos a un encuentro privado para <b>agradecer tu confianza</b> y mostrarte
  nuestra nueva etapa de servicio: más tecnología y visibilidad logística, mejor información
  para tu negocio y compras en tiempo real.<br><br>
  Networking, innovación, canapés, barra libre… <b>y algo de magia</b>.</p>

  <div class="meta">
    <div class="box">
      <div class="k">Cuándo</div>
      <div class="v">Martes 1 de septiembre</div>
      <div class="s">2026 · 19:00 – 21:00 h</div>
    </div>
    <div class="box">
      <div class="k">Dónde</div>
      <div class="v">Salón «Feria»</div>
      <div class="s">Hotel Presidente InterContinental<br>Polanco, Ciudad de México<br>
      <a href="https://maps.google.com/?q=Hotel+Presidente+InterContinental+Polanco+Ciudad+de+Mexico" target="_blank" rel="noopener">Ver mapa</a></div>
    </div>
  </div>

  <div class="badge">Acceso únicamente con <b>invitación personal</b>.<br>
  Al confirmar se genera tu pase individual: unos días antes del evento recibirás
  por correo tu <b>código QR personal</b> de acceso.</div>

  <div class="divider"><span>Confirma tu asistencia</span></div>

  <div class="err" id="err"></div>

  <form id="f" novalidate>
    <div class="field"><label for="nombre">Nombre completo <em>*</em></label>
      <input type="text" id="nombre" name="nombre" autocomplete="name" required></div>
    <div class="field"><label for="empresa">Empresa <em>*</em></label>
      <input type="text" id="empresa" name="empresa" autocomplete="organization" required></div>
    <div class="field"><label for="puesto">Puesto</label>
      <input type="text" id="puesto" name="puesto" autocomplete="organization-title"></div>
    <div class="field"><label for="email">Correo electrónico <em>*</em></label>
      <input type="email" id="email" name="email" autocomplete="email" required></div>
    <div class="field"><label for="celular">Celular / WhatsApp</label>
      <input type="tel" id="celular" name="celular" autocomplete="tel"></div>
    <div class="hp"><label for="web">Sitio web</label><input type="text" id="web" name="web" tabindex="-1" autocomplete="off"></div>

    <div class="radios">
      <input type="radio" name="asistira" id="rsi" value="si" checked>
      <label for="rsi">✓ &nbsp;Sí, asistiré</label>
      <input type="radio" name="asistira" id="rno" value="no">
      <label for="rno">No podré asistir</label>
    </div>

    <button type="submit" id="btn">Confirmar</button>
  </form>

  <div class="ok" id="ok"></div>

  <footer>¿Dudas o cambios? Escríbenos a <a href="mailto:info@naturaltrade.ca">info@naturaltrade.ca</a></footer>
</div>

<script>
(function(){
  var f = document.getElementById('f');
  var err = document.getElementById('err');
  var ok = document.getElementById('ok');
  var btn = document.getElementById('btn');
  var base = location.pathname.replace(/\\/+$/, '');

  f.addEventListener('submit', function(ev){
    ev.preventDefault();
    err.style.display = 'none';
    var datos = {
      nombre:  f.nombre.value.trim(),
      empresa: f.empresa.value.trim(),
      puesto:  f.puesto.value.trim(),
      email:   f.email.value.trim(),
      celular: f.celular.value.trim(),
      asistira: f.querySelector('input[name=asistira]:checked').value === 'si',
      web: f.web.value
    };
    if(!datos.nombre || !datos.empresa || !datos.email){
      err.textContent = 'Por favor completa nombre, empresa y correo.';
      err.style.display = 'block'; return;
    }
    btn.disabled = true; btn.textContent = 'Enviando…';
    fetch(base + '/confirmar', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(datos)
    }).then(function(r){ return r.json().then(function(j){ return {s:r.status, j:j}; }); })
    .then(function(res){
      if(res.s === 200 && res.j.ok){
        f.style.display = 'none';
        document.querySelector('.divider').style.display = 'none';
        if(res.j.asistira){
          ok.innerHTML = '<div class="big">¡Listo, ' + escapeHtml(res.j.nombre) + '! Tu lugar está reservado.</div>' +
            '<p>Unos días antes del evento recibirás por correo tu <b>código QR personal de acceso</b>.<br><br>' +
            'Nos dará mucho gusto recibirte el <b>martes 1 de septiembre a las 19:00 h</b><br>en el Salón «Feria» del Presidente InterContinental Polanco.</p>';
        } else {
          ok.innerHTML = '<div class="big">Gracias por avisarnos.</div>' +
            '<p>Lamentamos que no puedas acompañarnos esta vez.<br>' +
            'Si tu agenda cambia, escríbenos a <b>info@naturaltrade.ca</b> y con gusto te reservamos un lugar.</p>';
        }
        ok.style.display = 'block';
        window.scrollTo({top:0, behavior:'smooth'});
      } else {
        err.textContent = res.j.error || 'No se pudo enviar. Intenta de nuevo.';
        err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Confirmar';
      }
    }).catch(function(){
      err.textContent = 'Error de conexión. Intenta de nuevo.';
      err.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Confirmar';
    });
  });

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
})();
</script>
</body>
</html>`;
