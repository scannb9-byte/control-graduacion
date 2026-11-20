(() => {
  const CFG = window.APP_CONFIG;
  const $ = id => document.getElementById(id);
  const DEVICE = (navigator.userAgent.match(/\(([^;)]+)/) || [, 'web'])[1];

  let pin = localStorage.getItem('grad_pin') || '';
  let scanner = null;
  let camaras = [];
  let camIdx = 0;
  let ocupado = false;
  let ultimo = { code: '', t: 0 };

  $('evento').textContent = CFG.EVENTO || '';

  /* ================= API ================= */
  async function api(params) {
    const url = CFG.API_URL + '?' + new URLSearchParams({ ...params, pin }).toString();
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  function setConexion(ok) {
    $('conexion').className = 'punto ' + (ok ? 'ok' : 'err');
  }

  function pintarStats(s) {
    if (!s) return;
    $('presentes').textContent = s.presentes;
    $('total').textContent = s.total;
    $('salieron').textContent = s.salieron;
    $('pendientes').textContent = s.pendientes;
    $('barraProgreso').style.width = (s.total ? (s.presentes / s.total) * 100 : 0) + '%';
  }

  async function refrescarStats() {
    try {
      const r = await api({ action: 'stats' });
      if (!r.ok) {
        if (r.error === 'PIN incorrecto') return cerrarSesion('PIN incorrecto');
        throw new Error(r.error);
      }
      pintarStats(r.stats);
      setConexion(true);
    } catch (e) {
      setConexion(false);
    }
  }

  /* ================= ESCANEO ================= */
  async function procesar(codigoRaw) {
    const code = String(codigoRaw || '').trim().toUpperCase();
    if (!code || ocupado) return;
    // evita lecturas repetidas del mismo QR mientras sigue frente a la cámara
    if (code === ultimo.code && Date.now() - ultimo.t < 4000) return;
    ultimo = { code, t: Date.now() };
    ocupado = true;
    pausar();

    let r;
    try {
      r = await api({ action: 'scan', code, device: DEVICE });
      setConexion(true);
    } catch (e) {
      setConexion(false);
      r = { ok: false, resultado: 'ERROR', codigo: code, mensaje: 'Sin conexión. Intenta de nuevo.' };
    }
    if (r.error === 'PIN incorrecto') { ocupado = false; return cerrarSesion('PIN incorrecto'); }

    pintarStats(r.stats);
    mostrarResultado(r);
    agregarHistorial(r);

    setTimeout(() => {
      $('overlay').className = 'overlay oculto';
      ocupado = false;
      reanudar();
    }, r.resultado === 'INVALIDO' || r.resultado === 'ERROR' ? 2500 : 1700);
  }

  const TEXTOS = {
    ENTRADA:   { icono: '✅', titulo: 'PRESENTE' },
    REINGRESO: { icono: '🔁', titulo: 'REINGRESO' },
    SALIDA:    { icono: '🚪', titulo: 'SALIÓ' },
    REPETIDO:  { icono: '⚠️', titulo: 'YA ESCANEADO' },
    INVALIDO:  { icono: '⛔', titulo: 'NO VÁLIDO' },
    ERROR:     { icono: '📡', titulo: 'ERROR' }
  };

  function mostrarResultado(r) {
    const tipo = r.resultado || 'ERROR';
    const t = TEXTOS[tipo] || TEXTOS.ERROR;
    $('ovIcono').textContent = t.icono;
    $('ovTitulo').textContent = t.titulo;
    $('ovNombre').textContent = r.nombre || r.mensaje || '';
    $('ovCodigo').textContent = r.codigo || '';
    $('overlay').className = 'overlay ' + tipo;
    feedback(tipo);
  }

  function agregarHistorial(r) {
    const li = document.createElement('li');
    const tipo = r.resultado || 'ERROR';
    li.className = tipo;
    const hora = new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const izq = document.createElement('span');
    izq.textContent = (TEXTOS[tipo] || TEXTOS.ERROR).titulo + ' · ' + (r.nombre || r.codigo || '');
    const der = document.createElement('small');
    der.textContent = hora;
    li.append(izq, der);
    const ul = $('historial');
    ul.prepend(li);
    while (ul.children.length > 15) ul.lastChild.remove();
  }

  /* Sonido + vibración */
  let audioCtx;
  function beep(freq, dur) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(audioCtx.destination);
      g.gain.value = 0.2; o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (_) {}
  }
  function feedback(tipo) {
    if (tipo === 'ENTRADA' || tipo === 'REINGRESO') { beep(880, .15); navigator.vibrate?.(100); }
    else if (tipo === 'SALIDA') { beep(600, .15); setTimeout(() => beep(600, .15), 180); navigator.vibrate?.([80, 60, 80]); }
    else { beep(200, .5); navigator.vibrate?.([300, 100, 300]); }
  }

  /* ================= CÁMARA ================= */
  async function iniciarCamara() {
    $('btnCamara').classList.add('oculto');
    try {
      scanner = scanner || new Html5Qrcode('lector', { verbose: false });
      if (!camaras.length) {
        camaras = await Html5Qrcode.getCameras();
        const trasera = camaras.findIndex(c => /back|rear|trasera|environment/i.test(c.label));
        camIdx = trasera >= 0 ? trasera : camaras.length - 1;
      }
      const fuente = camaras[camIdx] ? camaras[camIdx].id : { facingMode: 'environment' };
      await scanner.start(
        fuente,
        { fps: 10, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
        texto => procesar(texto),
        () => {}
      );
    } catch (e) {
      $('btnCamara').classList.remove('oculto');
      alert('No se pudo abrir la cámara. Revisa los permisos del navegador.\n' + e);
    }
  }

  function pausar() { try { scanner?.pause(true); } catch (_) {} }
  function reanudar() { try { scanner?.resume(); } catch (_) {} }

  async function cambiarCamara() {
    if (!scanner || camaras.length < 2) return;
    await scanner.stop();
    camIdx = (camIdx + 1) % camaras.length;
    iniciarCamara();
  }

  /* ================= LOGIN ================= */
  function cerrarSesion(msg) {
    pin = '';
    localStorage.removeItem('grad_pin');
    $('loginError').textContent = msg || '';
    $('login').classList.remove('oculto');
  }

  $('formLogin').addEventListener('submit', async e => {
    e.preventDefault();
    pin = $('inputPin').value.trim();
    $('loginError').textContent = 'Verificando…';
    try {
      const r = await api({ action: 'stats' });
      if (!r.ok) throw new Error(r.error);
      localStorage.setItem('grad_pin', pin);
      $('login').classList.add('oculto');
      $('loginError').textContent = '';
      pintarStats(r.stats);
      setConexion(true);
      iniciarCamara();
    } catch (err) {
      $('loginError').textContent = err.message || 'Error de conexión';
    }
  });

  /* ================= EVENTOS ================= */
  $('btnCamara').addEventListener('click', iniciarCamara);
  $('btnCambiarCam').addEventListener('click', cambiarCamara);
  $('btnSalir').addEventListener('click', () => cerrarSesion());
  $('formManual').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('inputCodigo').value;
    $('inputCodigo').value = '';
    ultimo = { code: '', t: 0 };   // permitir ingreso manual aunque se repita
    procesar(v);
  });

  // Mantener pantalla encendida (si el navegador lo permite)
  async function wakeLock() { try { await navigator.wakeLock?.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wakeLock(); refrescarStats(); } });
  wakeLock();

  /* ================= INICIO ================= */
  if (!pin) {
    $('login').classList.remove('oculto');
  } else {
    refrescarStats();
    // iniciar cámara requiere gesto del usuario en algunos navegadores (iOS): queda el botón visible
  }
  setInterval(() => { if (pin && !ocupado) refrescarStats(); }, (CFG.REFRESCO_SEG || 15) * 1000);
})();
