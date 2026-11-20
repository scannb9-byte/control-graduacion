/*
 * Escaneo RÁPIDO: la lista de códigos se descarga al dispositivo y cada QR se valida
 * al instante. El Sheet se actualiza en segundo plano (cola con reintentos).
 */
(() => {
  const CFG = window.APP_CONFIG;
  const $ = id => document.getElementById(id);
  const DEVICE = (navigator.userAgent.match(/\(([^;)]+)/) || [, 'web'])[1];
  const PRESENTE = 'PRESENTE', SALIO = 'SALIÓ';

  let pin = localStorage.getItem('grad_pin') || '';
  let modo = localStorage.getItem('grad_modo') || 'in';
  let estados = new Map(JSON.parse(localStorage.getItem('grad_estados') || '[]'));
  let cola = JSON.parse(localStorage.getItem('grad_cola') || '[]');
  let cambiosLocales = 0;      // para no pisar escaneos nuevos con una sincronización vieja
  let enviando = false;
  let ocupado = false;
  let ultimo = { code: '', t: 0 };
  let scanner = null;

  /* ============ Utilidades ============ */
  const guardar = () => {
    localStorage.setItem('grad_estados', JSON.stringify([...estados]));
    localStorage.setItem('grad_cola', JSON.stringify(cola));
  };

  async function api(params) {
    const url = CFG.API_URL + '?' + new URLSearchParams({ ...params, pin });
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function pintarBarra() {
    let p = 0;
    estados.forEach(e => { if (e === PRESENTE) p++; });
    $('total').textContent = estados.size;
    $('presentes').textContent = p;
  }

  function pintarSync(error) {
    $('sync').className = 'punto' + (error ? ' err' : cola.length ? ' pend' : '');
  }

  /* ============ Validación local instantánea ============ */
  function validar(code) {
    if (!estados.has(code)) return 'INVALIDO';
    const e = estados.get(code);
    if (modo === 'in') return e === PRESENTE ? 'DUPLICADO' : 'ENTRADA';
    return e === PRESENTE ? 'SALIDA' : 'NO_INGRESADO';
  }

  const VISTA = {
    ENTRADA:      { cls: 'ok-in',  icono: '✅', titulo: 'INGRESO OK' },
    SALIDA:       { cls: 'ok-out', icono: '🚪', titulo: 'SALIDA OK' },
    DUPLICADO:    { cls: 'mal',    icono: '⛔', titulo: 'YA INGRESÓ' },
    NO_INGRESADO: { cls: 'mal',    icono: '⛔', titulo: 'NO HA INGRESADO' },
    INVALIDO:     { cls: 'mal',    icono: '⛔', titulo: 'NO VÁLIDO' }
  };

  function alEscanear(texto) {
    const code = String(texto || '').trim().toUpperCase();
    if (!code || ocupado) return;
    // El mismo QR sigue frente a la cámara: ignorarlo unos segundos
    if (code === ultimo.code && Date.now() - ultimo.t < 3000) return;
    ultimo = { code, t: Date.now() };
    ocupado = true;

    const resultado = validar(code);
    if (resultado === 'ENTRADA') estados.set(code, PRESENTE);
    if (resultado === 'SALIDA') estados.set(code, SALIO);
    cambiosLocales++;

    // Todo intento va al servidor (los inválidos/duplicados quedan en "Registro")
    cola.push({ code, modo, local: resultado });
    guardar();
    pintarBarra();
    mostrar(resultado, code);
    enviarCola();

    const ok = resultado === 'ENTRADA' || resultado === 'SALIDA';
    setTimeout(() => {
      $('overlay').className = 'overlay oculto';
      ocupado = false;
      ultimo.t = Date.now();
    }, ok ? 800 : 1800);
  }

  function mostrar(resultado, code) {
    const v = VISTA[resultado];
    $('ovIcono').textContent = v.icono;
    $('ovTitulo').textContent = v.titulo;
    $('ovCodigo').textContent = code;
    $('overlay').className = 'overlay ' + v.cls;
    if (v.cls === 'mal') { beep(220, .45); navigator.vibrate?.([300, 100, 300]); }
    else { beep(v.cls === 'ok-in' ? 1000 : 650, .12); navigator.vibrate?.(80); }
  }

  let audioCtx;
  function beep(freq, dur) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.25;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }

  /* ============ Cola hacia Google Sheets (segundo plano) ============ */
  async function enviarCola() {
    if (enviando || !cola.length) return pintarSync();
    enviando = true;
    pintarSync();
    try {
      while (cola.length) {
        const item = cola[0];
        const r = await api({ action: 'scan', code: item.code, modo: item.modo, device: DEVICE });
        if (r.error === 'PIN incorrecto') { enviando = false; return cerrarSesion('PIN incorrecto'); }
        const aceptadoLocal = item.local === 'ENTRADA' || item.local === 'SALIDA';
        // Otro dispositivo registró este código antes → el servidor manda
        if (aceptadoLocal && !r.ok) {
          if (r.estado) estados.set(item.code, String(r.estado).toUpperCase());
          avisar('⚠️ ' + item.code + (r.resultado === 'DUPLICADO'
            ? ' ya había INGRESADO por otro dispositivo (posible copia)'
            : ' rechazado: ' + r.resultado));
          pintarBarra();
        }
        cola.shift();
        guardar();
      }
      pintarSync();
    } catch (e) {
      pintarSync(true);
      setTimeout(enviarCola, 3000);      // sin internet: reintenta solo
    } finally {
      enviando = false;
    }
  }

  function avisar(msg) {
    $('aviso').textContent = msg;
    $('aviso').classList.remove('oculto');
    beep(220, .6); navigator.vibrate?.([400, 100, 400]);
    clearTimeout(avisar.t);
    avisar.t = setTimeout(() => $('aviso').classList.add('oculto'), 6000);
  }

  /* ============ Sincronizar con otros dispositivos ============ */
  async function sincronizar() {
    if (!pin || cola.length || enviando) return;
    const marca = cambiosLocales;
    try {
      const r = await api({ action: 'all' });
      if (r.error === 'PIN incorrecto') return cerrarSesion('PIN incorrecto');
      if (!r.ok) throw new Error(r.error);
      if (marca !== cambiosLocales || cola.length) return;   // hubo escaneos mientras tanto
      estados = new Map(r.codigos);
      guardar();
      pintarBarra();
      pintarSync();
    } catch (_) { pintarSync(true); }
  }

  /* ============ Cámara ============ */
  async function iniciarCamara() {
    $('btnCamara').classList.add('oculto');
    try {
      if (!scanner) {
        scanner = new Html5Qrcode('lector', {
          verbose: false,
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],      // solo QR = más rápido
          experimentalFeatures: { useBarCodeDetectorIfSupported: true } // lector nativo del teléfono
        });
      }
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 25, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.8); return { width: s, height: s }; },
          disableFlip: true },
        alEscanear,
        () => {}
      );
    } catch (e) {
      $('btnCamara').classList.remove('oculto');
    }
  }

  /* ============ Modo ingreso / salida ============ */
  function setModo(m) {
    modo = m;
    localStorage.setItem('grad_modo', m);
    $('btnIn').classList.toggle('activo', m === 'in');
    $('btnOut').classList.toggle('activo', m === 'out');
    ultimo = { code: '', t: 0 };
  }
  $('btnIn').addEventListener('click', () => setModo('in'));
  $('btnOut').addEventListener('click', () => setModo('out'));
  setModo(modo);

  /* ============ Login ============ */
  function cerrarSesion(msg) {
    pin = '';
    localStorage.removeItem('grad_pin');
    $('loginError').textContent = msg || '';
    $('login').classList.remove('oculto');
  }

  $('formLogin').addEventListener('submit', async e => {
    e.preventDefault();
    pin = $('inputPin').value.trim();
    $('loginError').textContent = 'Cargando invitados…';
    try {
      const r = await api({ action: 'all' });
      if (!r.ok) throw new Error(r.error);
      localStorage.setItem('grad_pin', pin);
      estados = new Map(r.codigos);
      guardar();
      pintarBarra();
      $('login').classList.add('oculto');
      $('loginError').textContent = '';
      iniciarCamara();
    } catch (err) {
      $('loginError').textContent = err.message || 'Error de conexión';
    }
  });

  // Cerrar sesión: mantener presionada la barra 2 segundos
  let tPress;
  $('total').parentElement.addEventListener('pointerdown', () => {
    tPress = setTimeout(() => { if (confirm('¿Cerrar sesión?')) cerrarSesion(); }, 2000);
  });
  ['pointerup', 'pointerleave'].forEach(ev => $('total').parentElement.addEventListener(ev, () => clearTimeout(tPress)));

  $('btnCamara').addEventListener('click', iniciarCamara);

  // Pantalla siempre encendida
  const wake = async () => { try { await navigator.wakeLock?.request('screen'); } catch (_) {} };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); sincronizar(); } });
  wake();

  /* ============ Inicio ============ */
  pintarBarra();
  if (!pin) {
    $('login').classList.remove('oculto');
  } else {
    iniciarCamara();
    enviarCola();
    sincronizar();
  }
  setInterval(sincronizar, (CFG.REFRESCO_SEG || 10) * 1000);
  setInterval(enviarCola, 5000);
})();
