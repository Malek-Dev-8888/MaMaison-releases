# =====================================================================
#  ESP32 Maison — firmware
#  Le même fichier pour toutes les cartes. Ce qui change d'une carte à
#  l'autre (sorties, capteurs) se règle dans appareil.json, modifiable
#  depuis l'appli (Options avancées > Configuration).
# =====================================================================
VERSION = "2.2"

import time
import os
import gc
import json
import network
import socket
import hashlib
import ubinascii
from machine import Pin, reset, unique_id
from umqtt.simple import MQTTClient

# --- MQTT ---
MQTT_BROKER = "broker.hivemq.com"
MQTT_PORT = 1883

DEVICE_ID = ubinascii.hexlify(unique_id()).decode()[-6:]
CLIENT_ID = ("esp32_" + DEVICE_ID).encode()

# Code maison : chaque maison a ses propres topics. Vide = la maison d'origine.
FICHIER_MAISON = "maison.json"
_CARACTERES_CODE = "abcdefghijklmnopqrstuvwxyz0123456789-"


def code_valide(c):
    return isinstance(c, str) and len(c) <= 32 and all(ch in _CARACTERES_CODE for ch in c)


def _lire_code_maison():
    try:
        with open(FICHIER_MAISON) as f:
            c = str(json.load(f).get("code", "")).strip().lower()
    except Exception:
        return ""
    return c if code_valide(c) else ""


def racine_maison(code):
    return "mon_projet_unique/esp" if not code else "mon_projet_unique/m/" + code + "/esp"


CODE_MAISON = _lire_code_maison()
RACINE = racine_maison(CODE_MAISON)
BASE = RACINE + "/" + DEVICE_ID


def topic(suffixe):
    return (BASE + "/" + suffixe).encode()


T_DISPO = topic("availability")
T_IP = topic("wifi/ip")
T_RESEAUX = topic("wifi/reseaux")
T_CONFIG = topic("config")
T_VERSION = topic("version")
T_ADMIN = topic("admin")
T_REPONSE = topic("admin/reponse")
T_OTA = topic("ota")
T_CMD_FILTRE = topic("+/cmd")

# --- Fichiers ---
FICHIER_WIFI = "wifi.json"
FICHIER_CONFIG = "appareil.json"
FICHIER_ETATS = "etats.json"
FLAG_AP = "force_ap"
FICHIER_ESSAIS = "ota_essais"      # géré avec boot.py
FICHIER_ROLLBACK = "ota_rollback"  # créé par boot.py s'il a dû revenir en arrière

# --- Réglages généraux ---
AP_SSID = "ESP32-Config-" + DEVICE_ID[-4:].upper()
AP_IP = "192.168.4.1"
INTERVALLE_PING_MS = 20000
INTERVALLE_CAPTEURS_MS = 60000
DELAI_RETRY_AP_MS = 180000        # mode réglage : retente les Wi-Fi connus toutes les 3 min
DELAI_MAX_SANS_WIFI_MS = 300000   # Wi-Fi perdu depuis 5 min -> mode réglage
APPUI_LONG_MS = 5000

CONFIG_DEFAUT = {
    "sorties": [{"id": "led", "nom": "Lumière", "pin": 2}],
    "capteurs": [],
    "led_statut": 2,   # LED qui s'allume en mode réglage (None pour aucune)
    "bouton": 0,       # bouton BOOT de la carte (None pour aucun)
}


# =====================================================================
# 1. Fichiers
# =====================================================================
def existe(nom):
    try:
        os.stat(nom)
        return True
    except OSError:
        return False


def supprimer(nom):
    try:
        os.remove(nom)
    except OSError:
        pass


def lire_json(nom, defaut):
    try:
        with open(nom) as f:
            return json.load(f)
    except (OSError, ValueError):
        return defaut


def ecrire_json(nom, data):
    """Écriture atomique : une coupure de courant ne laisse jamais un fichier à moitié écrit."""
    tmp = nom + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    try:
        os.rename(tmp, nom)
    except OSError:
        supprimer(nom)
        os.rename(tmp, nom)


# =====================================================================
# 2. Configuration de la carte + matériel
# =====================================================================
def config_valide(c):
    if not isinstance(c, dict):
        return False
    for cle in ("sorties", "capteurs"):
        liste = c.get(cle, [])
        if not isinstance(liste, list):
            return False
        for x in liste:
            if not isinstance(x, dict) or "id" not in x or "pin" not in x:
                return False
    return True


cfg = lire_json(FICHIER_CONFIG, None)
if not config_valide(cfg):
    cfg = CONFIG_DEFAUT

# Sorties (LED, relais...)
sorties = {}
ordre_sorties = []
for _s in cfg.get("sorties", []):
    sorties[_s["id"]] = (Pin(_s["pin"], Pin.OUT), bool(_s.get("inverse", False)))
    ordre_sorties.append(_s["id"])
_pins_sorties = [s["pin"] for s in cfg.get("sorties", [])]


def piloter_pin(sid, allume):
    p, inverse = sorties[sid]
    p.value(1 if allume != inverse else 0)


# Chauffages (thermostats) : la sortie est un relais piloté selon la température
#   "actif"   = le chauffage est en marche (choix de l'utilisateur)
#   "chauffe" = le relais est fermé en ce moment
CYCLE_MIN_MS = 180000            # au moins 3 min entre deux changements du relais
MESURE_PERIMEE_MS = 600000       # capteur muet depuis 10 min -> on coupe, par sécurité
thermostats = {}
for _s in cfg.get("sorties", []):
    if _s.get("type") == "thermostat":
        thermostats[_s["id"]] = {
            "capteur": _s.get("capteur"),
            "h": float(_s.get("hysteresis", 0.5)),
            "chauffe": False,
            "changement": None,
        }

# Restaure l'état d'avant la coupure de courant
etats = lire_json(FICHIER_ETATS, {})
actifs = {}
consignes = etats.get("consignes", {}) if isinstance(etats.get("consignes"), dict) else {}
for _sid in ordre_sorties:
    actifs[_sid] = bool(etats.get(_sid, False))
    piloter_pin(_sid, actifs[_sid] and _sid not in thermostats)


def sortie_allumee(sid):
    return actifs.get(sid, False)


def consigne(sid):
    try:
        return float(consignes.get(sid, 20))
    except (TypeError, ValueError):
        return 20.0

# LED de statut
_pin_statut = cfg.get("led_statut", 2)
led_statut = Pin(_pin_statut, Pin.OUT) if _pin_statut is not None else None
statut_libre = led_statut is not None and _pin_statut not in _pins_sorties

# Bouton
_pin_bouton = cfg.get("bouton", 0)
bouton = Pin(_pin_bouton, Pin.IN, Pin.PULL_UP) if _pin_bouton is not None else None

# Capteurs (DHT22 / DHT11)
capteurs = []
try:
    import dht
except ImportError:
    dht = None
for _c in cfg.get("capteurs", []):
    if dht is None:
        break
    try:
        _classe = dht.DHT11 if _c.get("type") == "dht11" else dht.DHT22
        capteurs.append((_c["id"], _classe(Pin(_c["pin"]))))
    except Exception as e:
        print("Capteur", _c.get("id"), "ignore :", e)

# --- État global ---
client = None
mode_ap = False
ip_locale = AP_IP
reseaux_scannes = []


# =====================================================================
# 3. Wi-Fi
# =====================================================================
def charger_profils():
    """Liste de [ssid, mot_de_passe]. Reprend automatiquement l'ancien wifi.txt."""
    p = lire_json(FICHIER_WIFI, None)
    if p is not None:
        return p
    p = []
    try:
        with open("wifi.txt") as f:
            for ligne in f:
                ligne = ligne.strip()
                if ligne and not ligne.startswith("#") and "," in ligne:
                    s, m = ligne.split(",", 1)
                    p.append([s.strip(), m.strip()])
    except OSError:
        pass
    if p:
        ecrire_json(FICHIER_WIFI, p)
    return p


def ajouter_wifi(ssid, mot_de_passe):
    """Ajoute (ou met à jour) un réseau, en tête de liste. Les anciens restent en secours."""
    p = [x for x in charger_profils() if x[0] != ssid]
    p.insert(0, [ssid, mot_de_passe])
    ecrire_json(FICHIER_WIFI, p[:6])
    print("Wi-Fi enregistre :", ssid)


def oublier_wifi(ssid):
    ecrire_json(FICHIER_WIFI, [x for x in charger_profils() if x[0] != ssid])


def tester_connexion_wifi(wlan_obj, ssid, password, duree_sec=8):
    try:
        wlan_obj.disconnect()
    except OSError:
        pass
    time.sleep(0.5)
    print("Test de connexion a '{}'...".format(ssid))
    try:
        wlan_obj.connect(ssid, password)
    except OSError:
        time.sleep(1)
        try:
            wlan_obj.connect(ssid, password)
        except OSError:
            return False
    cycles = duree_sec * 2
    while not wlan_obj.isconnected() and cycles > 0:
        time.sleep(0.5)
        cycles -= 1
    return wlan_obj.isconnected()


def connecter_reseaux_connus(wlan_obj, duree_sec=8):
    for s, p in charger_profils():
        if tester_connexion_wifi(wlan_obj, s, p, duree_sec):
            return True
        print("Echec sur", s)
    try:
        wlan_obj.disconnect()
    except OSError:
        pass
    return False


def scanner_reseaux(wlan_obj):
    noms = set()
    try:
        for net in wlan_obj.scan():
            try:
                nom = net[0].decode("utf-8")
            except UnicodeError:
                continue
            if nom:
                noms.add(nom)
    except Exception as e:
        print("Erreur de scan :", e)
    return sorted(noms)


def client_ap_connecte():
    try:
        return len(wlan_ap.status("stations")) > 0
    except Exception:
        return False


# =====================================================================
# 4. MQTT : publication, commandes, administration à distance
# =====================================================================
def publier(t, msg, retenu=False):
    if client is None:
        return
    if isinstance(msg, str):
        msg = msg.encode("utf-8")  # sinon les accents faussent la longueur du message MQTT
    try:
        client.publish(t, msg, retain=retenu)
    except Exception:
        pass  # la boucle principale s'occupe de la reconnexion


def publier_etat(sid):
    publier(topic(sid + "/status"), b"ON" if sortie_allumee(sid) else b"OFF", True)
    if sid in thermostats:
        publier(topic(sid + "/consigne"), "{:.1f}".format(consigne(sid)), True)
        publier(topic(sid + "/chauffe"), b"ON" if thermostats[sid]["chauffe"] else b"OFF", True)


def sauver_etats():
    d = dict(actifs)
    d["consignes"] = consignes
    try:
        ecrire_json(FICHIER_ETATS, d)
    except OSError:
        pass


def changer_sortie(sid, allume):
    actifs[sid] = allume
    sauver_etats()
    if sid in thermostats:
        evaluer_thermostat(sid, force=True)
    else:
        piloter_pin(sid, allume)
    publier_etat(sid)


def changer_consigne(sid, valeur):
    consignes[sid] = max(5.0, min(30.0, valeur))
    sauver_etats()
    evaluer_thermostat(sid, force=True)
    publier_etat(sid)


def evaluer_thermostat(sid, force=False):
    t = thermostats[sid]
    maintenant = time.ticks_ms()
    m = mesures.get(t["capteur"])
    if not sortie_allumee(sid):
        voulu = False
    elif m is None or time.ticks_diff(maintenant, m[1]) > MESURE_PERIMEE_MS:
        voulu = False  # pas de température fiable : on ne chauffe pas
    else:
        temp, c = m[0], consigne(sid)
        if temp <= c - t["h"]:
            voulu = True
        elif temp >= c + t["h"]:
            voulu = False
        else:
            voulu = t["chauffe"]

    if voulu == t["chauffe"]:
        return
    # Protège la chaudière des marche/arrêt trop rapprochés (sauf action de l'utilisateur)
    if (not force and t["changement"] is not None
            and time.ticks_diff(maintenant, t["changement"]) < CYCLE_MIN_MS):
        return
    t["chauffe"] = voulu
    t["changement"] = maintenant
    piloter_pin(sid, voulu)
    publier(topic(sid + "/chauffe"), b"ON" if voulu else b"OFF", True)
    print("Chauffage", sid, "->", "marche" if voulu else "arret")


def repondre(cmd, ok, message=""):
    publier(T_REPONSE, json.dumps({"cmd": cmd, "ok": ok, "message": message}))


def quitter_maison():
    """Efface les messages retenus de la maison actuelle (l'appareil n'y apparaîtra plus)."""
    sujets = [T_IP, T_RESEAUX, T_CONFIG, T_VERSION]
    for sid in ordre_sorties:
        sujets.append(topic(sid + "/status"))
        if sid in thermostats:
            sujets.append(topic(sid + "/consigne"))
            sujets.append(topic(sid + "/chauffe"))
    for cid, _ in capteurs:
        sujets.append(topic(cid + "/valeur"))
    sujets.append(T_DISPO)
    for t in sujets:
        publier(t, b"", True)
    try:
        client.disconnect()   # déconnexion propre : pas de message « offline » laissé derrière
    except Exception:
        pass


def redemarrer():
    publier(T_DISPO, b"offline", True)
    try:
        client.disconnect()
    except Exception:
        pass
    time.sleep(1)
    reset()


def on_message(t, msg):
    try:
        if t == T_OTA:
            appliquer_ota(msg)
            return
        if t == T_ADMIN:
            traiter_admin(msg)
            return
        s = t.decode()
        if s.endswith("/cmd"):
            sid = s[len(BASE) + 1:-4]
            if sid not in sorties:
                return
            cmd = msg.decode().strip().upper()
            if cmd == "ON":
                changer_sortie(sid, True)
            elif cmd == "OFF":
                changer_sortie(sid, False)
            elif cmd == "TOGGLE":
                changer_sortie(sid, not sortie_allumee(sid))
            elif cmd.startswith("CONSIGNE") and sid in thermostats:
                try:
                    changer_consigne(sid, float(cmd.split()[1].replace(",", ".")))
                except (IndexError, ValueError):
                    pass
            else:
                publier_etat(sid)
    except Exception as e:
        print("Erreur message :", e)


def traiter_admin(msg):
    global reseaux_scannes
    try:
        d = json.loads(msg.decode())
    except ValueError:
        return
    cmd = d.get("cmd", "")

    if cmd == "wifi_ajouter":
        ssid = d.get("ssid", "").strip()
        if not ssid:
            repondre(cmd, False, "Nom du Wi-Fi vide")
            return
        ajouter_wifi(ssid, d.get("password", ""))
        repondre(cmd, True, "Wi-Fi « {} » enregistré".format(ssid))

    elif cmd == "wifi_oublier":
        oublier_wifi(d.get("ssid", ""))
        repondre(cmd, True, "Réseau oublié")

    elif cmd == "wifi_liste":
        repondre(cmd, True, ", ".join(p[0] for p in charger_profils()))

    elif cmd == "scan":
        reseaux_scannes = scanner_reseaux(wlan)
        publier(T_RESEAUX, json.dumps(reseaux_scannes), True)
        repondre(cmd, True, "{} réseaux".format(len(reseaux_scannes)))

    elif cmd == "config":
        c = d.get("config")
        if not config_valide(c):
            repondre(cmd, False, "Configuration invalide")
            return
        ecrire_json(FICHIER_CONFIG, c)
        repondre(cmd, True, "Configuration enregistrée, redémarrage")
        redemarrer()

    elif cmd == "redemarrer":
        repondre(cmd, True, "Redémarrage")
        redemarrer()

    elif cmd == "maison":
        code = str(d.get("code", "")).strip().lower()
        if not code_valide(code):
            repondre(cmd, False, "Code maison invalide")
            return
        ecrire_json(FICHIER_MAISON, {"code": code})
        repondre(cmd, True, "Déplacé, redémarrage")
        quitter_maison()
        time.sleep(1)
        reset()

    elif cmd == "mode_config":
        open(FLAG_AP, "w").close()
        repondre(cmd, True, "Passage en mode réglage")
        redemarrer()

    else:
        repondre(cmd, False, "Commande inconnue")


def appliquer_ota(msg):
    """
    Mise à jour de main.py à distance.
    Format : b"OTA1\\n" + empreinte sha256 en hexa + b"\\n" + contenu du fichier.
    L'ancien main.py est gardé en main.bak : boot.py y revient si le nouveau plante.
    """
    try:
        n1 = msg.index(b"\n")
        n2 = msg.index(b"\n", n1 + 1)
        if msg[:n1] != b"OTA1":
            raise ValueError("format inconnu")
        empreinte = msg[n1 + 1:n2].decode()
        code = msg[n2 + 1:]
        calcul = ubinascii.hexlify(hashlib.sha256(code).digest()).decode()
        if calcul != empreinte:
            raise ValueError("fichier abîmé pendant l'envoi")

        with open("main.tmp", "wb") as f:
            f.write(code)
        del code
        gc.collect()

        # Vérifie qu'il n'y a pas d'erreur de syntaxe avant de remplacer quoi que ce soit
        try:
            with open("main.tmp") as f:
                compile(f.read(), "main.py", "exec")
        except (MemoryError, NameError):
            pass  # pas assez de mémoire pour vérifier : boot.py servira de filet
        gc.collect()

        supprimer("main.bak")
        os.rename("main.py", "main.bak")
        os.rename("main.tmp", "main.py")
        with open(FICHIER_ESSAIS, "w") as f:
            f.write("0")
        repondre("ota", True, "Mise à jour installée, redémarrage…")
        redemarrer()
    except SyntaxError as e:
        supprimer("main.tmp")
        repondre("ota", False, "Erreur de syntaxe : {}".format(e))
    except Exception as e:
        supprimer("main.tmp")
        repondre("ota", False, "Échec : {}".format(e))


def connecter_mqtt():
    c = MQTTClient(CLIENT_ID, MQTT_BROKER, port=MQTT_PORT, keepalive=60)
    c.set_callback(on_message)
    c.set_last_will(T_DISPO, b"offline", retain=True)
    c.connect()
    return c


def annoncer():
    """Tout ce que l'appli doit savoir, en messages retenus."""
    publier(T_DISPO, b"online", True)
    publier(T_VERSION, VERSION.encode(), True)
    publier(T_CONFIG, json.dumps(cfg).encode(), True)
    publier(T_IP, "http://{}".format(ip_locale).encode(), True)
    publier(T_RESEAUX, json.dumps(reseaux_scannes).encode(), True)
    for sid in ordre_sorties:
        publier_etat(sid)
    client.subscribe(T_CMD_FILTRE)
    client.subscribe(T_ADMIN)
    client.subscribe(T_OTA)
    lire_capteurs(force=True)

    # Suite d'une mise à jour
    if existe(FICHIER_ESSAIS):
        supprimer(FICHIER_ESSAIS)
        repondre("ota", True, "Version {} démarrée".format(VERSION))
    if existe(FICHIER_ROLLBACK):
        supprimer(FICHIER_ROLLBACK)
        repondre("ota", False, "La nouvelle version plantait : retour à l'ancienne")


# =====================================================================
# 5. Bouton BOOT et capteurs
# =====================================================================
_appui = None
_appui_long = False


def verifier_bouton():
    """
    Appui court : allume / éteint la première sortie.
    Appui de 5 s : la LED clignote vite -> lâcher -> mode réglage Wi-Fi
    (en mode réglage, même geste pour en sortir).
    """
    global _appui, _appui_long
    if bouton is None:
        return
    maintenant = time.ticks_ms()

    if bouton.value() == 0:
        if _appui is None:
            _appui = maintenant
            _appui_long = False
        duree = time.ticks_diff(maintenant, _appui)
        if duree >= APPUI_LONG_MS:
            _appui_long = True
            if led_statut:
                led_statut.value((maintenant // 100) % 2)
        elif duree > 1000 and led_statut and (statut_libre or mode_ap):
            led_statut.value((maintenant // 400) % 2)
        return

    if _appui is None:
        return
    duree = time.ticks_diff(maintenant, _appui)
    _appui = None

    if _appui_long:
        # On redémarre seulement une fois le bouton lâché :
        # GPIO0 enfoncé au démarrage ferait entrer la carte en mode téléchargement.
        if mode_ap:
            print("Sortie du mode reglage.")
            reset()
        open(FLAG_AP, "w").close()
        print("Passage en mode reglage.")
        redemarrer()
    elif 50 < duree < 1000 and not mode_ap and ordre_sorties:
        sid = ordre_sorties[0]
        changer_sortie(sid, not sortie_allumee(sid))

    if led_statut and mode_ap:
        led_statut.value(1)
    elif led_statut and statut_libre:
        led_statut.value(0)


_dernier_capteurs = None
mesures = {}   # id capteur -> (température, ticks de la mesure)


def lire_capteurs(force=False):
    """Lit les capteurs toutes les minutes, avec ou sans Internet (le chauffage en dépend)."""
    global _dernier_capteurs
    if not capteurs:
        return
    maintenant = time.ticks_ms()
    if (not force and _dernier_capteurs is not None
            and time.ticks_diff(maintenant, _dernier_capteurs) < INTERVALLE_CAPTEURS_MS):
        return
    _dernier_capteurs = maintenant
    for cid, capteur in capteurs:
        try:
            capteur.measure()
            t, h = capteur.temperature(), capteur.humidity()
            mesures[cid] = (t, maintenant)
            publier(topic(cid + "/valeur"), json.dumps({"t": t, "h": h}), True)
        except Exception as e:
            print("Lecture", cid, "impossible :", e)
    for sid in thermostats:
        evaluer_thermostat(sid)


# =====================================================================
# 6. Serveur web (portail de secours dans un navigateur + API de l'appli)
# =====================================================================
def decoder_url(chaine):
    chaine = chaine.replace("+", " ")
    out = bytearray()
    i = 0
    n = len(chaine)
    while i < n:
        c = chaine[i]
        if c == "%" and i + 3 <= n:
            try:
                out.append(int(chaine[i + 1:i + 3], 16))
                i += 3
                continue
            except ValueError:
                pass
        out.extend(c.encode("utf-8"))
        i += 1
    try:
        return out.decode("utf-8")
    except UnicodeError:
        return chaine


def echapper(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace("'", "&#39;").replace('"', "&quot;"))


def lire_requete(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        morceau = conn.recv(512)
        if not morceau:
            break
        data += morceau
        if len(data) > 4096:
            break
    if b"\r\n\r\n" not in data:
        return "", "", ""
    entete, corps = data.split(b"\r\n\r\n", 1)
    lignes = entete.decode("utf-8").split("\r\n")
    premiere = lignes[0].split(" ")
    methode = premiere[0] if premiere else ""
    chemin = premiere[1] if len(premiere) > 1 else "/"
    longueur = 0
    for l in lignes[1:]:
        if l.lower().startswith("content-length:"):
            try:
                longueur = int(l.split(":", 1)[1].strip())
            except ValueError:
                pass
    while len(corps) < longueur:
        morceau = conn.recv(512)
        if not morceau:
            break
        corps += morceau
    return methode, chemin.split("?")[0], corps.decode("utf-8")


def parser_formulaire(corps):
    champs = {}
    for param in corps.split("&"):
        if "=" in param:
            k, v = param.split("=", 1)
            champs[decoder_url(k)] = decoder_url(v)
    return champs


def envoyer(conn, statut, type_contenu, corps="", entetes_sup=""):
    if isinstance(corps, str):
        corps = corps.encode("utf-8")
    entete = ("HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}"
              "Connection: close\r\n\r\n").format(statut, type_contenu, len(corps), entetes_sup)
    conn.sendall(entete.encode("utf-8"))
    if corps:
        conn.sendall(corps)


def page_html():
    options = "".join("<option value='{0}'>{0}</option>".format(echapper(n)) for n in reseaux_scannes)
    return """<!DOCTYPE html><html><head><meta charset='utf-8'>
<meta name='viewport' content='width=device-width, initial-scale=1'>
<title>Réglage Wi-Fi</title>
<style>
 body{font-family:sans-serif;background:#F7F2EA;color:#2A2520;margin:0;padding:18px}
 .c{background:#FFFDF8;max-width:380px;margin:auto;padding:24px;border-radius:24px}
 h2{margin-top:0}
 label{display:block;margin:16px 0 6px;font-size:17px}
 select,input{width:100%;box-sizing:border-box;padding:14px;border:2px solid #E8E1D5;border-radius:14px;font-size:18px;background:#fff}
 button{width:100%;margin-top:24px;padding:18px;background:#B5532F;color:#fff;border:0;border-radius:16px;font-size:20px}
</style>
<script>
 function envoyer(e){
  e.preventDefault();
  var s=document.getElementById('s').value, p=document.getElementById('p').value, m=document.getElementById('m').value;
  document.getElementById('b').innerText='Envoi…';
  fetch('/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:'ssid='+encodeURIComponent(s)+'&password='+encodeURIComponent(p)+'&maison='+encodeURIComponent(m)})
  .finally(function(){
   var c=document.getElementById('c'); c.innerHTML='<h2>C\\'est enregistré</h2><p>L\\'appareil redémarre. Tu peux fermer cette page.</p>';
   setTimeout(function(){window.close();},1500);
  });
 }
</script></head><body><div class='c' id='c'>
<h2>Réglage du Wi-Fi</h2>
<form onsubmit='envoyer(event)'>
<label>Réseaux trouvés</label>
<select onchange="document.getElementById('s').value=this.value"><option value=''>Choisir…</option>""" + options + """</select>
<label>Nom du Wi-Fi</label><input id='s' required>
<label>Mot de passe</label><input id='p' type='password'>
<label>Code maison <small>(laisser tel quel si tu ne sais pas)</small></label>
<input id='m' value='""" + echapper(CODE_MAISON) + """' autocapitalize='off' autocomplete='off'>
<button id='b'>Enregistrer</button>
</form></div></body></html>"""


def gerer_client_web():
    try:
        conn, addr = serveur_web.accept()
    except OSError:
        return
    try:
        conn.settimeout(2.0)
        methode, chemin, corps = lire_requete(conn)

        if methode == "POST" and chemin == "/save":
            champs = parser_formulaire(corps)
            ssid = champs.get("ssid", "").strip()
            if ssid:
                ajouter_wifi(ssid, champs.get("password", "").strip())
                if "maison" in champs:
                    code = champs["maison"].strip().lower()
                    if code_valide(code) and code != CODE_MAISON:
                        ecrire_json(FICHIER_MAISON, {"code": code})
                envoyer(conn, "200 OK", "text/plain", "OK")
                conn.close()
                print("Redemarrage pour appliquer le nouveau Wi-Fi...")
                redemarrer()
            else:
                envoyer(conn, "400 Bad Request", "text/plain", "SSID manquant")

        elif methode == "GET" and chemin == "/":
            envoyer(conn, "200 OK", "text/html; charset=utf-8", page_html())

        elif methode == "GET" and chemin == "/networks":
            envoyer(conn, "200 OK", "application/json",
                    json.dumps({"id": DEVICE_ID, "version": VERSION, "maison": CODE_MAISON, "reseaux": reseaux_scannes}))

        elif mode_ap and chemin != "/favicon.ico":
            envoyer(conn, "302 Found", "text/plain", "", "Location: http://{}/\r\n".format(AP_IP))

        else:
            envoyer(conn, "404 Not Found", "text/plain", "")
    except Exception as e:
        print("Erreur web :", e)
    finally:
        try:
            conn.close()
        except Exception:
            pass


# DNS captif (mode réglage) : toutes les requêtes -> 192.168.4.1
def creer_dns():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("", 53))
    s.setblocking(False)
    return s


def gerer_dns(s):
    try:
        data, addr = s.recvfrom(512)
    except OSError:
        return
    try:
        i = 12
        while data[i] != 0:
            i += data[i] + 1
        question = data[12:i + 5]
        reponse = (data[:2] + b"\x81\x80" + data[4:6] + data[4:6] + b"\x00\x00\x00\x00"
                   + question
                   + b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04"
                   + bytes(int(x) for x in AP_IP.split(".")))
        s.sendto(reponse, addr)
    except Exception:
        pass


# =====================================================================
# 7. Boucles principales
# =====================================================================
def tache_fond():
    gerer_client_web()
    verifier_bouton()
    lire_capteurs()


def attendre_en_servant(secondes):
    debut = time.ticks_ms()
    while time.ticks_diff(time.ticks_ms(), debut) < secondes * 1000:
        tache_fond()
        time.sleep(0.05)


def connecter_mqtt_avec_backoff():
    global client
    delai = 2
    while wlan.isconnected():
        try:
            client = connecter_mqtt()
            annoncer()
            print("Connecte a MQTT. Portail : http://{}".format(ip_locale))
            return True
        except Exception as e:
            client = None
            print("Echec MQTT ({}), nouvel essai dans {}s".format(e, delai))
            attendre_en_servant(delai)
            delai = min(delai * 2, 60)
    return False


def boucle_connectee():
    global client, ip_locale
    connecter_mqtt_avec_backoff()
    dernier_ping = time.ticks_ms()
    perte_wifi_depuis = None

    while True:
        if not wlan.isconnected():
            client = None
            if perte_wifi_depuis is None:
                perte_wifi_depuis = time.ticks_ms()
                print("Wi-Fi perdu, tentative de reconnexion...")
            if connecter_reseaux_connus(wlan):
                ip_locale = wlan.ifconfig()[0]
                perte_wifi_depuis = None
                print("Wi-Fi retrouve ! IP :", ip_locale)
            elif time.ticks_diff(time.ticks_ms(), perte_wifi_depuis) > DELAI_MAX_SANS_WIFI_MS:
                print("Wi-Fi absent depuis trop longtemps, passage en mode reglage.")
                open(FLAG_AP, "w").close()
                reset()
            else:
                attendre_en_servant(5)
            continue

        if client is None:
            connecter_mqtt_avec_backoff()
            dernier_ping = time.ticks_ms()
            continue

        try:
            client.check_msg()
            if time.ticks_diff(time.ticks_ms(), dernier_ping) > INTERVALLE_PING_MS:
                client.ping()
                dernier_ping = time.ticks_ms()
        except OSError as e:
            print("Coupure MQTT ({}), reconnexion...".format(e))
            client = None
            attendre_en_servant(2)
            continue

        tache_fond()
        time.sleep(0.05)


def boucle_ap():
    global mode_ap, ip_locale, reseaux_scannes
    mode_ap = True
    ip_locale = AP_IP
    wlan_ap.active(True)
    wlan_ap.config(essid=AP_SSID, authmode=network.AUTH_OPEN)
    dns = creer_dns()
    if led_statut:
        led_statut.value(1)
    print("Mode reglage : '{}' -> http://{}".format(AP_SSID, AP_IP))

    debut = time.ticks_ms()
    dernier_essai = debut
    essai_ota = existe(FICHIER_ESSAIS)

    while True:
        gerer_client_web()
        gerer_dns(dns)
        verifier_bouton()
        lire_capteurs()   # le chauffage continue de réguler même en mode réglage

        # Une nouvelle version qui tourne 2 min sans planter est validée, même sans Wi-Fi
        if essai_ota and time.ticks_diff(time.ticks_ms(), debut) > 120000:
            supprimer(FICHIER_ESSAIS)
            essai_ota = False

        # Retente les Wi-Fi connus (box qui redémarre après une coupure...),
        # jamais pendant qu'un téléphone est en train de régler l'appareil.
        if (time.ticks_diff(time.ticks_ms(), dernier_essai) > DELAI_RETRY_AP_MS
                and not client_ap_connecte()):
            if charger_profils():
                print("Nouvelle tentative sur les reseaux connus...")
                if connecter_reseaux_connus(wlan):
                    print("Wi-Fi retrouve, redemarrage en mode normal.")
                    reset()
            reseaux_scannes = scanner_reseaux(wlan)
            dernier_essai = time.ticks_ms()

        time.sleep(0.02)


# =====================================================================
# 8. Démarrage
# =====================================================================
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan_ap = network.WLAN(network.AP_IF)

reseaux_scannes = scanner_reseaux(wlan)

serveur_web = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
serveur_web.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
serveur_web.bind(("", 80))
serveur_web.listen(2)
serveur_web.setblocking(False)

print("ESP32 Maison v{} - ID : {}".format(VERSION, DEVICE_ID))

try:
    if existe(FLAG_AP):
        supprimer(FLAG_AP)
        boucle_ap()
    elif connecter_reseaux_connus(wlan):
        wlan_ap.active(False)
        ip_locale = wlan.ifconfig()[0]
        print("Wi-Fi connecte ! IP :", ip_locale)
        boucle_connectee()
    else:
        print("Aucun Wi-Fi connu disponible.")
        boucle_ap()

except KeyboardInterrupt:
    print("Arret utilisateur.")
    if client:
        try:
            client.publish(T_DISPO, b"offline", retain=True)
            client.disconnect()
        except Exception:
            pass

except Exception as e:
    print("Erreur globale :", e)
    time.sleep(10)
    reset()
