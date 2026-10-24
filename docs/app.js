/* Ma Maison — web app (iPhone, PC, tablette).
 * Même broker, mêmes topics que l'appli Android : on voit la même maison des deux côtés. */
'use strict';
(() => {
  const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  // ------------------------------------------------------------------
  // Maisons (code vide = la maison d'origine). Gardées dans ce navigateur.
  // ------------------------------------------------------------------
  const racineDe = (code) => (code ? `mon_projet_unique/m/${code}/esp` : 'mon_projet_unique/esp');
  const codeValide = (c) => /^[a-z0-9-]{0,32}$/.test(c);
  function lireMaisons() {
    try {
      const l = JSON.parse(localStorage.getItem('maisons') || 'null');
      if (Array.isArray(l) && l.length) return l;
    } catch (e) { /* stockage indisponible */ }
    return [{ nom: 'Maison', code: '' }];
  }
  function ecrireMaisons(l) { try { localStorage.setItem('maisons', JSON.stringify(l)); } catch (e) { /* */ } }
  function maisonActuelle() {
    let code = '';
    try { code = localStorage.getItem('maison') || ''; } catch (e) { /* */ }
    const l = lireMaisons();
    return l.find((m) => m.code === code) || l[0];
  }
  function nouveauCode() {
    const c = 'abcdefghijkmnpqrstuvwxyz23456789';
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map((x) => c[x % c.length]).join('');
  }
  let RACINE = racineDe(maisonActuelle().code);
  // Première visite : il faut choisir sa maison (si le navigateur peut s'en souvenir)
  function accueilRequis() {
    try { return localStorage.getItem('maisons') === null; } catch (e) { return false; }
  }
  const BROCHES = [2, 4, 13, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33];
  const RESERVES = new Set(['admin', 'wifi', 'config', 'meta', 'version', 'ota', 'availability']);

  // Dessins (mêmes tracés que l'appli Android, repère 48 x 48)
  const PALE = 'M24,20 C17,15 18,5 24,5 C30,5 31,15 24,20 z';
  const DESSINS = {
    lampe: '<path d="M12,20 a12,12 0 1,0 24,0 a12,12 0 1,0 -24,0 z"/><path d="M18,30 h12 v5 h-12 z M19,37 h10 v3 h-10 z"/>',
    prise: '<path d="M17,6 h4 v10 h-4 z M27,6 h4 v10 h-4 z"/><path d="M12,16 h24 v10 a8,8 0 0,1 -8,8 h-8 a8,8 0 0,1 -8,-8 z"/><path d="M22,34 h4 v9 h-4 z"/>',
    ventilateur: `<path d="${PALE}"/><path transform="rotate(120 24 24)" d="${PALE}"/><path transform="rotate(240 24 24)" d="${PALE}"/><path d="M19,24 a5,5 0 1,0 10,0 a5,5 0 1,0 -10,0 z"/>`,
    eau: '<path d="M24,5 C24,5 12,19 12,29 a12,12 0 0,0 24,0 C36,19 24,5 24,5 z"/>',
    maison: '<path d="M6,24 L24,8 L42,24 h-6 v16 h-8 v-10 h-8 v10 h-8 v-16 z"/>',
    flamme: '<path d="M24,4 C26,12 35,16 35,28 a11,11 0 0,1 -22,0 C13,21 17,17 19,11 C21,15 22,18 24,19 C25,14 25,9 24,4 z"/>',
    thermo: '<path d="M19,9 a5,5 0 0,1 10,0 v17 a9,9 0 1,1 -10,0 z"/>'
  };
  const LISTE_DESSINS = [['lampe', 'Lampe'], ['prise', 'Prise'], ['ventilateur', 'Ventilateur'], ['eau', 'Eau'], ['flamme', 'Chauffage'], ['maison', 'Autre']];
  const dessin = (cle) => `<svg viewBox="0 0 48 48" aria-hidden="true">${DESSINS[cle] || DESSINS.lampe}</svg>`;

  // ------------------------------------------------------------------
  // Utilitaires
  // ------------------------------------------------------------------
  const $ = (sel, racine = document) => racine.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const maintenant = () => Date.now();
  const degres = (d) => (d % 1 === 0 ? `${d}°` : `${d.toFixed(1).replace('.', ',')}°`);

  let minuteurToast = null;
  function toast(texte) {
    const t = $('#toast');
    t.textContent = texte;
    t.classList.add('visible');
    clearTimeout(minuteurToast);
    minuteurToast = setTimeout(() => t.classList.remove('visible'), 3200);
  }

  // ------------------------------------------------------------------
  // Modèle
  // ------------------------------------------------------------------
  const etat = { connecte: false, pret: false, appareils: new Map() };

  function appareil(id) {
    if (!etat.appareils.has(id)) {
      etat.appareils.set(id, {
        id, enLigne: null, url: null, version: null, config: null,
        meta: { nom: null, icones: {} }, reseaux: [],
        etats: {}, mesures: {}, consignes: {}, chauffe: {},
        dernierOnline: 0, reponse: null, heureReponse: 0
      });
    }
    return etat.appareils.get(id);
  }
  const nom = (a) => a.meta.nom || `Appareil ${a.id.slice(-4).toUpperCase()}`;
  const sorties = (a) => (a.config ? a.config.sorties || [] : [{ id: 'led', nom: 'Lumière', pin: 2 }]);
  const capteurs = (a) => (a.config ? a.config.capteurs || [] : []);
  const estThermostat = (s) => s.type === 'thermostat';
  function icone(a, sid) {
    if (a.meta.icones && a.meta.icones[sid]) return a.meta.icones[sid];
    const s = sorties(a).find((x) => x.id === sid);
    return s && s.type === 'chauffage' ? 'flamme' : 'lampe';
  }
  const appareilsTries = () => [...etat.appareils.values()]
    .filter((a) => a.enLigne !== null || a.config)
    .sort((x, y) => nom(x).localeCompare(nom(y), 'fr'));
  const reponse = (a, cmd, depuis) => (a.reponse && a.heureReponse >= depuis && a.reponse.cmd === cmd ? a.reponse : null);

  // ------------------------------------------------------------------
  // MQTT
  // ------------------------------------------------------------------
  const client = mqtt.connect(BROKER, {
    clientId: 'web_' + Math.random().toString(16).slice(2, 10),
    clean: true, keepalive: 30, reconnectPeriod: 3000, connectTimeout: 10000
  });

  const filtres = (r) => [
    `${r}/+/availability`, `${r}/+/wifi/ip`, `${r}/+/wifi/reseaux`, `${r}/+/config`, `${r}/+/meta`,
    `${r}/+/version`, `${r}/+/admin/reponse`, `${r}/+/+/status`, `${r}/+/+/valeur`,
    `${r}/+/+/consigne`, `${r}/+/+/chauffe`
  ];

  client.on('connect', () => {
    etat.connecte = true;
    client.subscribe(filtres(RACINE), { qos: 1 });
    setTimeout(() => { etat.pret = true; rafraichir(); }, 2500);
    rafraichir();
  });
  client.on('close', () => { etat.connecte = false; rafraichir(); });
  client.on('offline', () => { etat.connecte = false; rafraichir(); });
  client.on('message', (topic, payload, paquet) => {
    traiter(topic, new TextDecoder().decode(payload).trim(), paquet.retain);
  });

  function publier(topic, message, retenu = false) {
    if (client.connected) client.publish(topic, message, { qos: 1, retain: retenu });
  }
  const t = (id, suffixe) => `${RACINE}/${id}/${suffixe}`;

  const commander = (id, sid, allumer) => publier(t(id, `${sid}/cmd`), allumer ? 'ON' : 'OFF');
  const envoyerConsigne = (id, sid, v) => publier(t(id, `${sid}/cmd`), `CONSIGNE ${v.toFixed(1)}`);
  const admin = (id, obj) => publier(t(id, 'admin'), JSON.stringify(obj));
  function enregistrerMeta(id, meta) {
    appareil(id).meta = meta;
    publier(t(id, 'meta'), JSON.stringify({ ...(meta.nom ? { nom: meta.nom } : {}), icones: meta.icones || {} }), true);
    rafraichir();
  }
  function oublier(id) {
    const a = etat.appareils.get(id);
    etat.appareils.delete(id);
    const sujets = ['wifi/ip', 'wifi/reseaux', 'config', 'meta', 'version'];
    if (a) {
      sorties(a).forEach((s) => {
        sujets.push(`${s.id}/status`);
        if (estThermostat(s)) sujets.push(`${s.id}/consigne`, `${s.id}/chauffe`);
      });
      capteurs(a).forEach((c) => sujets.push(`${c.id}/valeur`));
    }
    sujets.push('availability');
    sujets.forEach((s) => publier(t(id, s), '', true));
    rafraichir();
  }

  function choisirMaison(code) {
    try { localStorage.setItem('maison', code); } catch (e) { /* */ }
    const nouvelle = racineDe(code);
    if (nouvelle === RACINE) return;
    if (client.connected) {
      client.unsubscribe(filtres(RACINE));
      client.subscribe(filtres(nouvelle), { qos: 1 });
    }
    RACINE = nouvelle;
    etat.appareils.clear();
    afficher();
  }

  // Déplace un appareil vers une autre maison (il efface lui-même ses traces ici)
  function deplacer(id, code) {
    const a = etat.appareils.get(id);
    if (!a) return;
    admin(id, { cmd: 'maison', code });
    publier(`${racineDe(code)}/${id}/meta`, JSON.stringify({ ...(a.meta.nom ? { nom: a.meta.nom } : {}), icones: a.meta.icones || {} }), true);
    publier(t(id, 'meta'), '', true);
    etat.appareils.delete(id);
    rafraichir();
  }

  function traiter(topic, texte, retenu) {
    const prefixe = RACINE + '/';
    if (!topic.startsWith(prefixe)) return;
    const reste = topic.slice(prefixe.length);
    const i = reste.indexOf('/');
    if (i <= 0) return;
    const id = reste.slice(0, i);
    const sujet = reste.slice(i + 1);

    if (texte === '') {
      if (sujet === 'availability') { etat.appareils.delete(id); rafraichir(); }
      return;
    }
    const a = appareil(id);
    const fin = (suffixe) => sujet.endsWith('/' + suffixe) ? sujet.slice(0, -(suffixe.length + 1)) : null;
    let s;
    if (sujet === 'availability') {
      const online = texte === 'online';
      if (online && (!retenu || a.enLigne !== true)) a.dernierOnline = maintenant();
      a.enLigne = online;
    } else if (sujet === 'wifi/ip') a.url = texte;
    else if (sujet === 'wifi/reseaux') { try { a.reseaux = JSON.parse(texte); } catch (e) { a.reseaux = []; } }
    else if (sujet === 'config') { try { a.config = JSON.parse(texte); } catch (e) { /* ignoré */ } }
    else if (sujet === 'meta') { try { const m = JSON.parse(texte); a.meta = { nom: m.nom || null, icones: m.icones || {} }; } catch (e) { /* ignoré */ } }
    else if (sujet === 'version') a.version = texte;
    else if (sujet === 'admin/reponse') { try { a.reponse = JSON.parse(texte); a.heureReponse = maintenant(); } catch (e) { /* ignoré */ } }
    else if ((s = fin('status'))) a.etats[s] = texte.toUpperCase() === 'ON';
    else if ((s = fin('chauffe'))) a.chauffe[s] = texte.toUpperCase() === 'ON';
    else if ((s = fin('consigne'))) { const v = parseFloat(texte); if (!isNaN(v)) a.consignes[s] = v; }
    else if ((s = fin('valeur'))) { try { const o = JSON.parse(texte); a.mesures[s] = { t: o.t ?? null, h: o.h ?? null }; } catch (e) { /* ignoré */ } }
    rafraichir();
  }

  // ------------------------------------------------------------------
  // Navigation (le « retour » du téléphone fonctionne)
  // ------------------------------------------------------------------
  function vueCourante() {
    const h = location.hash.replace('#', '');
    const [vue, param] = h.split('/');
    return { vue: vue || 'accueil', param: param ? decodeURIComponent(param) : null };
  }
  const aller = (vue, param) => { location.hash = param ? `${vue}/${encodeURIComponent(param)}` : vue; };
  const retour = () => (history.length > 1 ? history.back() : aller('accueil'));
  window.addEventListener('hashchange', () => { edition = null; afficher(); window.scrollTo(0, 0); });

  const barre = (titre) => `<div class="barre"><button class="retour" data-action="retour" aria-label="Retour">‹</button><h1>${esc(titre)}</h1></div>`;

  // Affichage complet (changement d'écran) ...
  function afficher() {
    const { vue, param } = vueCourante();
    const app = $('#app');
    if (accueilRequis()) { app.innerHTML = vueBienvenue(); return; }
    const vues = { accueil: vueAccueil, reglages: vueReglages, ajouter: vueAjouter, wifi: vueWifi, avance: vueAvance, branche: () => vueBranche(param), carte: vueCarte };
    app.innerHTML = (vues[vue] || vueAccueil)();
  }

  // ... et mise à jour des seules parties vivantes (sans effacer ce qu'on est en train de taper)
  let rafraichissementPrevu = false;
  function rafraichir() {
    if (rafraichissementPrevu) return;
    rafraichissementPrevu = true;
    requestAnimationFrame(() => {
      rafraichissementPrevu = false;
      const { vue } = vueCourante();
      if (accueilRequis()) return;
      if (vue === 'accueil' || !['reglages', 'ajouter', 'wifi', 'avance', 'branche', 'carte'].includes(vue)) afficher();
      else if (vue === 'ajouter') remplir('#nouveaux', htmlNouveaux());
      else if (vue === 'wifi') remplir('#resultats', htmlResultatsWifi());
      else if (vue === 'avance') { remplir('#liste-avance', htmlListeAvance()); remplir('#ota', htmlOta()); }
    });
  }
  function remplir(sel, html) { const el = $(sel); if (el) el.innerHTML = html; }

  // ------------------------------------------------------------------
  // Écran principal
  // ------------------------------------------------------------------
  const attente = new Map();          // clé -> { v, t } : commande pas encore confirmée
  const attenteConsigne = new Map();  // clé -> { v, t }
  const envois = new Map();           // clé -> minuteur d'envoi de la consigne

  function vueAccueil() {
    const h = new Date().getHours();
    const salut = h >= 5 && h < 18 ? 'Bonjour' : 'Bonsoir';
    let date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    date = date.charAt(0).toUpperCase() + date.slice(1);

    let html = `<header><h1 class="salut">${salut}</h1><p class="date">${esc(date)}</p>
      ${lireMaisons().length > 1 ? `<button class="puce-maison" data-action="choisir-maison">${esc(maisonActuelle().nom)} ▾</button>` : ''}</header>`;
    if (!etat.connecte) html += `<p class="bandeau">Pas de connexion Internet pour le moment.<br>Ça revient tout seul, patiente un peu.</p>`;

    const tuiles = [];
    appareilsTries().forEach((a) => {
      const utilises = new Set(sorties(a).map((s) => s.capteur).filter(Boolean));
      sorties(a).forEach((s) => tuiles.push(estThermostat(s) ? tuileChauffage(a, s) : tuileSortie(a, s)));
      capteurs(a).filter((c) => !utilises.has(c.id)).forEach((c) => tuiles.push(tuileCapteur(a, c)));
    });

    if (tuiles.length) html += `<div class="tuiles">${tuiles.join('')}</div>`;
    else if (etat.connecte && etat.pret) {
      html += `<p class="texte" style="text-align:center;margin-top:48px">Aucun appareil pour l'instant.</p>
               <button class="gros" data-action="aller" data-vue="ajouter">Ajouter un appareil</button>`;
    }
    html += `<button class="lien-bas" data-action="aller" data-vue="reglages">Réglages</button>`;
    return html;
  }

  function titreTuile(a, sousNom, seul) { return seul ? nom(a) : `${nom(a)} · ${sousNom}`; }

  function lireAttente(map, cle, reel, delai) {
    const att = map.get(cle);
    if (att && (reel === att.v || maintenant() - att.t > delai)) map.delete(cle);
    return map.has(cle) ? map.get(cle).v : reel;
  }

  function tuileSortie(a, s) {
    const cle = `${a.id}/${s.id}`;
    const allume = lireAttente(attente, cle, a.etats[s.id], 4000);
    const joignable = etat.connecte && a.enLigne === true;
    const texte = a.enLigne !== true ? 'Ne répond pas'
      : !etat.connecte ? "En attente d'Internet"
        : allume === true ? 'Allumé' : allume === false ? 'Éteint' : '…';
    const titre = titreTuile(a, s.nom, sorties(a).length === 1);
    return `<button class="tuile sortie ${joignable && allume === true ? 'on' : ''} ${joignable ? '' : 'absent'}"
        data-action="basculer" data-id="${esc(a.id)}" data-s="${esc(s.id)}" aria-pressed="${allume === true}"
        aria-label="${esc(titre)}, ${esc(texte)}">
      <span class="rond">${dessin(icone(a, s.id))}</span>
      <span class="textes"><span class="nom">${esc(titre)}</span>
      <span class="etat ${a.enLigne !== true ? 'alerte' : ''}">${texte}</span></span>
    </button>`;
  }

  function tuileChauffage(a, s) {
    const cle = `${a.id}/${s.id}`;
    const joignable = etat.connecte && a.enLigne === true;
    const actif = lireAttente(attente, cle, a.etats[s.id], 4000);
    const attC = attenteConsigne.get(cle);
    if (attC && !envois.has(cle) && (a.consignes[s.id] === attC.v || maintenant() - attC.t > 6000)) attenteConsigne.delete(cle);
    const consigne = attenteConsigne.has(cle) ? attenteConsigne.get(cle).v : (a.consignes[s.id] ?? 20);
    const chauffe = a.chauffe[s.id] === true;
    const m = s.capteur ? a.mesures[s.capteur] : null;
    const temp = m && m.t != null ? m.t : null;

    const texte = a.enLigne !== true ? 'Ne répond pas'
      : !etat.connecte ? "En attente d'Internet"
        : actif !== true ? 'Arrêté'
          : temp == null ? 'Thermomètre muet'
            : chauffe ? 'Chauffe en cours' : 'Température atteinte';
    const classe = !joignable || actif !== true ? '' : chauffe ? 'actif chauffe' : 'actif';
    const off = joignable ? '' : 'disabled';
    return `<div class="tuile chauffage ${classe} ${joignable ? '' : 'absent'}">
      <div class="ligne">
        <span class="rond">${dessin('flamme')}</span>
        <span class="textes"><span class="nom">${esc(titreTuile(a, s.nom, sorties(a).length === 1))}</span>
        <span class="etat ${a.enLigne !== true ? 'alerte' : ''}">${texte}</span></span>
        <span class="valeur">${temp == null ? '—' : degres(Math.round(temp * 10) / 10)}</span>
      </div>
      <div class="reglage">
        <button class="rond-btn" data-action="consigne" data-id="${esc(a.id)}" data-s="${esc(s.id)}" data-v="${consigne - 0.5}" aria-label="Moins chaud" ${off}>−</button>
        <div class="consigne"><small>Température voulue</small><strong>${degres(consigne)}</strong></div>
        <button class="rond-btn" data-action="consigne" data-id="${esc(a.id)}" data-s="${esc(s.id)}" data-v="${consigne + 0.5}" aria-label="Plus chaud" ${off}>+</button>
      </div>
      <button class="gros clair" data-action="basculer" data-id="${esc(a.id)}" data-s="${esc(s.id)}" ${off}>
        ${actif === true ? 'Arrêter le chauffage' : 'Mettre en route'}</button>
    </div>`;
  }

  function tuileCapteur(a, c) {
    const m = a.mesures[c.id];
    const seul = capteurs(a).length === 1 && sorties(a).length === 0;
    const sous = a.enLigne !== true ? 'Ne répond pas' : m && m.h != null ? `Humidité ${Math.round(m.h)} %` : '';
    return `<div class="tuile capteur ${a.enLigne === true ? '' : 'absent'}">
      <span class="rond">${dessin('thermo')}</span>
      <span class="textes"><span class="nom">${esc(titreTuile(a, c.nom, seul))}</span><span class="sous">${sous}</span></span>
      <span class="valeur">${m && m.t != null ? `${Math.round(m.t)}°` : '—'}</span>
    </div>`;
  }

  function basculer(id, sid) {
    const a = etat.appareils.get(id);
    if (!a) return;
    if (!(etat.connecte && a.enLigne === true)) {
      toast(a.enLigne !== true ? "Cet appareil ne répond pas. Vérifie qu'il est bien branché." : "Pas d'Internet pour le moment.");
      return;
    }
    const cle = `${id}/${sid}`;
    const courant = lireAttente(attente, cle, a.etats[sid], 4000);
    const nouveau = courant !== true;
    attente.set(cle, { v: nouveau, t: maintenant() });
    commander(id, sid, nouveau);
    rafraichir();
    setTimeout(rafraichir, 4300); // sans confirmation, la tuile revient à son vrai état
  }

  function changerConsigne(id, sid, valeur) {
    const v = Math.min(30, Math.max(5, Math.round(valeur * 2) / 2));
    const cle = `${id}/${sid}`;
    attenteConsigne.set(cle, { v, t: maintenant() });
    clearTimeout(envois.get(cle));
    envois.set(cle, setTimeout(() => {
      envois.delete(cle);
      envoyerConsigne(id, sid, v);
      attenteConsigne.set(cle, { v, t: maintenant() });
      setTimeout(rafraichir, 6500);
    }, 1200));
    rafraichir();
  }

  // ------------------------------------------------------------------
  // Réglages
  // ------------------------------------------------------------------
  function vueReglages() {
    return `${barre('Réglages')}
      <div class="pile">
        <button class="gros" data-action="aller" data-vue="ajouter">Ajouter un appareil</button>
        <button class="gros clair" data-action="aller" data-vue="wifi">Le Wi-Fi de la maison a changé</button>
      </div>
      <button class="discret" style="margin-top:auto" data-appui-long="avance">Options avancées</button>`;
  }

  function vueAjouter() {
    return `${barre('Ajouter un appareil')}
      <p class="bandeau" style="margin:0 0 20px;font-size:16px">Carte neuve, jamais installée ? Prépare-la d'abord depuis un ordinateur :
        Réglages → Options avancées → « Préparer une carte neuve ».</p>
      <ol class="etapes">
        <li>Branche l'appareil. Sa petite lumière bleue reste allumée.<br>
          <span class="aide">Sinon, appuie 5 secondes sur son bouton « BOOT » et lâche quand ça clignote vite.</span></li>
        <li>Ouvre <b>Réglages → Wi-Fi</b> sur le téléphone et choisis le réseau <b>ESP32-Config-…</b></li>
        <li>Une page s'ouvre toute seule : choisis le Wi-Fi de la maison, écris son mot de passe,
          ${maisonActuelle().code ? `dans « Code maison » écris <code>${esc(maisonActuelle().code)}</code>,` : 'laisse « Code maison » vide,'}
          puis touche <b>Enregistrer</b>.<br>
          <span class="aide">Si rien ne s'ouvre, va sur <code>http://192.168.4.1</code> dans Safari.</span></li>
        <li>Reviens ici : l'appareil apparaît ci-dessous en 30 secondes environ.</li>
      </ol>
      <div id="nouveaux">${htmlNouveaux()}</div>`;
  }

  function htmlNouveaux() {
    const sansNom = appareilsTries().filter((a) => !a.meta.nom && a.enLigne === true);
    if (!sansNom.length) return '';
    return `<p class="texte" style="margin-top:8px"><b>Nouveaux appareils</b></p>` + sansNom.map((a) => `
      <div class="carte"><span class="textes"><b>${esc(nom(a))}</b><small>${esc(a.id)}</small></span>
        <button class="petit-btn" data-action="renommer" data-id="${esc(a.id)}">Lui donner un nom</button></div>`).join('');
  }

  // --- Wi-Fi de la maison ---
  const wifi = { heure: 0, etats: {}, messages: {} };

  function vueWifi() {
    const reseaux = [...new Set(appareilsTries().flatMap((a) => a.reseaux || []))].sort();
    return `${barre('Wi-Fi de la maison')}
      <p class="texte">Nouvelle box ou nouveau mot de passe ? Écris-les ici. Les appareils les gardent en mémoire, en plus de l'ancien.</p>
      <label for="ssid">Nom du Wi-Fi</label>
      <input id="ssid" list="liste-reseaux" autocomplete="off" autocapitalize="off" spellcheck="false">
      <datalist id="liste-reseaux">${reseaux.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <label for="pass">Mot de passe du Wi-Fi</label>
      <input id="pass" type="password" autocomplete="off">
      <button class="gros" style="margin-top:22px" data-action="envoyer-wifi">Envoyer aux appareils</button>
      <div id="resultats">${htmlResultatsWifi()}</div>`;
  }

  function envoyerWifi() {
    const ssid = $('#ssid').value.trim();
    if (!ssid) { toast('Écris le nom du Wi-Fi'); return; }
    const cmd = { cmd: 'wifi_ajouter', ssid, password: $('#pass').value };
    wifi.heure = maintenant();
    wifi.etats = {};
    wifi.messages = {};
    etat.appareils.forEach((a) => {
      if (etat.connecte && a.enLigne === true) { admin(a.id, cmd); wifi.etats[a.id] = 'envoi'; }
    });
    setTimeout(() => {
      Object.keys(wifi.etats).forEach((id) => { if (wifi.etats[id] === 'envoi') wifi.etats[id] = 'silence'; });
      rafraichir();
    }, 10000);
    rafraichir();
  }

  function htmlResultatsWifi() {
    if (!wifi.heure) return '';
    let unHorsLigne = false;
    const lignes = appareilsTries().map((a) => {
      if (wifi.etats[a.id] === 'envoi') {
        const r = reponse(a, 'wifi_ajouter', wifi.heure);
        if (r) { wifi.etats[a.id] = r.ok ? 'ok' : 'refus'; wifi.messages[a.id] = r.message; }
      }
      const e = wifi.etats[a.id];
      const [texte, classe] = e === 'envoi' ? ['Envoi…', 'attente']
        : e === 'ok' ? ["C'est enregistré ✔", 'ok']
          : e === 'refus' ? [`Refusé : ${wifi.messages[a.id] || ''}`, 'ko']
            : e === 'silence' ? ['Pas de réponse', 'ko'] : ['Ne répond pas en ce moment', 'ko'];
      if (!e || e === 'silence') unHorsLigne = true;
      return `<div class="carte"><span class="textes"><b>${esc(nom(a))}</b><span class="${classe}">${esc(texte)}</span></span></div>`;
    });
    return lignes.join('') + (unHorsLigne
      ? `<p class="bandeau">Un appareil qui ne répond pas passe tout seul en mode réglage, 5 minutes après avoir perdu le Wi-Fi.
         Mets-toi à côté et suis les étapes de « Ajouter un appareil ».</p>` : '');
  }

  // ------------------------------------------------------------------
  // Options avancées
  // ------------------------------------------------------------------
  const ota = { heure: 0, cibles: [] };

  function vueAvance() {
    return `${barre('Options avancées')}
      <button class="gros" data-action="lancer-ota">Mettre à jour les cartes${logiciel.version ? ` (logiciel v${esc(logiciel.version)})` : ''}</button>
      <div id="ota">${htmlOta()}</div>
      <button class="gros clair" style="margin-top:12px" data-action="maisons">Maisons : ${esc(maisonActuelle().nom)}${lireMaisons().length > 1 ? ` (+${lireMaisons().length - 1})` : ''}</button>
      <button class="gros clair" style="margin-top:12px" data-action="aller" data-vue="carte">Préparer une carte neuve (USB)</button>
      <div id="liste-avance">${htmlListeAvance()}</div>`;
  }

  function htmlListeAvance() {
    return appareilsTries().map((a) => {
      const details = [a.id, a.version ? `v${a.version}` : null, a.url ? a.url.replace('http://', '') : null,
        a.enLigne === true ? 'en ligne' : a.enLigne === false ? 'hors ligne' : '?'].filter(Boolean).join(' · ');
      return `<div class="carte"><span class="textes"><b>${esc(nom(a))}</b><small>${esc(details)}</small></span>
        <button class="menu-btn" data-action="menu" data-id="${esc(a.id)}" aria-label="Options">⋮</button></div>`;
    }).join('');
  }

  function htmlOta() {
    if (!ota.heure) return '';
    return `<p class="bandeau" style="font-size:16px">${ota.cibles.map((id) => {
      const a = etat.appareils.get(id);
      const r = a ? reponse(a, 'ota', ota.heure) : null;
      const n = esc(a ? nom(a) : id);
      if (!r) return `… ${n} : envoi`;
      return `${r.ok ? '✔' : '✖'} ${n} : ${esc(r.message)}`;
    }).join('<br>')}</p>`;
  }

  // Le main.py publié avec la web app (copié depuis esp32/ à chaque push)
  const logiciel = { octets: null, code: null, version: null };
  async function chargerLogiciel() {
    if (logiciel.octets) return logiciel;
    const rep = await fetch(`main.py?v=${Date.now()}`, { cache: 'no-store' });
    if (!rep.ok) throw new Error('logiciel introuvable');
    logiciel.octets = new Uint8Array(await rep.arrayBuffer());
    logiciel.code = new TextDecoder('utf-8', { ignoreBOM: true }).decode(logiciel.octets);
    const m = logiciel.code.match(/^VERSION\s*=\s*"([^"]+)"/m);
    logiciel.version = m ? m[1] : null;
    return logiciel;
  }
  chargerLogiciel().then(() => { if (vueCourante().vue === 'avance') afficher(); }).catch(() => {});

  function plusAncienne(a, b) {
    if (!a) return true;
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let k = 0; k < Math.max(x.length, y.length); k++) {
      const d = (x[k] || 0) - (y[k] || 0);
      if (d) return d < 0;
    }
    return false;
  }

  async function preparerOta() {
    let l;
    try { l = await chargerLogiciel(); } catch (e) { toast("Logiciel introuvable sur le site"); return; }
    const octets = l.octets, code = l.code;
    const enLigne = appareilsTries().filter((a) => a.enLigne === true);
    if (!enLigne.length) { toast('Aucun appareil en ligne'); return; }

    const { val, data } = await modale({
      titre: `Installer la version ${l.version || '?'}`,
      html: enLigne.map((a) => `<label class="case"><input type="checkbox" name="c_${esc(a.id)}" ${plusAncienne(a.version, l.version || '0') ? 'checked' : ''}> ${esc(nom(a))} (v${esc(a.version || '?')})</label>`).join('')
        + '<p class="aide">Cochées d\'office : les cartes qui ont une version plus ancienne.</p>',
      boutons: [{ texte: 'Envoyer', val: 'ok', classe: 'principal' }, { texte: 'Annuler', val: null }]
    });
    if (val !== 'ok') return;

    const empreinte = [...new Uint8Array(await crypto.subtle.digest('SHA-256', octets))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    ota.heure = maintenant();
    ota.cibles = [];
    enLigne.forEach((a) => {
      if (data[`c_${a.id}`]) {
        ota.cibles.push(a.id);
        publier(t(a.id, 'ota'), `OTA1\n${empreinte}\n${code}`);
      }
    });
    rafraichir();
  }

  async function menuAppareil(id) {
    const a = etat.appareils.get(id);
    if (!a) return;
    const { val } = await modale({
      titre: nom(a),
      boutons: [
        { texte: 'Renommer', val: 'renommer' },
        { texte: 'Changer le dessin', val: 'dessin' },
        { texte: 'Ce qui est branché (relais, chauffage…)', val: 'branche' },
        { texte: 'Configuration experte (JSON)', val: 'json' },
        { texte: 'Redémarrer', val: 'redemarrer' },
        { texte: 'Passer en mode réglage', val: 'mode' },
        { texte: 'Déplacer vers une autre maison', val: 'deplacer' },
        { texte: 'Retirer de la liste', val: 'retirer', classe: 'danger' },
        { texte: 'Fermer', val: null }
      ]
    });
    if (val === 'renommer') renommer(id);
    else if (val === 'dessin') changerDessin(id);
    else if (val === 'branche') aller('branche', id);
    else if (val === 'json') configJson(id);
    else if (val === 'deplacer') menuDeplacer(id);
    else if (val === 'redemarrer' && await confirmer(`Redémarrer « ${nom(a)} » ?`)) admin(id, { cmd: 'redemarrer' });
    else if (val === 'mode' && await confirmer(`Passer « ${nom(a)} » en mode réglage ?`,
      'Il quitte le Wi-Fi et attend un téléphone à proximité. Sans réglage, il revient tout seul après 3 minutes.')) admin(id, { cmd: 'mode_config' });
    else if (val === 'retirer' && await confirmer(`Retirer « ${nom(a)} » ?`,
      a.enLigne === true ? "Il est encore allumé : il réapparaîtra tant qu'il reste branché." : null)) oublier(id);
  }

  async function menuDeplacer(id) {
    const a = etat.appareils.get(id);
    const autres = lireMaisons().filter((m) => m.code !== maisonActuelle().code);
    if (!autres.length) { toast("Ajoute d'abord une autre maison (bouton « Maisons »)"); return; }
    if (a.enLigne !== true) { toast("L'appareil doit être en ligne"); return; }
    const { val } = await modale({
      titre: `Déplacer « ${nom(a)} » vers…`,
      boutons: autres.map((m) => ({ texte: m.nom, val: m.code || '__origine__' })).concat([{ texte: 'Annuler', val: null }])
    });
    if (val === null) return;
    const code = val === '__origine__' ? '' : val;
    if (await confirmer('Déplacer cet appareil ?', "Il disparaîtra d'ici et apparaîtra dans l'autre maison après son redémarrage.")) {
      deplacer(id, code);
      toast('Déplacé');
    }
  }

  async function demanderTexte(titre, valeur = '') {
    const { val, data } = await modale({
      titre, html: `<input name="v" value="${esc(valeur)}" autocapitalize="off" autocomplete="off">`,
      boutons: [{ texte: 'OK', val: 'ok', classe: 'principal' }, { texte: 'Annuler', val: null }]
    });
    return val === 'ok' && data.v.trim() ? data.v.trim() : null;
  }

  async function gererMaisons() {
    const l = lireMaisons();
    const actuelle = maisonActuelle().code;
    const { val } = await modale({
      titre: 'Maisons suivies ici',
      boutons: l.map((m, i) => ({ texte: `${m.code === actuelle ? '● ' : '○ '}${m.nom}`, val: `m${i}` }))
        .concat([{ texte: '+ Ajouter une maison', val: 'ajouter' }, { texte: 'Fermer', val: null }])
    });
    if (!val) return;
    if (val === 'ajouter') return ajouterMaison();
    const m = l[Number(val.slice(1))];
    const r = await modale({
      titre: m.nom,
      html: `<p>Code : <code>${esc(m.code || "(maison d'origine, sans code)")}</code></p>`,
      boutons: [{ texte: 'Afficher cette maison', val: 'voir', classe: 'principal' }, { texte: 'Renommer', val: 'nom' },
        { texte: 'Copier le code', val: 'copier' }, { texte: 'Ne plus suivre', val: 'retirer', classe: 'danger' }, { texte: 'Fermer', val: null }]
    });
    if (r.val === 'voir') choisirMaison(m.code);
    else if (r.val === 'nom') {
      const n = await demanderTexte('Nom de la maison', m.nom);
      if (n) { ecrireMaisons(l.map((x) => (x.code === m.code ? { ...x, nom: n } : x))); afficher(); }
    } else if (r.val === 'copier') {
      try { await navigator.clipboard.writeText(m.code); toast('Code copié'); } catch (e) { toast(`Code : ${m.code || '(vide)'}`); }
    } else if (r.val === 'retirer') {
      if (l.length <= 1) { toast('Il faut garder au moins une maison'); return; }
      ecrireMaisons(l.filter((x) => x.code !== m.code));
      if (m.code === actuelle) choisirMaison(lireMaisons()[0].code); else afficher();
    }
  }

  async function ajouterMaison() {
    const { val } = await modale({
      titre: 'Ajouter une maison',
      boutons: [{ texte: 'Créer une nouvelle maison', val: 'creer', classe: 'principal' },
        { texte: 'Rejoindre avec un code', val: 'code' }, { texte: "Rejoindre la maison d'origine", val: 'origine' }, { texte: 'Annuler', val: null }]
    });
    let code = null;
    if (val === 'creer') code = nouveauCode();
    else if (val === 'origine') code = '';
    else if (val === 'code') {
      const c = await demanderTexte('Code de la maison');
      if (!c) return;
      if (!codeValide(c.toLowerCase())) { toast('Code invalide'); return; }
      code = c.toLowerCase();
    }
    if (code === null) return;
    const nomMaison = await demanderTexte('Nom à afficher', val === 'creer' ? 'Chez moi' : val === 'origine' ? 'Chez papa' : 'Maison');
    if (!nomMaison) return;
    ecrireMaisons(lireMaisons().filter((m) => m.code !== code).concat([{ nom: nomMaison, code }]));
    choisirMaison(code);
    if (val === 'creer') toast('Maison créée : les cartes ajoutées maintenant iront dedans');
  }

  function vueBienvenue() {
    return `<header><h1 class="salut" style="margin-top:28px">Bienvenue</h1></header>
      <p class="texte" style="margin-top:12px">Pour commencer, crée ta maison : tes appareils n'apparaîtront que chez toi
        et chez les personnes à qui tu donneras son code.</p>
      <div class="pile" style="margin-top:20px">
        <button class="gros" data-action="bienvenue-creer">Je crée ma maison</button>
        <button class="gros clair" data-action="bienvenue-rejoindre">Je rejoins une maison avec un code</button>
      </div>
      <button class="lien-bas" data-action="bienvenue-origine">Maison d'origine (installation existante)</button>`;
  }

  async function premiereMaison(m) {
    ecrireMaisons([m]);
    choisirMaison(m.code);
    afficher();
  }

  async function bienvenue(choix) {
    if (choix === 'creer') {
      const n = await demanderTexte('Nom de ta maison', 'Ma maison');
      if (n) premiereMaison({ nom: n, code: nouveauCode() });
    } else if (choix === 'rejoindre') {
      const c = await demanderTexte('Code de la maison');
      if (!c) return;
      if (!codeValide(c.toLowerCase())) { toast('Code invalide'); return; }
      const n = await demanderTexte('Nom à afficher', 'Maison');
      if (n) premiereMaison({ nom: n, code: c.toLowerCase() });
    } else if (await confirmer("Maison d'origine", "C'est la maison des premières cartes installées, sans code. Choisis-la seulement si c'est la tienne.")) {
      premiereMaison({ nom: 'Maison', code: '' });
    }
  }

  async function choisirMaisonAccueil() {
    const l = lireMaisons();
    const { val } = await modale({
      titre: 'Quelle maison ?',
      boutons: l.map((m, i) => ({ texte: m.nom, val: `m${i}` })).concat([{ texte: 'Annuler', val: null }])
    });
    if (val) choisirMaison(l[Number(val.slice(1))].code);
  }

  async function renommer(id) {
    const a = etat.appareils.get(id);
    const { val, data } = await modale({
      titre: 'Nom de l\'appareil',
      html: `<input name="nom" value="${esc(a.meta.nom || '')}" placeholder="${esc(nom(a))}" autocapitalize="sentences">`,
      boutons: [{ texte: 'Enregistrer', val: 'ok', classe: 'principal' }, { texte: 'Annuler', val: null }]
    });
    if (val === 'ok') enregistrerMeta(id, { nom: data.nom.trim() || null, icones: a.meta.icones || {} });
  }

  async function changerDessin(id) {
    const a = etat.appareils.get(id);
    let s = sorties(a)[0];
    if (sorties(a).length > 1) {
      const r = await modale({ titre: 'Quelle sortie ?', boutons: sorties(a).map((x) => ({ texte: x.nom, val: x.id })).concat([{ texte: 'Annuler', val: null }]) });
      if (!r.val) return;
      s = sorties(a).find((x) => x.id === r.val);
    }
    if (!s) return;
    const r = await modale({ titre: `Dessin pour « ${s.nom} »`, boutons: LISTE_DESSINS.map(([cle, lib]) => ({ texte: lib, val: cle })).concat([{ texte: 'Annuler', val: null }]) });
    if (!r.val) return;
    enregistrerMeta(id, { nom: a.meta.nom, icones: { ...(a.meta.icones || {}), [s.id]: r.val } });
  }

  async function configJson(id) {
    const a = etat.appareils.get(id);
    if (a.enLigne !== true) { toast("L'appareil doit être en ligne"); return; }
    const exemple = { sorties: [{ id: 'led', nom: 'Lumière', pin: 2 }], capteurs: [], led_statut: 2, bouton: 0 };
    const { val, data } = await modale({
      titre: `Configuration de « ${nom(a)} »`,
      html: `<textarea name="json" spellcheck="false" autocapitalize="off">${esc(JSON.stringify(a.config || exemple, null, 2))}</textarea>
             <p class="aide">L'appareil redémarre après l'envoi.</p>`,
      boutons: [{ texte: 'Envoyer', val: 'ok', classe: 'principal' }, { texte: 'Annuler', val: null }]
    });
    if (val !== 'ok') return;
    try {
      const config = JSON.parse(data.json);
      if (!Array.isArray(config.sorties)) throw new Error('« sorties » manquant');
      admin(id, { cmd: 'config', config });
      toast("Envoyé, l'appareil redémarre");
    } catch (e) {
      toast(`JSON invalide : ${e.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Ce qui est branché (éditeur visuel)
  // ------------------------------------------------------------------
  let edition = null; // { id, elements: [...], prochaine }
  const LIB_TYPE = { inter: 'Interrupteur', chauffage: 'Chauffage', thermo: 'Thermomètre' };
  const NOM_DEFAUT = { inter: 'Lumière', chauffage: 'Chauffage', thermo: 'Température' };

  function chargerEdition(a) {
    let n = 1;
    const cfg = a.config || { sorties: [{ id: 'led', nom: 'Lumière', pin: 2 }], capteurs: [] };
    const thermos = (cfg.capteurs || []).map((c) => ({ cle: n++, id: c.id, type: 'thermo', nom: c.nom || 'Température', pin: c.pin ?? null, inverse: false, capteur: null, modele: c.type || 'dht22' }));
    const sorts = (cfg.sorties || []).map((s) => ({
      cle: n++, id: s.id,
      type: s.type === 'thermostat' || s.type === 'chauffage' ? 'chauffage' : 'inter',
      nom: s.nom || s.id, pin: s.pin ?? null, inverse: !!s.inverse,
      capteur: s.capteur ? (thermos.find((t) => t.id === s.capteur) || {}).cle ?? null : null,
      modele: 'dht22'
    }));
    edition = { id: a.id, elements: [...sorts, ...thermos], prochaine: n };
  }

  function vueBranche(id) {
    const a = etat.appareils.get(id);
    if (!a) return `${barre('Ce qui est branché')}<p class="texte">Appareil introuvable.</p>`;
    if (!edition || edition.id !== id) chargerEdition(a);
    return `${barre(`Branché sur « ${nom(a)} »`)}
      <p class="bandeau" style="font-size:15px;margin-top:0">Module relais : VCC → VIN (5 V), GND → GND, IN → la broche choisie.<br>
        Thermomètre DHT22 : + → 3V3, − → GND, OUT → la broche choisie.<br>
        Le numéro de broche est écrit sur la carte (D26, G26 ou IO26 = 26).</p>
      <div id="elements">${htmlElements()}</div>
      <button class="gros clair" style="margin-top:16px" data-action="ajouter-el">+ Ajouter un élément</button>
      <button class="gros" style="margin-top:12px" data-action="enregistrer-el">Enregistrer (l'appareil redémarre)</button>`;
  }

  function htmlElements() {
    const thermos = edition.elements.filter((e) => e.type === 'thermo');
    return edition.elements.map((e) => {
      const segs = Object.keys(LIB_TYPE).map((tp) => `<button class="${e.type === tp ? 'actif' : ''}" data-action="type-el" data-cle="${e.cle}" data-t="${tp}">${LIB_TYPE[tp]}</button>`).join('');
      const broches = BROCHES.map((p) => `<option value="${p}" ${e.pin === p ? 'selected' : ''}>${p === 2 ? '2 (LED bleue de la carte)' : p}</option>`).join('');
      let extra = '';
      if (e.type !== 'thermo') {
        extra += `<label class="case"><input type="checkbox" data-champ="inverse" data-cle="${e.cle}" ${e.inverse ? 'checked' : ''}> Logique inversée</label>
          <p class="aide">Le relais s'enclenche quand la broche est à 0. À cocher pour la plupart des modules relais (bleus).</p>`;
      }
      if (e.type === 'chauffage') {
        extra += `<label>Thermomètre qui commande ce chauffage</label>
          <select data-champ="capteur" data-cle="${e.cle}">
            <option value="">Aucun : marche / arrêt à la main</option>
            ${thermos.map((th) => `<option value="${th.cle}" ${e.capteur === th.cle ? 'selected' : ''}>${esc(th.nom || 'Thermomètre')}</option>`).join('')}
          </select>
          <p class="aide">${e.capteur ? "La chaudière s'arrête toute seule quand la température voulue est atteinte." : "Sans thermomètre, la chaudière tourne tant que c'est allumé."}</p>`;
      }
      if (e.type === 'thermo') {
        extra += `<label>Modèle du thermomètre</label>
          <select data-champ="modele" data-cle="${e.cle}">
            <option value="dht22" ${e.modele === 'dht22' ? 'selected' : ''}>DHT22 (blanc, conseillé)</option>
            <option value="dht11" ${e.modele === 'dht11' ? 'selected' : ''}>DHT11 (bleu)</option>
          </select>`;
      }
      return `<div class="element">
        <div class="segments">${segs}</div>
        <label>Nom affiché</label>
        <input data-champ="nom" data-cle="${e.cle}" value="${esc(e.nom)}" placeholder="ex : Lampe du salon" autocapitalize="sentences">
        <label>Broche</label>
        <select data-champ="pin" data-cle="${e.cle}"><option value="">Choisir…</option>${broches}</select>
        ${extra}
        <button class="supprimer" data-action="suppr-el" data-cle="${e.cle}">Supprimer</button>
      </div>`;
    }).join('');
  }

  const elementParCle = (cle) => edition && edition.elements.find((e) => e.cle === Number(cle));
  const majElements = () => remplir('#elements', htmlElements());

  function identifiant(nomEl) {
    const s = nomEl.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
    return s || 'element';
  }

  async function enregistrerElements() {
    const els = edition.elements;
    for (const e of els) {
      if (!e.nom.trim()) { toast('Chaque élément doit avoir un nom'); return; }
      if (e.pin == null) { toast(`Choisis la broche de « ${e.nom} »`); return; }
    }
    const broches = els.map((e) => e.pin);
    if (new Set(broches).size !== broches.length) { toast('Deux éléments utilisent la même broche'); return; }
    els.filter((e) => e.type === 'chauffage').forEach((e) => {
      if (!els.some((x) => x.cle === e.capteur && x.type === 'thermo')) e.capteur = null;
    });

    const pris = new Set();
    els.forEach((e) => {
      const base = e.id || identifiant(e.nom);
      let id = base;
      let n = 2;
      while (pris.has(id) || RESERVES.has(id)) id = `${base}_${n++}`;
      e.id = id;
      pris.add(id);
    });

    const config = {
      sorties: [], capteurs: [],
      led_statut: broches.includes(2) ? null : 2,
      bouton: 0
    };
    els.forEach((e) => {
      if (e.type === 'thermo') config.capteurs.push({ id: e.id, nom: e.nom.trim(), type: e.modele, pin: e.pin });
      else {
        const o = { id: e.id, nom: e.nom.trim(), pin: e.pin, inverse: e.inverse };
        if (e.type === 'chauffage') {
          const th = els.find((x) => x.cle === e.capteur);
          if (th) Object.assign(o, { type: 'thermostat', capteur: th.id, hysteresis: 0.5 });
          else o.type = 'chauffage';
        }
        config.sorties.push(o);
      }
    });

    const a = etat.appareils.get(edition.id);
    if (!a || a.enLigne !== true || !etat.connecte) { toast("L'appareil doit être en ligne pour recevoir la configuration"); return; }
    if (!await confirmer(`Envoyer à « ${nom(a)} » ?`, "L'appareil va redémarrer (environ 20 secondes).")) return;
    admin(a.id, { cmd: 'config', config });
    toast("Envoyé, l'appareil redémarre");
    edition = null;
    retour();
  }

  // ------------------------------------------------------------------
  // Préparer une carte neuve par USB (ordinateur, Chrome ou Edge)
  // MicroPython est écrit avec esptool-js (Espressif), puis boot.py et main.py
  // sont copiés par le « raw REPL » de MicroPython.
  // ------------------------------------------------------------------
  const carte = { port: null, occupe: false, lignes: [], pct: null };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  function vueCarte() {
    const ok = 'serial' in navigator;
    return `${barre('Préparer une carte neuve')}
      ${ok ? `<ol class="etapes">
        <li>Branche la carte en USB sur cet ordinateur. Rien d'autre ne doit être branché sur ses broches.</li>
        <li>Ferme Thonny s'il est ouvert : il bloque le port USB.</li>
        <li>Touche « Choisir la carte » et sélectionne le port (CP210x, CH340, USB Serial…).</li>
      </ol>
      <div class="pile">
        <button class="gros clair" data-action="connecter-carte">${carte.port ? 'Carte choisie ✔ (changer)' : 'Choisir la carte'}</button>
        <button class="gros" data-action="installer-tout" ${carte.port && !carte.occupe ? '' : 'disabled'}>Carte neuve : tout installer</button>
        <button class="gros clair" data-action="installer-logiciel" ${carte.port && !carte.occupe ? '' : 'disabled'}>Réinstaller seulement le logiciel</button>
      </div>
      <p class="aide">« Tout installer » efface la carte, installe MicroPython puis le logiciel Ma Maison (environ 2 minutes).
        « Réinstaller seulement le logiciel » garde le Wi-Fi et les réglages.</p>
      <div id="journal">${htmlJournal()}</div>`
      : `<p class="texte">Ce navigateur ne sait pas parler à la carte par USB.</p>
         <ul class="texte" style="padding-left:20px">
           <li><b>Téléphone Android</b> : utilise l'appli Ma Maison, Réglages → Options avancées → « Préparer une carte neuve (USB) », avec un adaptateur OTG.</li>
           <li><b>Ordinateur</b> : ouvre cette même page dans Chrome ou Edge.</li>
           <li><b>iPhone</b> : impossible, Apple bloque ce type de connexion USB. Passe par un ordinateur ou un téléphone Android.</li>
         </ul>`}`;
  }

  function htmlJournal() {
    if (!carte.lignes.length) return '';
    const barreProg = carte.pct == null ? '' : `<div style="height:10px;background:var(--pierre);border-radius:5px;margin:10px 0"><div style="height:100%;width:${Math.round(carte.pct * 100)}%;background:var(--terre);border-radius:5px"></div></div>`;
    return `<div class="bandeau" style="font-size:15px">${barreProg}${carte.lignes.map(esc).join('<br>')}</div>`;
  }
  function noter(texte, pct = carte.pct) {
    if (texte) carte.lignes.push(texte);
    carte.pct = pct;
    remplir('#journal', htmlJournal());
  }

  async function connecterCarte() {
    try {
      carte.port = await navigator.serial.requestPort();
      carte.lignes = [];
      carte.pct = null;
      afficher();
    } catch (e) { /* fenêtre fermée */ }
  }

  async function fichierDuSite(nomFichier) {
    const rep = await fetch(`${nomFichier}?v=${Date.now()}`, { cache: 'no-store' });
    if (!rep.ok) throw new Error(`${nomFichier} introuvable sur le site`);
    return new Uint8Array(await rep.arrayBuffer());
  }

  async function preparerCarte(toutInstaller) {
    if (!carte.port || carte.occupe) return;
    carte.occupe = true;
    carte.lignes = [];
    afficher();
    try {
      if (toutInstaller) await installerMicroPython();
      await installerLogiciel();
      noter('C\'est prêt ✔ La carte redémarre en mode réglage (lumière bleue fixe). Continue avec « Ajouter un appareil » sur le téléphone.', null);
    } catch (e) {
      noter(`✖ ${e.message || e}`, null);
      noter('Débranche et rebranche la carte, puis réessaie. Si ça bloque à « Connexion », maintiens le bouton BOOT pendant la connexion.');
    } finally {
      carte.occupe = false;
      const ligne = carte.lignes;
      afficher();
      carte.lignes = ligne;
      remplir('#journal', htmlJournal());
    }
  }

  async function installerMicroPython() {
    noter('Téléchargement de MicroPython…', 0);
    const binaire = await fichierDuSite('micropython.bin');
    let texte = '';
    for (let i = 0; i < binaire.length; i += 0x8000) texte += String.fromCharCode.apply(null, binaire.subarray(i, i + 0x8000));

    const { ESPLoader, Transport } = await import('./esptool.js');
    const transport = new Transport(carte.port, false);
    const loader = new ESPLoader({
      transport, baudrate: 460800, romBaudrate: 115200,
      terminal: { clean() {}, writeLine() {}, write() {} }
    });
    noter('Connexion à la carte…', 0);
    try {
      await loader.main();
      const puce = loader.chip.CHIP_NAME;
      if (puce !== 'ESP32') throw new Error(`Cette carte est un ${puce} : seul l'ESP32 classique (DevKit) est pris en charge.`);
      noter(`Carte détectée : ${puce}. Effacement puis écriture de MicroPython…`, 0);
      await loader.writeFlash({
        fileArray: [{ data: texte, address: 0x1000 }],
        flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
        eraseAll: true, compress: true,
        reportProgress: (_i, ecrit, total) => noter('', ecrit / total)
      });
      noter('MicroPython installé ✔', 1);
      await loader.after('hard_reset');
    } finally {
      try { await transport.disconnect(); } catch (e) { /* déjà fermé */ }
    }
    noter('Premier démarrage de la carte…', null);
    await pause(4000);
  }

  async function installerLogiciel() {
    noter('Copie du logiciel Ma Maison…', 0);
    const fichiers = [['boot.py', await fichierDuSite('boot.py')], ['main.py', await fichierDuSite('main.py')]];
    const repl = new Repl(carte.port);
    await repl.ouvrir();
    try {
      await repl.entrerRaw();
      const total = fichiers.reduce((n, f) => n + f[1].length, 0);
      let fait = 0;
      for (const [nomFichier, octets] of fichiers) {
        await repl.ecrireFichier(nomFichier, octets, (n) => noter('', (fait + n) / total));
        fait += octets.length;
        noter(`${nomFichier} copié ✔`, fait / total);
      }
      // Repart de zéro : le Wi-Fi et les réglages ne sont effacés que par « tout installer »
      await repl.executer('import os\nfor f in ("ota_essais","ota_rollback","main.bak","force_ap"):\n    try:\n        os.remove(f)\n    except OSError:\n        pass');
      await repl.redemarrer();
    } finally {
      await repl.fermer();
    }
  }

  class Repl {
    constructor(port) { this.port = port; this.tampon = ''; }

    async ouvrir() {
      await this.port.open({ baudRate: 115200 });
      // DTR/RTS relâchés : la carte démarre normalement (pas en mode téléchargement)
      try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) { /* non géré */ }
      this.ecrivain = this.port.writable.getWriter();
      this.lecteur = this.port.readable.getReader();
      const dec = new TextDecoder();
      (async () => {
        try {
          for (;;) {
            const { value, done } = await this.lecteur.read();
            if (done) break;
            this.tampon += dec.decode(value, { stream: true });
          }
        } catch (e) { /* port fermé */ }
      })();
      await pause(1500);
    }

    ecrire(texte) { return this.ecrivain.write(new TextEncoder().encode(texte)); }

    async attendre(motif, delai) {
      const fin = Date.now() + delai;
      while (Date.now() < fin) {
        const i = this.tampon.indexOf(motif);
        if (i >= 0) {
          const avant = this.tampon.slice(0, i);
          this.tampon = this.tampon.slice(i + motif.length);
          return avant;
        }
        await pause(20);
      }
      throw new Error('La carte ne répond pas (MicroPython est-il installé ?)');
    }

    async entrerRaw() {
      // Ctrl-C arrête main.py s'il tourne, Ctrl-A passe en mode « raw »
      for (let k = 0; k < 4; k++) { await this.ecrire('\r\x03'); await pause(200); }
      this.tampon = '';
      await this.ecrire('\r\x01');
      await this.attendre('raw REPL; CTRL-B to exit\r\n>', 4000);
    }

    async executer(code) {
      await this.ecrire(code);
      await this.ecrire('\x04');
      await this.attendre('OK', 5000);
      await this.attendre('\x04', 20000);          // sortie
      const erreur = await this.attendre('\x04', 5000);
      await this.attendre('>', 3000);
      if (erreur.trim()) throw new Error(`Erreur sur la carte : ${erreur.trim().split('\n').pop()}`);
    }

    async ecrireFichier(nomFichier, octets, progression) {
      await this.executer(`import ubinascii\nf=open('${nomFichier}','wb')`);
      const taille = 384;
      for (let i = 0; i < octets.length; i += taille) {
        let bin = '';
        octets.subarray(i, i + taille).forEach((b) => { bin += String.fromCharCode(b); });
        await this.executer(`f.write(ubinascii.a2b_base64('${btoa(bin)}'))`);
        progression(Math.min(octets.length, i + taille));
      }
      await this.executer('f.close()');
    }

    async redemarrer() {
      await this.ecrire('import machine\nmachine.reset()\x04');
      await pause(500);
    }

    async fermer() {
      try { await this.lecteur.cancel(); } catch (e) { /* */ }
      try { this.lecteur.releaseLock(); } catch (e) { /* */ }
      try { this.ecrivain.releaseLock(); } catch (e) { /* */ }
      try { await this.port.close(); } catch (e) { /* */ }
    }
  }

  // ------------------------------------------------------------------
  // Fenêtres
  // ------------------------------------------------------------------
  function modale({ titre, html = '', boutons }) {
    return new Promise((resolve) => {
      const fond = document.createElement('div');
      fond.className = 'fond-modale';
      fond.innerHTML = `<div class="modale" role="dialog" aria-modal="true" aria-label="${esc(titre)}">
        <h2>${esc(titre)}</h2><div class="contenu">${html}</div>
        <div class="actions">${boutons.map((b, i) => `<button class="${b.classe || ''}" data-i="${i}">${esc(b.texte)}</button>`).join('')}</div></div>`;
      document.body.appendChild(fond);
      const fermer = (val) => {
        const data = {};
        fond.querySelectorAll('[name]').forEach((el) => { data[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
        fond.remove();
        resolve({ val, data });
      };
      fond.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) fermer(boutons[Number(b.dataset.i)].val);
        else if (e.target === fond) fermer(null);
      });
      const champ = fond.querySelector('input:not([type=checkbox]),textarea');
      if (champ) setTimeout(() => champ.focus(), 60);
    });
  }

  async function confirmer(titre, message) {
    const { val } = await modale({
      titre, html: message ? `<p>${esc(message)}</p>` : '',
      boutons: [{ texte: 'Oui', val: true, classe: 'principal' }, { texte: 'Annuler', val: false }]
    });
    return val === true;
  }

  // ------------------------------------------------------------------
  // Événements
  // ------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const { action, id, s, vue, cle } = el.dataset;
    switch (action) {
      case 'aller': aller(vue); break;
      case 'retour': retour(); break;
      case 'basculer': basculer(id, s); break;
      case 'consigne': changerConsigne(id, s, Number(el.dataset.v)); break;
      case 'envoyer-wifi': envoyerWifi(); break;
      case 'renommer': renommer(id); break;
      case 'menu': menuAppareil(id); break;
      case 'lancer-ota': preparerOta(); break;
      case 'maisons': gererMaisons(); break;
      case 'bienvenue-creer': bienvenue('creer'); break;
      case 'bienvenue-rejoindre': bienvenue('rejoindre'); break;
      case 'bienvenue-origine': bienvenue('origine'); break;
      case 'choisir-maison': choisirMaisonAccueil(); break;
      case 'connecter-carte': connecterCarte(); break;
      case 'installer-tout': preparerCarte(true); break;
      case 'installer-logiciel': preparerCarte(false); break;
      case 'ajouter-el':
        edition.elements.push({ cle: edition.prochaine++, id: null, type: 'inter', nom: NOM_DEFAUT.inter, pin: null, inverse: true, capteur: null, modele: 'dht22' });
        majElements();
        setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
        break;
      case 'suppr-el': {
        const supprime = elementParCle(cle);
        edition.elements = edition.elements.filter((x) => x !== supprime);
        edition.elements.forEach((x) => { if (x.capteur === supprime.cle) x.capteur = null; });
        majElements();
        break;
      }
      case 'type-el': {
        const x = elementParCle(cle);
        const tp = el.dataset.t;
        if (x && x.type !== tp) {
          if (!x.nom.trim() || x.nom === NOM_DEFAUT[x.type]) x.nom = NOM_DEFAUT[tp];
          x.type = tp;
          majElements();
        }
        break;
      }
      case 'enregistrer-el': enregistrerElements(); break;
      default: break;
    }
  });

  // Champs de l'éditeur : on met à jour le modèle sans tout redessiner
  document.addEventListener('input', (e) => {
    const el = e.target;
    const x = el.dataset && el.dataset.cle ? elementParCle(el.dataset.cle) : null;
    if (x && el.dataset.champ === 'nom') x.nom = el.value;
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    const x = el.dataset && el.dataset.cle ? elementParCle(el.dataset.cle) : null;
    if (!x) return;
    const champ = el.dataset.champ;
    if (champ === 'pin') {
      x.pin = el.value === '' ? null : Number(el.value);
      if (x.pin === 2) { x.inverse = false; majElements(); }
    } else if (champ === 'inverse') x.inverse = el.checked;
    else if (champ === 'modele') x.modele = el.value;
    else if (champ === 'capteur') { x.capteur = el.value === '' ? null : Number(el.value); majElements(); }
    else if (champ === 'nom') { x.nom = el.value; if (x.type === 'thermo') majElements(); }
  });

  // « Options avancées » : appui long, pour éviter d'y entrer par erreur
  let minuteurAppui = null;
  let appuiLongFait = false;
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-appui-long]');
    if (!el) return;
    appuiLongFait = false;
    minuteurAppui = setTimeout(() => { appuiLongFait = true; aller(el.dataset.appuiLong); }, 700);
  });
  const annulerAppui = () => clearTimeout(minuteurAppui);
  document.addEventListener('pointerup', annulerAppui);
  document.addEventListener('pointercancel', annulerAppui);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-appui-long]') && !appuiLongFait) toast('Maintiens le doigt appuyé');
  });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-appui-long]')) e.preventDefault(); });

  // Retour au premier plan : l'heure et la date se mettent à jour
  document.addEventListener('visibilitychange', () => { if (!document.hidden) rafraichir(); });
  setInterval(() => { if (vueCourante().vue === 'accueil') rafraichir(); }, 60000);

  afficher();
})();
