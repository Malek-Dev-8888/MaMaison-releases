# boot.py — s'exécute avant main.py. À copier une seule fois sur chaque ESP32.
# Filet de sécurité des mises à jour à distance : si le nouveau main.py
# redémarre 3 fois sans jamais se connecter, on remet l'ancien (main.bak).
import os


def _existe(nom):
    try:
        os.stat(nom)
        return True
    except OSError:
        return False


if _existe("ota_essais"):
    try:
        with open("ota_essais") as f:
            n = int(f.read() or "0")
    except (OSError, ValueError):
        n = 0

    if n >= 3 and _existe("main.bak"):
        print("Mise a jour en echec : retour a l'ancienne version.")
        try:
            os.remove("main.py")
        except OSError:
            pass
        os.rename("main.bak", "main.py")
        os.remove("ota_essais")
        with open("ota_rollback", "w") as f:
            f.write("1")
    else:
        with open("ota_essais", "w") as f:
            f.write(str(n + 1))
