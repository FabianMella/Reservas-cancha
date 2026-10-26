// Los valores NO están en el código: se leen de words.env (en la misma carpeta que index.html).
// Acá solo quedan los nombres de las variables que usa la página.
const CONFIG = (() => {
  const c = { NOMBRE_CANCHA: "", SUPABASE_URL: "", SUPABASE_ANON_KEY: "", TURNSTILE_SITE_KEY: "", DUENO_EMAIL: "" };
  const x = new XMLHttpRequest();
  x.open("GET", "words.env", false);                 // espera a tener los datos antes de seguir
  try { x.send(); } catch (e) {}
  if (x.status === 200)
    for (const linea of x.responseText.split(/\r?\n/)) {
      const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] in c) c[m[1]] = m[2];
    }
  // la clave secreta de Supabase nunca puede ir en la página
  if (c.SUPABASE_ANON_KEY.startsWith("sb_secret_")) c.SUPABASE_ANON_KEY = "";
  return c;
})();
