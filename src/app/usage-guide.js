// Guia de uso dentro de la app: ventana con tres pestanas (Empezar, Novato,
// DJ). Modulo aparte, sin tocar el estado de la consola; se abre desde
// ? Ayuda -> Guia de uso y desde la barra de inicio guiado.
// El texto sigue a docs/GUIA.md: si cambia uno, cambiar el otro.

const TABS = [
  { id: 'start', label: 'Empezar' },
  { id: 'easy', label: '🟢 Nunca he mezclado' },
  { id: 'dj', label: '🔵 Ya sé mezclar' },
];

const CONTENT = {
  start: `
    <p class="ug-lead"><strong>Cualquier persona puede ser DJ.</strong> Tus manos son la controladora: sin equipo, sin instalar nada y sin saber de música.</p>
    <h3>Antes de empezar</h3>
    <ol>
      <li>Usa <strong>Chrome o Edge</strong>.</li>
      <li>Pulsa <strong>? Ayuda → Inicio guiado</strong> y sigue los pasos:
        <ol>
          <li><strong>Activar audio</strong>.</li>
          <li><strong>Cargar demos</strong>, o <strong>Importar música</strong> / <strong>Elegir carpeta…</strong> para usar tus canciones.</li>
          <li><strong>Activar cámara</strong>. Ponte a 1–1,5 m, con las manos a la vista y luz de frente.</li>
        </ol>
      </li>
      <li>¿Sin cámara? Todo funciona con <strong>mouse, teclado o pantalla táctil</strong>.</li>
      <li>¿Quieres verla en acción primero? <strong>? Ayuda → Demo guiada</strong>.</li>
    </ol>
    <p class="ug-note">Si el servidor de stems (Meta Demucs) está encendido, cada canción que cargues se separa sola en <strong>VOZ, BATERÍA, BAJO y RESTO</strong>. Verás «STEMS 45 %» y luego «STEMS ✓» en el deck.</p>
    <h3>Consejos para los gestos</h3>
    <ul>
      <li><strong>Luz de frente</strong>, no a contraluz.</li>
      <li><strong>Gestos claros y un momento sostenidos</strong>: la app espera unos milisegundos para no confundirse.</li>
      <li><strong>Dentro del cuadro</strong>, a la altura del pecho.</li>
      <li>Si algo raro pasa, <kbd>G</kbd> pausa los gestos al instante sin parar la música.</li>
    </ul>`,
  easy: `
    <p class="ug-lead">Pulsa <strong>FÁCIL</strong> arriba: la pantalla se simplifica y desaparece la jerga.</p>
    <h3>Tu primera mezcla en 4 pasos</h3>
    <ol>
      <li>Elige una canción, pulsa <strong>LOAD A</strong> y luego <strong>PLAY</strong> en el deck A. Ya suena.</li>
      <li>Elige otra canción y pulsa <strong>LOAD B</strong>, sin darle PLAY.</li>
      <li>Pulsa <strong>Igualar y mezclar</strong>: la app iguala el tempo de las dos y pasa de A a B en 8 segundos, suave.</li>
      <li>¿Quieres hacerlo tú? Mueve el <strong>crossfader</strong> (la barra del centro) de A hacia B. Con la cámara: haz una <strong>pinza</strong> (pulgar e índice juntos) sobre el crossfader y arrastra.</li>
    </ol>
    <p><strong>¿Que mezcle sola?</strong> Activa <strong>AUTO DJ</strong> en el mezclador: va pasando de A a B y de B a A.</p>
    <h3>Diviértete con las manos</h3>
    <ol>
      <li>Pulsa <strong>MANOS · FX</strong> en el deck que está sonando. La consola se aparta.</li>
      <li>Elige un efecto con una <strong>pinza</strong> sobre su tarjeta.</li>
      <li>Prueba:
        <ul>
          <li>✋ <strong>FRENO</strong>: palma quieta, como diciendo «alto». La canción frena como un vinilo; quita la mano y vuelve.</li>
          <li>☝️ <strong>ROLL</strong>: levanta 1, 2 o 3 dedos. Repite el golpe; más dedos, más rápido. Cierra la mano y sigue normal.</li>
          <li>🙌 <strong>SUBIDA</strong>: abre las dos manos y súbelas, la tensión crece. 🙏 Júntalas y suelta el <strong>DROP</strong>.</li>
        </ul>
      </li>
      <li>Para salir, <strong>saca las dos manos</strong> de la cámara.</li>
    </ol>
    <p class="ug-note">No te preocupes por el ritmo: la app espera el golpe o el compás, así que siempre suena a tiempo.</p>
    <p><strong>Graba tu mezcla:</strong> <strong>● Grabar mezcla</strong> y luego <strong>■ Detener y descargar</strong>.</p>`,
  dj: `
    <p class="ug-lead">Pulsa <strong>DJ</strong> arriba para la consola completa.</p>
    <h3>Decks</h3>
    <ul>
      <li><strong>PLAY / CUE / SYNC</strong>: SYNC iguala el BPM y alinea la fase con la rejilla de golpes.</li>
      <li><strong>Tempo ±8 %</strong> con retén en 0. <strong>Onda ampliada</strong> de 4, 8 o 16 s para ver los bombos sobre la rejilla.</li>
      <li><strong>Jog</strong>: el centro busca <strong>con audio hacia adelante y hacia atrás</strong>; el borde empuja el tempo y vuelve solo.</li>
      <li><strong>Pads fijos</strong>: 2 hot cues, 2 saltos de 4 tiempos, 2 efectos y 2 sonidos. <strong>LOOP 4</strong>.</li>
    </ul>
    <h3>Mezclador</h3>
    <ul>
      <li><strong>EQ</strong> HIGH/MID/LOW de −26 a +6 dB y <strong>TRIM</strong>.</li>
      <li><strong>FILTRO</strong> de un mando: un lado quita agudos, el otro quita graves. <strong>ECO</strong> al BPM por canal.</li>
      <li><strong>Faders, crossfader y MASTER</strong> con limitador. Avisos de <strong>«dos graves»</strong> y de <strong>saturación</strong>.</li>
    </ul>
    <h3>Lineup y preescucha</h3>
    <ul>
      <li>En la biblioteca, marca <strong>+A</strong> o <strong>+B</strong> en cada tema para armar la cola de cada deck. Cuando un deck queda libre se carga solo el siguiente; <strong>⏭ SIGUE</strong> lo carga ya.</li>
      <li><strong>PISTAS</strong> abre el selector a pantalla completa para elegir con los dedos mientras suena el otro deck.</li>
      <li><strong>⚙ Ajustes → Elegir auriculares…</strong>: la mezcla sigue por la salida principal y tú oyes el otro deck en tus audífonos. No entra en la grabación.</li>
    </ul>
    <h3>Modo manos avanzado</h3>
    <div class="ug-tablewrap"><table>
      <thead><tr><th>Efecto</th><th>Gesto</th><th>Control fino</th></tr></thead>
      <tbody>
        <tr><td><strong>FILTRO</strong></td><td>Dos pinzas, estirar como una cuerda</td><td>Elige la perilla: <strong>FILTRO, HIGH, MID, LOW, TRIM o ECO</strong>. Separar sube, juntar baja</td></tr>
        <tr><td><strong>ECO</strong></td><td>✊ Puño ~0,3 s para agarrar, subir = más eco, 👍 para lanzar</td><td>El otro deck entra <strong>en el mismo golpe, con el tempo igualado</strong>. Un segundo puño controla la cola. A → B → A sin salir</td></tr>
        <tr><td><strong>ROLL</strong></td><td>1, 2 o 3 dedos = 1, ½ o ¼ de tiempo</td><td>Con stems, elige la parte (p. ej. solo <strong>BATERÍA</strong>). La pista sigue por debajo (<em>slip</em>)</td></tr>
        <tr><td><strong>FRENO</strong></td><td>✋ Palma quieta ~0,4 s</td><td>Con stems, frena una parte o <strong>MÚSICA</strong> (todo menos la voz). Vuelve en el golpe y en su sitio</td></tr>
        <tr><td><strong>SUBIDA → DROP</strong></td><td>🙌 Dos manos arriba, 🙏 juntar</td><td>Roll de batería cada vez más corto, el bajo sale y el pasa-altos se abre. El DROP entra en el siguiente compás</td></tr>
        <tr><td><strong>STEMS</strong></td><td>🤏 Pellizca VOZ, BATERÍA, BAJO o RESTO</td><td>Apaga o enciende la parte en el golpe; dos pinzas = su volumen</td></tr>
      </tbody>
    </table></div>
    <h3>Atajos de teclado</h3>
    <p><kbd>Q</kbd>/<kbd>A</kbd> deck A · <kbd>P</kbd>/<kbd>L</kbd> deck B · <kbd>←</kbd><kbd>→</kbd> crossfader · <kbd>G</kbd> pausa los gestos · <kbd>F</kbd> pantalla completa · <kbd>Esc</kbd> salir del Modo manos</p>
    <p class="ug-note"><strong>Cámara:</strong> en <strong>📷 Cámara</strong> eliges ESPEJO y encuadre COMPLETO o RECORTE. En <strong>⚙ Ajustes</strong> calibras cuánto espera antes de salir del Modo manos al sacar las manos.</p>`,
};

function build() {
  const dlg = document.createElement('dialog');
  dlg.id = 'usageGuide';
  dlg.className = 'ug';
  dlg.setAttribute('aria-labelledby', 'ugTitle');
  dlg.innerHTML = `
    <div class="ug-head">
      <h2 id="ugTitle">📖 Guía de uso</h2>
      <div class="ug-tabs" role="tablist">${TABS.map(t => `<button type="button" class="btn ug-tab" role="tab" data-tab="${t.id}" aria-selected="false">${t.label}</button>`).join('')}</div>
      <button type="button" class="btn ug-close" aria-label="Cerrar la guía">✕</button>
    </div>
    <div class="ug-body">${TABS.map(t => `<section class="ug-panel" role="tabpanel" data-panel="${t.id}" hidden>${CONTENT[t.id]}</section>`).join('')}</div>`;
  document.body.appendChild(dlg);
  const show = id => {
    dlg.querySelectorAll('.ug-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
    dlg.querySelectorAll('.ug-panel').forEach(p => { p.hidden = p.dataset.panel !== id; });
    dlg.querySelector('.ug-body').scrollTop = 0;
  };
  dlg.addEventListener('click', e => {
    const tab = e.target.closest('.ug-tab');
    if (tab) { show(tab.dataset.tab); return; }
    if (e.target.closest('.ug-close') || e.target === dlg) dlg.close();
  });
  // Las teclas de la consola (Q, A, P, L, G…) no actuan con la guia abierta.
  dlg.addEventListener('keydown', e => { if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation(); });
  return { dlg, show };
}

let ui = null;
export function openUsageGuide(tab) {
  if (!ui) ui = build();
  // Por defecto abre la pestana que corresponde a la vista actual.
  const view = document.body.dataset.view;
  ui.show(tab || (view === 'easy' ? 'easy' : 'start'));
  if (!ui.dlg.open) ui.dlg.showModal();
  const menu = document.getElementById('menuHelp'); if (menu) menu.open = false;
}

document.querySelectorAll('[data-open-guide]').forEach(b => b.addEventListener('click', () => openUsageGuide(b.dataset.openGuide || undefined)));
