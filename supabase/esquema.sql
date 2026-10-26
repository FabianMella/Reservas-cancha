-- =====================================================================
-- Reservas de la cancha · base de datos en Supabase
--
-- Cómo usarlo: Supabase → SQL Editor → New query → pegá TODO este
-- archivo → Run. Se puede volver a correr sin perder datos.
--
-- Quién puede hacer qué:
--   · Clientes (sin cuenta): solo ven qué horarios están ocupados y crean
--     reservas con crear_reserva() (una vez) o crear_fijo() (todas las semanas),
--     y cancelan las suyas con cancelar_turno() escribiendo el nombre con el que reservaron,
--     que validan todo (anti-robots, límites por teléfono, horario, horas fijas).
--     No ven nombres ni teléfonos.
--   · Dueño (cuenta anotada en la tabla duenos): ve y maneja todo.
--
-- Limpieza: todos los días se borra lo anterior al mes pasado
-- (se guardan el mes actual y el anterior).
-- =====================================================================

create extension if not exists http with schema extensions;   -- para verificar el anti-robots (Turnstile)

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table if not exists public.reservas (
  id            uuid primary key default gen_random_uuid(),
  fecha         date not null,
  hora          smallint not null check (hora between 12 and 23),   -- turno de hora a hora+1
  nombre        text not null default '' check (char_length(nombre) <= 60),  -- vacío = horario bloqueado por el dueño
  telefono      text not null default '' check (char_length(telefono) <= 20),
  telefono_norm text not null default '',                           -- últimos 8 números, para reconocer el mismo teléfono
  origen        text not null default 'cliente' check (origen in ('cliente','dueno')),
  creado        timestamptz not null default now(),
  unique (fecha, hora)                                               -- imposible reservar dos veces el mismo turno
);
create index if not exists reservas_telefono_idx on public.reservas (telefono_norm, fecha);

-- Gastos del mes que anota el dueño (luz, agua, wifi…), para calcular la ganancia real
create table if not exists public.gastos (
  id       uuid primary key default gen_random_uuid(),
  mes      date not null check (extract(day from mes) = 1),          -- primer día del mes al que corresponde
  concepto text not null check (char_length(btrim(concepto)) between 1 and 40),
  monto    int  not null check (monto between 1 and 100000000),      -- en pesos, sin centavos
  creado   timestamptz not null default now()
);
create index if not exists gastos_mes_idx on public.gastos (mes);

create table if not exists public.fijos (
  id       uuid primary key default gen_random_uuid(),
  dia      smallint not null check (dia between 0 and 6),           -- 0 = domingo … 6 = sábado
  hora     smallint not null check (hora between 12 and 23),
  nombre   text not null check (char_length(nombre) between 1 and 60),
  telefono text not null default '' check (char_length(telefono) <= 20),
  desde    date not null default (now() at time zone 'America/Argentina/Buenos_Aires')::date,
  creado   timestamptz not null default now()
);
-- hasta: último día que se jugó. Al quitar una hora fija no se borra enseguida,
-- así sigue contando en los ingresos del mes hasta que la limpieza la saque.
alter table public.fijos add column if not exists hasta date;
alter table public.fijos add column if not exists origen text not null default 'dueno' check (origen in ('cliente','dueno'));
alter table public.fijos drop constraint if exists fijos_dia_hora_key;
create unique index if not exists fijos_activos_idx on public.fijos (dia, hora) where hasta is null;

-- "Liberar este día" de una hora fija
create table if not exists public.excepciones (
  fijo_id uuid not null references public.fijos(id) on delete cascade,
  fecha   date not null,
  primary key (fijo_id, fecha)
);

create table if not exists public.config (
  id               int primary key default 1 check (id = 1),
  whatsapp         text not null default '' check (whatsapp ~ '^[0-9]{0,16}$'),
  max_por_telefono int  not null default 2 check (max_por_telefono between 1 and 20)
);
alter table public.config add column if not exists precio_hora int not null default 0 check (precio_hora between 0 and 100000000);
alter table public.config add column if not exists max_fijos_por_telefono int not null default 1 check (max_fijos_por_telefono between 0 and 10);
insert into public.config (id) values (1) on conflict do nothing;

-- Cuentas que pueden entrar al panel
create table if not exists public.duenos (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Datos que la página nunca puede leer (ej: la clave secreta de Turnstile)
create schema if not exists privado;
create table if not exists privado.secretos (
  nombre text primary key,
  valor  text not null
);
alter table privado.secretos enable row level security;
-- Intentos fallidos de cancelar un turno (para bloquear a quien prueba nombres al azar)
create table if not exists privado.intentos_cancelar (
  fecha    date not null,
  hora     smallint not null,
  intentos int not null default 0,
  desde    timestamptz not null default now(),
  primary key (fecha, hora)
);
alter table privado.intentos_cancelar enable row level security;   -- sin políticas: solo las funciones de la base la leen
revoke all on schema privado from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Funciones de apoyo
-- ---------------------------------------------------------------------
-- Lee un secreto (ej: la clave de Turnstile). Primero busca en Supabase Vault, donde
-- queda guardado cifrado; si no está ahí, en privado.secretos (forma anterior).
create or replace function privado.secreto(p_nombre text) returns text
language plpgsql stable as $$
declare v text;
begin
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using p_nombre;
  exception when others then
    v := null;   -- Vault no disponible
  end;
  if coalesce(v, '') = '' then
    select valor into v from privado.secretos where nombre = p_nombre;
  end if;
  return v;
end;
$$;

create or replace function privado.ahora() returns timestamp
language sql stable as $$
  select now() at time zone 'America/Argentina/Buenos_Aires'
$$;

-- Los últimos 8 números del teléfono: "11 5555-1234", "+54 9 11 5555 1234" y
-- "1155551234" son el mismo teléfono (y no se puede saltear el límite cambiando el formato)
create or replace function privado.clave_tel(p_tel text) returns text
language sql immutable as $$
  select right(regexp_replace(coalesce(p_tel, ''), '\D', '', 'g'), 8)
$$;

-- ¿Hay una hora fija ocupando ese turno (y no la liberaron ese día)?
create or replace function privado.fijo_ocupa(p_fecha date, p_hora int) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.fijos f
    where f.dia = extract(dow from p_fecha)::int
      and f.hora = p_hora
      and f.desde <= p_fecha
      and (f.hasta is null or p_fecha <= f.hasta)
      and not exists (select 1 from public.excepciones e where e.fijo_id = f.id and e.fecha = p_fecha))
$$;

-- Borra todo lo anterior al primer día del mes pasado
create or replace function privado.limpiar_viejos() returns int
language plpgsql as $$
declare
  v_corte date := (date_trunc('month', privado.ahora()) - interval '1 month')::date;
  v_n     int;
  v_total int := 0;
begin
  delete from public.reservas    where fecha < v_corte;                       get diagnostics v_n = row_count; v_total := v_total + v_n;
  delete from public.excepciones where fecha < v_corte;
  delete from public.gastos      where mes < v_corte;
  delete from privado.intentos_cancelar where fecha < v_corte;
  delete from public.fijos       where hasta is not null and hasta < v_corte; get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end;
$$;

create or replace function public.es_dueno() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.duenos where user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
-- Para los clientes
-- ---------------------------------------------------------------------

-- Turnos ocupados (reservas + horas fijas). No devuelve nombres ni teléfonos.
-- (cambió lo que devuelve: hay que borrarla antes de volver a crearla)
drop function if exists public.turnos_ocupados(date, date);
create function public.turnos_ocupados(p_desde date, p_hasta date)
returns table (fecha date, hora smallint, fijo boolean)
language sql stable security definer set search_path = '' as $$
  with rango as (select p_desde as d, least(p_hasta, p_desde + 31) as h)
  select r.fecha, r.hora, false
    from public.reservas r, rango
   where r.fecha between rango.d and rango.h
  union
  select g.dia::date, f.hora, true
    from public.fijos f
   cross join rango
   cross join lateral generate_series(greatest(rango.d, f.desde)::timestamp,
                                      least(rango.h, coalesce(f.hasta, rango.h))::timestamp,
                                      interval '1 day') as g(dia)
   where extract(dow from g.dia)::int = f.dia
     and not exists (select 1 from public.excepciones e where e.fijo_id = f.id and e.fecha = g.dia::date)
$$;

-- Controles comunes a todo lo que pide un cliente (anti-robots, datos, fecha).
-- Errores: CAPTCHA · NOMBRE · TELEFONO · FECHA · PASADO
create or replace function privado.validar_cliente(
  p_fecha date, p_hora int, p_nombre text, p_telefono text, p_captcha text)
returns void
language plpgsql as $$
declare
  v_ahora   timestamp := privado.ahora();
  v_hoy     date := v_ahora::date;
  v_digitos text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  v_secreto text;
  v_resp    extensions.http_response;
begin
  -- 1. Anti-robots (solo si cargaste la clave secreta de Turnstile)
  v_secreto := privado.secreto('turnstile');
  if coalesce(v_secreto, '') <> '' then
    if coalesce(p_captcha, '') = '' then raise exception 'CAPTCHA'; end if;
    v_resp := extensions.http_post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      json_build_object('secret', v_secreto, 'response', p_captcha)::text,
      'application/json');
    if v_resp.status <> 200 or coalesce((v_resp.content::json ->> 'success')::boolean, false) = false then
      raise exception 'CAPTCHA';
    end if;
  end if;

  -- 2. Datos
  if char_length(btrim(coalesce(p_nombre, ''))) not between 3 and 60 then raise exception 'NOMBRE'; end if;
  -- solo letras, números, espacios y . ' - (y que empiece con letra o número): nada de código ni fórmulas de Excel
  if btrim(p_nombre) !~ '^[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñÀÈÌÒÙàèìòùÂÊÎÔÛâêîôûÇçÃÕãõ][A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñÀÈÌÒÙàèìòùÂÊÎÔÛâêîôûÇçÃÕãõ .''-]*$' then raise exception 'NOMBRE_INVALIDO'; end if;
  if char_length(v_digitos) not between 8 and 15 or char_length(btrim(coalesce(p_telefono, ''))) > 20 then raise exception 'TELEFONO'; end if;
  if btrim(p_telefono) !~ '^[0-9 +().-]+$' then raise exception 'TELEFONO'; end if;
  if p_hora is null or p_hora not between 12 and 23 then raise exception 'FECHA'; end if;
  if p_fecha is null or p_fecha < v_hoy or p_fecha > v_hoy + 13 then raise exception 'FECHA'; end if;
  -- el turno se cierra cuando faltan 10 minutos o menos
  if p_fecha = v_hoy and p_hora * 60 - (extract(hour from v_ahora) * 60 + extract(minute from v_ahora)) <= 10 then
    raise exception 'PASADO';
  end if;
end;
$$;

-- Reservar un turno por única vez.
-- Errores: los de validar_cliente · OCUPADO · LIMITE
create or replace function public.crear_reserva(
  p_fecha date, p_hora int, p_nombre text, p_telefono text, p_captcha text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_ahora   timestamp := privado.ahora();
  v_hoy     date := v_ahora::date;
  v_clave   text := privado.clave_tel(p_telefono);
  v_cfg     public.config%rowtype;
  v_activos int;
begin
  perform privado.validar_cliente(p_fecha, p_hora, p_nombre, p_telefono, p_captcha);

  -- Límite de reservas activas por teléfono (el lock evita que dos pedidos simultáneos lo salteen)
  perform pg_advisory_xact_lock(hashtext('tel:' || v_clave));
  select * into v_cfg from public.config where id = 1;
  select count(*) into v_activos
    from public.reservas r
   where r.telefono_norm = v_clave and r.origen = 'cliente'
     and (r.fecha > v_hoy or (r.fecha = v_hoy and r.hora >= extract(hour from v_ahora)));
  if v_activos >= coalesce(v_cfg.max_por_telefono, 2) then raise exception 'LIMITE'; end if;

  -- Disponibilidad
  if privado.fijo_ocupa(p_fecha, p_hora) then raise exception 'OCUPADO'; end if;
  begin
    insert into public.reservas (fecha, hora, nombre, telefono, telefono_norm, origen)
    values (p_fecha, p_hora, btrim(p_nombre), btrim(p_telefono), v_clave, 'cliente');
  exception when unique_violation then
    raise exception 'OCUPADO';
  end;

  return json_build_object('whatsapp', coalesce(v_cfg.whatsapp, ''));
end;
$$;

-- Reservar el mismo día y hora todas las semanas, empezando por p_fecha.
-- Si esa persona ya tenía reservas sueltas en ese horario, pasan a la hora fija.
-- Errores: los de validar_cliente · OCUPADO · OCUPADO_SEMANAS:<fechas> · LIMITE_FIJOS
create or replace function public.crear_fijo(
  p_fecha date, p_hora int, p_nombre text, p_telefono text, p_captcha text default null)
returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_dia     int := extract(dow from p_fecha)::int;
  v_clave   text := privado.clave_tel(p_telefono);
  v_cfg     public.config%rowtype;
  v_choques text;
begin
  perform privado.validar_cliente(p_fecha, p_hora, p_nombre, p_telefono, p_captcha);

  perform pg_advisory_xact_lock(hashtext('tel:' || v_clave));
  select * into v_cfg from public.config where id = 1;
  if (select count(*) from public.fijos f where f.hasta is null and privado.clave_tel(f.telefono) = v_clave)
     >= coalesce(v_cfg.max_fijos_por_telefono, 1) then
    raise exception 'LIMITE_FIJOS';
  end if;

  -- ese día y hora ya es de otra hora fija (aunque justo este día esté liberado)
  if exists (select 1 from public.fijos where dia = v_dia and hora = p_hora and hasta is null) then
    raise exception 'OCUPADO';
  end if;
  -- reservas de otras personas ese día o en las semanas siguientes
  select string_agg(r.fecha::text, ',' order by r.fecha) into v_choques
    from public.reservas r
   where r.fecha >= p_fecha and r.hora = p_hora and extract(dow from r.fecha)::int = v_dia
     and r.telefono_norm <> v_clave;
  if v_choques is not null then
    if split_part(v_choques, ',', 1)::date = p_fecha then raise exception 'OCUPADO'; end if;
    raise exception 'OCUPADO_SEMANAS:%', v_choques;
  end if;

  delete from public.reservas r
   where r.telefono_norm = v_clave and r.fecha >= p_fecha and r.hora = p_hora
     and extract(dow from r.fecha)::int = v_dia;
  insert into public.fijos (dia, hora, nombre, telefono, desde, origen)
  values (v_dia, p_hora, btrim(p_nombre), btrim(p_telefono), p_fecha, 'cliente');

  return json_build_object('whatsapp', coalesce(v_cfg.whatsapp, ''));
exception when unique_violation then
  raise exception 'OCUPADO';
end;
$$;

-- Nombre para comparar: sin mayúsculas, acentos ni espacios de más ("  José  Pérez" = "jose perez")
create or replace function privado.normalizar_nombre(p text) returns text
language sql immutable as $$
  select regexp_replace(translate(lower(btrim(coalesce(p, ''))), 'áéíóúüàèìòùñ', 'aeiouuaeioun'), '\s+', ' ', 'g')
$$;

-- El cliente cancela su turno escribiendo el mismo nombre con el que reservó.
-- p_todas = true: si es una hora fija, la cancela todas las semanas (si no, solo ese día).
-- Devuelve: CANCELADA · CANCELADO_DIA · CANCELADO_FIJO
-- Errores: CAPTCHA · NO_EXISTE · PASADO · NOMBRE_INCORRECTO · DEMASIADOS_INTENTOS
create or replace function public.cancelar_turno(
  p_fecha date, p_hora int, p_nombre text, p_todas boolean default false, p_captcha text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_ahora   timestamp := privado.ahora();
  v_secreto text;
  v_resp    extensions.http_response;
  v_r       public.reservas%rowtype;
  v_f       public.fijos%rowtype;
  v_nombre  text;
  v_int     privado.intentos_cancelar%rowtype;
begin
  -- 1. Anti-robots (igual que al reservar)
  v_secreto := privado.secreto('turnstile');
  if coalesce(v_secreto, '') <> '' then
    if coalesce(p_captcha, '') = '' then raise exception 'CAPTCHA'; end if;
    v_resp := extensions.http_post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      json_build_object('secret', v_secreto, 'response', p_captcha)::text,
      'application/json');
    if v_resp.status <> 200 or coalesce((v_resp.content::json ->> 'success')::boolean, false) = false then
      raise exception 'CAPTCHA';
    end if;
  end if;

  -- 2. No se cancela lo que ya empezó
  if p_fecha is null or p_hora is null
     or p_fecha < v_ahora::date or (p_fecha = v_ahora::date and extract(hour from v_ahora) >= p_hora) then
    raise exception 'PASADO';
  end if;

  -- 3. Demasiados nombres incorrectos para este turno en la última hora
  perform pg_advisory_xact_lock(hashtext('cancelar:' || p_fecha || ':' || p_hora));
  select * into v_int from privado.intentos_cancelar where fecha = p_fecha and hora = p_hora;
  if found and v_int.desde > now() - interval '1 hour' and v_int.intentos >= 5 then
    raise exception 'DEMASIADOS_INTENTOS';
  end if;

  -- 4. ¿De quién es el turno?
  select * into v_r from public.reservas where fecha = p_fecha and hora = p_hora;
  if found then
    v_nombre := v_r.nombre;
  else
    select f.* into v_f from public.fijos f
     where f.dia = extract(dow from p_fecha)::int and f.hora = p_hora and f.desde <= p_fecha
       and (f.hasta is null or p_fecha <= f.hasta)
       and not exists (select 1 from public.excepciones e where e.fijo_id = f.id and e.fecha = p_fecha);
    if not found then raise exception 'NO_EXISTE'; end if;
    v_nombre := v_f.nombre;
  end if;

  -- 5. Nombre incorrecto: se anota el intento (sin error, para que quede guardado) y se avisa
  if v_nombre = '' or privado.normalizar_nombre(v_nombre) <> privado.normalizar_nombre(p_nombre) then
    insert into privado.intentos_cancelar (fecha, hora, intentos, desde) values (p_fecha, p_hora, 1, now())
    on conflict (fecha, hora) do update
      set intentos = case when privado.intentos_cancelar.desde > now() - interval '1 hour'
                          then privado.intentos_cancelar.intentos + 1 else 1 end,
          desde    = case when privado.intentos_cancelar.desde > now() - interval '1 hour'
                          then privado.intentos_cancelar.desde else now() end;
    return 'NOMBRE_INCORRECTO';
  end if;

  -- 6. Cancelar
  delete from privado.intentos_cancelar where fecha = p_fecha and hora = p_hora;
  if v_r.id is not null then
    delete from public.reservas where id = v_r.id;
    return 'CANCELADA';
  elsif p_todas then
    perform privado.quitar_fijo(v_f.id);
    return 'CANCELADO_FIJO';
  else
    insert into public.excepciones (fijo_id, fecha) values (v_f.id, p_fecha) on conflict do nothing;
    return 'CANCELADO_DIA';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Para el dueño (todas chequean que sea el dueño)
-- ---------------------------------------------------------------------

-- Anotar una reserva manual o bloquear un horario (nombre vacío)
create or replace function public.dueno_reservar(p_fecha date, p_hora int, p_nombre text, p_telefono text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_tel text := btrim(coalesce(p_telefono, ''));
begin
  if not public.es_dueno() then raise exception 'NO_AUTORIZADO'; end if;
  if privado.fijo_ocupa(p_fecha, p_hora) then raise exception 'OCUPADO'; end if;
  insert into public.reservas (fecha, hora, nombre, telefono, telefono_norm, origen)
  values (p_fecha, p_hora, btrim(coalesce(p_nombre, '')), v_tel, privado.clave_tel(v_tel), 'dueno');
exception when unique_violation then
  raise exception 'OCUPADO';
end;
$$;

-- Agregar una hora fija. Si esa misma persona (mismo teléfono) ya tenía reservas
-- en ese día y horario, pasan a ser parte de la hora fija. Devuelve cuántas pasaron.
-- Errores: NOMBRE · FIJO_REPETIDO · CHOQUE:<fechas con reservas de OTRAS personas>
create or replace function public.dueno_agregar_fijo(p_dia int, p_hora int, p_nombre text, p_telefono text)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_ahora   timestamp := privado.ahora();
  v_hoy     date := v_ahora::date;
  v_desde   date := v_hoy;
  v_clave   text := privado.clave_tel(p_telefono);
  v_choques text;
  v_pasadas int;
begin
  if not public.es_dueno() then raise exception 'NO_AUTORIZADO'; end if;
  if btrim(coalesce(p_nombre, '')) = '' then raise exception 'NOMBRE'; end if;
  if exists (select 1 from public.fijos where dia = p_dia and hora = p_hora and hasta is null) then
    raise exception 'FIJO_REPETIDO';
  end if;
  -- si hoy es ese día y el turno ya empezó, arranca la semana que viene
  if extract(dow from v_hoy)::int = p_dia and extract(hour from v_ahora) >= p_hora then v_desde := v_hoy + 1; end if;

  -- reservas de OTRA persona (u horarios bloqueados) en ese día y hora → no se puede
  select string_agg(r.fecha::text, ',' order by r.fecha) into v_choques
    from public.reservas r
   where r.fecha >= v_desde and r.hora = p_hora and extract(dow from r.fecha)::int = p_dia
     and (v_clave = '' or r.telefono_norm is distinct from v_clave);
  if v_choques is not null then raise exception 'CHOQUE:%', v_choques; end if;

  -- reservas de la MISMA persona → las cubre la hora fija
  delete from public.reservas r
   where v_clave <> '' and r.telefono_norm = v_clave
     and r.fecha >= v_desde and r.hora = p_hora and extract(dow from r.fecha)::int = p_dia;
  get diagnostics v_pasadas = row_count;

  insert into public.fijos (dia, hora, nombre, telefono, desde)
  values (p_dia, p_hora, btrim(p_nombre), btrim(coalesce(p_telefono, '')), v_desde);
  return v_pasadas;
exception when unique_violation then
  raise exception 'FIJO_REPETIDO';
end;
$$;

-- Quitar una hora fija. Lo ya jugado queda registrado para los ingresos del mes.
create or replace function public.dueno_quitar_fijo(p_fijo_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_dueno() then raise exception 'NO_AUTORIZADO'; end if;
  perform privado.quitar_fijo(p_fijo_id);
end;
$$;

create or replace function privado.quitar_fijo(p_fijo_id uuid)
returns void
language plpgsql as $$
declare
  v_ahora timestamp := privado.ahora();
  v_hoy   date := v_ahora::date;
  v_f     public.fijos%rowtype;
  v_hasta date;
begin
  select * into v_f from public.fijos where id = p_fijo_id and hasta is null;
  if not found then return; end if;
  -- el turno de hoy cuenta como jugado si ya empezó
  v_hasta := case when v_f.dia = extract(dow from v_hoy)::int and extract(hour from v_ahora) >= v_f.hora
                  then v_hoy else v_hoy - 1 end;
  if v_hasta < v_f.desde then
    delete from public.fijos where id = p_fijo_id;               -- nunca llegó a jugarse
  else
    update public.fijos set hasta = v_hasta where id = p_fijo_id;
    delete from public.excepciones where fijo_id = p_fijo_id and fecha > v_hasta;
  end if;
end;
$$;

-- Deshacer un "liberar este día" (si nadie reservó ese turno mientras tanto)
create or replace function public.dueno_restaurar_fijo(p_fijo_id uuid, p_fecha date)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_dueno() then raise exception 'NO_AUTORIZADO'; end if;
  if exists (select 1 from public.reservas r join public.fijos f on f.id = p_fijo_id
              where r.fecha = p_fecha and r.hora = f.hora) then
    raise exception 'OCUPADO';
  end if;
  delete from public.excepciones where fijo_id = p_fijo_id and fecha = p_fecha;
end;
$$;

-- El panel la llama al abrir, por si la limpieza automática no está activa
create or replace function public.dueno_limpiar()
returns int
language plpgsql security definer set search_path = '' as $$
begin
  if not public.es_dueno() then raise exception 'NO_AUTORIZADO'; end if;
  return privado.limpiar_viejos();
end;
$$;

-- ---------------------------------------------------------------------
-- Seguridad: RLS + permisos
-- ---------------------------------------------------------------------
alter table public.reservas    enable row level security;
alter table public.fijos       enable row level security;
alter table public.excepciones enable row level security;
alter table public.config      enable row level security;
alter table public.gastos      enable row level security;
alter table public.duenos      enable row level security;   -- sin políticas: nadie la toca desde la página

drop policy if exists "solo el dueño" on public.reservas;
drop policy if exists "solo el dueño" on public.fijos;
drop policy if exists "solo el dueño" on public.excepciones;
drop policy if exists "solo el dueño" on public.config;
drop policy if exists "solo el dueño" on public.gastos;
create policy "solo el dueño" on public.reservas    for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "solo el dueño" on public.fijos       for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "solo el dueño" on public.excepciones for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "solo el dueño" on public.config      for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "solo el dueño" on public.gastos      for all to authenticated using (public.es_dueno()) with check (public.es_dueno());

-- Los clientes no tocan ninguna tabla directo: solo las funciones de arriba
revoke all on public.reservas, public.fijos, public.excepciones, public.config, public.duenos, public.gastos from anon;
revoke all on public.duenos from authenticated;
grant select, insert, update, delete on public.reservas, public.fijos, public.excepciones, public.gastos to authenticated;
grant select, update on public.config to authenticated;

revoke execute on function public.turnos_ocupados(date, date)                  from public;
revoke execute on function public.crear_reserva(date, int, text, text, text)   from public;
revoke execute on function public.crear_fijo(date, int, text, text, text)      from public;
revoke execute on function public.cancelar_turno(date, int, text, boolean, text) from public;
revoke execute on function public.es_dueno()                                   from public;
revoke execute on function public.dueno_reservar(date, int, text, text)        from public, anon;
revoke execute on function public.dueno_agregar_fijo(int, int, text, text)     from public, anon;
revoke execute on function public.dueno_quitar_fijo(uuid)                      from public, anon;
revoke execute on function public.dueno_restaurar_fijo(uuid, date)             from public, anon;
revoke execute on function public.dueno_limpiar()                              from public, anon;
grant  execute on function public.turnos_ocupados(date, date)                  to anon, authenticated;
grant  execute on function public.crear_reserva(date, int, text, text, text)   to anon, authenticated;
grant  execute on function public.crear_fijo(date, int, text, text, text)      to anon, authenticated;
grant  execute on function public.cancelar_turno(date, int, text, boolean, text) to anon, authenticated;
grant  execute on function public.es_dueno()                                   to anon, authenticated;
grant  execute on function public.dueno_reservar(date, int, text, text)        to authenticated;
grant  execute on function public.dueno_agregar_fijo(int, int, text, text)     to authenticated;
grant  execute on function public.dueno_quitar_fijo(uuid)                      to authenticated;
grant  execute on function public.dueno_restaurar_fijo(uuid, date)             to authenticated;
grant  execute on function public.dueno_limpiar()                              to authenticated;

-- Avisos en vivo para el panel del dueño (respetan las reglas de arriba)
do $$
declare t text;
begin
  foreach t in array array['reservas', 'fijos', 'excepciones', 'gastos'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Limpieza automática todos los días a las 4 de la mañana (hora Argentina = 7 UTC).
-- Si pg_cron no se pudiera activar, igual se limpia cada vez que el dueño abre el panel.
do $$
begin
  execute 'create extension if not exists pg_cron';
  execute $cron$ select cron.schedule('limpiar-reservas-viejas', '0 7 * * *', 'select privado.limpiar_viejos()') $cron$;
exception when others then
  raise notice 'No se pudo programar la limpieza automática (%). Se va a limpiar al abrir el panel.', sqlerrm;
end $$;

-- =====================================================================
-- DESPUÉS de correr esto, en una consulta APARTE (New query), una sola vez (ver LEEME.md):
--
-- 1) Anotar la cuenta del dueño (el email es el mismo que pusiste en js/config.js):
--    insert into public.duenos (user_id)
--    select id from auth.users where email = 'dueno@cancha-matadero.com'
--    on conflict do nothing;
--
-- 2) Activar el anti-robots: guardá tu Secret Key de Cloudflare Turnstile en Vault (queda cifrada):
--    select vault.create_secret('TU_SECRET_KEY', 'turnstile', 'Clave secreta de Cloudflare Turnstile');
--    Para cambiarla más adelante:
--    select vault.update_secret((select id from vault.secrets where name = 'turnstile'), 'NUEVA_SECRET_KEY');
-- =====================================================================
