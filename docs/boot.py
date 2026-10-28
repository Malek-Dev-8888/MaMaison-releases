# boot.py — s'exécute avant main.py. À copier une seule fois sur chaque ESP32.
# Filet de sécurité des mises à jour à distance : si la nouvelle version
# redémarre 3 fois sans jamais se connecter, on remet l'ancienne
# (maison.bak -> maison.mpy, main.bak -> main.py).
import os


def _existe(nom):
    try:
        os.stat(nom)
        return True
    except OSError:
        return False


def _restaurer(sauvegarde, fichier):
    if _existe(sauvegarde):
        try:
            os.remove(fichier)
        except OSError:
            pass
        os.rename(sauvegarde, fichier)
        return True
    return False


if _existe("ota_essais"):
    try:
        with open("ota_essais") as f:
            n = int(f.read() or "0")
    except (OSError, ValueError):
        n = 0

    if n >= 3 and (_existe("maison.bak") or _existe("main.bak")):
        print("Mise a jour en echec : retour a l'ancienne version.")
        _restaurer("maison.bak", "maison.mpy")
        _restaurer("main.bak", "main.py")
        os.remove("ota_essais")
        with open("ota_rollback", "w") as f:
            f.write("1")
    else:
        with open("ota_essais", "w") as f:
            f.write(str(n + 1))
