// Panel del dueño: agenda, reservas manuales, horas fijas, ingresos y ajustes

let d = { reservas:{}, fijos:{}, excepciones:new Set(), config:{}, gastos:[] }; // lo último que se cargó

// La base guarda el mes actual y el anterior; se carga todo eso para poder calcular ingresos
const inicioMesAnterior = () => { const n=new Date(); return ymd(new Date(n.getFullYear(), n.getMonth()-1, 1)); };
const plata = n => new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",maximumFractionDigits:0}).format(n);
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

// --- Pestañas ---
const VISTAS=["agenda","ingresos","ajustes"];
function tab(v){
  for(const x of VISTAS){ $("tab-"+x).setAttribute("aria-selected", x===v); $("vista-"+x).hidden = x!==v; }
  history.replaceState(null,"","#"+v);
}
for(const x of VISTAS) $("tab-"+x).onclick=()=>tab(x);

function mostrar(el, ok, txt){ el.className="msg "+(ok?"ok":"err"); el.textContent=txt; }

// Trae todas las filas de a 1000 (el máximo que devuelve Supabase por pedido)
async function todas(armar){
  const out=[];
  for(let i=0;;i+=1000){ const lote=await q(armar().range(i,i+999)); out.push(...lote); if(lote.length<1000) return out; }
}

// --- Carga de datos (el dueño ve todo gracias a las reglas de la base) ---
async function cargar(){
  try{
    const desde=inicioMesAnterior();
    const [reservas, fijos, excepciones, config, gastos] = await Promise.all([
      todas(()=>sb.from("reservas").select("id,fecha,hora,nombre,telefono,origen").gte("fecha", desde).order("fecha").order("hora")),
      q(sb.from("fijos").select("id,dia,hora,nombre,telefono,desde,hasta,origen")),
      todas(()=>sb.from("excepciones").select("fijo_id,fecha").gte("fecha", desde).order("fecha")),
      q(sb.from("config").select("max_por_telefono,max_fijos_por_telefono,precio_hora").eq("id",1).maybeSingle()),
      q(sb.from("gastos").select("id,mes,concepto,monto").gte("mes", desde).order("mes").order("creado")),
    ]);
    d = {
      reservas: Object.fromEntries(reservas.map(r=>[idTurno(r.fecha,r.hora), r])),
      fijos: Object.fromEntries(fijos.map(f=>[f.id, f])),
      excepciones: new Set(excepciones.map(e=>e.fijo_id+"_"+e.fecha)),
      config: config || {},
      gastos,
    };
    $("aviso").hidden=true;
    render();
  }catch(e){
    $("aviso").hidden=false; $("aviso").textContent=textoError(e, "No se pudieron cargar los datos. Reintentamos solos en un minuto.");
  }
}
let temporizador=null;
const cargarPronto = () => { clearTimeout(temporizador); temporizador=setTimeout(cargar,300); };

// Hora fija que cae en esa fecha/hora (incluye las ya quitadas, para lo que se jugó antes)
function fijoEn(fecha,h){
  const dow=parse(fecha).getDay();
  for(const f of Object.values(d.fijos))
    if(f.dia===dow && f.hora===h && fecha>=f.desde && (!f.hasta || fecha<=f.hasta))
      return { ...f, liberado: d.excepciones.has(f.id+"_"+fecha) };
  return null;
}

// Qué pasa en un turno: reserva, hora fija o nada
function turno(fecha,h){
  const r=d.reservas[idTurno(fecha,h)];
  if(r) return {tipo:"reserva", fecha, hora:h, r};
  const f=fijoEn(fecha,h);
  return f ? {tipo:"fijo", fecha, hora:h, f} : null;
}
// ¿Ese turno se cobra? (no se cobran los horarios bloqueados ni los fijos liberados)
const seCobra = t => t && (t.tipo==="reserva" ? !!t.r.nombre : !t.f.liberado);

// Botón que pide un segundo toque para confirmar
function botonConfirmar(texto, pregunta, accion, clase="link"){
  const b=document.createElement("button"); b.type="button"; b.className=clase; b.textContent=texto;
  b.onclick=async()=>{
    if(b.dataset.sure!=="1"){ b.dataset.sure="1"; b.textContent=pregunta; setTimeout(()=>{ if(!b.disabled){ b.dataset.sure=""; b.textContent=texto; } },4000); return; }
    b.disabled=true; b.textContent="…";
    try{ await accion(); await cargar(); }
    catch(e){ b.textContent = codigoError(e)==="OCUPADO" ? "Ya hay otra reserva" : "No se pudo"; b.disabled=false; b.dataset.sure=""; }
  };
  return b;
}

function fila(hora, nombre, detalle, tags, acciones, clase="item"){
  const it=document.createElement("div"); it.className=clase;
  it.innerHTML='<span class="h"></span><div class="who"><b></b><span></span></div><div class="acciones"></div>';
  it.querySelector(".h").textContent=hora;
  it.querySelector(".who > span").textContent=detalle;
  const b=it.querySelector("b"); b.textContent=nombre;
  for(const [txt,cls] of tags){ const t=document.createElement("span"); t.className="tag "+(cls||""); t.textContent=txt; b.append(t); }
  it.querySelector(".acciones").append(...acciones);
  return it;
}

// --- Agenda: reservas sueltas + horas fijas de los próximos 14 días ---
function turnosProximos(){
  const out=[];
  for(const fecha of dias()) for(const h of HORAS){ const t=turno(fecha,h); if(t) out.push(t); }
  return out;
}

function renderAgenda(turnos){
  const a=$("agenda"); a.textContent="";
  if(!turnos.length){ const e=document.createElement("div"); e.className="empty"; e.textContent="Todavía no hay reservas. Cuando alguien reserve, va a aparecer acá ordenado por día y hora."; a.append(e); return; }
  let dia=null, list=null;
  for(const t of turnos){
    if(t.fecha!==dia){ dia=t.fecha; const l=document.createElement("div"); l.className="daylabel"; l.textContent=(dia===hoy()?"Hoy, ":"")+largo(dia); a.append(l); list=document.createElement("div"); list.className="list"; a.append(list); }
    const hora=pad(t.hora)+":00";
    if(t.tipo==="reserva"){
      const r=t.r, bloqueo=!r.nombre;
      const tags = bloqueo ? [["Bloqueado"]] : r.origen==="dueno" ? [["Manual"]] : [];
      list.append(fila(hora, bloqueo?"Horario bloqueado":r.nombre, r.telefono?"Tel: "+r.telefono:"Sin teléfono", tags,
        [botonConfirmar(bloqueo?"Desbloquear":"Cancelar","¿Seguro? Tocá de nuevo",()=>q(sb.from("reservas").delete().eq("id",r.id)))]));
    } else if(!t.f.liberado){
      list.append(fila(hora, t.f.nombre, (t.f.telefono?"Tel: "+t.f.telefono+" · ":"")+"todos los "+DOW_LARGO[t.f.dia], [["Fijo","fijo"]],
        [botonConfirmar("Liberar este día","¿Liberar solo este día?",()=>q(sb.from("excepciones").insert({fijo_id:t.f.id, fecha:t.fecha}))),
         botonConfirmar("Quitar hora fija","¿Quitar todas las semanas?",()=>rpc("dueno_quitar_fijo",{p_fijo_id:t.f.id}),"link danger")]));
    } else {
      list.append(fila(hora, t.f.nombre, "Libre este día: se puede reservar", [["Fijo liberado"]],
        [botonConfirmar("Volver a reservar","¿Volver a ocuparlo?",()=>rpc("dueno_restaurar_fijo",{p_fijo_id:t.f.id, p_fecha:t.fecha}))]));
    }
  }
}

// --- Ingresos del mes: horas cobrables × precio por hora ---
function ingresosMes(anio, mes){
  const r={ jugadas:0, porJugar:0, web:0, manual:0, fijo:0 };
  const ultimo=new Date(anio,mes+1,0).getDate(), hoyS=hoy(), ahora=new Date().getHours();
  for(let dia=1; dia<=ultimo; dia++){
    const fecha=ymd(new Date(anio,mes,dia));
    for(const h of HORAS){
      const t=turno(fecha,h);
      if(!seCobra(t)) continue;
      r[t.tipo==="fijo" ? "fijo" : t.r.origen==="dueno" ? "manual" : "web"]++;
      (fecha<hoyS || (fecha===hoyS && h<=ahora)) ? r.jugadas++ : r.porJugar++;
    }
  }
  r.horas=r.jugadas+r.porJugar;
  return r;
}

const primerDia = (anio,mes) => ymd(new Date(anio,mes,1));
const gastosDe = (anio,mes) => d.gastos.filter(g=>g.mes===primerDia(anio,mes));
const suma = lista => lista.reduce((t,g)=>t+g.monto,0);

function filaDl(dl, texto, valor, clase=""){
  const dt=document.createElement("dt"), dd=document.createElement("dd");
  dt.textContent=texto; dd.textContent=valor; dd.className="m "+clase; dt.className=clase;
  dl.append(dt,dd);
}

function renderIngresos(){
  const [anio,mes]=$("i-mes").value.split("-").map(Number), precio=d.config.precio_hora||0;
  const r=ingresosMes(anio,mes), esteMes=mes===new Date().getMonth();
  renderGanancia(anio,mes,r,precio,esteMes);
  renderGastos(anio,mes,esteMes);
  $("i-total").textContent=plata(r.horas*precio);
  $("i-horas").textContent=r.horas+(r.horas===1?" hora alquilada":" horas alquiladas")+" × "+plata(precio);
  const filas=[
    ["Ya jugadas", r.jugadas], ...(esteMes ? [["Por jugar (ya reservadas)", r.porJugar]] : []),
    ["Reservas por la página", r.web], ...(r.manual ? [["Anotadas por vos", r.manual]] : []), ["Horas fijas", r.fijo],
  ];
  const dl=$("i-desglose"); dl.textContent="";
  for(const [k,v] of filas){
    const dt=document.createElement("dt"), h=document.createElement("dd"), m=document.createElement("dd");
    dt.textContent=k; h.className="h"; h.textContent=v+" h"; m.className="m"; m.textContent=plata(v*precio);
    dl.append(dt,h,m);
  }
  $("i-nota").textContent = !precio ? "Cargá el precio por hora en Ajustes para ver la plata."
    : "Calculado con el precio actual. No cuentan los horarios bloqueados ni las horas fijas liberadas."
      + (esteMes ? " Las horas fijas que faltan del mes ya se cuentan como por jugar." : "");
}

// Ganancia real = lo que entra por alquiler − los gastos del mes
function renderGanancia(anio,mes,r,precio,esteMes){
  const ingresos=r.horas*precio, jugado=r.jugadas*precio, gastos=suma(gastosDe(anio,mes)), ganancia=ingresos-gastos;
  const g=$("g-ganancia"); g.textContent=plata(ganancia); g.classList.toggle("negativa", ganancia<0);
  $("g-cuenta").textContent = ganancia<0 ? "los gastos superan a los ingresos" : (esteMes ? "si se juega todo lo reservado" : "lo que te quedó en el mes");
  const dl=$("g-resultado"); dl.textContent="";
  filaDl(dl, "Ingresos", plata(ingresos));
  filaDl(dl, "Gastos", "− "+plata(gastos), "gasto");
  filaDl(dl, "Ganancia", plata(ganancia), "total"+(ganancia<0?" negativa":""));
  $("g-nota").textContent = !precio ? "Cargá el precio por hora en Ajustes para calcular los ingresos."
    : esteMes ? "Con lo jugado hasta hoy ("+plata(jugado)+"), la ganancia va en "+plata(jugado-gastos)+"."
    : "";
}

// Lista de gastos del mes elegido, con botón para borrar cada uno
function renderGastos(anio,mes,esteMes){
  const lista=gastosDe(anio,mes), c=$("g-lista"); c.textContent="";
  if(!lista.length){
    const e=document.createElement("div"); e.className="empty";
    e.textContent="Todavía no anotaste gastos este mes. Agregá la luz, el agua, el wifi… y abajo ves la ganancia real.";
    c.append(e);
  } else {
    const ul=document.createElement("div"); ul.className="list";
    for(const g of lista){
      const it=document.createElement("div"); it.className="item gasto-item";
      it.innerHTML='<b></b><span class="monto"></span><div class="acciones"></div>';
      it.querySelector("b").textContent=g.concepto;
      it.querySelector(".monto").textContent=plata(g.monto);
      it.querySelector(".acciones").append(botonConfirmar("Borrar","¿Borrar?",()=>q(sb.from("gastos").delete().eq("id",g.id)),"link danger"));
      ul.append(it);
    }
    const tot=document.createElement("div"); tot.className="item gasto-item total";
    tot.innerHTML='<b>Total</b><span class="monto"></span><span></span>';
    tot.querySelector(".monto").textContent=plata(suma(lista));
    ul.append(tot); c.append(ul);
  }
  // copiar los del mes pasado: solo en el mes actual, si todavía está vacío
  const ant=new Date(anio,mes-1,1), deAntes=gastosDe(ant.getFullYear(),ant.getMonth());
  $("g-copiar").hidden = !(esteMes && !lista.length && deAntes.length);
  $("g-copiar").textContent="Copiar los "+deAntes.length+" gastos del mes pasado";
}

$("f-gasto").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const [anio,mes]=$("i-mes").value.split("-").map(Number);
  const concepto=$("g-concepto").value.trim().replace(/\s+/g," "), monto=Number($("g-monto").value), m=$("g-msg");
  if(!concepto) return mostrar(m,false,"Escribí qué gasto es (ej: Luz).");
  if(!Number.isInteger(monto) || monto<1) return mostrar(m,false,"El monto tiene que ser un número entero mayor a 0, sin puntos ni comas.");
  try{
    await q(sb.from("gastos").insert({ mes:primerDia(anio,mes), concepto, monto }));
    $("g-concepto").value=""; $("g-monto").value=""; mostrar(m,true,"Anotado: "+concepto+" "+plata(monto)+".");
    document.activeElement.blur();
    await cargar();
  }catch(e){ mostrar(m,false,textoError(e)); }
});

$("g-copiar").onclick=async()=>{
  const n=new Date(), ant=new Date(n.getFullYear(),n.getMonth()-1,1), b=$("g-copiar");
  const nuevos=gastosDe(ant.getFullYear(),ant.getMonth()).map(g=>({ mes:primerDia(n.getFullYear(),n.getMonth()), concepto:g.concepto, monto:g.monto }));
  b.disabled=true;
  try{ await q(sb.from("gastos").insert(nuevos)); mostrar($("g-msg"),true,"Listo. Si algún monto cambió (ej: la luz), borralo y anotalo de nuevo."); await cargar(); }
  catch(e){ mostrar($("g-msg"),false,textoError(e)); }
  finally{ b.disabled=false; }
};

function renderStats(turnos){
  const activos=turnos.filter(seCobra), n=new Date(), mes=ingresosMes(n.getFullYear(), n.getMonth());
  const st=[["Hoy",activos.filter(t=>t.fecha===hoy()).length],["Próximos 14 días",activos.length]];
  if(d.config.precio_hora) st.push(["ganancia del mes", plata(mes.horas*d.config.precio_hora - suma(gastosDe(n.getFullYear(), n.getMonth())))]);
  $("stats").textContent="";
  for(const [k,v] of st){ const s=document.createElement("span"); s.innerHTML="<b></b> "; s.firstChild.textContent=v; s.append(k); $("stats").append(s); }
}

function render(){
  const turnos=turnosProximos();
  renderStats(turnos); renderAgenda(turnos); renderIngresos();
  const c=d.config;
  if(document.activeElement!==$("maximo")) $("maximo").value=c.max_por_telefono||2;
  if(document.activeElement!==$("maxfijos")) $("maxfijos").value=c.max_fijos_por_telefono ?? 1;
  if(document.activeElement!==$("precio")) $("precio").value=c.precio_hora||"";
}

// --- Selects ---
function opciones(sel, items){ sel.textContent=""; for(const [v,t] of items){ const o=document.createElement("option"); o.value=v; o.textContent=t; sel.append(o); } }
function llenarSelects(){
  const previos=["i-mes"].map(id=>[id,$(id).value]);
  const n=new Date(), actual=new Date(n.getFullYear(),n.getMonth(),1), anterior=new Date(n.getFullYear(),n.getMonth()-1,1);
  opciones($("i-mes"), [[actual,"Este mes"],[anterior,"Mes pasado"]].map(([f,t])=>[f.getFullYear()+"-"+f.getMonth(), capital(MESES[f.getMonth()])+" "+f.getFullYear()+" ("+t.toLowerCase()+")"]));
  for(const [id,v] of previos) if(v && [...$(id).options].some(o=>o.value===v)) $(id).value=v;
}
$("i-mes").onchange=renderIngresos;

// --- Ajustes ---
$("cfg").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const max=Number($("maximo").value), maxFijos=Number($("maxfijos").value), precio=Number($("precio").value||0), m=$("cfgmsg");
  if(!(max>=1 && max<=20)){ mostrar(m,false,"El máximo por teléfono tiene que ser entre 1 y 20."); return; }
  if(!(Number.isInteger(maxFijos) && maxFijos>=0 && maxFijos<=10)){ mostrar(m,false,"Las horas fijas por teléfono tienen que ser entre 0 y 10."); return; }
  if(!Number.isInteger(precio) || precio<0){ mostrar(m,false,"El precio tiene que ser un número entero, sin puntos ni comas."); return; }
  try{
    await q(sb.from("config").update({ max_por_telefono:max, max_fijos_por_telefono:maxFijos, precio_hora:precio }).eq("id",1));
    mostrar(m,true,"Guardado."); cargar();
  }catch(e){ mostrar(m,false,textoError(e)); }
});

// Exportar a CSV (separado por ; para que Excel en español lo abra bien)
// Si un dato empieza con = + - @, Excel lo toma como fórmula (ataque conocido): se le antepone ' para que quede como texto
function celda(v){ let t=String(v??""); if(/^[=+\-@\t\r]/.test(t)) t="'"+t; return '"'+t.replace(/"/g,'""')+'"'; }
function csv(filas){ return String.fromCharCode(0xFEFF)+filas.map(f=>f.map(celda).join(";")).join("\r\n"); } // marca BOM: para que Excel lea bien los acentos
$("exportar").onclick=async()=>{
  const m=$("expmsg"), b=$("exportar"); b.disabled=true; mostrar(m,true,"Preparando…");
  try{
    const reservas=await todas(()=>sb.from("reservas").select("fecha,hora,nombre,telefono,origen,creado").order("fecha").order("hora"));
    const fijos=await q(sb.from("fijos").select("dia,hora,nombre,telefono,desde,hasta").order("dia").order("hora"));
    const gastos=await q(sb.from("gastos").select("mes,concepto,monto").order("mes").order("creado"));
    const filas=[["Tipo","Fecha / Día","Hora","Nombre / Concepto","Teléfono","Origen","Creado / Desde","Hasta","Monto"]];
    for(const r of reservas) filas.push(["Reserva", r.fecha, rango(r.hora), r.nombre||"(bloqueado)", r.telefono, r.origen==="dueno"?"Dueño":"Cliente", new Date(r.creado).toLocaleString("es-AR"), ""]);
    for(const f of fijos) filas.push(["Hora fija", capital(DOW_LARGO[f.dia]), rango(f.hora), f.nombre, f.telefono, "Dueño", f.desde, f.hasta||"sigue"]);
    for(const g of gastos) filas.push(["Gasto", g.mes.slice(0,7), "", g.concepto, "", "", "", "", g.monto]);
    const a=document.createElement("a");
    a.href=URL.createObjectURL(new Blob([csv(filas)],{type:"text/csv;charset=utf-8"}));
    a.download="reservas-"+hoy()+".csv"; document.body.append(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    mostrar(m,true,"Listo: "+reservas.length+(reservas.length===1?" reserva":" reservas")+" y "+fijos.length+(fijos.length===1?" hora fija.":" horas fijas."));
  }catch(e){ mostrar(m,false,textoError(e)); }
  finally{ b.disabled=false; }
};

$("f-clave").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const actual=$("c-actual").value, nueva=$("c-nueva").value, rep=$("c-rep").value, m=$("c-msg");
  if(nueva.length<8){ mostrar(m,false,"La nueva tiene que tener al menos 8 caracteres."); return; }
  if(nueva!==rep){ mostrar(m,false,"Las dos contraseñas nuevas no coinciden."); return; }
  const r1=await sb.auth.signInWithPassword({ email:CONFIG.DUENO_EMAIL, password:actual });
  if(r1.error){ mostrar(m,false,"La contraseña actual no es correcta."); return; }
  const r2=await sb.auth.updateUser({ password:nueva });
  if(r2.error){ mostrar(m,false,"No se pudo cambiar: "+r2.error.message); return; }
  $("c-actual").value=$("c-nueva").value=$("c-rep").value="";
  mostrar(m,true,"Contraseña cambiada.");
});

$("salir").onclick=async()=>{ await sb.auth.signOut(); location.href="index.html"; };

// --- Entrar: si no hay sesión del dueño, se pide la contraseña acá mismo ---
function mostrarLogin(){
  $("entrar-box").hidden=false;
  if(matchMedia("(pointer:fine)").matches) $("clave").focus();
}
$("login").addEventListener("submit", async ev=>{
  ev.preventDefault();
  const m=$("lockmsg"), btn=$("entrar");
  btn.disabled=true; m.className="msg"; m.textContent="Entrando…";
  const { error } = await sb.auth.signInWithPassword({ email:CONFIG.DUENO_EMAIL, password:$("clave").value });
  $("clave").value="";
  if(error){
    btn.disabled=false; m.className="msg err";
    m.textContent = error.status===400 ? "Contraseña incorrecta." : error.status===429 ? "Demasiados intentos. Esperá unos minutos." : "No se pudo entrar. Revisá tu internet y probá de nuevo.";
    return;
  }
  if(!(await esDueno())){ await sb.auth.signOut(); btn.disabled=false; m.className="msg err"; m.textContent=ERRORES.NO_AUTORIZADO; return; }
  document.activeElement.blur();
  abrirPanel();
});

let panelAbierto=false;
async function abrirPanel(){
  if(panelAbierto) return; panelAbierto=true;
  $("entrar-box").hidden=true; $("app").hidden=false;
  llenarSelects();
  tab(VISTAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "agenda");
  await rpc("dueno_limpiar").catch(()=>{}); // borra lo anterior al mes pasado (por si no corre la limpieza automática)
  await cargar();

  // Cambios en vivo (una reserva nueva aparece sola) + recarga cada minuto por las dudas
  const canal=sb.channel("panel");
  for(const t of ["reservas","fijos","excepciones","gastos"]) canal.on("postgres_changes",{event:"*",schema:"public",table:t},cargarPronto);
  canal.subscribe();
  setInterval(()=>{ llenarSelects(); cargar(); }, 60000);
  sb.auth.onAuthStateChange(ev=>{ if(ev==="SIGNED_OUT") location.replace("index.html"); });
}

(async()=>{
  if(!sb){ $("verificando").textContent="La página todavía no está conectada a la base de datos (falta completar words.env y correr generar-config.js)."; return; }
  const { data:{ session } } = await sb.auth.getSession();
  $("verificando").remove();
  if(session && await esDueno()) return abrirPanel();
  if(session) await sb.auth.signOut();
  mostrarLogin();
})();
