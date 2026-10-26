// Página del cliente: elegir día y hora, reservar (una vez o todas las semanas) o cancelar su propio turno

let diaSel = hoy(), horaSel = null, cancelSel = null;   // horaSel: turno libre elegido · cancelSel: turno ocupado tocado para cancelar
let ocupados = new Map(), cargado = false;              // "fecha_hh" → true si es de una hora fija

const plural = dia => dia.endsWith("s") ? dia : dia+"s";          // jueves → jueves, sábado → sábados
const semanal = () => document.querySelector('input[name="frec"]:checked').value === "semanal";
const cancelarTodas = () => document.querySelector('input[name="cfrec"]:checked').value === "todas";

async function cargar(){
  if(!sb) return;
  try{
    const filas = await rpc("turnos_ocupados", { p_desde: hoy(), p_hasta: dias().at(-1) });
    ocupados = new Map(filas.map(f=>[idTurno(f.fecha, Number(f.hora)), !!f.fijo]));
    cargado = true; $("aviso").hidden = true;
  }catch(e){
    $("aviso").hidden = false; $("aviso").textContent = "No se pudieron cargar los horarios. Revisá tu internet; reintentamos solos.";
  }
  render();
}

function renderDias(){
  const c=$("days"); c.textContent="";
  for(const s of dias()){
    const d=parse(s), b=document.createElement("button");
    b.type="button"; b.className="day"; b.setAttribute("aria-pressed", s===diaSel);
    b.innerHTML="<span></span><b></b><span></span>";
    b.children[0].textContent = s===hoy()?"Hoy":DOW[d.getDay()];
    b.children[1].textContent = d.getDate();
    b.children[2].textContent = MES[d.getMonth()];
    b.onclick=()=>{diaSel=s; horaSel=null; cancelSel=null; render();};
    c.append(b);
  }
}

// en el celular: bajar hasta el formulario sin abrir el teclado de golpe (taparía el resumen)
function irA(form, input){
  if(matchMedia("(pointer:fine)").matches) $(input).focus();
  else $(form).scrollIntoView({behavior:"smooth", block:"start"});
}

function renderGrid(){
  const g=$("grid"); g.textContent="";
  $("cargando").hidden = cargado || !sb;
  for(const h of HORAS){
    const occ=ocupados.has(idTurno(diaSel,h)), pas=pasada(diaSel,h);
    if(occ && h===horaSel) horaSel=null;      // se lo ganó otro mientras elegía
    if(!occ && h===cancelSel) cancelSel=null; // ya se canceló
    const b=document.createElement("button"); b.type="button";
    b.className="slot"+(occ?" ocupado":"")+(h===horaSel||h===cancelSel?" sel":"");
    b.disabled = !cargado || pas;
    b.innerHTML='<span class="h"></span><span class="s"></span>';
    b.children[0].textContent=pad(h)+":00";
    b.children[1].textContent= !cargado?"…": occ?"Reservado": pas?"Ya pasó":"Libre";
    b.onclick = occ
      ? ()=>{ cancelSel=h; horaSel=null; $("c-msg").textContent=""; render(); mostrarCaptcha("cancelar"); irA("cancelar","c-nombre"); }
      : ()=>{ horaSel=h; cancelSel=null; $("formmsg").textContent=""; render(); mostrarCaptcha("reserva"); irA("form","nombre"); };
    g.append(b);
  }
  const ocupado=!$("listo").hidden;
  $("form").hidden = horaSel===null || ocupado;
  $("cancelar").hidden = cancelSel===null || ocupado;
  renderResumen();
  renderCancelar();
}

// Texto del resumen y del botón según "solo esta vez" / "todas las semanas"
function renderResumen(){
  const dia=DOW_LARGO[parse(diaSel).getDay()];
  $("frec-semanal").textContent="Todos los "+plural(dia);
  $("frec-nota").hidden=!semanal();
  if(horaSel===null) return;
  $("resumen").textContent = semanal()
    ? "Hora fija: todos los "+plural(dia)+" de "+rango(horaSel)+", desde el "+largo(diaSel)+"."
    : "Turno: "+largo(diaSel)+", de "+rango(horaSel)+".";
  $("confirmar").textContent = semanal() ? "Confirmar hora fija" : "Confirmar reserva";
}
for(const r of document.querySelectorAll('input[name="frec"]')) r.addEventListener("change", ()=>{ $("formmsg").textContent=""; renderResumen(); });

// Tarjeta para cancelar el turno tocado
function renderCancelar(){
  if(cancelSel===null) return;
  const fijo=ocupados.get(idTurno(diaSel,cancelSel)), dia=plural(DOW_LARGO[parse(diaSel).getDay()]);
  $("c-resumen").textContent=(fijo?"Hora fija de los "+dia+": ":"Turno reservado: ")+largo(diaSel)+", de "+rango(cancelSel)+".";
  $("c-frec").hidden=!fijo;
  $("c-todas").textContent="Todos los "+dia;
  $("c-confirmar").textContent = fijo && cancelarTodas() ? "Cancelar todas las semanas" : "Cancelar turno";
}
for(const r of document.querySelectorAll('input[name="cfrec"]')) r.addEventListener("change", ()=>{ $("c-msg").textContent=""; renderCancelar(); });

function render(){ renderDias(); renderGrid(); }

// --- Anti-robots (Cloudflare Turnstile): uno para reservar y otro para cancelar ---
const captchas = { reserva:{ el:"#captcha", id:null, token:null }, cancelar:{ el:"#captcha-cancelar", id:null, token:null } };
function mostrarCaptcha(cual){
  const c=captchas[cual];
  if(!CONFIG.TURNSTILE_SITE_KEY || c.id!==null || !window.turnstile) return;
  c.id = turnstile.render(c.el, {
    sitekey: CONFIG.TURNSTILE_SITE_KEY, language: "es", size: "flexible",
    callback: t => { c.token = t; },
    "expired-callback": () => { c.token = null; },
    "error-callback": () => { c.token = null; },
  });
}
function reiniciarCaptcha(cual){ const c=captchas[cual]; c.token=null; if(c.id!==null) turnstile.reset(c.id); }
window.alCargarTurnstile = () => { if(horaSel!==null) mostrarCaptcha("reserva"); if(cancelSel!==null) mostrarCaptcha("cancelar"); };
if(CONFIG.TURNSTILE_SITE_KEY){
  const s=document.createElement("script");
  s.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=alCargarTurnstile";
  s.async=true; document.head.append(s);
}

function mensaje(id, txt, ok=false){ const m=$(id); m.className="msg "+(ok?"ok":"err"); m.textContent=txt; m.scrollIntoView({behavior:"smooth", block:"nearest"}); }
function mostrarListo(titulo, nota){
  $("listotxt").textContent=titulo; $("listonota").textContent=nota;
  $("listo").hidden=false;
  document.activeElement.blur(); // cierra el teclado
}

// --- Reservar ---
const error = txt => mensaje("formmsg", txt);
$("form").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const nombre=$("nombre").value.trim(), telefono=$("tel").value.trim(), msg=$("formmsg"), fijo=semanal();
  if(!nombre||!telefono) return error("Completá tu nombre y teléfono.");
  if(nombre.length<3) return error(ERRORES.NOMBRE);
  if(!NOMBRE_OK.test(nombre)) return error(ERRORES.NOMBRE_INVALIDO);
  const digitos=telefono.replace(/\D/g,"");
  if(digitos.length<8 || digitos.length>15 || !TELEFONO_OK.test(telefono)) return error(ERRORES.TELEFONO);
  if(CONFIG.TURNSTILE_SITE_KEY && !captchas.reserva.token) return error("Esperá a que termine la verificación anti-robots (el recuadro de arriba).");
  const fecha=diaSel, hora=horaSel;
  if(pasada(fecha,hora)){ horaSel=null; render(); return error(ERRORES.PASADO); }
  $("confirmar").disabled=true; msg.className="msg"; msg.textContent="Guardando…";
  try{
    await rpc(fijo ? "crear_fijo" : "crear_reserva",
      { p_fecha:fecha, p_hora:hora, p_nombre:nombre, p_telefono:telefono, p_captcha:captchas.reserva.token });
    mostrarListo(
      fijo ? "Hora fija confirmada: todos los "+plural(DOW_LARGO[parse(fecha).getDay()])+" de "+rango(hora)+", desde el "+largo(fecha)+"."
           : "Reserva confirmada: "+largo(fecha)+", de "+rango(hora)+".",
      (fijo ? "Queda anotada todas las semanas." : "Tu turno ya quedó anotado.")
        +" Si no podés ir, tocá tu horario y cancelalo con el nombre que pusiste: "+nombre+".");
    horaSel=null; $("nombre").value=""; $("tel").value=""; msg.textContent="";
    document.querySelector('input[name="frec"][value="una"]').checked=true;
    await cargar();                // las horas fijas ocupan varias semanas
    $("listo").scrollIntoView({behavior:"smooth", block:"center"});
  }catch(e){
    const cod=codigoError(e);
    if(cod==="OCUPADO_SEMANAS"){
      const fechas=e.message.split(":")[1].split(",").map(largo);
      error("Ese horario ya está reservado el "+fechas.join(", el ")+", así que no puede ser fijo. Podés reservarlo solo esta vez o elegir otra hora.");
    } else if(cod==="OCUPADO" && fijo && !ocupados.has(idTurno(fecha,hora))){
      error("Ese horario es fijo de otro grupo (este día justo quedó libre). Podés reservarlo solo esta vez.");
    } else {
      error(textoError(e, "No se pudo guardar la reserva. Intentá de nuevo."));
      if(["OCUPADO","PASADO"].includes(cod)){ horaSel=null; cargar(); }
    }
  }finally{ $("confirmar").disabled=false; reiniciarCaptcha("reserva"); }
});

// --- Cancelar: tocando el turno y escribiendo el mismo nombre con el que se reservó ---
$("cancelar").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const nombre=$("c-nombre").value.trim(), fecha=diaSel, hora=cancelSel;
  const fijo=ocupados.get(idTurno(fecha,hora)), todas=fijo && cancelarTodas();
  if(nombre.length<3) return mensaje("c-msg", "Escribí el nombre con el que reservaste.");
  if(CONFIG.TURNSTILE_SITE_KEY && !captchas.cancelar.token) return mensaje("c-msg", "Esperá a que termine la verificación anti-robots (el recuadro de arriba).");
  $("c-confirmar").disabled=true; $("c-msg").className="msg"; $("c-msg").textContent="Cancelando…";
  try{
    const r = await rpc("cancelar_turno", { p_fecha:fecha, p_hora:hora, p_nombre:nombre, p_todas:todas, p_captcha:captchas.cancelar.token });
    if(r==="NOMBRE_INCORRECTO") return mensaje("c-msg", "Nombre incorrecto.");
    cancelSel=null; $("c-nombre").value=""; $("c-msg").textContent="";
    document.querySelector('input[name="cfrec"][value="dia"]').checked=true;
    mostrarListo(
      r==="CANCELADO_FIJO" ? "Cancelaste tu hora fija de los "+plural(DOW_LARGO[parse(fecha).getDay()])+" de "+rango(hora)+"."
                           : "Turno cancelado: "+largo(fecha)+", de "+rango(hora)+".",
      r==="CANCELADO_DIA" ? "Tu hora fija sigue las otras semanas. El turno de ese día ya quedó libre para otros."
                          : "El horario ya quedó libre para otros.");
    await cargar();
    $("listo").scrollIntoView({behavior:"smooth", block:"center"});
  }catch(e){
    const cod=codigoError(e);
    mensaje("c-msg", cod==="PASADO" ? "Ese turno ya empezó: no se puede cancelar."
                   : cod==="NO_EXISTE" ? "Ese turno ya no está reservado."
                   : textoError(e, "No se pudo cancelar. Intentá de nuevo."));
    if(cod==="NO_EXISTE"){ cancelSel=null; cargar(); }
  }finally{ $("c-confirmar").disabled=false; reiniciarCaptcha("cancelar"); }
});

$("otra").onclick=()=>{ $("listo").hidden=true; render(); $("grid").scrollIntoView({behavior:"smooth", block:"start"}); };

// --- Inicio ---
if(!sb){ $("aviso").hidden=false; $("aviso").textContent="La página todavía no está conectada a la base de datos (falta completar words.env y correr generar-config.js)."; }
render();
cargar();
setInterval(()=>{
  if(!dias().includes(diaSel)) diaSel=hoy();
  if(horaSel!==null && pasada(diaSel,horaSel)) horaSel=null;
  if(cancelSel!==null && pasada(diaSel,cancelSel)) cancelSel=null;
  cargar();
}, 20000);
document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState==="visible") cargar(); });
