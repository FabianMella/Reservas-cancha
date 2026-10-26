// Utilidades y conexión compartidas por index.html y dueno.html

const HORAS = Array.from({length:12},(_,i)=>12+i); // 12..23, último turno 23:00-00:00
const DIAS_ADELANTE = 14;
const MIN_ANTES = 10; // se cierra el turno cuando faltan 10 minutos o menos
const DOW = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const DOW_LARGO = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const MES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const $ = id => document.getElementById(id);

const pad = n => String(n).padStart(2,"0");
const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const hoy = () => ymd(new Date());
const parse = s => { const [y,m,d]=s.split("-").map(Number); return new Date(y,m-1,d); };
const largo = s => { const d=parse(s); return DOW_LARGO[d.getDay()]+" "+d.getDate()+" de "+MES[d.getMonth()]; };
const rango = h => pad(h)+":00 a "+(h===23?"00":pad(h+1))+":00";
const idTurno = (fecha,h) => fecha+"_"+pad(h);
const capital = s => s[0].toUpperCase()+s.slice(1);

function dias(){ const out=[]; const b=new Date(); b.setHours(0,0,0,0); for(let i=0;i<DIAS_ADELANTE;i++){const d=new Date(b); d.setDate(b.getDate()+i); out.push(ymd(d));} return out; }
function pasada(dia,h){ if(dia<hoy()) return true; if(dia!==hoy()) return false; const n=new Date(); return h*60-(n.getHours()*60+n.getMinutes()) <= MIN_ANTES; }

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------
// La sesión del dueño se guarda en sessionStorage: se borra sola al cerrar la pestaña,
// en vez de quedar guardada en el celular indefinidamente (localStorage).
try{ for(const k of Object.keys(localStorage)) if(/^sb-.+-auth-token/.test(k)) localStorage.removeItem(k); }catch(e){} // sesiones viejas
// Nombre de la cancha en el título de la pestaña (opcional, se configura en config.js)
if(CONFIG.NOMBRE_CANCHA) document.title = document.title.replace("Reservas", "Reservas " + CONFIG.NOMBRE_CANCHA).replace("Panel de control", "Panel de control · " + CONFIG.NOMBRE_CANCHA);

const sb = (window.supabase && CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY)
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true },
    })
  : null;

// Espera una respuesta de Supabase y tira el error si vino con error
async function q(promesa){ const {data,error}=await promesa; if(error) throw error; return data; }
const rpc = (nombre,args) => q(sb.rpc(nombre,args));
const esDueno = () => rpc("es_dueno").catch(()=>false);

// Códigos que devuelve la base de datos (ver supabase/esquema.sql)
const ERRORES = {
  OCUPADO: "Ese horario lo acaba de reservar otra persona. Elegí otro.",
  LIMITE: "Ya tenés el máximo de reservas activas con ese teléfono. Si necesitás otro turno, escribile al dueño.",
  LIMITE_FIJOS: "Con ese teléfono no se pueden pedir más horas fijas desde la página. Escribile al dueño.",
  CAPTCHA: "No pudimos verificar que no seas un robot. Esperá el tilde de verificación y probá de nuevo.",
  NOMBRE: "Escribí tu nombre (al menos 3 letras).",
  NOMBRE_INVALIDO: "El nombre solo puede tener letras, números, espacios y los signos . ' -",
  TELEFONO: "Número inválido.",
  FECHA: "Ese día u horario no se puede reservar.",
  PASADO: "Ese turno ya cerró: faltan 10 minutos o menos. Elegí otro.",
  NO_AUTORIZADO: "Esta cuenta no tiene acceso al panel.",
  FIJO_REPETIDO: "Ya hay una hora fija ese día y horario.",
  DEMASIADOS_INTENTOS: "Demasiados intentos con nombres incorrectos para este turno. Probá de nuevo en una hora.",
};
// Mismas reglas que la base de datos (supabase/esquema.sql → validar_cliente). La que manda es la de la base.
const LETRAS = "A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñÀÈÌÒÙàèìòùÂÊÎÔÛâêîôûÇçÃÕãõ";
const NOMBRE_OK = new RegExp("^["+LETRAS+"]["+LETRAS+" .'-]*$");
const TELEFONO_OK = /^[0-9 +().-]+$/;

const codigoError = e => String((e&&e.message)||"").split(":")[0];
function textoError(e, otro="Algo falló al guardar. Intentá de nuevo en un rato."){
  if(ERRORES[codigoError(e)]) return ERRORES[codigoError(e)];
  const cod=String((e&&e.code)||"");
  // la página es más nueva que la base: falta correr supabase/esquema.sql en Supabase
  if(["PGRST202","PGRST204","42703","42883"].includes(cod))
    return "La base de datos no está actualizada (falta correr supabase/esquema.sql en Supabase). Código "+cod+".";
  // sin respuesta del servidor = problema de conexión
  if(!cod && /fetch|network|load failed/i.test(String((e&&e.message)||"")))
    return "No se pudo conectar. Revisá tu internet e intentá de nuevo.";
  return otro+(cod ? " (código "+cod+")" : "");
}
