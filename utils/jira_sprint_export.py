#!/usr/bin/env python3
"""
Exporte les tickets du prochain sprint d'un tableau Jira vers CSV et JSON, par l'API REST.

Python 3, bibliothèque standard uniquement, aucune installation nécessaire.
Les identifiants ne sont jamais enregistrés sur le disque : ils viennent des
variables d'environnement ou sont demandés à l'invite.

Jira Cloud (atlassian.net) : URL + e-mail + jeton d'API
  https://id.atlassian.com/manage-profile/security/api-tokens
Jira Data Center            : URL + jeton d'accès personnel (pas d'e-mail)
Derrière un SSO sans jeton : utiliser plutôt jira-capture-app.mjs.

Variables d'environnement facultatives :
  JIRA_URL, JIRA_EMAIL, JIRA_TOKEN

Exemples, depuis utils/ :
  python3 jira_sprint_export.py --board "Nom du tableau"
  python3 jira_sprint_export.py --board 42 --sprint "Sprint 24" --out exports

Sortie par défaut : utils/exports/ (ignoré par git : données de client, dépôt public).
"""

import argparse
import base64
import csv
import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime
from pathlib import Path

DEFAULT_POINTS_FIELD = "customfield_10016"  # varie selon l'instance, à vérifier
DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "exports"
BASE_FIELDS = ["summary", "status", "assignee", "priority", "issuetype",
               "labels", "parent", "issuelinks", "description"]


def die(msg):
    sys.exit(f"Erreur : {msg}")


class JiraClient:
    def __init__(self, base_url, email, token):
        self.base = base_url.rstrip("/")
        if email:  # Cloud : authentification de base e-mail + jeton
            basic = base64.b64encode(f"{email}:{token}".encode()).decode()
            self.auth = f"Basic {basic}"
        else:      # Data Center : jeton d'accès personnel
            self.auth = f"Bearer {token}"

    def get(self, path, params=None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(
            url, headers={"Accept": "application/json", "Authorization": self.auth})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode("utf-8", "replace")
            if e.code == 401:
                die("authentification refusée (vérifiez l'e-mail et le jeton)")
            if e.code == 403:
                die(f"accès refusé sur {path}")
            die(f"HTTP {e.code} sur {path} : {body}")
        except urllib.error.URLError as e:
            die(f"connexion impossible : {e.reason}")

    def paginate(self, path, params=None, page=50):
        params = dict(params or {})
        start, out = 0, []
        while True:
            params.update(startAt=start, maxResults=page)
            data = self.get(path, params)
            items = data.get("issues", data.get("values", []))
            if not items:
                break
            out.extend(items)
            start += len(items)
            if data.get("isLast") is True:
                break
            if "total" in data and start >= data["total"]:
                break
        return out


def find_board(client, name_or_id):
    if str(name_or_id).isdigit():
        return client.get(f"/rest/agile/1.0/board/{name_or_id}")
    boards = client.paginate("/rest/agile/1.0/board", {"name": name_or_id})
    exact = [b for b in boards if b["name"].lower() == name_or_id.lower()]
    candidates = exact or boards
    if not candidates:
        die(f"aucun tableau nommé « {name_or_id} »")
    if len(candidates) > 1:
        lines = "\n".join(f"  {b['id']} : {b['name']}" for b in candidates)
        die(f"plusieurs tableaux correspondent, précisez l'identifiant :\n{lines}")
    return candidates[0]


def pick_sprint(client, board_id, wanted):
    sprints = client.paginate(f"/rest/agile/1.0/board/{board_id}/sprint",
                              {"state": "future"})
    if not sprints:
        die("aucun sprint futur sur ce tableau")
    if wanted:
        match = [s for s in sprints if s["name"] == wanted or str(s["id"]) == wanted]
        if not match:
            die(f"sprint « {wanted} » introuvable parmi les sprints futurs")
        return match[0]
    # Le prochain sprint est celui qui démarre le plus tôt
    return min(sprints, key=lambda s: s.get("startDate") or "9999")


def fetch_issues(client, sprint_id, points_field):
    fields = ",".join(BASE_FIELDS + [points_field])
    return client.paginate(f"/rest/agile/1.0/sprint/{sprint_id}/issue",
                           {"fields": fields})


def text_of(node):
    """Extrait le texte d'une description (texte brut ou format ADF Jira Cloud)."""
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return " ".join(filter(None, (text_of(n) for n in node)))
    if isinstance(node, dict):
        if "text" in node:
            return node["text"]
        return " ".join(filter(None, (text_of(c) for c in node.get("content", []))))
    return ""


def to_row(issue, points_field):
    f = issue["fields"]
    return {
        "cle": issue["key"],
        "type": (f.get("issuetype") or {}).get("name", ""),
        "resume": f.get("summary", ""),
        "statut": (f.get("status") or {}).get("name", ""),
        "assigne": (f.get("assignee") or {}).get("displayName", "Non assigné"),
        "priorite": (f.get("priority") or {}).get("name", ""),
        "estimation": f.get(points_field, ""),
        "parent": (f.get("parent") or {}).get("key", ""),
        "libelles": ";".join(f.get("labels") or []),
        "nb_liens": len(f.get("issuelinks") or []),
        "description": " ".join(text_of(f.get("description")).split()),
    }


def write_outputs(rows, sprint, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    safe = "".join(c if c.isalnum() else "_" for c in sprint["name"])
    base = out_dir / f"{safe}_{stamp}"
    with open(f"{base}.csv", "w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()), delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    with open(f"{base}.json", "w", encoding="utf-8") as fh:
        json.dump({"sprint": sprint, "tickets": rows}, fh, ensure_ascii=False, indent=2)
    return base


def main():
    parser = argparse.ArgumentParser(description="Export des tickets du prochain sprint Jira.")
    parser.add_argument("--board", required=True, help="nom ou identifiant du tableau")
    parser.add_argument("--sprint", help="nom ou identifiant du sprint (défaut : le prochain)")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR),
                        help="dossier de sortie (défaut : utils/exports)")
    parser.add_argument("--points-field", default=DEFAULT_POINTS_FIELD,
                        help="identifiant du champ d'estimation")
    args = parser.parse_args()

    url = os.environ.get("JIRA_URL") or input("URL Jira (ex. https://votre-org.atlassian.net) : ").strip()
    email = os.environ.get("JIRA_EMAIL")
    if email is None:
        email = input("E-mail Atlassian (laisser vide pour Data Center) : ").strip() or None
    token = os.environ.get("JIRA_TOKEN") or getpass.getpass("Jeton d'API (saisie masquée) : ")

    client = JiraClient(url, email, token)
    board = find_board(client, args.board)
    print(f"Tableau : {board['name']} (id {board['id']})")

    sprint = pick_sprint(client, board["id"], args.sprint)
    print(f"Sprint : {sprint['name']} (id {sprint['id']})")

    issues = fetch_issues(client, sprint["id"], args.points_field)
    if not issues:
        die("aucun ticket dans ce sprint")
    rows = [to_row(i, args.points_field) for i in issues]

    base = write_outputs(rows, sprint, Path(args.out))
    print(f"{len(rows)} tickets exportés :")
    print(f"  {base}.csv")
    print(f"  {base}.json")
    print("Répartition par statut :", dict(Counter(r["statut"] for r in rows)))


if __name__ == "__main__":
    main()
